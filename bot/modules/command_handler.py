"""
command_handler.py — v1.4  (importaciones relativas — bot/modules/)

Cambios v1.4:
  - REVERT PERF: eliminado ThreadPoolExecutor (causaba cuelgue del módulo en Railway).
    Vuelto a serial, pero con timeout reducido a 3s y short-circuit al primer éxito.
    En la práctica el primer RPC bueno responde en <1s.
  - Se mantiene "rpc_attempts" para diagnóstico en el UI.
  - Se mantiene el fix de nombres "usdc"/"pol" de v1.3.

Cambios v1.3:
  - FIX CRÍTICO: _handle_check_balance devolvía "usdc_balance"/"pol_balance"
    pero ModeSelector.jsx lee "usdc"/"pol" → saldo siempre aparecía como $0.00.

Cambios v1.2:
  - FIX CRÍTICO: _handle_check_clob y _handle_test_order leían market.get("clobTokenIds")
    que NO existe en el dict devuelto por get_active_market(). El scanner devuelve un dict
    procesado con clave "tokens" (lista de {"outcome","token_id","price",...}).

Cambios v1.1:
  - FIX: get_active_btc_market → get_active_market
  - FIX: get_active_market ya no recibe cfg como argumento
  - FIX: get_clob_price ahora importable
  - FIX: _handle_check_balance intenta múltiples RPCs de Polygon
"""

import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# RPCs públicos de Polygon — se prueban en serie hasta el primero que responda.
# Poner primero los que históricamente responden más rápido desde Railway.
_POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://rpc-mainnet.matic.network",
]

_RPC_TIMEOUT = 3  # segundos por intento


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


# ── Handlers de comandos ──────────────────────────────────────────────────────

