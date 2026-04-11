"""
claimer.py — Redención automática via Safe.execTransaction (Polygon)

v4.0 — FIX CRÍTICO: SAFE.EXECTRANSACTION
─────────────────────────────────────────
Los tokens CTF están en el Safe (POLYMARKET_FUNDER), NO en la EOA.
Versiones anteriores llamaban CTF.redeemPositions() directamente desde
la EOA → la TX no tiene los tokens → siempre falla o no hace nada.

Flujo correcto:
  1. Leer nonce del Safe
  2. Codificar callData = CTF.redeemPositions(USDC, 0x0, conditionId, [indexSet])
  3. Computar Safe txHash via Safe.getTransactionHash()
  4. Firmar el hash con la EOA (raw, sin prefijo Ethereum — igual que ethers signingKey.sign)
  5. Ejecutar Safe.execTransaction() enviado por la EOA
  6. Verificar ExecutionSuccess en los logs del receipt
  7. Verificar delta USDC en el Safe como confirmación

Para mercados BTC UP/DOWN (binarios estándar, no NegRisk):
  - parentCollectionId = bytes32(0)
  - indexSets = [1] para UP (YES), [2] para DOWN (NO)
  - Contrato destino: CTF ConditionalTokens

v3.1 — SELL FALLBACK DESHABILITADO
v3.0 — RETRY SCHEDULE + GAMMA CHECK

Destino: bot/modules/claimer.py
"""

import json as _json
import logging
import os
import threading
import time
from typing import Optional

import requests
from eth_keys import keys as _eth_keys
from web3 import Web3

logger = logging.getLogger(__name__)

# ── Contratos Polygon mainnet ─────────────────────────────────────────────────

CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # ConditionalTokens
USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"  # USDC.e (bridged)
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
CHAIN_ID     = 137

GAS_LIMIT       = 400_000   # gas para execTransaction
CONFIRM_TIMEOUT = 90        # segundos esperando recibo on-chain

# Topics del evento Safe (ExecutionSuccess / ExecutionFailure)
EXECUTION_SUCCESS_TOPIC = "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e"
EXECUTION_FAILURE_TOPIC = "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272bbec61743f0301"

SELL_FALLBACK_ENABLED = False
SELL_FALLBACK_PRICE   = 0.99

# ── Retry schedule ────────────────────────────────────────────────────────────
# Mercados BTC/USD en Polymarket se resuelven entre 1h y 3h tras el cierre.
# Intento 1 → +2h 00min desde WIN  (7200s)
# Intento 2 → +2h 30min desde WIN  (+1800s)
RETRY_SCHEDULE = [7200, 1800]

# ── RPCs Polygon con fallback ─────────────────────────────────────────────────
POLYGON_RPCS = [
    os.environ.get("POLYGON_RPC_URL", ""),
    "https://polygon.llamarpc.com",
    "https://polygon.drpc.org",
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
]

# ── API endpoints ─────────────────────────────────────────────────────────────
CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint"
GAMMA_API     = "https://gamma-api.polymarket.com/markets"

# ── ABIs (mínimos necesarios) ─────────────────────────────────────────────────

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
        "name": "balanceOf",
        "type": "function",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "id",      "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]

SAFE_ABI = [
    {
        "name": "nonce",
        "type": "function",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "name": "getTransactionHash",
        "type": "function",
        "inputs": [
            {"name": "to",             "type": "address"},
            {"name": "value",          "type": "uint256"},
            {"name": "data",           "type": "bytes"},
            {"name": "operation",      "type": "uint8"},
            {"name": "safeTxGas",      "type": "uint256"},
            {"name": "baseGas",        "type": "uint256"},
            {"name": "gasPrice",       "type": "uint256"},
            {"name": "gasToken",       "type": "address"},
            {"name": "refundReceiver", "type": "address"},
            {"name": "_nonce",         "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "name": "execTransaction",
        "type": "function",
        "inputs": [
            {"name": "to",             "type": "address"},
            {"name": "value",          "type": "uint256"},
            {"name": "data",           "type": "bytes"},
            {"name": "operation",      "type": "uint8"},
            {"name": "safeTxGas",      "type": "uint256"},
            {"name": "baseGas",        "type": "uint256"},
            {"name": "gasPrice",       "type": "uint256"},
            {"name": "gasToken",       "type": "address"},
            {"name": "refundReceiver", "type": "address"},
            {"name": "signatures",     "type": "bytes"},
        ],
        "outputs": [{"name": "success", "type": "bool"}],
        "stateMutability": "payable",
    },
]

USDC_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    }
]


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS INTERNOS
# ══════════════════════════════════════════════════════════════════════════════

