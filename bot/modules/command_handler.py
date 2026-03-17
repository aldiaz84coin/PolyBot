"""
command_handler.py — v1.0
Ejecutor de comandos emitidos desde el dashboard via tabla bot_commands.

Comandos soportados:
  check_clob      → prueba conectividad CLOB + lectura de precio
  check_balance   → consulta saldo USDC y POL en cartera
  test_order      → ejecuta una orden real de prueba con importe mínimo
                    params: { direction: 'UP'|'DOWN', stake: 1.0 }

Uso desde monitor.py:
  from modules.command_handler import process_pending_commands
  process_pending_commands(cfg)   # llamar periódicamente en el loop principal
"""

import logging
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


# ── Helpers de DB ─────────────────────────────────────────────────────────

def _claim_command(client, cmd_id: int) -> bool:
    """Marca el comando como 'running' de forma atómica."""
    try:
        res = client.table("bot_commands") \
            .update({"status": "running", "updated_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("id", cmd_id) \
            .eq("status", "pending") \
            .execute()
        return bool(res.data)
    except Exception as e:
        logger.warning(f"[CMD] ⚠ claim_command [{cmd_id}]: {e}")
        return False


def _finish_command(client, cmd_id: int, success: bool, result: dict):
    """Escribe resultado y marca status=done|error."""
    try:
        status = "done" if success else "error"
        client.table("bot_commands").update({
            "status":     status,
            "result":     {**result, "success": success},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", cmd_id).execute()
    except Exception as e:
        logger.warning(f"[CMD] ⚠ finish_command [{cmd_id}]: {e}")


# ── Handlers individuales ─────────────────────────────────────────────────

def _handle_check_clob(cfg: dict) -> tuple[bool, dict]:
    """
    Verifica conectividad con clob.polymarket.com:
    1. Obtiene mercado activo via Gamma API
    2. Lee precio CLOB via midpoint endpoint
    Devuelve (success, result_dict)
    """
    try:
        import requests
        from modules.market_scanner import get_active_btc_market, get_clob_price

        t0 = time.time()

        # Obtener mercado activo
        market = get_active_btc_market(cfg)
        if not market:
            return False, {"error": "No se encontró mercado BTC activo en Gamma API"}

        market_slug = market.get("slug", "—")
        clob_ids    = market.get("clobTokenIds", [])
        if not clob_ids:
            return False, {
                "error": "Mercado sin clobTokenIds",
                "market_slug": market_slug,
            }

        yes_token_id = clob_ids[0]
        no_token_id  = clob_ids[1] if len(clob_ids) > 1 else None

        # Leer precio CLOB YES
        yes_price = get_clob_price(yes_token_id)
        no_price  = get_clob_price(no_token_id) if no_token_id else None

        latency_ms = round((time.time() - t0) * 1000)

        return True, {
            "latency_ms":  latency_ms,
            "market_slug": market_slug,
            "yes_token_id": yes_token_id,
            "yes_price":   yes_price,
            "no_price":    no_price,
        }

    except Exception as e:
        logger.error(f"[CMD] check_clob error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_check_balance(cfg: dict) -> tuple[bool, dict]:
    """
    Consulta saldo USDC (ERC-20 en Polygon) y POL (gas).
    Devuelve (success, result_dict)
    """
    try:
        from web3 import Web3

        rpc_url    = cfg.get("polymarket", {}).get("rpc_url", "https://polygon-rpc.com")
        funder_addr = cfg.get("polymarket", {}).get("funder", "")

        if not funder_addr:
            return False, {"error": "polymarket.funder no configurado"}

        w3 = Web3(Web3.HTTPProvider(rpc_url))

        # USDC en Polygon (6 decimales) — dirección oficial
        USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        ERC20_ABI = [
            {
                "constant": True, "inputs": [{"name": "_owner", "type": "address"}],
                "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}],
                "type": "function",
            }
        ]

        usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_POLYGON), abi=ERC20_ABI)
        addr_cs = Web3.to_checksum_address(funder_addr)
        raw_usdc = usdc.functions.balanceOf(addr_cs).call()
        usdc_balance = raw_usdc / 1_000_000  # 6 decimales

        # Balance POL (gas nativo)
        raw_pol  = w3.eth.get_balance(addr_cs)
        pol_balance = raw_pol / 1e18

        return True, {
            "usdc_balance": round(usdc_balance, 4),
            "pol_balance":  round(pol_balance, 6),
            "wallet":       funder_addr[:10] + "…",
        }

    except Exception as e:
        logger.error(f"[CMD] check_balance error: {e}", exc_info=True)
        return False, {"error": str(e)}


def _handle_test_order(cfg: dict, params: dict) -> tuple[bool, dict]:
    """
    Ejecuta una orden real de prueba en el mercado activo.
    params: { direction: 'UP'|'DOWN', stake: float }
    """
    try:
        from modules.market_scanner import get_active_btc_market, get_clob_price
        from modules.strategy import Signal, Direction, execute_order

        direction_str = str(params.get("direction", "UP")).upper()
        stake         = float(params.get("stake", 1.0))

        if direction_str not in ("UP", "DOWN"):
            return False, {"error": "direction debe ser UP o DOWN"}
        if stake < 0.5 or stake > 10:
            return False, {"error": "stake fuera de rango (0.50 – 10.00 USDC)"}

        # Forzamos modo NO simulado para la prueba
        test_cfg = {**cfg}
        test_cfg.setdefault("strategy", {})
        test_cfg["strategy"] = {**test_cfg["strategy"], "simulate_mode": False}

        # Obtener mercado activo
        market = get_active_btc_market(test_cfg)
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

        # Construir señal sintética para test
        signal = Signal(
            direction=direction,
            distance=9999,  # señal fuerte artificial para prueba
            target=0,
            price=0,
            umbral=0,
            window="TEST",
        )
        # Inyectar token_id en el mercado para el test
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


# ── Dispatcher principal ──────────────────────────────────────────────────

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

        client = db._client  # acceso directo al cliente Supabase

        # Buscar el comando pending más antiguo
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

        # Reclamar atómicamente (evita doble ejecución si hubiera dos instancias)
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