def _handle_check_clob(cfg: dict) -> tuple[bool, dict]:
    """
    Verifica conexión CLOB:
    1. Obtiene mercado activo via Gamma API
    2. Lee precio CLOB via midpoint endpoint
    """
    try:
        from modules.market_scanner import get_active_market, get_clob_price

        t0 = time.time()

        market = get_active_market()
        if not market:
            return False, {"error": "No se encontró mercado BTC activo en Gamma API"}

        market_slug = market.get("slug", "—")

        tokens_list  = market.get("tokens", [])
        yes_token    = next((t for t in tokens_list if t.get("outcome") == "Yes"), None)
        no_token     = next((t for t in tokens_list if t.get("outcome") == "No"),  None)
        yes_token_id = yes_token.get("token_id") if yes_token else None
        no_token_id  = no_token.get("token_id")  if no_token  else None

        if not yes_token_id:
            return False, {"error": "Mercado sin token YES", "market_slug": market_slug}

        yes_price = get_clob_price(yes_token_id)
        no_price  = get_clob_price(no_token_id) if no_token_id else None

        latency_ms = round((time.time() - t0) * 1000)

        return True, {
            "latency_ms":   latency_ms,
            "market_slug":  market_slug,
            "yes_token_id": yes_token_id,
            "yes_price":    yes_price,
            "no_price":     no_price,
        }

    except Exception as e:
        logger.error(f"[CMD] check_clob error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_check_balance(cfg: dict) -> tuple[bool, dict]:
    """
    Consulta saldo USDC (ERC-20 en Polygon) y POL (gas).

    v1.4: serial con timeout=3s y short-circuit al primer éxito.
          Devuelve "usdc"/"pol" (nombres que lee ModeSelector.jsx).
          Incluye "rpc_attempts" con diagnóstico de todos los intentos.
    """
    try:
        from web3 import Web3

        funder_addr = cfg.get("polymarket", {}).get("funder", "")
        if not funder_addr:
            return False, {"error": "polymarket.funder no configurado"}

        USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        ERC20_ABI = [{
            "constant": True,
            "inputs":   [{"name": "_owner", "type": "address"}],
            "name":     "balanceOf",
            "outputs":  [{"name": "balance", "type": "uint256"}],
            "type":     "function",
        }]

        cfg_rpc  = cfg.get("polymarket", {}).get("rpc_url", "")
        rpc_list = ([cfg_rpc] + _POLYGON_RPCS) if cfg_rpc else list(_POLYGON_RPCS)

        addr_cs  = Web3.to_checksum_address(funder_addr)
        attempts = []

        for rpc_url in rpc_list:
            t0 = time.time()
            try:
                w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": _RPC_TIMEOUT}))

                if not w3.is_connected():
                    elapsed = round((time.time() - t0) * 1000)
                    attempts.append({"rpc": rpc_url, "ok": False,
                                     "latency_ms": elapsed, "error": "is_connected=False"})
                    logger.warning(f"[CMD] ⚠ RPC no conectado: {rpc_url} ({elapsed}ms)")
                    continue

                usdc     = w3.eth.contract(address=Web3.to_checksum_address(USDC_POLYGON), abi=ERC20_ABI)
                raw_usdc = usdc.functions.balanceOf(addr_cs).call()
                raw_pol  = w3.eth.get_balance(addr_cs)
                elapsed  = round((time.time() - t0) * 1000)

                attempts.append({"rpc": rpc_url, "ok": True, "latency_ms": elapsed})
                logger.info(f"[CMD] ✅ Balance obtenido via {rpc_url} ({elapsed}ms)")

                usdc_val = round(raw_usdc / 1_000_000, 4)
                pol_val  = round(raw_pol  / 1e18,      6)

                return True, {
                    # campos que lee ModeSelector.jsx
                    "usdc":           usdc_val,
                    "pol":            pol_val,
                    # aliases back-compat
                    "usdc_balance":   usdc_val,
                    "pol_balance":    pol_val,
                    # diagnóstico
                    "wallet":         funder_addr[:10] + "…",
                    "rpc_used":       rpc_url,
                    "rpc_latency_ms": elapsed,
                    "rpc_attempts":   attempts,
                }

            except Exception as rpc_err:
                elapsed = round((time.time() - t0) * 1000)
                attempts.append({"rpc": rpc_url, "ok": False,
                                 "latency_ms": elapsed, "error": str(rpc_err)[:80]})
                logger.warning(f"[CMD] ⚠ RPC falló ({rpc_url} {elapsed}ms): {rpc_err}")
                continue

        return False, {
            "error":        "Todos los RPCs fallaron",
            "rpc_attempts": attempts,
        }

    except Exception as e:
        logger.error(f"[CMD] check_balance error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_test_order(cfg: dict, params: dict) -> tuple[bool, dict]:
    """
    Coloca una orden de prueba real (SIMULATE_MODE ignorado).
    params: { direction: 'UP'|'DOWN', stake: float }
    """
    try:
        from modules.market_scanner import get_active_market, get_clob_price
        from modules.strategy import Signal, Direction, execute_order

        direction_str = str(params.get("direction", "UP")).upper()
        stake         = float(params.get("stake", 1.0))

        if direction_str not in ("UP", "DOWN"):
            return False, {"error": "direction debe ser UP o DOWN"}
        if stake < 0.5 or stake > 10:
            return False, {"error": "stake fuera de rango (0.50 – 10.00 USDC)"}

        test_cfg = {**cfg}
        test_cfg.setdefault("strategy", {})
        test_cfg["strategy"] = {**test_cfg["strategy"], "simulate_mode": False}

        market = get_active_market()
        if not market:
            return False, {"error": "No se encontró mercado BTC activo"}

        tokens_list = market.get("tokens", [])
        yes_token   = next((t for t in tokens_list if t.get("outcome") == "Yes"), None)
        no_token    = next((t for t in tokens_list if t.get("outcome") == "No"),  None)

        if not yes_token:
            return False, {"error": "Mercado sin token YES"}

        direction = Direction.UP if direction_str == "UP" else Direction.DOWN
        token     = yes_token if direction == Direction.UP else (no_token or yes_token)
        token_id  = token.get("token_id")

        if not token_id:
            return False, {"error": "token_id no encontrado en el mercado"}

        entry_odds = get_clob_price(token_id)
        if not entry_odds or entry_odds <= 0:
            return False, {"error": f"No se pudo obtener precio CLOB para token {token_id[:10]}…"}

        signal = Signal(
            direction=direction,
            distance=9999,
            target=0,
            price=0,
            umbral=0,
            window="TEST",
        )
        market_with_token = {**market, "_test_token_id": token_id}

        result_order = execute_order(signal, market_with_token, test_cfg)
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


# ── Dispatcher principal ──────────────────────────────────────────────────────

def process_pending_commands(cfg: dict):
    """
    Consulta la tabla bot_commands por comandos pending y los ejecuta.
    Llamar periódicamente desde el loop principal de monitor.py.
    Es seguro llamar cada ciclo — solo procesa un comando por llamada.
    """
    try:
        from modules import db
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
            else:
                success, result = False, {"error": f"Comando desconocido: {command}"}
        except Exception as e:
            success, result = False, {"error": f"Excepción interna: {e}"}

        _finish_command(client, cmd_id, success, result)

        icon = "✅" if success else "❌"
        logger.info(f"[CMD] {icon} Comando #{cmd_id} {command} → {'OK' if success else 'ERROR'}: {result}")

    except Exception as e:
        logger.warning(f"[CMD] ⚠ process_pending_commands: {e}")
