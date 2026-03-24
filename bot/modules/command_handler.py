"""
command_handler.py — v1.6  (importaciones relativas — bot/modules/)

Cambios v1.6:
  - _handle_manual_claim(): nuevo handler para el comando manual_claim.
    Ejecuta _redimir_once() directamente (un intento, sin retry schedule).
    Params esperados: { condition_id, direction, market_slug, tokens, stake, op_id }
    Returns: { success, tx_hash, usdc_est, note } | { error, gamma_resolved }
    Si estimate_gas falla Y Gamma API confirma resolución → reintenta con
    _redimir_once_no_estimate() (gas fijo 150k) como workaround.
  - "manual_claim" añadido al dispatcher de process_pending_commands.

Cambios v1.5:
  - FIX CRÍTICO: eliminado w3.is_connected() en _handle_check_balance.
    Bloqueaba el hilo del bot — el comando quedaba en status="running" siempre.

Cambios v1.4:
  - REVERT PERF: eliminado ThreadPoolExecutor (cuelgue en Railway).
    Serial con timeout 3s y short-circuit al primer éxito.

Cambios v1.3:
  - FIX: nombres "usdc"/"pol" (ModeSelector.jsx los lee así).

Cambios v1.2:
  - FIX: market.get("tokens") en lugar de "clobTokenIds".

Cambios v1.1:
  - FIX: get_active_market sin cfg, get_clob_price importable.
"""

import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# RPCs públicos de Polygon
_POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://rpc-mainnet.matic.network",
]
_RPC_TIMEOUT = 4


# ── Helpers Supabase ──────────────────────────────────────────────────────────

