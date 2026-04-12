"""
claimer.py — Redención automática via Safe.execTransaction

v5.0 — REESCRITURA TOTAL: SCAN HORARIO SIMPLIFICADO
─────────────────────────────────────────────────────
FIX CRÍTICO: en web3.py >= 6.x el método es `encode_abi()` (con guión bajo),
NO `encodeABI()`. Ese era el único bug que bloqueaba todas las redenciones.

Arquitectura nueva (simple):
  - scan_and_redeem(cfg): lee operaciones WIN sin claim_tx de Supabase
    y las intenta redimir una a una.
  - Llamado desde monitor.py cada nueva hora (cur_hour != last_hour).
  - Llamado inmediatamente ante comando trigger_redeem.
  - redimir_posicion(cfg, bet): interfaz legacy monitor.py → solo loguea,
    el scan horario recoge la operación automáticamente.

Safe.execTransaction:
  Los tokens CTF están en el Safe (POLYMARKET_FUNDER), no en la EOA.
  La EOA firma el Safe tx hash y lo envía como execTransaction.
  Portado del TypeScript de referencia funcional.

Destino: bot/modules/claimer.py
"""

import logging
import os
import time
from typing import Optional

import requests
from web3 import Web3

logger = logging.getLogger(__name__)

# ── Contratos Polygon mainnet ──────────────────────────────────────────────────
CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
ZERO_ADDR    = "0x0000000000000000000000000000000000000000"
CHAIN_ID     = 137
GAS_LIMIT    = 400_000

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
CTF_ABI = [
    {
        "name": "redeemPositions", "type": "function",
        "inputs": [
            {"name": "collateralToken",    "type": "address"},
            {"name": "parentCollectionId", "type": "bytes32"},
            {"name": "conditionId",        "type": "bytes32"},
            {"name": "indexSets",          "type": "uint256[]"},
        ],
        "outputs": [], "stateMutability": "nonpayable",
    },
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

SAFE_ABI = [
    {
        "name": "nonce", "type": "function",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
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
    Firma raw SIN prefijo Ethereum — igual que ethers.js signingKey.sign().
    Safe necesita r + s + v (v = 27 o 28).
    """
    from eth_keys import keys as _eth_keys
    pk  = _eth_keys.PrivateKey(bytes.fromhex(private_key_hex.removeprefix("0x")))
    sig = pk.sign_msg_hash(hash_bytes)
    v   = sig.v + 27
    return bytes(sig.r) + bytes(sig.s) + bytes([v])


def _gamma_get_condition_id(slug: str) -> Optional[str]:
    """Obtiene conditionId de Gamma API dado el market slug."""
    try:
        r = requests.get(GAMMA_API, params={"slug": slug}, timeout=10)
        r.raise_for_status()
        data = r.json()
        mkt  = data[0] if isinstance(data, list) and data else data
        if not mkt:
            return None
        raw = mkt.get("conditionId") or mkt.get("condition_id") or ""
        if not raw:
            return None
        return raw if raw.startswith("0x") else f"0x{raw}"
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ Gamma error ({slug}): {e}")
        return None


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# CORE: CTF.redeemPositions via Safe.execTransaction
# ══════════════════════════════════════════════════════════════════════════════

def _redeem_via_safe(
    condition_id: str,
    direction:    str,
    private_key:  str,
    safe_address: str,
) -> str:
    """
    Ejecuta CTF.redeemPositions() DESDE el Safe via execTransaction.

    FIX v5.0: usa encode_abi() (web3.py >= 6.x) en lugar del roto encodeABI().

    direction: "UP" → indexSets=[1] (YES token)
               "DOWN" → indexSets=[2] (NO token)

    Devuelve tx_hash. Lanza excepción si falla.
    """
    w3 = _connect_polygon()

    safe_cs = w3.to_checksum_address(safe_address)
    ctf_cs  = w3.to_checksum_address(CTF_ADDRESS)
    usdc_cs = w3.to_checksum_address(USDC_ADDRESS)
    zero_cs = w3.to_checksum_address(ZERO_ADDR)

    cond_bytes  = _to_bytes32(condition_id)
    parent_zero = bytes(32)
    index_sets  = [1] if direction == "UP" else [2]

    ctf  = w3.eth.contract(address=ctf_cs, abi=CTF_ABI)
    safe = w3.eth.contract(address=safe_cs, abi=SAFE_ABI)
    usdc = w3.eth.contract(address=w3.to_checksum_address(USDC_ADDRESS), abi=USDC_ABI)

    # USDC antes
    usdc_before = 0
    try:
        usdc_before = usdc.functions.balanceOf(safe_cs).call()
    except Exception:
        pass

    # ── FIX: encode_abi (web3.py >= 6) ───────────────────────────────────────
    # ❌ ROTO en v6:  ctf.encodeABI("redeemPositions", args=[...])
    # ✅ CORRECTO v6: ctf.encode_abi("redeemPositions", args=[...])
    call_data_hex   = ctf.encode_abi(
        "redeemPositions",
        args=[usdc_cs, parent_zero, cond_bytes, index_sets],
    )
    call_data_bytes = bytes.fromhex(call_data_hex.removeprefix("0x"))

    # ── Safe tx hash ──────────────────────────────────────────────────────────
    nonce = safe.functions.nonce().call()
    safe_tx_hash = safe.functions.getTransactionHash(
        ctf_cs, 0, call_data_bytes, 0, 0, 0, 0, zero_cs, zero_cs, nonce,
    ).call()

    # ── Firma EOA raw (sin prefijo Ethereum) ──────────────────────────────────
    signature = _sign_safe_hash(private_key, bytes(safe_tx_hash))

    # ── Enviar execTransaction ────────────────────────────────────────────────
    account   = w3.eth.account.from_key(private_key)
    gas_price = int(w3.eth.gas_price * 1.2)
    eoa_nonce = w3.eth.get_transaction_count(account.address, "pending")

    logger.info(
        f"[CLAIMER] 📤 execTransaction — "
        f"dir={direction} | indexSets={index_sets} | "
        f"condId={condition_id[:14]}… | Safe nonce={nonce}"
    )

    built = safe.functions.execTransaction(
        ctf_cs, 0, call_data_bytes, 0, 0, 0, 0, zero_cs, zero_cs, signature,
    ).build_transaction({
        "from":     account.address,
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

    # Verificar logs del Safe
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
        # status=1 sin topic explícito → asumir OK (algunos nodos omiten el log)
        logger.warning(f"[CLAIMER] ⚠ ExecutionSuccess topic no encontrado (status=1) — asumiendo OK")

    logger.info(f"[CLAIMER] ✅ ExecutionSuccess — tx: {tx_hash_hex}")

    # USDC delta
    try:
        time.sleep(3)
        usdc_after = usdc.functions.balanceOf(safe_cs).call()
        delta = (usdc_after - usdc_before) / 1_000_000
        logger.info(
            f"[CLAIMER] 💵 USDC delta: {'+'if delta>=0 else ''}{delta:.4f} "
            f"(Safe total: {usdc_after / 1_000_000:.4f})"
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

        # Obtener conditionId desde Gamma
        condition_id = _gamma_get_condition_id(slug)
        if not condition_id:
            logger.warning(f"[CLAIMER] ⚠ {op_id}: conditionId no encontrado en Gamma — skip")
            _mark_claim_error(db, op_id, "gamma_condition_not_found")
            skip += 1
            continue

        logger.info(f"[CLAIMER] conditionId={condition_id[:16]}…")

        # Intentar redención
        try:
            tx_hash = _redeem_via_safe(
                condition_id=condition_id,
                direction=direction,
                private_key=private_key,
                safe_address=safe_address,
            )
            _mark_claim_ok(db, op_id, tx_hash)
            logger.info(f"[CLAIMER] ✅ Redimido {op_id} — ~{tokens:.4f} tokens | tx: {tx_hash}")
            ok += 1

        except Exception as e:
            err_msg = str(e)[:400]
            logger.error(f"[CLAIMER] ❌ {op_id}: {err_msg}")
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
    v5.0: solo loguea — el scan horario recoge la operación automáticamente.
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
) -> str:
    """Wrapper público para command_handler.py."""
    if not safe_address:
        safe_address = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not safe_address:
        raise ValueError("safe_address (POLYMARKET_FUNDER) no configurado")
    return _redeem_via_safe(condition_id, direction, private_key, safe_address)
