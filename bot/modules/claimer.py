"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)

v3.0 — REDISEÑO COMPLETO DEL TIMING + DIAGNÓSTICO MEJORADO
  - RETRY_SCHEDULE: [7200, 3600] — solo 2 intentos:
      · Intento 1: espera 2h tras el cierre del mercado ("dentro de 2 ventanas")
      · Intento 2: +1h adicional si el primero falla
      · Total ventana: ~3h desde el cierre
    Rationale: Polymarket puede tardar 1-2h en resolver on-chain.
    Intentar antes siempre da "result for condition not received yet".

  - _check_condition_resolved(): PRE-CHECK ON-CHAIN antes de estimate_gas.
    Llama payoutDenominator() en el CTF — si devuelve 0, el mercado aún no
    está resuelto y el intento se descarta sin consumir gas ni generar ruido.
    Si devuelve > 0, el mercado está resuelto y procedemos con redeemPositions.

  - NOTIFICACIONES ENRIQUECIDAS: cada mensaje incluye slug del mercado,
    conditionId (primeros 20 chars), dirección, stake, tokens y odds.

  - SELL FALLBACK ROBUSTO:
    · _get_winning_token_id_with_diagnostics(): devuelve (token_id, info_debug)
      con diagnóstico de qué campos se encontraron en el market dict.
    · _fetch_clob_midpoint_with_retry(): 3 reintentos con 10s de espera.
    · Si midpoint < 0.80 o None, la razón exacta se loguea y notifica.
    · URL directa al mercado en Polymarket para reclamo manual.

  - WORKAROUND ADICIONAL en fallback: si sell_position() falla en el precio
    normal, se reintenta con precio más agresivo (mid - 0.015) antes de rendir.

v2.1 — SELL FALLBACK + RETRY MEJORADO (8 intentos, 3min-2h)
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
    },
    {
        # v3.0: Para pre-check de resolución sin gastar gas
        "name": "payoutDenominator",
        "type": "function",
        "inputs": [
            {"name": "conditionId", "type": "bytes32"},
        ],
        "outputs": [
            {"name": "", "type": "uint256"},
        ],
        "stateMutability": "view",
    },
]

# ── RPCs de Polygon (se prueban en orden; el primero que responde se usa) ─────
POLYGON_RPCS = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc-mainnet.matic.quiknode.pro",
]

# ── Endpoints externos ────────────────────────────────────────────────────────
CLOB_MIDPOINT  = "https://clob.polymarket.com/midpoint"
GAMMA_MARKETS  = "https://gamma-api.polymarket.com/markets"

# ── Calendario de reintentos ──────────────────────────────────────────────────
# v3.0: Solo 2 intentos, bien espaciados.
#
# El mercado BTC hourly tarda entre 1-2h en resolverse on-chain.
# Intentar antes de ese punto siempre da "result for condition not received yet".
#
# Intento 1 → 2h (7200s)  — "dentro de 2 ventanas" desde el cierre
# Intento 2 → +1h (3600s) — si el primero falla, última oportunidad on-chain
# ─────────────────────────────────────────────────────────────────────────────
# Si ambos fallan → SELL FALLBACK (2 intentos de precio)
# Si SELL también falla → aviso manual con URL directa al mercado
RETRY_SCHEDULE = [7200, 3600]


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


def _check_condition_resolved(condition_id: str, w3: Web3) -> tuple[bool, int]:
    """
    v3.0: Pre-check on-chain ANTES de llamar estimate_gas.
    Llama payoutDenominator(conditionId) en el CTF.

    Returns:
        (is_resolved: bool, payout_denominator: int)
        - is_resolved=True  → mercado resuelto, proceder con redeemPositions
        - is_resolved=False → mercado aún no resuelto, esperar
    """
    try:
        ctf = w3.eth.contract(
            address=w3.to_checksum_address(CTF_ADDRESS),
            abi=CTF_ABI,
        )
        cond_bytes  = _condition_id_to_bytes(condition_id)
        denom       = ctf.functions.payoutDenominator(cond_bytes).call()
        is_resolved = denom > 0
        logger.info(
            f"[CLAIMER] 🔍 payoutDenominator = {denom} "
            f"→ {'✅ RESUELTO' if is_resolved else '⏳ NO RESUELTO AÚN'}"
        )
        return is_resolved, denom
    except Exception as e:
        logger.warning(
            f"[CLAIMER] ⚠ payoutDenominator check falló: {e} "
            f"— asumiendo no resuelto"
        )
        return False, 0


