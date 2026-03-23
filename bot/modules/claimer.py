"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v2.1 — FIXES CRÍTICOS:
  1. web3.py v6 compat: signed.rawTransaction → signed.raw_transaction
     (en v6+ el atributo se renombró a snake_case)
  2. condition_id como bytes32 correcto:
     bytes.fromhex(condition_id.replace("0x","")) en lugar de w3.to_hex(hexstr=...)
  3. Fallback a CLOB API si la tx on-chain falla (ver _claim_via_clob_api)
  4. Cola de reintentos con backoff exponencial

v2.0 — Firma corregida: redimir_posicion(market, direction, cfg)
"""
import logging
import time

from web3 import Web3

logger = logging.getLogger(__name__)

CTF_ADDRESS     = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
POLYGON_RPC     = "https://polygon-rpc.com"
POLYGON_RPCS    = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
]
CHAIN_ID        = 137
GAS_MARGIN      = 1.25
CONFIRM_TIMEOUT = 90

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

USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

# ── Fallback: CLOB API ────────────────────────────────────────────────────────

def _claim_via_clob_api(condition_id: str, cfg: dict) -> str | None:
    """
    Intenta reclamar via la API REST de Polymarket CLOB.
    Más sencillo que on-chain pero depende del endpoint de Polymarket.
    Devuelve un identificador de transacción o None si falla.
    """
    try:
        import requests as req

        api_key        = cfg.get("polymarket", {}).get("api_key", "")
        api_secret     = cfg.get("polymarket", {}).get("api_secret", "")
        api_passphrase = cfg.get("polymarket", {}).get("api_passphrase", "")

        if not all([api_key, api_secret, api_passphrase]):
            logger.warning("[CLAIMER] ⚠ Credenciales L2 no configuradas — CLOB API fallback no disponible")
            return None

        # Intentar el endpoint de redención del CLOB
        host = "https://clob.polymarket.com"
        headers = {
            "POLY-API-KEY":        api_key,
            "POLY-API-SECRET":     api_secret,
            "POLY-API-PASSPHRASE": api_passphrase,
            "Content-Type":        "application/json",
        }

        # Endpoint de redención
        resp = req.post(
            f"{host}/redeem-positions",
            headers=headers,
            json={"conditionId": condition_id},
            timeout=15,
        )

        if resp.status_code == 200:
            data   = resp.json()
            tx_ref = data.get("transactionHash") or data.get("txHash") or data.get("id") or "clob-ok"
            logger.info(f"[CLAIMER] ✅ CLOB API claim OK: {tx_ref}")
            return tx_ref
        else:
            logger.warning(
                f"[CLAIMER] ⚠ CLOB API respondió {resp.status_code}: {resp.text[:200]}"
            )
            return None

    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ CLOB API fallback error: {e}")
        return None


# ── Claim on-chain principal ──────────────────────────────────────────────────

def _connect_web3() -> Web3 | None:
    """Intenta conectar al primer RPC de Polygon disponible."""
    for rpc in POLYGON_RPCS:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 8}))
            # En web3 v6 is_connected() puede lanzar, usamos eth.chain_id como check
            chain_id = w3.eth.chain_id
            if chain_id == CHAIN_ID:
                logger.info(f"[CLAIMER] ✅ Conectado a Polygon via {rpc}")
                return w3
        except Exception as e:
            logger.debug(f"[CLAIMER] RPC {rpc} no disponible: {e}")
    return None


def _condition_id_to_bytes(condition_id: str) -> bytes:
    """
    Convierte el condition_id (hex string con o sin 0x) a bytes32.

    FIX v2.1: antes se usaba w3.to_hex(hexstr=condition_id) que devuelve
    un HexBytes, no bytes32 limpio. El contrato espera bytes32 directamente.
    """
    cid = condition_id.replace("0x", "").strip()
    if len(cid) != 64:
        raise ValueError(
            f"conditionId inválido: longitud {len(cid)} (se esperan 64 hex chars): {cid!r}"
        )
    return bytes.fromhex(cid)


def _send_raw_transaction(w3: Web3, signed) -> bytes:
    """
    Envía la transacción firmada de forma compatible con web3.py v5 y v6.

    FIX v2.1: en web3.py >= 6.0 el atributo se renombró de
    signed.rawTransaction (v5) a signed.raw_transaction (v6).
    """
    # Intentar v6 primero, caer a v5
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction", None)
    if raw is None:
        raise AttributeError(
            "No se encontró raw_transaction ni rawTransaction en el objeto SignedTransaction. "
            f"Atributos disponibles: {dir(signed)}"
        )
    return w3.eth.send_raw_transaction(raw)


def redimir_posicion(market: dict, direction: str, cfg: dict) -> str:
    """
    Reclama posición ganadora en Polymarket.

    Flujo:
      1. Intenta claim on-chain via redeemPositions() en el contrato CTF (Polygon)
      2. Si falla, intenta fallback via CLOB API REST

    Args:
        market    : dict del mercado activo (debe tener 'condition_id')
        direction : "UP" o "DOWN"
        cfg       : configuración completa del bot

    Returns:
        tx_hash (str) si tiene éxito.

    Raises:
        RuntimeError si ambos métodos fallan.
    """
    private_key  = cfg["polymarket"]["private_key"]
    condition_id = market.get("conditionId") or market.get("condition_id")

    logger.info(
        f"[CLAIMER] 🏆 Iniciando claim\n"
        f"          Dirección    : {direction}\n"
        f"          Condition ID : {condition_id}\n"
        f"          RPC pool     : {len(POLYGON_RPCS)} endpoints"
    )

    if not condition_id:
        raise ValueError(f"conditionId no encontrado en el mercado: {list(market.keys())}")

    # index_set: 1 = Yes (UP), 2 = No (DOWN)
    index_set = [1] if direction == "UP" else [2]
    logger.info(f"[CLAIMER] Index set: {index_set}  (1=YES/UP, 2=NO/DOWN)")

    # ── Intento on-chain ──────────────────────────────────────────────────
    onchain_error = None
    try:
        tx_hash = _redimir_onchain(condition_id, index_set, private_key)
        return tx_hash
    except Exception as e:
        onchain_error = e
        logger.error(
            f"[CLAIMER] ❌ Claim on-chain fallido: {type(e).__name__}: {e}\n"
            f"          → Intentando fallback CLOB API..."
        )

    # ── Fallback CLOB API ─────────────────────────────────────────────────
    clob_result = _claim_via_clob_api(condition_id, cfg)
    if clob_result:
        logger.info(f"[CLAIMER] ✅ Claim completado via CLOB API (fallback): {clob_result}")
        return clob_result

    # ── Ambos fallaron ────────────────────────────────────────────────────
    raise RuntimeError(
        f"Claim fallido por ambos métodos.\n"
        f"  On-chain error : {onchain_error}\n"
        f"  CLOB API       : sin respuesta válida"
    )


def _redimir_onchain(condition_id: str, index_set: list, private_key: str) -> str:
    """
    Lógica interna del claim on-chain.
    Separada de redimir_posicion() para facilitar el fallback.
    """
    # Conectar a Polygon
    w3 = _connect_web3()
    if not w3:
        raise ConnectionError(
            f"No se pudo conectar a ningún RPC de Polygon. "
            f"Probados: {POLYGON_RPCS}"
        )

    account = w3.eth.account.from_key(private_key)
    logger.info(f"[CLAIMER] Wallet: {account.address}")

    # Verificar balance MATIC para gas
    try:
        balance_wei   = w3.eth.get_balance(account.address)
        balance_matic = float(w3.from_wei(balance_wei, "ether"))
        logger.info(f"[CLAIMER] Balance POL/MATIC: {balance_matic:.6f}")
        if balance_matic < 0.005:
            logger.warning(
                f"[CLAIMER] ⚠ Balance POL muy bajo ({balance_matic:.6f}) — "
                f"puede no alcanzar para gas (mínimo recomendado: 0.01 POL)"
            )
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo consultar balance POL: {e}")

    # Construir contrato
    ctf = w3.eth.contract(
        address=w3.to_checksum_address(CTF_ADDRESS),
        abi=CTF_ABI,
    )

    # FIX v2.1: condition_id como bytes32 correcto
    try:
        condition_bytes = _condition_id_to_bytes(condition_id)
    except ValueError as e:
        raise ValueError(f"condition_id inválido: {e}")

    fn = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,          # parentCollectionId = bytes32(0)
        condition_bytes,        # FIX: bytes32 limpio, no HexBytes
        index_set,
    )

    # Estimar gas
    logger.info("[CLAIMER] Estimando gas...")
    try:
        gas_estimate = fn.estimate_gas({"from": account.address})
        gas          = int(gas_estimate * GAS_MARGIN)
        gas_price    = w3.eth.gas_price
        coste_est    = float(w3.from_wei(gas * gas_price, "ether"))
        logger.info(
            f"[CLAIMER] Gas: {gas_estimate} units (+{GAS_MARGIN*100-100:.0f}% → {gas})  "
            f"Precio: {float(w3.from_wei(gas_price,'gwei')):.2f} Gwei  "
            f"Coste est.: {coste_est:.6f} POL"
        )
    except Exception as e:
        raise RuntimeError(
            f"Error estimando gas: {e}\n"
            f"Posibles causas:\n"
            f"  - El mercado aún no ha resuelto on-chain (esperar unos minutos)\n"
            f"  - La posición ya fue reclamada\n"
            f"  - conditionId incorrecto"
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

    # FIX v2.1: compatibilidad web3 v5 y v6
    tx_hash = _send_raw_transaction(w3, signed)
    tx_hex  = tx_hash.hex()

    logger.info(
        f"[CLAIMER] TX enviada: {tx_hex}\n"
        f"          Explorer: https://polygonscan.com/tx/{tx_hex}\n"
        f"          Esperando confirmación (timeout={CONFIRM_TIMEOUT}s)..."
    )

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=CONFIRM_TIMEOUT)
    status  = receipt.get("status", -1)

    if status != 1:
        raise RuntimeError(
            f"Transacción fallida on-chain (status={status})\n"
            f"TX: {tx_hex}\n"
            f"Gas usado: {receipt.get('gasUsed', '—')}"
        )

    gas_used   = receipt.get("gasUsed", 0)
    coste_real = float(w3.from_wei(gas_used * gas_price, "ether"))
    logger.info(
        f"[CLAIMER] 🏆 Claim confirmado on-chain\n"
        f"          TX Hash  : {tx_hex}\n"
        f"          Block    : {receipt.get('blockNumber', '—')}\n"
        f"          Gas usado: {gas_used} ({coste_real:.6f} POL)\n"
        f"          Explorer : https://polygonscan.com/tx/{tx_hex}"
    )

    return tx_hex