def _connect_polygon() -> Web3:
    """Prueba RPCs en orden, devuelve el primero que conecta."""
    for rpc in POLYGON_RPCS:
        if not rpc:
            continue
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 15}))
            if w3.is_connected():
                logger.info(f"[CLAIMER] ✅ RPC Polygon OK: {rpc}")
                return w3
        except Exception as e:
            logger.warning(f"[CLAIMER] ⚠ RPC {rpc}: {e}")
    raise ConnectionError(f"[CLAIMER] Ningún RPC disponible — define POLYGON_RPC_URL en Railway")


def _to_bytes32(hex_str: str) -> bytes:
    """Convierte conditionId hex (con o sin 0x) a bytes32."""
    return bytes.fromhex(hex_str.removeprefix("0x").zfill(64))


def _sign_safe_hash(private_key_hex: str, hash_bytes: bytes) -> bytes:
    """
    Firma raw hash SIN prefijo Ethereum (requerido por Gnosis Safe).
    Equivalente a ethers.js: wallet.signingKey.sign(txHash)

    Devuelve: r (32 bytes) + s (32 bytes) + v (1 byte, valor 27 o 28).
    """
    pk_bytes = bytes.fromhex(private_key_hex.removeprefix("0x"))
    pk       = _eth_keys.PrivateKey(pk_bytes)
    sig      = pk.sign_msg_hash(hash_bytes)
    v        = sig.v + 27   # eth_keys devuelve 0/1 → Safe necesita 27/28
    return bytes(sig.r) + bytes(sig.s) + bytes([v])


def _condition_id_from_bet(bet: dict) -> str:
    """Extrae conditionId del bet dict (varios formatos posibles)."""
    market = bet.get("market", {})
    return (
        market.get("conditionId")
        or market.get("condition_id")
        or bet.get("condition_id")
        or ""
    )


def _get_winning_token_id(bet: dict) -> Optional[str]:
    """
    Extrae token_id del lado ganador.
    Busca en market["tokens"] primero, luego en clobTokenIds.
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

    clob_raw = market.get("clobTokenIds")
    if clob_raw:
        try:
            clob_ids = _json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
            if isinstance(clob_ids, list) and len(clob_ids) >= 2:
                return clob_ids[0] if direction == "UP" else clob_ids[1]
        except Exception:
            pass

    logger.warning("[CLAIMER] ⚠ No se pudo extraer token_id ganador del bet")
    return None


def _check_gamma_resolved(condition_id: str) -> dict:
    """
    Consulta Gamma API para saber si el mercado está resuelto on-chain.
    Retorna dict con: resolved, closed, outcome, question, end_date, error.
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
        r = requests.get(GAMMA_API, params={"conditionId": condition_id}, timeout=10)
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


# ══════════════════════════════════════════════════════════════════════════════
# CORE: SAFE.EXECTRANSACTION
# ══════════════════════════════════════════════════════════════════════════════

