"""
claimer.py — Redención automática via Safe.execTransaction

v6.0 — NEGSRISK ADAPTER (FIX CRÍTICO)
─────────────────────────────────────────────────────────────────────────────
CAMBIO CRÍTICO:
  ❌ CTF.redeemPositions(USDC, parentCollectionId, conditionId, indexSets)
     NO funciona para mercados NegRisk BTC (firma interna incorrecta para CTF
     NegRisk, produce revert silencioso o ExecutionFailure en el Safe).

  ✅ NegRiskAdapter.redeemPositions(conditionId, [yesBalance, noBalance])
     CORRECTO para NegRisk. Solo necesita el conditionId del mercado y el
     balance real de tokens on-chain en el Safe.

TAMBIÉN:
  - _gamma_get_market_info() prueba ?closed=true y ?active=false como
    fallback para mercados ya resueltos que no devuelve el query por defecto.
  - Extrae token_id (YES/NO) de clobTokenIds[0/1] desde Gamma.
  - CTF.balanceOf(safeAddress, token_id) → balance real on-chain.
  - execute_claim_once / execute_claim_no_estimate: aceptan market_slug
    opcional para auto-lookup del token_id desde Gamma.

Destino: bot/modules/claimer.py
"""

import json
import logging
import os
import time
from typing import Optional

import requests
from web3 import Web3

logger = logging.getLogger(__name__)

# ── Contratos Polygon mainnet ──────────────────────────────────────────────────
CTF_ADDRESS      = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # ConditionalTokens CTF
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"  # NegRisk Adapter
USDC_ADDRESS     = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"  # USDC.e
ZERO_ADDR        = "0x0000000000000000000000000000000000000000"
CHAIN_ID         = 137
GAS_LIMIT        = 400_000

EXECUTION_SUCCESS_TOPIC = "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e"
EXECUTION_FAILURE_TOPIC = "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272bbec61743f0301"

GAMMA_API = "https://gamma-api.polymarket.com/markets"

# ── RPCs Polygon ───────────────────────────────────────────────────────────────
POLYGON_RPCS = [
    os.environ.get("POLYGON_RPC_URL", ""),
    "https://polygon.llamarpc.com",
    "https://polygon.drpc.org",
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
]

# ── ABIs mínimos ───────────────────────────────────────────────────────────────

# CTF: solo balanceOf — para leer balance de tokens YES/NO en el Safe
CTF_ABI = [
    {
        "name": "balanceOf", "type": "function",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "id",      "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]

# NegRiskAdapter.redeemPositions(bytes32 conditionId, uint256[] amounts)
# amounts = [yesTokenBalance, noTokenBalance]
NEG_RISK_ADAPTER_ABI = [
    {
        "name": "redeemPositions", "type": "function",
        "inputs": [
            {"name": "conditionId", "type": "bytes32"},
            {"name": "amounts",     "type": "uint256[]"},
        ],
        "outputs": [], "stateMutability": "nonpayable",
    },
]

SAFE_ABI = [
    {
        "name": "nonce", "type": "function",
        "inputs": [], "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "name": "getTransactionHash", "type": "function",
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
        "name": "execTransaction", "type": "function",
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
        "name": "balanceOf", "type": "function",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    }
]


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _connect_polygon() -> Web3:
    for rpc in POLYGON_RPCS:
        if not rpc:
            continue
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 15}))
            if w3.is_connected():
                logger.info(f"[CLAIMER] ✅ RPC OK: {rpc}")
                return w3
        except Exception as e:
            logger.debug(f"[CLAIMER] RPC fail {rpc}: {e}")
    raise ConnectionError("[CLAIMER] Ningún RPC disponible")


def _to_bytes32(hex_str: str) -> bytes:
    return bytes.fromhex(hex_str.removeprefix("0x").zfill(64))


