"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v2.1 — SELL FALLBACK + RETRY MEJORADO
  - RETRY_SCHEDULE: primer intento con 3 min de espera (el mercado no se resuelve
    on-chain instantáneamente — el primer intento inmediato siempre fallaba).
  - Ventana total extendida a ~2h 8 min (8 intentos vs 7 anteriores).
  - sell_fallback_clob(): si se agotan todos los reintentos del claim, intenta
    vender los tokens ganadores en el CLOB a precio de mercado (~0.999).
    Esto recupera el valor sin necesidad de resolución on-chain.
  - _get_winning_token_id(): extrae el token_id ganador del market dict incluido
    en bet (tokens list con outcome Yes/No, o fallback a clobTokenIds).
  - _fetch_clob_midpoint(): precio live del token ganador en el CLOB.
  - notify_claim_scheduled(): nueva notificación al lanzar el hilo de claim,
    informa al usuario que el primer intento será en 3 min.

v2.0 — RETRY + FALLBACK + NOTIFICACIONES
  - claim_with_retry(): reintenta según RETRY_SCHEDULE (hasta ~64 min total)
  - 4 RPCs de Polygon con fallback automático
  - Notificaciones Telegram para: reintento, éxito con TX, fallo definitivo
  - Se ejecuta en hilo daemon desde monitor.py → no bloquea el loop principal
  - condition_id acepta formato "0x..." y sin prefijo
  - estimate_gas detecta si el mercado no está resuelto aún (error esperado)