def _execute_via_safe(
    w3:           Web3,
    safe_address: str,
    private_key:  str,
    to:           str,
    call_data:    bytes,
    gas_limit:    int = GAS_LIMIT,
) -> str:
    """
    Ejecuta una llamada desde el Gnosis Safe firmada por la EOA como único owner.

    Equivalente Python del executeViaSafe() del TypeScript de referencia.

    Devuelve tx_hash (hex str). Lanza RuntimeError si la TX falla.
    """
    safe_cs = w3.to_checksum_address(safe_address)
    to_cs   = w3.to_checksum_address(to)
    zero    = w3.to_checksum_address(ZERO_ADDRESS)
    account = w3.eth.account.from_key(private_key)

    safe  = w3.eth.contract(address=safe_cs, abi=SAFE_ABI)
    nonce = safe.functions.nonce().call()

    # ── 1. Computar Safe tx hash ───────────────────────────────────────────────
    safe_tx_hash = safe.functions.getTransactionHash(
        to_cs,      # to
        0,          # value
        call_data,  # data (bytes)
        0,          # operation  (0 = CALL)
        0,          # safeTxGas
        0,          # baseGas
        0,          # gasPrice
        zero,       # gasToken
        zero,       # refundReceiver
        nonce,      # _nonce
    ).call()

    # ── 2. Firmar el hash con la EOA (raw, sin prefijo Ethereum) ──────────────
    signature = _sign_safe_hash(private_key, bytes(safe_tx_hash))

    logger.info(
        f"[CLAIMER] Safe.execTransaction → nonce={nonce} | "
        f"to={to_cs[:14]}… | EOA={account.address[:12]}…"
    )

    # ── 3. Construir y enviar la TX desde la EOA ──────────────────────────────
    gas_price = int(w3.eth.gas_price * 1.2)   # +20% para asegurar inclusión
    eoa_nonce = w3.eth.get_transaction_count(account.address, "pending")

    built_tx = safe.functions.execTransaction(
        to_cs,      # to
        0,          # value
        call_data,  # data
        0,          # operation
        0,          # safeTxGas
        0,          # baseGas
        0,          # gasPrice
        zero,       # gasToken
        zero,       # refundReceiver
        signature,  # signatures
    ).build_transaction({
        "from":     account.address,
        "gas":      gas_limit,
        "gasPrice": gas_price,
        "nonce":    eoa_nonce,
        "chainId":  CHAIN_ID,
    })

    signed      = w3.eth.account.sign_transaction(built_tx, private_key)
    raw_tx      = signed.raw_transaction          # web3.py >= 6
    tx_hash_hex = w3.eth.send_raw_transaction(raw_tx).hex()

    logger.info(f"[CLAIMER] TX enviada: {tx_hash_hex} — esperando recibo…")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash_hex, timeout=CONFIRM_TIMEOUT)

    # ── 4. Verificar status y logs del Safe ───────────────────────────────────
    if receipt.status == 0:
        raise RuntimeError(f"[CLAIMER] TX revertida on-chain: {tx_hash_hex}")

    for log in receipt.logs:
        if not log.topics:
            continue
        topic = log.topics[0].hex()
        if topic == EXECUTION_SUCCESS_TOPIC:
            logger.info(f"[CLAIMER] ✅ ExecutionSuccess confirmado: {tx_hash_hex}")
            return tx_hash_hex
        if topic == EXECUTION_FAILURE_TOPIC:
            raise RuntimeError(f"[CLAIMER] Safe ExecutionFailure — tx: {tx_hash_hex}")

    # Sin topic explícito pero status=1 → asumimos OK
    logger.warning(
        f"[CLAIMER] ExecutionSuccess topic no encontrado (status=1) — "
        f"asumiendo OK: {tx_hash_hex}"
    )
    return tx_hash_hex


# ══════════════════════════════════════════════════════════════════════════════
# CORE: INTENTO DE REDENCIÓN
# ══════════════════════════════════════════════════════════════════════════════