def _sign_safe_hash(private_key_hex: str, hash_bytes: bytes) -> bytes:
    """
    Firma raw SIN prefijo Ethereum — idéntico a ethers.js signingKey.sign().
    Safe necesita r + s + v (v = 27 o 28), cada uno como bytes fijos.

    FIX CRÍTICO: sig.r y sig.s son enteros Python, NO bytes.
      ❌ bytes(sig.r)              → crea sig.r bytes cero (INCORRECTO)
      ✅ sig._signature_bytes[0:32] → 32 bytes raw de r directamente (CORRECTO)

    Equivalente TS exacto:
      const sigObj = wallet.signingKey.sign(txHash)
      ethers.concat([sigObj.r, sigObj.s, ethers.toBeHex(sigObj.v, 1)])
    """
    from eth_keys import keys as _eth_keys
    pk  = _eth_keys.PrivateKey(bytes.fromhex(private_key_hex.removeprefix("0x")))
    sig = pk.sign_msg_hash(hash_bytes)
    v   = sig.v + 27
    # sig._signature_bytes es 64 bytes: r[0:32] + s[32:64]
    return sig._signature_bytes[0:32] + sig._signature_bytes[32:64] + bytes([v])


def _parse_market_info(mkt: dict) -> dict:
    """Extrae conditionId y token IDs de un objeto market de Gamma."""
    raw_cond = mkt.get("conditionId") or mkt.get("condition_id") or ""
    if raw_cond and not raw_cond.startswith("0x"):
        raw_cond = f"0x{raw_cond}"

    # clobTokenIds: puede ser string JSON o lista
    try:
        raw_ids  = mkt.get("clobTokenIds") or "[]"
        clob_ids = raw_ids if isinstance(raw_ids, list) else json.loads(raw_ids)
    except Exception:
        clob_ids = []

    yes_token_id = str(clob_ids[0]) if len(clob_ids) > 0 else ""
    no_token_id  = str(clob_ids[1]) if len(clob_ids) > 1 else ""

    # Fallback: buscar en tokens[]
    if not yes_token_id or not no_token_id:
        for tok in (mkt.get("tokens") or []):
            out = (tok.get("outcome") or "").lower()
            tid = str(tok.get("token_id") or tok.get("tokenId") or "")
            if out in ("yes", "up")  and not yes_token_id:
                yes_token_id = tid
            if out in ("no", "down") and not no_token_id:
                no_token_id  = tid

    return {
        "condition_id":  raw_cond or None,
        "yes_token_id":  yes_token_id or None,
        "no_token_id":   no_token_id  or None,
    }


def _gamma_get_market_info(slug: str) -> dict:
    """
    Obtiene conditionId + token IDs de Gamma API dado el market slug.

    Prueba 3 queries en orden hasta encontrar conditionId:
      1. ?slug={slug}              (mercados activos)
      2. ?slug={slug}&closed=true  (mercados resueltos — FIX para claims históricos)
      3. ?slug={slug}&active=false (alias alternativo)

    Devuelve: {"condition_id": str|None, "yes_token_id": str|None, "no_token_id": str|None}
    """
    queries = [
        {"slug": slug},
        {"slug": slug, "closed": "true"},
        {"slug": slug, "active": "false"},
    ]
    for params in queries:
        try:
            r = requests.get(GAMMA_API, params=params, timeout=10)
            r.raise_for_status()
            data = r.json()
            mkt  = data[0] if isinstance(data, list) and data else (data or None)
            if not mkt:
                continue
            info = _parse_market_info(mkt)
            if info["condition_id"]:
                logger.debug(
                    f"[CLAIMER] Gamma OK (params={params}) — "
                    f"condId={info['condition_id'][:16]}… "
                    f"yes={str(info['yes_token_id'] or '')[:20]}… "
                    f"no={str(info['no_token_id'] or '')[:20]}…"
                )
                return info
        except Exception as e:
            logger.warning(f"[CLAIMER] ⚠ Gamma error (params={params}): {e}")

    logger.warning(f"[CLAIMER] ⚠ Gamma: no se encontró conditionId para slug={slug}")
    return {"condition_id": None, "yes_token_id": None, "no_token_id": None}


