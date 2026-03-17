"""
command_handler.py — v1.0  (importaciones absolutas — para bot/monitor.py, bot/main.py)
Contenido idéntico a bot/modules/command_handler.py salvo la ruta de importación.
Ver bot/modules/command_handler.py para documentación completa.
"""

import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


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


def _handle_check_clob(cfg: dict) -> tuple[bool, dict]:
    try:
        import time as _time
        from market_scanner import get_active_btc_market, get_clob_price
        t0     = _time.time()
        market = get_active_btc_market(cfg)
        if not market:
            return False, {"error": "No se encontró mercado BTC activo"}
        market_slug = market.get("slug", "—")
        clob_ids    = market.get("clobTokenIds", [])
        if not clob_ids:
            return False, {"error": "Mercado sin clobTokenIds", "market_slug": market_slug}
        yes_price = get_clob_price(clob_ids[0])
        no_price  = get_clob_price(clob_ids[1]) if len(clob_ids) > 1 else None
        return True, {
            "latency_ms":   round((_time.time() - t0) * 1000),
            "market_slug":  market_slug,
            "yes_token_id": clob_ids[0],
            "yes_price":    yes_price,
            "no_price":     no_price,
        }
    except Exception as e:
        logger.error(f"[CMD] check_clob error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_check_balance(cfg: dict) -> tuple[bool, dict]:
    try:
        from web3 import Web3
        rpc_url     = cfg.get("polymarket", {}).get("rpc_url", "https://polygon-rpc.com")
        funder_addr = cfg.get("polymarket", {}).get("funder", "")
        if not funder_addr:
            return False, {"error": "polymarket.funder no configurado"}
        w3 = Web3(Web3.HTTPProvider(rpc_url))
        USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        ERC20_ABI = [{"constant": True, "inputs": [{"name": "_owner", "type": "address"}],
                      "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}],
                      "type": "function"}]
        usdc      = w3.eth.contract(address=Web3.to_checksum_address(USDC_POLYGON), abi=ERC20_ABI)
        addr_cs   = Web3.to_checksum_address(funder_addr)
        raw_usdc  = usdc.functions.balanceOf(addr_cs).call()
        raw_pol   = w3.eth.get_balance(addr_cs)
        return True, {
            "usdc_balance": round(raw_usdc / 1_000_000, 4),
            "pol_balance":  round(raw_pol / 1e18, 6),
            "wallet":       funder_addr[:10] + "…",
        }
    except Exception as e:
        logger.error(f"[CMD] check_balance error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_test_order(cfg: dict, params: dict) -> tuple[bool, dict]:
    try:
        from market_scanner import get_active_btc_market, get_clob_price
        from strategy import Signal, Direction, execute_order
        direction_str = str(params.get("direction", "UP")).upper()
        stake         = float(params.get("stake", 1.0))
        if direction_str not in ("UP", "DOWN"):
            return False, {"error": "direction debe ser UP o DOWN"}
        if stake < 0.5 or stake > 10:
            return False, {"error": "stake fuera de rango (0.50 – 10.00 USDC)"}
        test_cfg = {**cfg, "strategy": {**cfg.get("strategy", {}), "simulate_mode": False}}
        market   = get_active_btc_market(test_cfg)
        if not market:
            return False, {"error": "No se encontró mercado BTC activo"}
        clob_ids = market.get("clobTokenIds", [])
        if not clob_ids:
            return False, {"error": "Mercado sin clobTokenIds"}
        direction  = Direction.UP if direction_str == "UP" else Direction.DOWN
        token_idx  = 0 if direction == Direction.UP else 1
        token_id   = clob_ids[token_idx] if len(clob_ids) > token_idx else clob_ids[0]
        entry_odds = get_clob_price(token_id)
        if not entry_odds or entry_odds <= 0:
            return False, {"error": f"No se pudo obtener precio CLOB para token {token_id[:10]}…"}
        signal = Signal(direction=direction, distance=9999, target=0, price=0, umbral=0, window="TEST")
        result_order = execute_order(signal, {**market, "_test_token_id": token_id}, test_cfg)
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


def process_pending_commands(cfg: dict):
    """Consulta bot_commands por comandos pending y ejecuta el más antiguo."""
    try:
        import db
        if not db.is_enabled():
            return
        client = db._client
        res = client.table("bot_commands") \
            .select("id, command, params").eq("status", "pending") \
            .order("created_at", desc=False).limit(1).execute()
        if not res.data:
            return
        row     = res.data[0]
        cmd_id  = row["id"]
        command = row["command"]
        params  = row.get("params") or {}
        logger.info(f"[CMD] 📩 Procesando comando #{cmd_id}: {command}  params={params}")
        if not _claim_command(client, cmd_id):
            return
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
        logger.info(f"[CMD] {'✅' if success else '❌'} Comando #{cmd_id} {command} → {result}")
    except Exception as e:
        logger.warning(f"[CMD] ⚠ process_pending_commands: {e}")