def _redimir_once(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str,
    token_id:     Optional[str] = None,
) -> str:
    """
    Intento único de CTF.redeemPositions() via Safe.execTransaction.

    v4.0: ejecuta DESDE el Safe (donde están los tokens), no desde la EOA.

    Parámetros:
      condition_id  — hex str con o sin 0x
      direction     — "UP" | "DOWN"
      private_key   — EOA private key (owner del Safe)
      safe_address  — Gnosis Safe address (donde están los tokens CTF)
      token_id      — str numérico para verificar balance previo (opcional)

    Devuelve tx_hash (hex str). Lanza excepción si falla.
    """
    w3       = _connect_polygon()
    safe_cs  = w3.to_checksum_address(safe_address)
    ctf_cs   = w3.to_checksum_address(CTF_ADDRESS)
    usdc_cs  = w3.to_checksum_address(USDC_ADDRESS)

    cond_bytes  = _to_bytes32(condition_id)
    parent_zero = bytes(32)                          # 0x00…00 para mercados binarios
    index_sets  = [1] if direction == "UP" else [2]  # 1=YES/UP, 2=NO/DOWN

    # ── 1. Verificar balance de tokens YES/NO en el Safe ──────────────────────
    ctf  = w3.eth.contract(address=ctf_cs, abi=CTF_ABI)
    usdc = w3.eth.contract(address=usdc_cs, abi=USDC_ABI)

    if token_id:
        try:
            balance = ctf.functions.balanceOf(safe_cs, int(token_id)).call()
            if balance == 0:
                logger.warning(
                    f"[CLAIMER] ⚠ Balance tokens en Safe = 0 "
                    f"(token={token_id[:16]}…) — ¿ya redimido?"
                )
                raise RuntimeError("balance_zero_safe: tokens no encontrados en Safe")
            logger.info(
                f"[CLAIMER] 💰 Balance tokens en Safe: "
                f"{balance / 1_000_000:.4f} (token={token_id[:16]}…)"
            )
        except RuntimeError:
            raise
        except Exception as e:
            logger.warning(f"[CLAIMER] ⚠ No se pudo leer balance CTF: {e}")

    # ── 2. USDC en Safe antes de la TX ────────────────────────────────────────
    usdc_before = 0
    try:
        usdc_before = usdc.functions.balanceOf(safe_cs).call()
    except Exception:
        pass

    # ── 3. Codificar callData para CTF.redeemPositions ────────────────────────
    call_data_hex   = ctf.encodeABI(
        fn_name="redeemPositions",
        args=[usdc_cs, parent_zero, cond_bytes, index_sets],
    )
    call_data_bytes = bytes.fromhex(call_data_hex.removeprefix("0x"))

    logger.info(
        f"[CLAIMER] Redimiendo — direction={direction} | "
        f"indexSets={index_sets} | conditionId={condition_id[:16]}…"
    )

    # ── 4. Ejecutar via Safe ───────────────────────────────────────────────────
    tx_hash = _execute_via_safe(
        w3=w3,
        safe_address=safe_address,
        private_key=private_key,
        to=CTF_ADDRESS,
        call_data=call_data_bytes,
    )

    # ── 5. Verificar delta USDC en el Safe ────────────────────────────────────
    try:
        time.sleep(3)
        usdc_after = usdc.functions.balanceOf(safe_cs).call()
        delta = (usdc_after - usdc_before) / 1_000_000
        if delta > 0:
            logger.info(
                f"[CLAIMER] 💵 USDC recibidos en Safe: +{delta:.4f} "
                f"(total: {usdc_after / 1_000_000:.4f})"
            )
        else:
            logger.warning(
                f"[CLAIMER] ⚠ Delta USDC = 0 tras ExecutionSuccess — "
                f"¿UMA aún no reportó? tx={tx_hash}"
            )
    except Exception:
        pass

    return tx_hash


def _redimir_once_no_estimate(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str,
) -> str:
    """
    Workaround: igual que _redimir_once() pero sin verificar balance previo.
    Usar cuando Gamma confirma resolución pero el check de balance falla.

    AVISO: si el mercado no está resuelto, la TX fallará en el Safe
    (ExecutionFailure) — usar SOLO cuando Gamma lo confirma.
    """
    return _redimir_once(
        condition_id=condition_id,
        direction=direction,
        private_key=private_key,
        safe_address=safe_address,
        token_id=None,   # omitir verificación de balance
    )


# ══════════════════════════════════════════════════════════════════════════════
# API PÚBLICA: RETRY CON NOTIFICACIONES (llamado desde monitor.py)
# ══════════════════════════════════════════════════════════════════════════════