def _check_gamma_resolution(condition_id: str) -> dict:
    """
    v3.0: Consulta Gamma API para estado de resolución del mercado.
    Útil para enriquecer el error cuando el on-chain pre-check falla.
    """
    try:
        r = requests.get(
            GAMMA_MARKETS,
            params={"condition_id": condition_id},
            timeout=8,
        )
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list) and data:
            m = data[0]
            return {
                "resolved":   m.get("resolved", False),
                "resolution": m.get("resolution", "—"),
                "question":   (m.get("question", "—") or "")[:80],
                "slug":       m.get("slug", "—"),
                "closed":     m.get("closed", False),
            }
        return {"resolved": False, "resolution": "sin datos en Gamma"}
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ Gamma check falló: {e}")
        return {"resolved": False, "resolution": f"error Gamma: {e}"}


def _get_winning_token_id_with_diagnostics(bet: dict) -> tuple[str | None, str]:
    """
    v3.0: Extrae el token_id del lado ganador con diagnóstico completo.
    Returns:
        (token_id: str | None, diagnostics: str)
    """
    market    = bet.get("market", {})
    direction = bet.get("direction", "UP")

    diag = []
    market_keys = list(market.keys()) if market else []
    diag.append(f"market_keys={market_keys}")

    # Intento 1: tokens list con outcome
    tokens_list = market.get("tokens", [])
    diag.append(
        f"tokens_field={'present' if tokens_list else 'ABSENT'} "
        f"(len={len(tokens_list) if isinstance(tokens_list, list) else 'N/A'})"
    )

    if isinstance(tokens_list, list) and tokens_list:
        for t in tokens_list:
            outcome = t.get("outcome", "").lower()
            if direction == "UP" and outcome == "yes":
                tid = t.get("token_id") or t.get("tokenId")
                diag.append(f"✅ via tokens[outcome=yes] → {(tid or 'NONE')[:20]}")
                return tid, " | ".join(diag)
            if direction == "DOWN" and outcome == "no":
                tid = t.get("token_id") or t.get("tokenId")
                diag.append(f"✅ via tokens[outcome=no] → {(tid or 'NONE')[:20]}")
                return tid, " | ".join(diag)
        diag.append(f"tokens present but no matching outcome for {direction}")
    else:
        diag.append("tokens list empty or absent")

    # Intento 2: clobTokenIds (índice 0=YES/UP, 1=NO/DOWN)
    clob_raw = market.get("clobTokenIds")
    diag.append(f"clobTokenIds={'present' if clob_raw else 'ABSENT'}")

    if clob_raw:
        try:
            clob_ids = _json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
            if isinstance(clob_ids, list) and len(clob_ids) >= 2:
                idx = 0 if direction == "UP" else 1
                tid = clob_ids[idx]
                diag.append(f"✅ via clobTokenIds[{idx}] → {str(tid)[:20]}")
                return tid, " | ".join(diag)
            else:
                diag.append(f"clobTokenIds malformed: {clob_ids}")
        except Exception as ex:
            diag.append(f"clobTokenIds parse error: {ex}")
    else:
        diag.append("clobTokenIds not in market dict")

    # Intento 3: token_id directo en bet
    direct = bet.get("token_id") or bet.get("winning_token_id")
    if direct:
        diag.append(f"✅ via bet.token_id → {str(direct)[:20]}")
        return direct, " | ".join(diag)

    diag.append("❌ ALL ATTEMPTS FAILED — no token_id extractable")
    return None, " | ".join(diag)