# Legacy wrapper — usado por _check_gamma_resolved y command_handler
def _gamma_get_condition_id(slug: str) -> Optional[str]:
    return _gamma_get_market_info(slug)["condition_id"]


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# CORE: NegRiskAdapter.redeemPositions via Safe.execTransaction
# ══════════════════════════════════════════════════════════════════════════════

def _redeem_via_safe(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str,
    token_id:     str = "",
) -> str:
    """
    v6.1: NegRiskAdapter.redeemPositions() — dos modos según dónde estén los tokens.

    Flujo:
      1. Verificar balance en Safe (POLYMARKET_FUNDER).
      2. Si balance=0, verificar balance en EOA (derivada de private_key).
      3a. Tokens en Safe → NegRiskAdapter vía Safe.execTransaction.
      3b. Tokens en EOA  → NegRiskAdapter llamada directa desde EOA (más simple).

    direction: "UP"   → redime tokens YES → amounts = [balance, 0]
               "DOWN" → redime tokens NO  → amounts = [0, balance]
    """
    w3 = _connect_polygon()

    account = w3.eth.account.from_key(private_key)
    eoa_cs  = account.address

    safe_cs = w3.to_checksum_address(safe_address)
    ctf_cs  = w3.to_checksum_address(CTF_ADDRESS)
    nra_cs  = w3.to_checksum_address(NEG_RISK_ADAPTER)
    usdc_cs = w3.to_checksum_address(USDC_ADDRESS)
    zero_cs = w3.to_checksum_address(ZERO_ADDR)

    cond_bytes = _to_bytes32(condition_id)

    ctf  = w3.eth.contract(address=ctf_cs,  abi=CTF_ABI)
    nra  = w3.eth.contract(address=nra_cs,  abi=NEG_RISK_ADAPTER_ABI)
    safe = w3.eth.contract(address=safe_cs, abi=SAFE_ABI)
    usdc = w3.eth.contract(address=usdc_cs, abi=USDC_ABI)

    # ── Validar token_id ───────────────────────────────────────────────────────
    if not token_id or not str(token_id).strip().lstrip("-").isdigit():
        raise ValueError(
            f"[CLAIMER] token_id inválido o ausente: {token_id!r} — "
            "requerido para NegRiskAdapter.redeemPositions"
        )
    token_id_int = int(token_id)

    # ── Buscar balance: Safe primero, luego EOA ────────────────────────────────
    balance_safe = 0
    balance_eoa  = 0
    try:
        balance_safe = ctf.functions.balanceOf(safe_cs, token_id_int).call()
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ balanceOf(Safe) error: {e}")
    try:
        balance_eoa = ctf.functions.balanceOf(eoa_cs, token_id_int).call()
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ balanceOf(EOA) error: {e}")

    logger.info(
        f"[CLAIMER] 💰 Balance on-chain — "
        f"token_id={str(token_id)[:22]}… dir={direction} | "
        f"Safe={balance_safe / 1_000_000:.6f} | EOA={balance_eoa / 1_000_000:.6f}"
    )

    if balance_safe == 0 and balance_eoa == 0:
        raise ValueError(
            f"[CLAIMER] Balance = 0 en Safe {safe_address[:12]}… Y EOA {eoa_cs[:12]}… — "
            "¿ya redimido? ¿token_id incorrecto?"
        )

    # Elegir wallet con balance y construir amounts
    use_safe      = balance_safe > 0
    token_balance = balance_safe if use_safe else balance_eoa
    holder_cs     = safe_cs if use_safe else eoa_cs
    amounts       = [token_balance, 0] if direction == "UP" else [0, token_balance]

    logger.info(
        f"[CLAIMER] 📍 Tokens en {'Safe' if use_safe else 'EOA'} ({holder_cs[:12]}…) | "
        f"balance={token_balance / 1_000_000:.6f} | amounts={amounts}"
    )

    # ── USDC antes ─────────────────────────────────────────────────────────────
    usdc_before = 0
    try:
        usdc_before = usdc.functions.balanceOf(holder_cs).call()
    except Exception:
        pass

    # ── Codificar NegRiskAdapter.redeemPositions ───────────────────────────────
    call_data_hex   = nra.encode_abi("redeemPositions", args=[cond_bytes, amounts])
    call_data_bytes = bytes.fromhex(call_data_hex.removeprefix("0x"))

    gas_price = int(w3.eth.gas_price * 1.2)
    eoa_nonce = w3.eth.get_transaction_count(eoa_cs, "pending")

    logger.info(
        f"[CLAIMER] 📤 NegRiskAdapter.redeemPositions — "
        f"via={'Safe.execTx' if use_safe else 'EOA directo'} | "
        f"condId={condition_id[:16]}… | gasPrice={gas_price // 10**9:.1f} gwei"
    )

    if use_safe:
        # ── Ruta A: tokens en Safe → Safe.execTransaction ──────────────────────
        nonce = safe.functions.nonce().call()
        safe_tx_hash = safe.functions.getTransactionHash(
            nra_cs, 0, call_data_bytes, 0, 0, 0, 0, zero_cs, zero_cs, nonce,
        ).call()
        signature = _sign_safe_hash(private_key, bytes(safe_tx_hash))

        logger.info(f"[CLAIMER] 🔏 Safe nonce={nonce} | EOA nonce={eoa_nonce}")

        built = safe.functions.execTransaction(
            nra_cs, 0, call_data_bytes, 0, 0, 0, 0, zero_cs, zero_cs, signature,
        ).build_transaction({
            "from":     eoa_cs,
            "gas":      GAS_LIMIT,
            "gasPrice": gas_price,
            "nonce":    eoa_nonce,
            "chainId":  CHAIN_ID,
        })
        signed      = w3.eth.account.sign_transaction(built, private_key)
        tx_hash_hex = w3.eth.send_raw_transaction(signed.raw_transaction).hex()

    else:
        # ── Ruta B: tokens en EOA → llamada directa a NegRiskAdapter ──────────
        logger.info(f"[CLAIMER] 🔏 EOA nonce={eoa_nonce}")

        built = nra.functions.redeemPositions(
            cond_bytes, amounts,
        ).build_transaction({
            "from":     eoa_cs,
            "gas":      GAS_LIMIT,
            "gasPrice": gas_price,
            "nonce":    eoa_nonce,
            "chainId":  CHAIN_ID,
        })
        signed      = w3.eth.account.sign_transaction(built, private_key)
        tx_hash_hex = w3.eth.send_raw_transaction(signed.raw_transaction).hex()

    logger.info(f"[CLAIMER] ⏳ TX enviada: {tx_hash_hex} — esperando recibo…")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash_hex, timeout=90)

    if receipt.status == 0:
        raise RuntimeError(f"TX revertida on-chain: {tx_hash_hex}")

    # ── Verificar logs del Safe (solo ruta A) ──────────────────────────────────
    if use_safe:
        success_confirmed = False
        for log in receipt.logs:
            if not log.topics:
                continue
            topic = log.topics[0].hex()
            if topic == EXECUTION_SUCCESS_TOPIC:
                success_confirmed = True
                break
            if topic == EXECUTION_FAILURE_TOPIC:
                raise RuntimeError(f"Safe ExecutionFailure — tx: {tx_hash_hex}")
        if not success_confirmed:
            logger.warning(
                f"[CLAIMER] ⚠ ExecutionSuccess topic no encontrado (status=1) — asumiendo OK"
            )

    logger.info(f"[CLAIMER] ✅ TX confirmada — tx: {tx_hash_hex}")

    # ── USDC delta ─────────────────────────────────────────────────────────────
    try:
        time.sleep(3)
        usdc_after = usdc.functions.balanceOf(holder_cs).call()
        delta = (usdc_after - usdc_before) / 1_000_000
        logger.info(
            f"[CLAIMER] 💵 USDC delta: {'+'if delta>=0 else ''}{delta:.4f} "
            f"(wallet total: {usdc_after / 1_000_000:.4f})"
        )
    except Exception:
        pass

    return tx_hash_hex