Destino: bot/modules/claimer.py
"""
import logging
import time

import requests
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

# ── CLOB endpoint para midpoint ───────────────────────────────────────────────
CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint"

# ── Calendario de reintentos ──────────────────────────────────────────────────
# Cada valor = segundos de ESPERA ANTES de ese intento.
# v2.1 FIX: RETRY_SCHEDULE[0] = 180 (3 min) — el mercado no se resuelve
# on-chain instantáneamente; el intento inmediato previo siempre fallaba.
#
# Intento 1 →  3 min  (esperar resolución on-chain inicial)
# Intento 2 → +2 min  (5 min total)
# Intento 3 → +3 min  (8 min total)
# Intento 4 → +5 min  (13 min total)
# Intento 5 → +10 min (23 min total)
# Intento 6 → +15 min (38 min total)
# Intento 7 → +30 min (68 min total ~1h)
# Intento 8 → +60 min (128 min total ~2h)
# ─────────────────────────────────────────────────────────────────
# Si todos fallan → SELL FALLBACK en CLOB (~0.999)
RETRY_SCHEDULE = [180, 120, 180, 300, 600, 900, 1800, 3600]


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


def _get_winning_token_id(bet: dict) -> str | None:
    """
    Extrae el token_id del lado ganador (YES si UP, NO si DOWN).
    Busca primero en market["tokens"] (lista con outcome), luego en clobTokenIds.
    """
    market    = bet.get("market", {})
    direction = bet.get("direction", "UP")
    tokens    = market.get("tokens", [])

    if isinstance(tokens, list) and tokens:
        for t in tokens:
            outcome = t.get("outcome", "").lower()
            if direction == "UP" and outcome == "yes":
                return t.get("token_id")
            if direction == "DOWN" and outcome == "no":
                return t.get("token_id")

    # Fallback: clobTokenIds (índice 0=YES/UP, 1=NO/DOWN)
    import json as _json
    clob_raw = market.get("clobTokenIds")
    if clob_raw:
        try:
            clob_ids = _json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
            if isinstance(clob_ids, list) and len(clob_ids) >= 2:
                return clob_ids[0] if direction == "UP" else clob_ids[1]
        except Exception:
            pass

    logger.warning(f"[CLAIMER] ⚠ No se pudo extraer token_id ganador del mercado")
    return None


def _fetch_clob_midpoint(token_id: str) -> float | None:
    """Consulta el precio live del token en el CLOB."""
    try:
        r = requests.get(CLOB_MIDPOINT, params={"token_id": token_id}, timeout=8)
        r.raise_for_status()
        mid = r.json().get("mid")
        return float(mid) if mid is not None else None
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo obtener midpoint CLOB: {e}")
        return None


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

    gas_price    = w3.eth.gas_price
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


# ── Fallback: vender posición en el CLOB ─────────────────────────────────────

def _sell_fallback_clob(bet: dict, cfg: dict) -> None:
    """
    v2.1: Fallback cuando el claim on-chain falla definitivamente.
    Vende los tokens ganadores en el CLOB al precio de mercado actual (~0.999).
    Notifica el resultado (éxito o fallo) por Telegram.
    """
    from .notifier import notify_sell_fallback_ok, notify_sell_fallback_failed

    direction   = bet.get("direction", "UP")
    stake       = bet.get("stake", 0.0)
    entry_odds  = bet.get("odds", 0.5)
    tokens_held = round(stake / max(entry_odds, 0.001), 4)

    token_id = _get_winning_token_id(bet)
    if not token_id:
        msg = "No se pudo extraer token_id — SELL no ejecutado"
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)
        return

    # Precio live del token
    mid = _fetch_clob_midpoint(token_id)
    if mid is None or mid < 0.80:
        msg = f"Midpoint CLOB no disponible o muy bajo ({mid}) — SELL no ejecutado"
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)
        return

    # Precio de venta: midpoint redondeado a 2 decimales, con un pequeño margen
    # para garantizar fill. Mínimo 0.90.
    sell_price = max(0.90, round(mid - 0.005, 3))
    logger.info(
        f"[CLAIMER] 💰 SELL FALLBACK\n"
        f"          Token    : {token_id[:16]}...\n"
        f"          Tokens   : {tokens_held}\n"
        f"          Midpoint : {mid:.4f}  →  Sell @ {sell_price:.4f}\n"
        f"          USDC est.: ~{tokens_held * sell_price:.2f}"
    )

    from .strategy import sell_position
    market = bet.get("market", {})
    resp = sell_position(token_id, tokens_held, sell_price, cfg, market)

    if resp:
        usdc_received = round(tokens_held * sell_price, 4)
        logger.info(
            f"[CLAIMER] ✅ SELL ejecutado — "
            f"~{usdc_received:.4f} USDC recuperados"
        )
        notify_sell_fallback_ok(cfg, bet, resp, sell_price, usdc_received)
    else:
        msg = "sell_position() devolvió None — orden no ejecutada"
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)


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

    v2.1:
      - Primer intento con 3 min de espera (mercado no resuelto on-chain aún).
      - Ventana total ~2h 8 min (8 intentos).
      - Si todos los intentos fallan → intenta SELL FALLBACK en CLOB.

    Notificaciones Telegram:
      · notify_claim_scheduled   — al lanzar el hilo (primer intento en 3 min)
      · notify_claim_retrying    — antes de cada reintento (2º en adelante)
      · notify_claim_ok          — en cuanto confirma on-chain
      · notify_claim_failed      — si se agotan todos los intentos
      · notify_sell_fallback_ok  — si el SELL FALLBACK tuvo éxito
      · notify_sell_fallback_failed — si el SELL FALLBACK también falló

    Uso en monitor.py:
        import threading
        threading.Thread(
            target=claim_with_retry,
            args=(active_bet, cfg),
            daemon=True,
            name=f"claim-{active_bet.get('id', 'x')}",
        ).start()
    """
    from .notifier import (
        notify_claim_ok,
        notify_claim_retrying,
        notify_claim_failed,
        notify_claim_scheduled,
    )

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
        _sell_fallback_clob(bet, cfg)
        return

    max_attempts = len(RETRY_SCHEDULE)
    last_error   = "desconocido"

    # Notificación inicial: el usuario sabe que el bot esperará antes del primer intento
    first_wait = RETRY_SCHEDULE[0]
    notify_claim_scheduled(cfg, bet, first_wait_secs=first_wait, max_attempts=max_attempts)
    logger.info(
        f"[CLAIMER] ⏳ Claim programado — primer intento en {first_wait}s "
        f"({first_wait//60}m {first_wait%60}s)"
    )

    for attempt_idx, wait_secs in enumerate(RETRY_SCHEDULE):
        attempt_num = attempt_idx + 1

        # Esperar antes del intento
        if wait_secs > 0:
            logger.info(
                f"[CLAIMER] ⏳ Esperando {wait_secs}s antes del intento "
                f"{attempt_num}/{max_attempts}..."
            )
            # La notificación de reintento se envía desde el 2º intento en adelante
            # (el primero ya fue notificado por notify_claim_scheduled)
            if attempt_num > 1:
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

    # ── Se agotaron todos los intentos → intentar SELL FALLBACK ──────────────
    logger.error(
        f"[CLAIMER] ❌ Claim fallido tras {max_attempts} intentos. "
        f"Último error: {last_error}"
    )
    notify_claim_failed(cfg, bet, reason=last_error, attempts=max_attempts)

    logger.info("[CLAIMER] 🔄 Intentando SELL FALLBACK en CLOB...")
    _sell_fallback_clob(bet, cfg)