def _fetch_clob_midpoint_with_retry(token_id: str, max_retries: int = 3) -> float | None:
    """v3.0: Consulta midpoint CLOB con hasta 3 reintentos espaciados 10s."""
    for attempt in range(1, max_retries + 1):
        try:
            r = requests.get(CLOB_MIDPOINT, params={"token_id": token_id}, timeout=8)
            r.raise_for_status()
            mid = r.json().get("mid")
            if mid is not None:
                logger.info(
                    f"[CLAIMER] 📊 Midpoint CLOB (intento {attempt}/{max_retries}): "
                    f"{float(mid):.6f}"
                )
                return float(mid)
            logger.warning(
                f"[CLAIMER] ⚠ midpoint=null en respuesta CLOB (intento {attempt})"
            )
        except Exception as e:
            logger.warning(
                f"[CLAIMER] ⚠ Midpoint CLOB intento {attempt}/{max_retries} falló: {e}"
            )
        if attempt < max_retries:
            time.sleep(10)
    return None


def _get_market_url(bet: dict) -> str:
    """Devuelve URL directa al mercado en Polymarket para acción manual."""
    market = bet.get("market", {})
    slug   = market.get("slug", "")
    if slug:
        return f"https://polymarket.com/event/{slug}"
    return "https://polymarket.com/portfolio"


# ── Núcleo: un intento de redención ──────────────────────────────────────────