# ══════════════════════════════════════════════════════════════════════════════
# SCAN HORARIO — escanea Supabase y redime todo lo pendiente
# ══════════════════════════════════════════════════════════════════════════════

def scan_and_redeem(cfg: dict) -> dict:
    """
    Lee operaciones WIN sin claim_tx de Supabase y las redime.

    Llamar desde:
      - monitor.py al cambio de hora (cur_hour != last_hour)
      - command_handler al recibir comando 'trigger_redeem'

    Devuelve: {"ok": N, "skip": N, "error": N}
    """
    from . import db

    private_key  = (cfg.get("polymarket", {}).get("private_key", "")
                    or os.environ.get("POLYMARKET_PRIVATE_KEY", "")).strip()
    safe_address = (cfg.get("polymarket", {}).get("funder", "")
                    or os.environ.get("POLYMARKET_FUNDER", "")).strip()

    if not private_key or not safe_address:
        logger.error("[CLAIMER] ❌ private_key o funder no configurados — scan abortado")
        return {"ok": 0, "skip": 0, "error": 0}

    if not db.is_enabled():
        logger.warning("[CLAIMER] ⚠ Supabase no disponible — scan abortado")
        return {"ok": 0, "skip": 0, "error": 0}

    logger.info("[CLAIMER] 🔍 Escaneando operaciones WIN pendientes de redención…")

    try:
        res = db._client.table("operations") \
            .select("id, market_slug, direccion, tokens_comprados, stake_usd") \
            .eq("resultado", "WIN") \
            .eq("simulado", False) \
            .is_("claim_tx", "null") \
            .order("ts_entrada", desc=False) \
            .limit(20) \
            .execute()
        ops = res.data or []
    except Exception as e:
        logger.error(f"[CLAIMER] ❌ Error consultando Supabase: {e}", exc_info=True)
        return {"ok": 0, "skip": 0, "error": 0}

    if not ops:
        logger.info("[CLAIMER] ✅ Sin operaciones WIN pendientes — todo al día")
        return {"ok": 0, "skip": 0, "error": 0}

    logger.info(f"[CLAIMER] 📋 {len(ops)} operación(es) pendiente(s)")

    ok = skip = errors = 0

    for op in ops:
        op_id     = op["id"]
        slug      = op.get("market_slug", "")
        direction = op.get("direccion", "UP")
        tokens    = op.get("tokens_comprados", 0)

        logger.info(f"[CLAIMER] ── {op_id} | slug={slug} | dir={direction}")

        if not slug:
            logger.warning(f"[CLAIMER] ⚠ {op_id}: market_slug vacío — skip")
            _mark_claim_error(db, op_id, "no_slug")
            skip += 1
            continue

        # Obtener conditionId + token IDs desde Gamma (con fallback closed=true)
        market_info  = _gamma_get_market_info(slug)
        condition_id = market_info["condition_id"]

        if not condition_id:
            logger.warning(f"[CLAIMER] ⚠ {op_id}: conditionId no encontrado en Gamma — skip")
            _mark_claim_error(db, op_id, "gamma_condition_not_found")
            skip += 1
            continue

        # Token ganador: UP → YES (índice 0), DOWN → NO (índice 1)
        token_id = (
            market_info["yes_token_id"] if direction == "UP"
            else market_info["no_token_id"]
        )

        if not token_id:
            logger.warning(f"[CLAIMER] ⚠ {op_id}: token_id no encontrado en Gamma — skip")
            _mark_claim_error(db, op_id, "gamma_token_id_not_found")
            skip += 1
            continue

        logger.info(
            f"[CLAIMER] conditionId={condition_id[:16]}… | "
            f"token_id={str(token_id)[:22]}… | dir={direction}"
        )

        # Intentar redención
        try:
            tx_hash = _redeem_via_safe(
                condition_id=condition_id,
                direction=direction,
                private_key=private_key,
                safe_address=safe_address,
                token_id=token_id,
            )
            _mark_claim_ok(db, op_id, tx_hash)
            logger.info(
                f"[CLAIMER] ✅ Redimido {op_id} — ~{tokens:.4f} tokens | tx: {tx_hash}"
            )
            ok += 1

        except Exception as e:
            err_msg = str(e)[:400]
            logger.error(f"[CLAIMER] ❌ {op_id}: {err_msg}", exc_info=True)
            _mark_claim_error(db, op_id, err_msg)
            errors += 1

    logger.info(
        f"[CLAIMER] 🏁 Scan completo — "
        f"✅ {ok} redimidos | ⏭ {skip} skip | ❌ {errors} errores"
    )
    return {"ok": ok, "skip": skip, "error": errors}