def _claim_command(client, cmd_id: int) -> bool:
    try:
        res = client.table("bot_commands") \
            .update({"status": "running", "updated_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("id", cmd_id).eq("status", "pending").execute()
        return bool(res.data)
    except Exception as e:
        logger.warning(f"[CMD] ⚠ claim_command [{cmd_id}]: {e}")
        return False


def _finish_command(client, cmd_id: int, success: bool, result: dict):
    try:
        client.table("bot_commands").update({
            "status":     "done" if success else "error",
            "result":     {**result, "success": success},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", cmd_id).execute()
    except Exception as e:
        logger.warning(f"[CMD] ⚠ finish_command [{cmd_id}]: {e}")


# ── check_clob ────────────────────────────────────────────────────────────────

def _handle_check_clob(cfg: dict) -> tuple[bool, dict]:
    try:
        from .market_scanner import get_active_market, get_clob_price

        t0     = time.time()
        market = get_active_market()
        if not market:
            return False, {"error": "No se encontró mercado BTC activo en Gamma API"}

        market_slug  = market.get("slug", "—")
        tokens_list  = market.get("tokens", [])
        yes_token    = next((t for t in tokens_list if t.get("outcome") == "Yes"), None)
        no_token     = next((t for t in tokens_list if t.get("outcome") == "No"),  None)
        yes_token_id = yes_token.get("token_id") if yes_token else None
        no_token_id  = no_token.get("token_id")  if no_token  else None

        if not yes_token_id:
            return False, {"error": "Mercado sin token YES", "market_slug": market_slug}

        yes_price = get_clob_price(yes_token_id)
        no_price  = get_clob_price(no_token_id) if no_token_id else None

        return True, {
            "latency_ms":   round((time.time() - t0) * 1000),
            "market_slug":  market_slug,
            "yes_token_id": yes_token_id,
            "yes_price":    yes_price,
            "no_price":     no_price,
        }
    except Exception as e:
        logger.error(f"[CMD] check_clob error: {e}", exc_info=True)
        return False, {"error": str(e)}


# ── check_balance ─────────────────────────────────────────────────────────────

def _handle_check_balance(cfg: dict) -> tuple[bool, dict]:
    """
    v1.5: sin w3.is_connected() para evitar cuelgue.
    Devuelve "usdc"/"pol" (nombres que lee ModeSelector.jsx).
    """
    import requests as _req
    from web3 import Web3

    USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
    USDC_ABI     = [{"name": "balanceOf", "type": "function",
                     "inputs": [{"name": "account", "type": "address"}],
                     "outputs": [{"name": "", "type": "uint256"}],
                     "stateMutability": "view"}]

    private_key = cfg.get("polymarket", {}).get("private_key", "")
    if not private_key:
        return False, {"error": "private_key no configurada"}

    rpc_attempts = []
    last_error   = "todos los RPCs fallaron"
    t0           = time.time()

    for rpc in _POLYGON_RPCS:
        try:
            w3      = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": _RPC_TIMEOUT}))
            account = w3.eth.account.from_key(private_key)
            address = account.address

            usdc_contract = w3.eth.contract(
                address=w3.to_checksum_address(USDC_POLYGON),
                abi=USDC_ABI,
            )
            usdc_raw = usdc_contract.functions.balanceOf(address).call()
            pol_raw  = w3.eth.get_balance(address)

            usdc_balance = usdc_raw / 1e6
            pol_balance  = float(w3.from_wei(pol_raw, "ether"))
            latency_ms   = round((time.time() - t0) * 1000)

            rpc_attempts.append({"rpc": rpc, "ok": True})
            return True, {
                "usdc":          usdc_balance,
                "pol":           pol_balance,
                "wallet":        address,
                "rpc_used":      rpc,
                "rpc_latency_ms": latency_ms,
                "rpc_attempts":  rpc_attempts,
            }
        except Exception as e:
            rpc_attempts.append({"rpc": rpc, "ok": False, "error": str(e)[:80]})
            last_error = str(e)
            continue

    return False, {"error": last_error, "rpc_attempts": rpc_attempts}


# ── test_order ────────────────────────────────────────────────────────────────

def _handle_test_order(cfg: dict, params: dict) -> tuple[bool, dict]:
    try:
        from .market_scanner import get_active_market, get_clob_price
        from .strategy import execute_order, Signal, Direction

        direction_str = params.get("direction", "UP")
        stake         = params.get("stake", 1.0)

        if direction_str not in ("UP", "DOWN"):
            return False, {"error": "direction debe ser UP o DOWN"}
        if stake < 0.5 or stake > 10:
            return False, {"error": "stake fuera de rango (0.50 – 10.00 USDC)"}

        test_cfg = {**cfg, "strategy": {**cfg.get("strategy", {}), "simulate_mode": False}}
        market   = get_active_market()
        if not market:
            return False, {"error": "No se encontró mercado BTC activo"}

        tokens_list  = market.get("tokens", [])
        target_out   = "Yes" if direction_str == "UP" else "No"
        token        = next((t for t in tokens_list if t.get("outcome") == target_out), None)
        if not token:
            return False, {"error": f"Mercado sin token {target_out}"}
        token_id = token.get("token_id")

        entry_odds = get_clob_price(token_id)
        if not entry_odds or entry_odds <= 0:
            return False, {"error": f"No se pudo obtener precio CLOB para token {token_id[:10]}…"}

        direction     = Direction.UP if direction_str == "UP" else Direction.DOWN
        signal        = Signal(direction=direction, distance=9999, target=0, price=0, umbral=0, window="TEST")
        result_order  = execute_order(signal, market, test_cfg)

        if result_order is None:
            return False, {"error": "execute_order devolvió None — revisar credenciales Level 2"}

        return True, {
            "order_id":  result_order.get("orderID") or result_order.get("id") or "—",
            "status":    result_order.get("status", "—"),
            "direction": direction_str,
            "stake":     stake,
            "odds":      result_order.get("odds"),
        }
    except Exception as e:
        logger.error(f"[CMD] test_order error: {e}", exc_info=True)
        return False, {"error": str(e)}


# ── manual_claim ──────────────────────────────────────────────────────────────

def _handle_manual_claim(cfg: dict, params: dict) -> tuple[bool, dict]:
    """
    v1.6: Ejecuta un claim on-chain en un único intento, lanzado desde el dashboard.

    Params (desde POST /api/claim):
      condition_id  (str)   — conditionId del mercado (hex, con o sin 0x)
      direction     (str)   — "UP" | "DOWN"
      market_slug   (str)   — slug del mercado (para diagnóstico)
      tokens        (float) — tokens comprados (para calcular USDC esperado)
      stake         (float) — stake en USDC
      op_id         (str)   — id de la operación en Supabase (informativo)

    Flujo:
      1. Intenta execute_claim_once() (con estimate_gas).
      2. Si falla Y Gamma confirma resolución (resolved=True O closed+outcome) →
         intenta execute_claim_no_estimate() (gas fijo 150k) como workaround.
      3. Devuelve {tx_hash, usdc_est, note} o {error, gamma_resolved}.
    """
    from .claimer import execute_claim_once, execute_claim_no_estimate, _check_gamma_resolved

    condition_id = params.get("condition_id", "")
    direction    = params.get("direction", "UP")
    market_slug  = params.get("market_slug", "—")
    tokens       = float(params.get("tokens") or 0)
    stake        = float(params.get("stake")  or 0)
    op_id        = params.get("op_id", "—")

    if not condition_id:
        return False, {"error": "condition_id requerido pero no proporcionado"}
    if direction not in ("UP", "DOWN"):
        return False, {"error": f"direction inválida: {direction!r}"}

    private_key = cfg.get("polymarket", {}).get("private_key", "")
    if not private_key:
        return False, {"error": "private_key no configurada en el bot"}

    usdc_est = round(tokens, 4)  # tokens ganadores valen 1 USDC c/u

    logger.info(
        f"[CMD] 🔄 manual_claim — slug={market_slug}  dir={direction}  "
        f"op={op_id}  condId={condition_id[:14]}…"
    )

    # ── Intento 1: con estimate_gas ──────────────────────────────────────────
    try:
        tx_hash = execute_claim_once(condition_id, direction, private_key)
        logger.info(f"[CMD] ✅ manual_claim OK (estimate_gas) — tx={tx_hash[:16]}…")
        return True, {
            "tx_hash":  tx_hash,
            "usdc_est": usdc_est,
            "note":     "Claim ejecutado correctamente",
        }
    except Exception as e1:
        err_std = str(e1)
        logger.warning(f"[CMD] ⚠ manual_claim intento estándar falló: {err_std}")

    # ── Workaround: consultar Gamma antes del segundo intento ────────────────
    gamma = {}
    try:
        gamma = _check_gamma_resolved(condition_id)
        logger.info(
            f"[CMD] 📡 Gamma — resolved={gamma.get('resolved')}  "
            f"closed={gamma.get('closed')}  outcome={gamma.get('outcome')!r}  "
            f"err={gamma.get('error')!r}"
        )
    except Exception as eg:
        logger.warning(f"[CMD] ⚠ _check_gamma_resolved falló: {eg}")

    gamma_resolved = gamma.get("resolved", False)
    gamma_closed   = gamma.get("closed", False)
    gamma_outcome  = gamma.get("outcome", "") or ""

    # Considerar reclamable si: resolved=True  O  (closed=True + outcome conocido)
    # Gamma a veces tarda en marcar resolved aunque el mercado ya esté cerrado
    effectively_resolved = gamma_resolved or (gamma_closed and bool(gamma_outcome.strip()))

    # ── Intento 2: gas fijo ──────────────────────────────────────────────────
    if effectively_resolved:
        note_why = "resuelto según Gamma" if gamma_resolved else f"cerrado + outcome='{gamma_outcome}'"
        logger.info(
            f"[CMD] 🔁 Gamma confirma ({note_why}) — "
            "intentando redención con gas fijo (sin estimate_gas)…"
        )
        try:
            tx_hash = execute_claim_no_estimate(condition_id, direction, private_key)
            logger.info(f"[CMD] ✅ manual_claim OK (gas fijo) — tx={tx_hash[:16]}…")
            return True, {
                "tx_hash":  tx_hash,
                "usdc_est": usdc_est,
                "note":     f"Claim ejecutado — workaround gas fijo ({note_why})",
            }
        except Exception as e2:
            err_fixed = str(e2)
            logger.warning(f"[CMD] ⚠ manual_claim gas fijo también falló: {err_fixed}")
            return False, {
                "error":          f"Ambos intentos fallaron. std: {err_std[:120]} | gas_fijo: {err_fixed[:120]}",
                "gamma_resolved": gamma_resolved,
                "gamma_closed":   gamma_closed,
                "gamma_outcome":  gamma_outcome,
            }
    else:
        logger.info(
            f"[CMD] ℹ Gamma no confirma resolución "
            f"(resolved={gamma_resolved}, closed={gamma_closed}, outcome={gamma_outcome!r}) "
            "— workaround gas fijo omitido"
        )
        return False, {
            "error":          f"estimate_gas falló y Gamma no confirma resolución: {err_std[:200]}",
            "gamma_resolved": gamma_resolved,
            "gamma_closed":   gamma_closed,
            "gamma_outcome":  gamma_outcome,
            "gamma_error":    gamma.get("error"),
        }


# ── Dispatcher principal ──────────────────────────────────────────────────────

def process_pending_commands(cfg: dict):
    """
    Consulta bot_commands por comandos pending y ejecuta el más antiguo.
    Llamar periódicamente desde el loop principal de monitor.py.
    Es seguro llamar cada ciclo — solo procesa un comando por llamada.
    """
    try:
        from . import db
        if not db.is_enabled():
            return

        client = db._client

        res = client.table("bot_commands") \
            .select("id, command, params") \
            .eq("status", "pending") \
            .order("created_at", desc=False) \
            .limit(1) \
            .execute()

        if not res.data:
            return

        row     = res.data[0]
        cmd_id  = row["id"]
        command = row["command"]
        params  = row.get("params") or {}

        logger.info(f"[CMD] 📩 Procesando comando #{cmd_id}: {command}  params={params}")

        if not _claim_command(client, cmd_id):
            return  # otro proceso ya lo tomó

        try:
            if command == "check_clob":
                success, result = _handle_check_clob(cfg)
            elif command == "check_balance":
                success, result = _handle_check_balance(cfg)
            elif command == "test_order":
                success, result = _handle_test_order(cfg, params)
            elif command == "manual_claim":
                success, result = _handle_manual_claim(cfg, params)
            else:
                success, result = False, {"error": f"Comando desconocido: {command}"}
        except Exception as e:
            success, result = False, {"error": f"Excepción interna: {e}"}

        _finish_command(client, cmd_id, success, result)

        icon = "✅" if success else "❌"
        logger.info(f"[CMD] {icon} Comando #{cmd_id} {command} → {'OK' if success else 'ERROR'}: {result}")

    except Exception as e:
        logger.warning(f"[CMD] ⚠ process_pending_commands: {e}")