def _redimir_once(
    condition_id: str,
    direction: str,
    private_key: str,
    bet: dict | None = None,
) -> str:
    """
    v3.0: Intento único de redeemPositions() con:
      1. Pre-check payoutDenominator — falla rápido + consulta Gamma si no resuelto
      2. Logging detallado con mercado, wallet, gas, RPC usado
      3. Lanza excepción descriptiva si falla

    Devuelve tx_hash (hex string).
    """
    index_set = [1] if direction == "UP" else [2]
    market = bet.get("market", {}) if bet else {}
    slug   = market.get("slug", "—")

    logger.info(
        f"[CLAIMER] ════════════════════════════════════════\n"
        f"          Intento de redención on-chain\n"
        f"          Mercado   : {slug}\n"
        f"          Direction : {direction}  →  index_set={index_set}\n"
        f"          CondID    : {condition_id[:20]}...{condition_id[-8:]}\n"
        f"          ════════════════════════════════════════"
    )

    w3      = _connect_polygon()
    account = w3.eth.account.from_key(private_key)
    logger.info(f"[CLAIMER] Wallet: {account.address}")

    # ── PRE-CHECK: ¿está el mercado resuelto on-chain? ───────────────────────
    is_resolved, payout_denom = _check_condition_resolved(condition_id, w3)
    if not is_resolved:
        gamma = _check_gamma_resolution(condition_id)
        raise RuntimeError(
            f"Mercado NO resuelto on-chain (payoutDenominator=0). "
            f"Gamma → resolved={gamma.get('resolved')}, "
            f"resolution='{gamma.get('resolution')}', "
            f"closed={gamma.get('closed')}"
        )

    logger.info(
        f"[CLAIMER] ✅ Resuelto on-chain (payoutDenominator={payout_denom}). "
        f"Procediendo con redeemPositions..."
    )

    # Balance POL
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

    # estimate_gas (solo falla si ya fue reclamado u otro error real post-resolución)
    try:
        gas_estimate = fn.estimate_gas({"from": account.address})
        gas = int(gas_estimate * GAS_MARGIN)
    except Exception as e:
        raise RuntimeError(
            f"estimate_gas falló TRAS confirmar resolución on-chain. "
            f"Posiblemente ya reclamado anteriormente. Error: {e}"
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
    v3.0: Fallback cuando el claim on-chain falla definitivamente.

    Mejoras vs v2.1:
      - Diagnóstico completo de qué campos tiene market dict (token_id extraction)
      - Retry de midpoint CLOB (3 intentos × 10s)
      - 2 intentos de SELL: precio normal y precio agresivo
      - URL directa al mercado Polymarket en el mensaje de fallo manual
    """
    from .notifier import notify_sell_fallback_ok, notify_sell_fallback_failed

    direction   = bet.get("direction", "UP")
    stake       = bet.get("stake", 0.0)
    entry_odds  = bet.get("odds", 0.5)
    tokens_held = round(stake / max(entry_odds, 0.001), 4)
    market      = bet.get("market", {})
    slug        = market.get("slug", "—")
    market_url  = _get_market_url(bet)

    logger.info(
        f"[CLAIMER] 🔄 SELL FALLBACK iniciado\n"
        f"          Mercado   : {slug}\n"
        f"          URL       : {market_url}\n"
        f"          Dirección : {direction}\n"
        f"          Stake     : {stake} USDC\n"
        f"          Tokens    : {tokens_held}\n"
        f"          Odds ent. : {entry_odds}"
    )

    # ── Extraer token_id con diagnóstico ─────────────────────────────────────
    token_id, token_diag = _get_winning_token_id_with_diagnostics(bet)
    logger.info(f"[CLAIMER] 🔍 Token ID diagnóstico:\n          {token_diag}")

    if not token_id:
        msg = (
            f"No se pudo extraer token_id del mercado.\n"
            f"Diagnóstico: {token_diag[:400]}"
        )
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg, market_url=market_url)
        return

    logger.info(
        f"[CLAIMER] Token ganador: {token_id[:20]}...{token_id[-8:] if len(token_id) > 28 else ''}"
    )

    # ── Midpoint CLOB con retry ───────────────────────────────────────────────
    mid = _fetch_clob_midpoint_with_retry(token_id, max_retries=3)

    if mid is None:
        msg = (
            f"Midpoint CLOB no disponible tras 3 intentos (×10s).\n"
            f"Token: {token_id[:24]}..."
        )
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg, market_url=market_url)
        return

    if mid < 0.80:
        msg = (
            f"Midpoint CLOB demasiado bajo: {mid:.4f} (mínimo 0.80).\n"
            f"El mercado puede no haber resuelto a favor o aún estar en proceso.\n"
            f"Token: {token_id[:24]}..."
        )
        logger.error(f"[CLAIMER] ❌ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg, market_url=market_url)
        return

    # ── Intento 1: precio normal ──────────────────────────────────────────────
    from .strategy import sell_position

    sell_price = max(0.90, round(mid - 0.005, 3))
    logger.info(
        f"[CLAIMER] 💰 SELL FALLBACK — Intento 1 (precio normal)\n"
        f"          Token    : {token_id[:24]}...\n"
        f"          Tokens   : {tokens_held}\n"
        f"          Midpoint : {mid:.6f}  →  Sell @ {sell_price:.4f}\n"
        f"          USDC est.: ~{tokens_held * sell_price:.4f}"
    )

    resp = sell_position(token_id, tokens_held, sell_price, cfg, market)

    if resp:
        usdc_received = round(tokens_held * sell_price, 4)
        logger.info(
            f"[CLAIMER] ✅ SELL ejecutado — ~{usdc_received:.4f} USDC recuperados"
        )
        notify_sell_fallback_ok(cfg, bet, resp, sell_price, usdc_received)
        return

    # ── Intento 2: precio agresivo (workaround adicional) ────────────────────
    logger.warning(
        "[CLAIMER] ⚠ Intento 1 SELL falló — reintentando con precio más agresivo..."
    )
    time.sleep(5)

    sell_price_2 = max(0.85, round(mid - 0.015, 3))
    logger.info(
        f"[CLAIMER] 💰 SELL FALLBACK — Intento 2 (precio agresivo)\n"
        f"          Sell @ {sell_price_2:.4f}  (antes: {sell_price:.4f})\n"
        f"          USDC est.: ~{tokens_held * sell_price_2:.4f}"
    )

    resp2 = sell_position(token_id, tokens_held, sell_price_2, cfg, market)

    if resp2:
        usdc_received = round(tokens_held * sell_price_2, 4)
        logger.info(
            f"[CLAIMER] ✅ SELL exitoso en intento 2 — ~{usdc_received:.4f} USDC"
        )
        notify_sell_fallback_ok(cfg, bet, resp2, sell_price_2, usdc_received)
        return

    # ── Ambos intentos fallaron ───────────────────────────────────────────────
    msg = (
        f"sell_position() devolvió None en 2 intentos.\n"
        f"Precio 1: {sell_price:.4f}  |  Precio 2: {sell_price_2:.4f}\n"
        f"Token: {token_id[:24]}...\n"
        f"Midpoint: {mid:.6f}"
    )
    logger.error(f"[CLAIMER] ❌ {msg}")
    notify_sell_fallback_failed(cfg, bet, msg, market_url=market_url)


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
    v3.0: 2 intentos espaciados 2h + 1h. Luego SELL FALLBACK.
    Diseñado para ejecutarse en un hilo daemon (no bloquea el loop del bot).

    Notificaciones Telegram:
      · notify_claim_scheduled   — al lanzar (primer intento en 2h)
      · notify_claim_retrying    — antes del 2º intento
      · notify_claim_ok          — claim confirmado on-chain
      · notify_claim_failed      — si ambos intentos fallaron
      · notify_sell_fallback_ok  — SELL CLOB exitoso
      · notify_sell_fallback_failed — todo falló + URL manual

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
    odds      = bet.get("odds", 0.5)
    slug      = market.get("slug", "—")

    condition_id = (
        market.get("conditionId")
        or market.get("condition_id", "")
    )
    private_key = cfg["polymarket"]["private_key"]

    logger.info(
        f"[CLAIMER] 🚀 claim_with_retry iniciado\n"
        f"          Mercado   : {slug}\n"
        f"          Dirección : {direction}\n"
        f"          Stake     : {stake} USDC\n"
        f"          Tokens    : {tokens}\n"
        f"          Odds ent. : {odds}\n"
        f"          CondID    : {(condition_id[:20] + '...') if condition_id else 'AUSENTE'}"
    )

    # Validación temprana
    if not condition_id:
        logger.error(
            "[CLAIMER] ❌ conditionId ausente — pasando directamente a SELL FALLBACK"
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
        f"[CLAIMER] ⏳ Primer intento en {first_wait}s "
        f"({first_wait // 3600}h {(first_wait % 3600) // 60}m)"
    )

    for attempt_idx, wait_secs in enumerate(RETRY_SCHEDULE):
        attempt_num = attempt_idx + 1

        if wait_secs > 0:
            logger.info(
                f"[CLAIMER] ⏳ Esperando {wait_secs}s "
                f"({wait_secs // 3600}h {(wait_secs % 3600) // 60}m) "
                f"antes del intento {attempt_num}/{max_attempts}..."
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

        logger.info(
            f"[CLAIMER] 🔄 ══ Intento {attempt_num}/{max_attempts} ══\n"
            f"          Mercado   : {slug}\n"
            f"          Dirección : {direction}\n"
            f"          CondID    : {condition_id[:20]}...\n"
            f"          Stake     : {stake} USDC  |  Tokens: {tokens}  |  Odds: {odds}"
        )

        try:
            tx_hash  = _redimir_once(condition_id, direction, private_key, bet=bet)
            usdc_est = round(tokens, 4)
            notify_claim_ok(cfg, bet, tx_hash, attempt=attempt_num, usdc_est=usdc_est)
            logger.info(f"[CLAIMER] ✅ Claim exitoso en intento {attempt_num}")
            return

        except Exception as e:
            last_error = str(e)
            logger.warning(
                f"[CLAIMER] ⚠ Intento {attempt_num}/{max_attempts} fallido:\n"
                f"          {last_error}"
            )

    # ── Se agotaron los intentos ──────────────────────────────────────────────
    logger.error(
        f"[CLAIMER] ❌ Claim fallido tras {max_attempts} intentos.\n"
        f"          Mercado   : {slug}\n"
        f"          CondID    : {condition_id[:20]}...\n"
        f"          Último err: {last_error}"
    )
    notify_claim_failed(cfg, bet, reason=last_error, attempts=max_attempts)

    logger.info("[CLAIMER] 🔄 Intentando SELL FALLBACK en CLOB...")
    _sell_fallback_clob(bet, cfg)
