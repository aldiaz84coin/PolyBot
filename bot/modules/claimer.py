"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v2.0 — RETRY + FALLBACK + NOTIFICACIONES
  - claim_with_retry(): reintenta según RETRY_SCHEDULE (hasta ~64 min total)
  - 4 RPCs de Polygon con fallback automático (polygon-rpc, ankr, publicnode, quiknode)
  - Notificaciones Telegram para: reintento, éxito con TX, fallo definitivo
  - Se ejecuta en hilo daemon desde monitor.py → no bloquea el loop principal
  - condition_id acepta formato "0x..." y sin prefijo
  - estimate_gas detecta si el mercado no está resuelto aún (error esperado)

Destino: bot/modules/claimer.py
"""
import logging
import time

from web3 import Web3

logger = logging.getLogger(__name__)

# ── Contrato CTF Polymarket (Polygon) ─────────────────────────────────────────
CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
CHAIN_ID     = 137
GAS_MARGIN   = 1.25   # +25% sobre el estimado
CONFIRM_TIMEOUT = 90  # segundos esperando recibo on-chain

CTF_ABI = [
    {
        "name": "redeemPositions",
        "type": "function",
        "inputs": [
            {"name": "collateralToken",    "type": "address"},
            {"name": "parentCollectionId", "type": "bytes32"},
            {"name": "conditionId",        "type": "bytes32"},
            {"name": "indexSets",          "type": "uint256[]"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    }
]

# ── RPCs de Polygon (se prueban en orden; el primero que responde se usa) ─────
POLYGON_RPCS = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc-mainnet.matic.quiknode.pro",
]

# ── Calendario de reintentos ──────────────────────────────────────────────────
# Cada valor = segundos de ESPERA antes de ese intento (el 0 = inmediato).
# Razón: Polymarket puede tardar entre 5 y 30 min en resolver on-chain.
#
# Intento 1 →  0s  (inmediato al detectar WIN)
# Intento 2 → +1 min
# Intento 3 → +3 min
# Intento 4 → +5 min
# Intento 5 → +10 min
# Intento 6 → +15 min
# Intento 7 → +30 min
# ─────────────────────────────────────────
# Total máx: ~64 min de ventana de reintento
RETRY_SCHEDULE = [0, 60, 180, 300, 600, 900, 1800]


# ── Helpers internos ──────────────────────────────────────────────────────────

def _connect_polygon() -> Web3:
    """
    Prueba los RPCs de POLYGON_RPCS en orden y devuelve el primero que conecta.
    Lanza ConnectionError si todos fallan.
    """
    for rpc in POLYGON_RPCS:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 15}))
            if w3.is_connected():
                logger.info(f"[CLAIMER] ✅ Conectado a Polygon via {rpc}")
                return w3
            else:
                logger.warning(f"[CLAIMER] ⚠ RPC sin respuesta: {rpc}")
        except Exception as e:
            logger.warning(f"[CLAIMER] ⚠ Error en RPC {rpc}: {e}")
    raise ConnectionError(
        f"Todos los RPCs de Polygon fallaron: {POLYGON_RPCS}"
    )


def _condition_id_to_bytes(condition_id: str) -> bytes:
    """Convierte condition_id (hex str con o sin '0x') a bytes32."""
    hex_str = condition_id.removeprefix("0x").zfill(64)
    return bytes.fromhex(hex_str)


# ── Núcleo: un intento de redención ──────────────────────────────────────────

def _redimir_once(
    condition_id: str,
    direction: str,
    private_key: str,
) -> str:
    """
    Intento único de redeemPositions() con fallback de RPCs.
    Devuelve tx_hash (hex string). Lanza excepción si falla.
    """
    index_set = [1] if direction == "UP" else [2]

    logger.info(
        f"[CLAIMER] Iniciando redención\n"
        f"          Direction    : {direction}  →  index_set={index_set}\n"
        f"          Condition ID : {condition_id}"
    )

    w3      = _connect_polygon()
    account = w3.eth.account.from_key(private_key)
    logger.info(f"[CLAIMER] Wallet: {account.address}")

    # Verificar balance POL (gas)
    try:
        bal_pol = float(w3.from_wei(w3.eth.get_balance(account.address), "ether"))
        logger.info(f"[CLAIMER] Balance POL: {bal_pol:.6f}")
        if bal_pol < 0.001:
            logger.warning(
                f"[CLAIMER] ⚠ Balance POL muy bajo ({bal_pol:.6f}) — "
                "puede no alcanzar para gas"
            )
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo consultar balance POL: {e}")

    ctf = w3.eth.contract(
        address=w3.to_checksum_address(CTF_ADDRESS),
        abi=CTF_ABI,
    )

    cond_bytes = _condition_id_to_bytes(condition_id)

    fn = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,
        cond_bytes,
        index_set,
    )

    # estimate_gas falla si el mercado no está resuelto on-chain todavía
    try:
        gas_estimate = fn.estimate_gas({"from": account.address})
        gas = int(gas_estimate * GAS_MARGIN)
    except Exception as e:
        raise RuntimeError(
            f"estimate_gas falló (mercado no resuelto aún, o ya reclamado): {e}"
        ) from e

    gas_price   = w3.eth.gas_price
    pol_cost_est = w3.from_wei(gas * gas_price, "ether")
    logger.info(
        f"[CLAIMER] Gas: {gas_estimate} units (+{(GAS_MARGIN-1)*100:.0f}% → {gas})  "
        f"@ {w3.from_wei(gas_price, 'gwei'):.2f} Gwei  "
        f"≈ {pol_cost_est:.6f} POL"
    )

    nonce = w3.eth.get_transaction_count(account.address)
    tx = fn.build_transaction({
        "from":     account.address,
        "gas":      gas,
        "gasPrice": gas_price,
        "nonce":    nonce,
        "chainId":  CHAIN_ID,
    })

    logger.info("[CLAIMER] 📤 Firmando y enviando transacción...")
    signed  = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
    tx_hex  = tx_hash.hex()

    logger.info(
        f"[CLAIMER] TX enviada: {tx_hex}\n"
        f"          Esperando confirmación (timeout={CONFIRM_TIMEOUT}s)..."
    )

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=CONFIRM_TIMEOUT)

    if receipt.get("status") != 1:
        raise RuntimeError(f"TX fallida on-chain (status=0): {tx_hex}")

    gas_used = receipt.get("gasUsed", 0)
    pol_real = w3.from_wei(gas_used * gas_price, "ether")
    logger.info(
        f"[CLAIMER] 🏆 Claim confirmado\n"
        f"          Block  : {receipt.get('blockNumber')}\n"
        f"          Gas    : {gas_used}  ({pol_real:.6f} POL)\n"
        f"          TX     : https://polygonscan.com/tx/{tx_hex}"
    )
    return tx_hex


# ── API pública: intento único (compatibilidad) ───────────────────────────────

def redimir_posicion(market: dict, direction: str, cfg: dict) -> str:
    """
    Intento único con fallback de RPCs.
    Interfaz compatible con llamadas antiguas desde monitor.py.
    Devuelve tx_hash o lanza excepción.
    """
    condition_id = (
        market.get("conditionId")
        or market.get("condition_id", "")
    )
    if not condition_id:
        raise ValueError("conditionId no encontrado en el mercado")

    private_key = cfg["polymarket"]["private_key"]
    return _redimir_once(condition_id, direction, private_key)


# ── API pública: retry con notificaciones (usar desde monitor.py) ─────────────

def claim_with_retry(bet: dict, cfg: dict) -> None:
    """
    Reintenta el claim siguiendo RETRY_SCHEDULE.
    Diseñado para ejecutarse en un hilo daemon (no bloquea el loop del bot).

    Notifica por Telegram:
      · notify_claim_retrying  — antes de cada reintento
      · notify_claim_ok        — en cuanto confirma on-chain
      · notify_claim_failed    — si se agotan todos los intentos

    Uso en monitor.py:
        import threading
        threading.Thread(
            target=claim_with_retry,
            args=(active_bet, cfg),
            daemon=True,
            name=f"claim-{active_bet.get('id', 'x')}",
        ).start()
    """
    # Import tardío para evitar importación circular
    from .notifier import notify_claim_ok, notify_claim_retrying, notify_claim_failed

    market    = bet.get("market", {})
    direction = bet.get("direction", "UP")
    tokens    = bet.get("tokens", 0.0)
    stake     = bet.get("stake", 0.0)

    condition_id = (
        market.get("conditionId")
        or market.get("condition_id", "")
    )
    private_key = cfg["polymarket"]["private_key"]

    # Validación temprana
    if not condition_id:
        logger.error(
            "[CLAIMER] ❌ claim_with_retry: conditionId ausente en active_bet — "
            "no se puede reclamar"
        )
        notify_claim_failed(cfg, bet, "conditionId no disponible en el mercado", attempts=0)
        return

    max_attempts = len(RETRY_SCHEDULE)
    last_error   = "desconocido"

    for attempt_idx, wait_secs in enumerate(RETRY_SCHEDULE):
        attempt_num = attempt_idx + 1

        # Esperar antes del intento (excepto el primero)
        if wait_secs > 0:
            logger.info(
                f"[CLAIMER] ⏳ Esperando {wait_secs}s antes del intento "
                f"{attempt_num}/{max_attempts}..."
            )
            notify_claim_retrying(
                cfg, bet,
                attempt=attempt_num,
                max_attempts=max_attempts,
                reason=last_error,
                wait_secs=wait_secs,
            )
            time.sleep(wait_secs)

        logger.info(f"[CLAIMER] 🔄 Intento {attempt_num}/{max_attempts}...")

        try:
            tx_hash  = _redimir_once(condition_id, direction, private_key)
            usdc_est = round(tokens, 4)   # tokens ganadores valen 1 USDC c/u
            notify_claim_ok(cfg, bet, tx_hash, attempt=attempt_num, usdc_est=usdc_est)
            logger.info(f"[CLAIMER] ✅ Claim exitoso en intento {attempt_num}")
            return  # ← éxito, terminar el hilo

        except Exception as e:
            last_error = str(e)
            logger.warning(
                f"[CLAIMER] ⚠ Intento {attempt_num}/{max_attempts} fallido: {last_error}"
            )

    # Se agotaron todos los intentos
    logger.error(
        f"[CLAIMER] ❌ Claim fallido tras {max_attempts} intentos. "
        f"Último error: {last_error}"
    )
    notify_claim_failed(cfg, bet, reason=last_error, attempts=max_attempts)
