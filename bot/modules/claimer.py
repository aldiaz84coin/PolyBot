"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v3.1 — SELL FALLBACK DESHABILITADO
  - SELL_FALLBACK_ENABLED = False: deshabilitado hasta verificar que 0.99
    tiene contrapartida en el mercado resuelto. Si el claim falla → aviso manual.
  - SELL_FALLBACK_PRICE = 0.99: precio límite correcto para cuando se reactive.
    Vender a menos de ~0.99 en una posición WIN implica pérdida real.

v3.0 — TIMING FIX + GAMMA CHECK + FALLBACK MEJORADO
  - RETRY_SCHEDULE: [7200, 1800] — primer intento a las 2h post-WIN, segundo
    a las 2h30min. Solo 2 intentos on-chain bien temporizados.
  - _check_gamma_resolved(): consulta Gamma API antes de cada intento on-chain.
  - _redimir_once_no_estimate(): workaround con gas fijo (150k), activo solo
    si Gamma confirma resolución pero estimate_gas sigue fallando.
  - Notificaciones enriquecidas con slug, conditionId, stake, tokens.
  - notify_claim_attempt(): nueva, enviada antes de cada TX con diagnóstico Gamma.

v2.1 — SELL FALLBACK + RETRY MEJORADO
  - RETRY_SCHEDULE: primer intento con 3 min de espera.
  - Ventana total ~2h 8 min (8 intentos).
  - sell_fallback_clob(): intenta vender en CLOB al fallar claim on-chain.

v2.0 — RETRY + FALLBACK + NOTIFICACIONES