def claim_with_retry(bet: dict, cfg: dict) -> None:
    """
    Reintenta el claim siguiendo RETRY_SCHEDULE.
    Diseñado para ejecutarse en un hilo daemon (no bloquea el loop del bot).

    v4.0: usa Safe.execTransaction, lee safe_address de cfg["polymarket"]["funder"].
    """
    from .notifier import (
        notify_claim_attempt,
        notify_claim_ok,
        notify_claim_retrying,
    )

    condition_id = _condition_id_from_bet(bet)
    direction    = bet.get("direction", "UP")
    slug         = bet.get("market", {}).get("slug", "—")
    stake        = float(bet.get("stake", 0.0))
    tokens       = float(bet.get("tokens_comprados", bet.get("tokens", 0.0)))
    token_id     = _get_winning_token_id(bet)

    private_key  = cfg.get("polymarket", {}).get("private_key", "").strip()
    safe_address = cfg.get("polymarket", {}).get("funder", "").strip()

    # ── Validar credenciales ───────────────────────────────────────────────────
    if not condition_id:
        logger.error("[CLAIMER] ❌ conditionId no encontrado en bet — claim abortado")
        return
    if not private_key:
        logger.error("[CLAIMER] ❌ private_key no configurada — claim abortado")
        return
    if not safe_address:
        # Fallback a env var
        safe_address = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not safe_address:
        logger.error("[CLAIMER] ❌ funder (Safe address) no configurado — claim abortado")
        return

    max_attempts = len(RETRY_SCHEDULE)
    last_error   = ""

    logger.info(
        f"[CLAIMER] ⏳ Claim programado — slug={slug}\n"
        f"          conditionId : {condition_id}\n"
        f"          Direction   : {direction}  |  "
        f"token_id: {(token_id or '—')[:20]}…\n"
        f"          Stake       : ${stake:.2f}  Tokens: {tokens:.4f}\n"
        f"          Safe        : {safe_address[:12]}…\n"
        f"          Primer intento en {RETRY_SCHEDULE[0]}s "
        f"({RETRY_SCHEDULE[0] // 60}m)"
    )

    for attempt_idx, wait_secs in enumerate(RETRY_SCHEDULE):
        attempt_num = attempt_idx + 1

        # ── Esperar antes del intento ─────────────────────────────────────────
        if wait_secs > 0:
            logger.info(
                f"[CLAIMER] ⏳ Esperando {wait_secs}s antes del intento "
                f"{attempt_num}/{max_attempts}…"
            )
            if attempt_num > 1:
                try:
                    notify_claim_retrying(
                        cfg, bet,
                        attempt=attempt_num,
                        max_attempts=max_attempts,
                        reason=last_error,
                        wait_secs=wait_secs,
                    )
                except Exception:
                    pass
            time.sleep(wait_secs)

        logger.info(f"[CLAIMER] 🔄 Intento {attempt_num}/{max_attempts}…")

        # ── Gamma check antes del intento on-chain ────────────────────────────
        gamma = _check_gamma_resolved(condition_id)
        logger.info(
            f"[CLAIMER] 📡 Gamma — resolved={gamma['resolved']}  "
            f"closed={gamma['closed']}  outcome='{gamma['outcome']}'  "
            f"error='{gamma['error']}'"
        )

        try:
            notify_claim_attempt(
                cfg, bet,
                attempt=attempt_num,
                max_attempts=max_attempts,
                gamma=gamma,
            )
        except Exception:
            pass

        # ── Intento estándar (con balance check) ──────────────────────────────
        try:
            tx_hash = _redimir_once(
                condition_id=condition_id,
                direction=direction,
                private_key=private_key,
                safe_address=safe_address,
                token_id=token_id,
            )
            usdc_est = round(tokens, 4)
            try:
                notify_claim_ok(cfg, bet, tx_hash, attempt=attempt_num)
            except Exception:
                pass
            logger.info(
                f"[CLAIMER] ✅ Claim exitoso — tx={tx_hash}  ~${usdc_est:.2f} USDC"
            )
            return

        except Exception as e:
            last_error = str(e)[:300]
            logger.warning(
                f"[CLAIMER] ⚠ Intento {attempt_num} falló: {last_error}"
            )

            # Workaround en el último intento si Gamma confirma resolución
            gamma_ok = gamma["resolved"] or (gamma["closed"] and gamma["outcome"])
            if gamma_ok and attempt_num == max_attempts:
                logger.info(
                    "[CLAIMER] 🔧 Gamma confirma resolución — "
                    "reintentando sin balance check (gas fijo)…"
                )
                try:
                    tx_hash = _redimir_once_no_estimate(
                        condition_id=condition_id,
                        direction=direction,
                        private_key=private_key,
                        safe_address=safe_address,
                    )
                    try:
                        notify_claim_ok(cfg, bet, tx_hash, attempt=attempt_num)
                    except Exception:
                        pass
                    logger.info(
                        f"[CLAIMER] ✅ Claim workaround exitoso — tx={tx_hash}"
                    )
                    return
                except Exception as e2:
                    last_error = str(e2)[:300]
                    logger.error(
                        f"[CLAIMER] ❌ Workaround también falló: {last_error}"
                    )

    # ── Todos los intentos fallaron ────────────────────────────────────────────
    logger.error(
        f"[CLAIMER] ❌ Todos los intentos agotados — slug={slug}\n"
        f"          Último error: {last_error}\n"
        f"          Reclamar manualmente en polymarket.com"
    )
    _sell_fallback(bet, cfg)


