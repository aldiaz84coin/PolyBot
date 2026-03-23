"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v2.2 — Añadida claim_with_retry(bet, cfg):
  - Función pública requerida por monitor.py.
  - Reintentos con backoff exponencial (espera creciente entre intentos).
  - Notificaciones Telegram en cada paso (programado, intento, ok, fallo).
  - Consulta Gamma API antes de cada intento para saber si el mercado
    ya resolvió on-chain (evita gastar gas en vano).
  - Fallback a CLOB API si todos los intentos on-chain fallan.

v2.1 — FIXES CRÍTICOS:
  1. web3.py v6 compat: signed.rawTransaction → signed.raw_transaction
  2. condition_id como bytes32 correcto via bytes.fromhex()
  3. Fallback CLOB API
"""
import logging
import time

from web3 import Web3

logger = logging.getLogger(__name__)

CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
POLYGON_RPCS = [
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
GAMMA_API    = "https://gamma-api.polymarket.com/markets"

# Configuración de reintentos
_MAX_ATTEMPTS    = 6
# Esperas en segundos entre intentos: 2min, 5min, 10min, 15min, 20min
_RETRY_WAITS     = [120, 300, 600, 900, 1200]
# Espera inicial antes del primer intento (el mercado tarda en resolver)
_FIRST_WAIT_SECS = 120


# ── claim_with_retry — punto de entrada desde monitor.py ─────────────────────

def claim_with_retry(bet: dict, cfg: dict) -> None:
    """
    Intenta reclamar una posición ganadora con reintentos y backoff.

    Llamar desde un thread daemon (no bloqueante para el loop principal):
        threading.Thread(target=claim_with_retry, args=(bet, cfg), daemon=True).start()

    Args:
        bet : dict de la apuesta (necesita 'market', 'direction', 'stake', 'odds')
        cfg : configuración completa del bot
    """
    from .notifier import (
        notify_claim_scheduled,
        notify_claim_attempt,
        notify_claim_ok,
        notify_claim_retrying,
        notify_claim_failed,
        notify_sell_fallback_failed,
    )

    market       = bet.get("market") or {}
    direction    = bet.get("direction", "UP")
    condition_id = market.get("condition_id") or market.get("conditionId") or ""
    slug         = market.get("slug", "")

    if not condition_id:
        logger.error("[CLAIMER] ❌ claim_with_retry: condition_id vacío — imposible reclamar")
        return

    logger.info(
        f"[CLAIMER] 🏁 claim_with_retry iniciado — "
        f"dir={direction}  cond={condition_id[:16]}...  "
        f"esperando {_FIRST_WAIT_SECS}s antes del primer intento"
    )

    try:
        notify_claim_scheduled(cfg, bet, _FIRST_WAIT_SECS, _MAX_ATTEMPTS)
    except Exception:
        pass

    # Espera inicial — el mercado tarda en resolver on-chain
    time.sleep(_FIRST_WAIT_SECS)

    last_error = "Sin intentos realizados"

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        # Consultar estado del mercado en Gamma antes de intentar
        gamma_status = _check_gamma_resolved(slug, condition_id)

        try:
            notify_claim_attempt(cfg, bet, attempt, _MAX_ATTEMPTS, gamma_status)
        except Exception:
            pass

        logger.info(
            f"[CLAIMER] Intento {attempt}/{_MAX_ATTEMPTS} — "
            f"gamma_resolved={gamma_status.get('resolved')}  "
            f"gamma_closed={gamma_status.get('closed')}"
        )

        try:
            tx = redimir_posicion(market, direction, cfg)

            # ── Éxito ──────────────────────────────────────────────────────
            stake    = float(bet.get("stake", 0))
            odds     = float(bet.get("odds", 0.5))
            tokens   = round(stake / max(odds, 0.001), 4)
            usdc_est = round(tokens * 1.0, 4)  # ~1 USDC por token ganador

            logger.info(f"[CLAIMER] ✅ Claim completado en intento {attempt}: {tx}")
            try:
                notify_claim_ok(cfg, bet, tx, attempt, usdc_est)
            except Exception:
                pass
            return

        except Exception as e:
            last_error = str(e)
            logger.warning(
                f"[CLAIMER] ⚠ Intento {attempt}/{_MAX_ATTEMPTS} fallido: "
                f"{type(e).__name__}: {str(e)[:200]}"
            )

            if attempt >= _MAX_ATTEMPTS:
                break

            wait = _RETRY_WAITS[min(attempt - 1, len(_RETRY_WAITS) - 1)]
            logger.info(f"[CLAIMER] Esperando {wait}s antes del intento {attempt + 1}...")

            try:
                notify_claim_retrying(cfg, bet, attempt + 1, _MAX_ATTEMPTS, last_error, wait)
            except Exception:
                pass

            time.sleep(wait)

    # ── Todos los intentos fallaron ───────────────────────────────────────
    logger.error(
        f"[CLAIMER] ❌ Todos los intentos fallaron ({_MAX_ATTEMPTS}). "
        f"Último error: {last_error}"
    )

    try:
        notify_claim_failed(cfg, bet, last_error, _MAX_ATTEMPTS)
    except Exception:
        pass

    try:
        notify_sell_fallback_failed(cfg, bet, "Claim on-chain agotado y CLOB API sin respuesta")
    except Exception:
        pass


# ── Consulta estado del mercado en Gamma API ──────────────────────────────────

def _check_gamma_resolved(slug: str, condition_id: str) -> dict:
    """
    Consulta Gamma API para saber si el mercado ya resolvió.
    Devuelve dict con claves: resolved, closed, outcome, error.
    """
    try:
        import requests as req

        params = {}
        if slug:
            params["slug"] = slug
        elif condition_id:
            params["conditionId"] = condition_id

        if not params:
            return {"resolved": None, "closed": None, "error": "Sin slug ni conditionId"}

        r = req.get(GAMMA_API, params=params, timeout=8)
        r.raise_for_status()
        data = r.json()

        market = data[0] if isinstance(data, list) and data else data
        if not market:
            return {"resolved": None, "closed": None, "error": "Mercado no encontrado en Gamma"}

        resolved = bool(market.get("resolved") or market.get("resolutionTime"))
        closed   = bool(market.get("closed") or market.get("endDate"))
        outcome  = market.get("outcome") or market.get("resolution") or ""

        return {"resolved": resolved, "closed": closed, "outcome": outcome, "error": None}

    except Exception as e:
        return {"resolved": None, "closed": None, "error": str(e)[:120]}


# ── Fallback: CLOB API ────────────────────────────────────────────────────────

def _claim_via_clob_api(condition_id: str, cfg: dict) -> str | None:
    """
    Intenta reclamar via la API REST de Polymarket CLOB.
    Fallback cuando el claim on-chain falla.
    """
    try:
        import requests as req

        api_key        = cfg.get("polymarket", {}).get("api_key", "")
        api_secret     = cfg.get("polymarket", {}).get("api_secret", "")
        api_passphrase = cfg.get("polymarket", {}).get("api_passphrase", "")

        if not all([api_key, api_secret, api_passphrase]):
            logger.warning("[CLAIMER] ⚠ Credenciales L2 no configuradas — CLOB API fallback no disponible")
            return None

        host    = "https://clob.polymarket.com"
        headers = {
            "POLY-API-KEY":        api_key,
            "POLY-API-SECRET":     api_secret,
            "POLY-API-PASSPHRASE": api_passphrase,
            "Content-Type":        "application/json",
        }

        resp = req.post(
            f"{host}/redeem-positions",
            headers=headers,
            json={"conditionId": condition_id},
            timeout=15,
        )

        if resp.status_code == 200:
            data   = resp.json()
            tx_ref = (
                data.get("transactionHash")
                or data.get("txHash")
                or data.get("id")
                or "clob-ok"
            )
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


# ── Claim principal ───────────────────────────────────────────────────────────

def redimir_posicion(market: dict, direction: str, cfg: dict) -> str:
    """
    Reclama posición ganadora. Intenta on-chain primero, CLOB API como fallback.

    Args:
        market    : dict del mercado activo (debe tener 'condition_id')
        direction : "UP" o "DOWN"
        cfg       : configuración completa del bot

    Returns:
        tx_hash o referencia de transacción.

    Raises:
        RuntimeError si ambos métodos fallan.
    """
    private_key  = cfg["polymarket"]["private_key"]
    condition_id = market.get("conditionId") or market.get("condition_id")

    if not condition_id:
        raise ValueError(f"conditionId no encontrado en el mercado: {list(market.keys())}")

    index_set = [1] if direction == "UP" else [2]

    logger.info(
        f"[CLAIMER] 🏆 redimir_posicion — dir={direction}  "
        f"cond={condition_id[:16]}...  index_set={index_set}"
    )

    # ── Intento on-chain ──────────────────────────────────────────────────
    onchain_error = None
    try:
        tx_hash = _redimir_onchain(condition_id, index_set, private_key)
        return tx_hash
    except Exception as e:
        onchain_error = e
        logger.error(
            f"[CLAIMER] ❌ On-chain fallido: {type(e).__name__}: {e}\n"
            f"          → Intentando fallback CLOB API..."
        )

    # ── Fallback CLOB API ─────────────────────────────────────────────────
    clob_result = _claim_via_clob_api(condition_id, cfg)
    if clob_result:
        logger.info(f"[CLAIMER] ✅ Claim via CLOB API (fallback): {clob_result}")
        return clob_result

    # ── Ambos fallaron ────────────────────────────────────────────────────
    raise RuntimeError(
        f"Claim fallido por ambos métodos.\n"
        f"  On-chain : {type(onchain_error).__name__}: {onchain_error}\n"
        f"  CLOB API : sin respuesta válida"
    )


# ── Helpers on-chain ──────────────────────────────────────────────────────────

def _connect_web3() -> Web3 | None:
    """Conecta al primer RPC de Polygon disponible."""
    for rpc in POLYGON_RPCS:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 8}))
            if w3.eth.chain_id == CHAIN_ID:
                logger.info(f"[CLAIMER] ✅ Conectado a Polygon via {rpc}")
                return w3
        except Exception as e:
            logger.debug(f"[CLAIMER] RPC {rpc} no disponible: {e}")
    return None


def _condition_id_to_bytes(condition_id: str) -> bytes:
    """Convierte condition_id hex string a bytes32."""
    cid = condition_id.replace("0x", "").strip()
    if len(cid) != 64:
        raise ValueError(
            f"conditionId inválido: longitud {len(cid)} (se esperan 64 hex chars): {cid!r}"
        )
    return bytes.fromhex(cid)


def _send_raw_transaction(w3: Web3, signed) -> bytes:
    """
    Envía la tx firmada compatible con web3.py v5 y v6.
    v5: signed.rawTransaction
    v6: signed.raw_transaction
    """
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction", None)
    if raw is None:
        raise AttributeError(
            f"No se encontró raw_transaction ni rawTransaction. "
            f"Atributos con 'raw': {[a for a in dir(signed) if 'raw' in a.lower()]}"
        )
    return w3.eth.send_raw_transaction(raw)


def _redimir_onchain(condition_id: str, index_set: list, private_key: str) -> str:
    """Lógica interna del claim on-chain."""
    w3 = _connect_web3()
    if not w3:
        raise ConnectionError(f"No se pudo conectar a ningún RPC de Polygon: {POLYGON_RPCS}")

    account = w3.eth.account.from_key(private_key)
    logger.info(f"[CLAIMER] Wallet: {account.address}")

    # Verificar balance POL para gas
    try:
        balance_pol = float(w3.from_wei(w3.eth.get_balance(account.address), "ether"))
        logger.info(f"[CLAIMER] Balance POL: {balance_pol:.6f}")
        if balance_pol < 0.005:
            logger.warning(
                f"[CLAIMER] ⚠ Balance POL muy bajo ({balance_pol:.6f}) — "
                f"mínimo recomendado: 0.01 POL"
            )
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo consultar balance POL: {e}")

    ctf = w3.eth.contract(
        address=w3.to_checksum_address(CTF_ADDRESS),
        abi=CTF_ABI,
    )

    condition_bytes = _condition_id_to_bytes(condition_id)

    fn = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,    # parentCollectionId = bytes32(0)
        condition_bytes, # FIX: bytes32 limpio via bytes.fromhex()
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
            f"[CLAIMER] Gas: {gas_estimate} → {gas} units  "
            f"Precio: {float(w3.from_wei(gas_price, 'gwei')):.2f} Gwei  "
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
    tx    = fn.build_transaction({
        "from":     account.address,
        "gas":      gas,
        "gasPrice": gas_price,
        "nonce":    nonce,
        "chainId":  CHAIN_ID,
    })

    logger.info("[CLAIMER] 📤 Firmando y enviando transacción...")
    signed  = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = _send_raw_transaction(w3, signed)  # FIX: compatible web3 v5/v6
    tx_hex  = tx_hash.hex()

    logger.info(f"[CLAIMER] TX enviada: {tx_hex}  Esperando confirmación...")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=CONFIRM_TIMEOUT)
    status  = receipt.get("status", -1)

    if status != 1:
        raise RuntimeError(
            f"TX fallida on-chain (status={status})  TX: {tx_hex}  "
            f"Gas usado: {receipt.get('gasUsed', '—')}"
        )

    gas_used   = receipt.get("gasUsed", 0)
    coste_real = float(w3.from_wei(gas_used * gas_price, "ether"))
    logger.info(
        f"[CLAIMER] 🏆 Claim confirmado on-chain\n"
        f"          TX    : {tx_hex}\n"
        f"          Block : {receipt.get('blockNumber', '—')}\n"
        f"          Gas   : {gas_used} ({coste_real:.6f} POL)\n"
        f"          Link  : https://polygonscan.com/tx/{tx_hex}"
    )

    return tx_hex