Destino: bot/modules/claimer.py
"""
import json as _json
import logging
import time

import requests
from web3 import Web3

logger = logging.getLogger(__name__)

# ── Contrato CTF Polymarket (Polygon) ─────────────────────────────────────────
CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
CHAIN_ID     = 137
GAS_MARGIN   = 1.25       # +25% sobre el estimado
GAS_FIXED    = 150_000    # gas fijo para workaround sin estimate_gas
CONFIRM_TIMEOUT = 90      # segundos esperando recibo on-chain

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

# ── Endpoints ─────────────────────────────────────────────────────────────────
CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint"
GAMMA_API     = "https://gamma-api.polymarket.com/markets"

# ── Calendario de reintentos ──────────────────────────────────────────────────
# v3.0: Solo 2 intentos, bien temporizados.
# Los mercados BTC/USD en Polymarket se resuelven on-chain entre 1h y 3h
# después del cierre de la vela. Intentar antes siempre falla (error:
# "result for condition not received yet").
#
# Intento 1 → +2h 00min desde WIN  (7200s)
# Intento 2 → +2h 30min desde WIN  (+1800s)
# ──────────────────────────────────────────────────────────────────────────────
# Si ambos fallan → SELL FALLBACK en CLOB
RETRY_SCHEDULE = [7200, 1800]


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
    clob_raw = market.get("clobTokenIds")
    if clob_raw:
        try:
            clob_ids = _json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
            if isinstance(clob_ids, list) and len(clob_ids) >= 2:
                return clob_ids[0] if direction == "UP" else clob_ids[1]
        except Exception:
            pass

    logger.warning("[CLAIMER] ⚠ No se pudo extraer token_id ganador del mercado")
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


def _check_gamma_resolved(condition_id: str) -> dict:
    """
    v3.0 — Workaround: consulta la Gamma API para verificar si el mercado
    ha sido resuelto antes de intentar el claim on-chain.

    Retorna un dict con:
      resolved    (bool)   — True si el mercado está marcado como resuelto
      closed      (bool)   — True si el mercado está cerrado para trading
      outcome     (str)    — "Yes" / "No" / "" según Gamma
      question    (str)    — título del mercado
      end_date    (str)    — fecha de cierre programada (ISO)
      error       (str)    — razón si la consulta falló
    """
    result = {
        "resolved": False,
        "closed":   False,
        "outcome":  "",
        "question": "—",
        "end_date": "—",
        "error":    "",
    }
    if not condition_id:
        result["error"] = "conditionId vacío"
        return result

    try:
        r = requests.get(
            GAMMA_API,
            params={"conditionId": condition_id},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        if not data or not isinstance(data, list):
            result["error"] = "Gamma API devolvió respuesta vacía o inesperada"
            return result

        mkt = data[0]
        result["resolved"] = bool(mkt.get("resolved") or mkt.get("resolutionSource"))
        result["closed"]   = bool(mkt.get("closed") or mkt.get("active") is False)
        result["outcome"]  = str(mkt.get("outcome", "") or mkt.get("resolution", ""))
        result["question"] = str(mkt.get("question", "—"))[:80]
        result["end_date"] = str(mkt.get("endDate", "—"))

    except Exception as e:
        result["error"] = str(e)
        logger.warning(f"[CLAIMER] ⚠ Error consultando Gamma API: {e}")

    return result


# ── Núcleo: un intento de redención (con estimate_gas) ────────────────────────

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
        f"[CLAIMER] Iniciando redención (estimate_gas)\n"
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

    return _send_redeem_tx(w3, fn, account, private_key, gas)


def _redimir_once_no_estimate(
    condition_id: str,
    direction: str,
    private_key: str,
) -> str:
    """
    v3.0 — Workaround adicional: intenta redeemPositions() con gas_limit FIJO
    (GAS_FIXED = 150 000) sin llamar a estimate_gas.

    Usar SOLO cuando Gamma API confirma que el mercado está resuelto pero
    estimate_gas sigue fallando — puede indicar un delay en el nodo RPC o
    un problema transitorio de la cadena.

    AVISO: si el mercado no está resuelto, esta TX fallará on-chain y consumirá
    gas de todas formas. Por eso solo se activa cuando Gamma confirma resolución.
    """
    index_set = [1] if direction == "UP" else [2]

    logger.info(
        f"[CLAIMER] Iniciando redención SIN estimate_gas (gas fijo={GAS_FIXED})\n"
        f"          Direction    : {direction}  →  index_set={index_set}\n"
        f"          Condition ID : {condition_id}"
    )

    w3      = _connect_polygon()
    account = w3.eth.account.from_key(private_key)

    ctf        = w3.eth.contract(
        address=w3.to_checksum_address(CTF_ADDRESS),
        abi=CTF_ABI,
    )
    cond_bytes = _condition_id_to_bytes(condition_id)
    fn         = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,
        cond_bytes,
        index_set,
    )

    return _send_redeem_tx(w3, fn, account, private_key, GAS_FIXED)


def _send_redeem_tx(w3, fn, account, private_key: str, gas: int) -> str:
    """
    Construye, firma y envía la TX de redeemPositions. Espera recibo.
    Devuelve tx_hash. Lanza RuntimeError si la TX es rechazada on-chain.
    """
    gas_price    = w3.eth.gas_price
    pol_cost_est = w3.from_wei(gas * gas_price, "ether")
    logger.info(
        f"[CLAIMER] Gas: {gas} units  "
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

# v3.1: SELL FALLBACK DESHABILITADO temporalmente.
# Razón: vender a cualquier precio por debajo de ~0.99 implica pérdidas en una
# posición ganadora. El precio correcto es 0.99, pero el CLOB no cotiza el token
# resuelto (devuelve mid=None) — la orden no se llenaría de todas formas.
# Cuando se reactive: usar SELL_FALLBACK_PRICE = 0.99 y verificar que el token
# siga activo en el CLOB antes de enviar la orden.
# Para reactivar: cambiar SELL_FALLBACK_ENABLED = True.
SELL_FALLBACK_ENABLED = False
SELL_FALLBACK_PRICE   = 0.99   # precio límite cuando se reactive


def _sell_fallback_clob(bet: dict, cfg: dict) -> None:
    """
    v3.1: DESHABILITADO. Cuando SELL_FALLBACK_ENABLED=True, vende los tokens
    ganadores en el CLOB a SELL_FALLBACK_PRICE (0.99) para recuperar valor
    sin necesidad de resolución on-chain.

    Precio fijado a 0.99 (no mid - descuento) porque:
    - Los tokens ganadores valen exactamente 1.00 USDC tras resolución.
    - Vender a menos de ~0.99 implica pérdida real en una posición WIN.
    - Si no hay contrapartida al 0.99, la orden queda pendiente hasta que
      alguien compre (o se cancela manualmente).
    """
    from .notifier import notify_sell_fallback_failed

    slug      = bet.get("market", {}).get("slug", "—")
    direction = bet.get("direction", "UP")

    if not SELL_FALLBACK_ENABLED:
        msg = (
            f"SELL FALLBACK deshabilitado (SELL_FALLBACK_ENABLED=False). "
            f"Reclamar manualmente en polymarket.com — mercado: {slug}"
        )
        logger.warning(f"[CLAIMER] ⚠ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)
        return

    # ── Código activo cuando SELL_FALLBACK_ENABLED = True ────────────────────
    from .notifier import notify_sell_fallback_ok

    entry_odds  = bet.get("odds", 0.5)
    stake       = bet.get("stake", 0.0)
    tokens_held = round(stake / max(entry_odds, 0.001), 4)

    token_id = _get_winning_token_id(bet)
    if not token_id:
        msg = "No se pudo extraer token_id del bet — SELL no ejecutado"
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)
        return

    mid = _fetch_clob_midpoint(token_id)
    sell_price = SELL_FALLBACK_PRICE

    logger.info(
        f"[CLAIMER] 💰 SELL FALLBACK\n"
        f"          Token    : {token_id[:16]}...\n"
        f"          Tokens   : {tokens_held}\n"
        f"          Midpoint : {mid!r}  →  Sell @ {sell_price:.4f}\n"
        f"          USDC est.: ~{tokens_held * sell_price:.2f}\n"
        f"          Slug     : {slug}"
    )

    from .strategy import sell_position
    market = bet.get("market", {})
    resp = sell_position(token_id, tokens_held, sell_price, cfg, market)

    if resp:
        usdc_received = round(tokens_held * sell_price, 4)
        logger.info(
            f"[CLAIMER] ✅ SELL ejecutado — ~{usdc_received:.4f} USDC recuperados"
        )
        notify_sell_fallback_ok(cfg, bet, resp, sell_price, usdc_received)
    else:
        msg = f"sell_position() devolvió None (mid={mid!r}, sell_price={sell_price:.4f})"
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

    v3.0:
      - RETRY_SCHEDULE = [7200, 1800] — 2 intentos: a las 2h y a las 2h30min.
      - Antes de cada intento consulta Gamma API (_check_gamma_resolved) para
        diagnosticar si el mercado ya está resuelto on-chain.
      - Si Gamma dice "resuelto" pero estimate_gas falla → activa el workaround
        _redimir_once_no_estimate() con gas fijo (150k).
      - Si ambos intentos (y workarounds) fallan → SELL FALLBACK en CLOB.
      - Todas las notificaciones incluyen: slug, conditionId, stake, tokens.

    Notificaciones Telegram:
      · notify_claim_scheduled   — al lanzar el hilo
      · notify_claim_attempt     — justo antes de cada intento (NEW v3.0)
      · notify_claim_retrying    — antes del 2º intento
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
        notify_claim_attempt,
    )

    market       = bet.get("market", {})
    direction    = bet.get("direction", "UP")
    tokens       = bet.get("tokens", 0.0)
    stake        = bet.get("stake", 0.0)
    slug         = market.get("slug", "—")

    condition_id = (
        market.get("conditionId")
        or market.get("condition_id", "")
    )
    private_key = cfg["polymarket"]["private_key"]

    # Validación temprana
    if not condition_id:
        logger.error(
            "[CLAIMER] ❌ claim_with_retry: conditionId ausente en active_bet — "
            "no se puede reclamar on-chain"
        )
        notify_claim_failed(cfg, bet, "conditionId no disponible en el mercado", attempts=0)
        _sell_fallback_clob(bet, cfg)
        return

    max_attempts = len(RETRY_SCHEDULE)
    last_error   = "desconocido"

    # Notificación inicial
    first_wait = RETRY_SCHEDULE[0]
    notify_claim_scheduled(cfg, bet, first_wait_secs=first_wait, max_attempts=max_attempts)
    logger.info(
        f"[CLAIMER] ⏳ Claim programado — slug={slug}\n"
        f"          conditionId : {condition_id}\n"
        f"          Stake       : ${stake:.2f}  Tokens: {tokens:.4f}\n"
        f"          Primer intento en {first_wait}s ({first_wait // 60}m)"
    )

    for attempt_idx, wait_secs in enumerate(RETRY_SCHEDULE):
        attempt_num = attempt_idx + 1

        # Esperar antes del intento
        if wait_secs > 0:
            logger.info(
                f"[CLAIMER] ⏳ Esperando {wait_secs}s antes del intento "
                f"{attempt_num}/{max_attempts} ..."
            )
            if attempt_num > 1:
                notify_claim_retrying(
                    cfg, bet,
                    attempt=attempt_num,
                    max_attempts=max_attempts,
                    reason=last_error,
                    wait_secs=wait_secs,
                )
            time.sleep(wait_secs)

        logger.info(f"[CLAIMER] 🔄 Intento {attempt_num}/{max_attempts} ...")

        # ── Workaround: consultar Gamma API antes del intento on-chain ──────
        gamma = _check_gamma_resolved(condition_id)
        logger.info(
            f"[CLAIMER] 📡 Gamma status — "
            f"resolved={gamma['resolved']}  closed={gamma['closed']}  "
            f"outcome='{gamma['outcome']}'  error='{gamma['error']}'"
        )

        # Notificar intento con contexto completo
        notify_claim_attempt(
            cfg, bet,
            attempt=attempt_num,
            max_attempts=max_attempts,
            gamma=gamma,
        )

        # ── Intento estándar (con estimate_gas) ─────────────────────────────
        try:
            tx_hash  = _redimir_once(condition_id, direction, private_key)
            usdc_est = round(tokens, 4)
            notify_claim_ok(cfg, bet, tx_hash, attempt=attempt_num, usdc_est=usdc_est)
            logger.info(f"[CLAIMER] ✅ Claim exitoso en intento {attempt_num}")
            return  # éxito

        except Exception as e:
            last_error = str(e)
            logger.warning(
                f"[CLAIMER] ⚠ Intento {attempt_num}/{max_attempts} estándar falló: {last_error}"
            )

        # ── Workaround adicional: si Gamma dice resuelto, intenta sin estimate_gas
        if gamma.get("resolved"):
            logger.info(
                "[CLAIMER] 🔁 Gamma dice RESUELTO — intentando redención "
                "con gas fijo (sin estimate_gas)..."
            )
            try:
                tx_hash  = _redimir_once_no_estimate(condition_id, direction, private_key)
                usdc_est = round(tokens, 4)
                notify_claim_ok(
                    cfg, bet, tx_hash,
                    attempt=attempt_num,
                    usdc_est=usdc_est,
                    extra_note="(workaround: gas fijo sin estimate_gas)",
                )
                logger.info(
                    f"[CLAIMER] ✅ Claim exitoso (workaround gas fijo) "
                    f"en intento {attempt_num}"
                )
                return  # éxito por workaround

            except Exception as e2:
                we_error = str(e2)
                logger.warning(
                    f"[CLAIMER] ⚠ Workaround gas fijo también falló: {we_error}"
                )
                last_error = f"{last_error} | gas_fijo: {we_error}"
        else:
            logger.info(
                "[CLAIMER] ℹ Gamma NO confirma resolución todavía — "
                "workaround gas fijo omitido"
            )

    # ── Se agotaron todos los intentos → intentar SELL FALLBACK ──────────────
    logger.error(
        f"[CLAIMER] ❌ Claim fallido tras {max_attempts} intentos. "
        f"Último error: {last_error}"
    )
    notify_claim_failed(cfg, bet, reason=last_error, attempts=max_attempts)

    logger.info("[CLAIMER] 🔄 Intentando SELL FALLBACK en CLOB...")
    _sell_fallback_clob(bet, cfg)