def _mark_claim_ok(db, op_id: str, tx_hash: str):
    try:
        db._client.table("operations").update({
            "claim_tx":    tx_hash,
            "claim_error": None,
            "updated_at":  _now_iso(),
        }).eq("id", op_id).execute()
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo guardar claim_tx: {e}")


def _mark_claim_error(db, op_id: str, error: str):
    try:
        db._client.table("operations").update({
            "claim_error": error[:500],
            "updated_at":  _now_iso(),
        }).eq("id", op_id).execute()
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo guardar claim_error: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# API PÚBLICA (interfaz con monitor.py y command_handler.py)
# ══════════════════════════════════════════════════════════════════════════════

def redimir_posicion(cfg: dict, bet: dict) -> None:
    """
    Llamado desde monitor.py al detectar WIN.
    v5.0+: solo loguea — el scan horario recoge la operación automáticamente.
    """
    slug = bet.get("market", {}).get("slug") or bet.get("market_slug", "—")
    logger.info(
        f"[CLAIMER] 📌 WIN registrado ({slug}) — "
        f"será redimido en el próximo scan horario."
    )


def execute_claim_once(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str = "",
    market_slug:  str = "",
    token_id:     str = "",
) -> str:
    """
    Wrapper público para command_handler.py (manual_claim desde dashboard).

    Si token_id no se proporciona, lo obtiene de Gamma via market_slug.
    Si market_slug tampoco se proporciona, lanza ValueError.
    """
    if not safe_address:
        safe_address = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not safe_address:
        raise ValueError("safe_address (POLYMARKET_FUNDER) no configurado")

    # Auto-lookup token_id desde Gamma si no se pasa directamente
    if not token_id and market_slug:
        info = _gamma_get_market_info(market_slug)
        token_id = (
            info["yes_token_id"] if direction == "UP"
            else info["no_token_id"]
        ) or ""
        if not token_id:
            raise ValueError(
                f"No se pudo obtener token_id de Gamma para slug={market_slug} dir={direction}"
            )

    if not token_id:
        raise ValueError(
            "token_id requerido — pasa market_slug para auto-lookup o token_id directamente"
        )

    return _redeem_via_safe(
        condition_id=condition_id,
        direction=direction,
        private_key=private_key,
        safe_address=safe_address,
        token_id=token_id,
    )


def execute_claim_no_estimate(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str = "",
    market_slug:  str = "",
    token_id:     str = "",
) -> str:
    """
    Workaround sin estimate_gas — en NegRiskAdapter el gas fijo siempre aplica.
    Misma implementación que execute_claim_once.
    """
    return execute_claim_once(
        condition_id=condition_id,
        direction=direction,
        private_key=private_key,
        safe_address=safe_address,
        market_slug=market_slug,
        token_id=token_id,
    )


def _check_gamma_resolved(condition_id: str) -> dict:
    """Comprueba si un mercado está resuelto en Gamma por conditionId."""
    try:
        r = requests.get(
            GAMMA_API,
            params={"conditionId": condition_id},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        mkt  = data[0] if isinstance(data, list) and data else (data or {})
        if not mkt:
            return {"resolved": False, "closed": False, "outcome": None, "error": "no_market"}
        return {
            "resolved": bool(mkt.get("resolved")),
            "closed":   bool(mkt.get("closed") or mkt.get("active") is False),
            "outcome":  mkt.get("outcome") or mkt.get("resolution") or None,
            "error":    None,
        }
    except Exception as e:
        return {
            "resolved": False,
            "closed":   False,
            "outcome":  None,
            "error":    str(e)[:100],
        }