def _sell_fallback(bet: dict, cfg: dict) -> None:
    """Fallback cuando el claim on-chain falla. Actualmente deshabilitado."""
    try:
        from .notifier import notify_sell_fallback_failed
        msg = (
            f"SELL FALLBACK deshabilitado. "
            f"Reclamar manualmente — "
            f"mercado: {bet.get('market', {}).get('slug', '—')}"
        )
        logger.warning(f"[CLAIMER] ⚠ {msg}")
        notify_sell_fallback_failed(cfg, bet, msg)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════════════
# API PÚBLICA: wrappers para command_handler (importación externa)
# ══════════════════════════════════════════════════════════════════════════════

def execute_claim_once(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str = "",
    token_id:     Optional[str] = None,
) -> str:
    """
    Wrapper público de _redimir_once().
    Usar desde command_handler.py — intento único con balance check.
    Devuelve tx_hash o lanza excepción.
    """
    if not safe_address:
        safe_address = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not safe_address:
        raise ValueError("safe_address (POLYMARKET_FUNDER) no configurado")
    return _redimir_once(condition_id, direction, private_key, safe_address, token_id)


def execute_claim_no_estimate(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str = "",
) -> str:
    """
    Wrapper público de _redimir_once_no_estimate().
    Usar desde command_handler.py cuando Gamma confirma resolución
    pero balance check falla. Devuelve tx_hash o lanza excepción.
    """
    if not safe_address:
        safe_address = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not safe_address:
        raise ValueError("safe_address (POLYMARKET_FUNDER) no configurado")
    return _redimir_once_no_estimate(condition_id, direction, private_key, safe_address)


# ══════════════════════════════════════════════════════════════════════════════
# API PÚBLICA: interfaz con monitor.py
# ══════════════════════════════════════════════════════════════════════════════

def redimir_posicion(cfg: dict, bet: dict) -> None:
    """
    Punto de entrada desde monitor.py al detectar WIN.

    Lanza claim_with_retry() en un hilo daemon para no bloquear el loop.
    El hilo espera RETRY_SCHEDULE[0] segundos antes del primer intento.

    Llamada en monitor.py:
        redimir_posicion(cfg, active_bet)
    """
    t = threading.Thread(
        target=claim_with_retry,
        args=(bet, cfg),
        daemon=True,
        name="claimer-retry",
    )
    t.start()
    logger.info(
        f"[CLAIMER] 🚀 Hilo de claim lanzado (daemon) — "
        f"primer intento en {RETRY_SCHEDULE[0] // 60}m. "
        f"El loop del bot continúa normalmente."
    )
