"""
monitor.py — Loop principal del bot PolyBot
v7.0 — Fix crítico: resolución WIN/LOSS movida al bloque de reset horario.
       El check `if mins_left <= 0` era inalcanzable (_mins_to_close nunca ≤ 0).
       Ahora la vela se resuelve al detectar cambio de hora (now_hour != last_hour),
       ANTES de generar el resumen y resetear contadores.
       También se limpian fired_window / active_bet en el reset horario.

Destinos:
  bot/monitor.py          (import absoluto)
  bot/modules/monitor.py  (import relativo)
"""

import csv
import logging
import os
import time
from datetime import datetime, timezone

logger = logging.getLogger("monitor")

_SEPARATOR  = "─" * 72
_SEPARATOR2 = "·" * 72


# ── Imports duales (absoluto / relativo) ──────────────────────────────────────
try:
    from modules.market_scanner import get_active_market
    from modules.price_feed      import get_btc_price
    from modules.strategy        import evaluate, execute_order, Direction
    from modules.notifier        import (
        notify_start, notify_stop, notify_error,
        notify_startup_summary,
        notify_new_hour, notify_hour_summary,
        notify_market_found, notify_market_lost,
        notify_target_change, notify_target_failed,
        notify_signal_eval,
        notify_bet,
        notify_win, notify_loss, notify_stop_loss,
        notify_order_failed,
    )
    from modules.claimer import redimir_posicion
    from modules.market_scanner import get_target_price_1h_binance
except ImportError:
    from market_scanner import get_active_market
    from price_feed      import get_btc_price
    from strategy        import evaluate, execute_order, Direction
    from notifier        import (
        notify_start, notify_stop, notify_error,
        notify_startup_summary,
        notify_new_hour, notify_hour_summary,
        notify_market_found, notify_market_lost,
        notify_target_change, notify_target_failed,
        notify_signal_eval,
        notify_bet, notify_bet_failed,
        notify_win, notify_loss, notify_stop_loss,
        notify_order_failed,
    )
    from claimer import redimir_posicion
    from market_scanner import get_target_price_1h_binance


# ── Helpers temporales ────────────────────────────────────────────────────────

def _mins_to_close() -> float:
    """
    Minutos hasta el cierre de la vela horaria actual.
    Devuelve un valor en (0, 60]. NUNCA devuelve ≤ 0 porque en cuanto
    la hora cambia a la siguiente vela, el contador vuelve a ~60.
    La resolución de apuestas NO debe basarse en este valor — usar
    el cambio de now_hour != last_hour como señal de cierre de vela.
    """
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def _log_cycle(price, target, mins_left, ops_hoy, max_ops):
    dist_str = "—"
    if price and target:
        dist     = price - target
        dist_str = f"{dist:+,.0f}"
    logger.debug(
        f"[MONITOR] Ciclo — "
        f"BTC=${price:,.2f}  "
        f"Target={f'${target:,.2f}' if target else '—'}  "
        f"Dist={dist_str}  "
        f"Mins={mins_left:.1f}  "
        f"Ops={ops_hoy}/{max_ops}"
    )


# ── CSV de operaciones ────────────────────────────────────────────────────────

_CSV_HEADERS = [
    "id", "ts_entrada", "ts_cierre",
    "direccion", "ventana",
    "entry_price", "target_price", "distancia",
    "umbral",
    "odds", "stake_usd", "tokens_comprados",
    "retorno_estimado_usd",
    "pnl_usd", "pnl_pct",
    "resultado",
    "market_slug",
    "simulado",
]


def _ensure_csv(path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=_CSV_HEADERS)
            writer.writeheader()


def _csv_write_row(path: str, row: dict):
    try:
        _ensure_csv(path)
        with open(path, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=_CSV_HEADERS, extrasaction="ignore")
            writer.writerow(row)
        logger.info(f"[MONITOR] 💾 Operación guardada en CSV: {row.get('resultado')} | P&L ${row.get('pnl_usd', 0):+.2f}")
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error escribiendo CSV: {e}")


def _build_trade_row(bet: dict, result: str, ts_cierre: str, pnl_usd: float, pnl_pct: float) -> dict:
    stake   = bet.get("stake", 0)
    odds    = bet.get("odds", 0.5)
    retorno = round(stake / odds, 2) if odds > 0 else 0
    return {
        "id":                   bet.get("id", ""),
        "ts_entrada":           bet.get("ts_entrada", ""),
        "ts_cierre":            ts_cierre,
        "direccion":            bet.get("direction", ""),
        "ventana":              bet.get("window", ""),
        "entry_price":          bet.get("entry", ""),
        "target_price":         bet.get("target", ""),
        "distancia":            round(bet.get("distance", 0), 2),
        "umbral":               bet.get("umbral", ""),
        "odds":                 odds,
        "stake_usd":            stake,
        "tokens_comprados":     bet.get("tokens", ""),
        "retorno_estimado_usd": retorno,
        "pnl_usd":              round(pnl_usd, 2),
        "pnl_pct":              round(pnl_pct, 2),
        "resultado":            result,
        "market_slug":          bet.get("market_slug", ""),
        "simulado":             bet.get("simulated", False),
    }


# ── Historial acumulado ───────────────────────────────────────────────────────

def _load_historical_stats(csv_path: str) -> dict:
    """Lee el CSV completo y devuelve stats acumuladas."""
    stats = {
        "total_ops": 0, "wins": 0, "losses": 0, "stops": 0,
        "total_pnl": 0.0, "total_invested": 0.0,
    }
    if not os.path.exists(csv_path):
        return stats
    try:
        with open(csv_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                result = row.get("resultado", "").upper()
                if result not in ("WIN", "LOSS", "STOP"):
                    continue
                stats["total_ops"] += 1
                if result == "WIN":
                    stats["wins"]   += 1
                elif result == "LOSS":
                    stats["losses"] += 1
                elif result == "STOP":
                    stats["stops"]  += 1
                try:
                    stats["total_pnl"]     += float(row.get("pnl_usd", 0))
                    stats["total_invested"] += float(row.get("stake_usd", 0))
                except ValueError:
                    pass
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo historial CSV: {e}")
    return stats


def _log_accumulated_stats(stats: dict, label: str = "HISTORIAL"):
    wins   = stats["wins"]
    losses = stats["losses"] + stats["stops"]
    wr     = round(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    sign   = "+" if stats["total_pnl"] >= 0 else ""
    logger.info(
        f"[MONITOR] 📊 {label}: "
        f"{stats['total_ops']} ops  "
        f"{wins}W/{losses}L  WR={wr}%  "
        f"P&L={sign}${stats['total_pnl']:,.2f}  "
        f"Invertido=${stats['total_invested']:,.2f}"
    )


def _log_hour_ops(hour_utc: int, hour_ops: list, hist_stats: dict):
    """
    Muestra tabla detallada de operaciones de la hora actual + acumulado.
    Se imprime al cambio de hora y al finalizar la sesión.
    """
    if not hour_ops:
        return

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 📋 RESUMEN HORA {hour_utc:02d}:00 UTC — {len(hour_ops)} operación(es)")
    logger.info(
        f"[MONITOR] {'#':>2}  {'Dir':<5} {'Ventana':<6}  "
        f"{'BTC compra':>10}  {'Tokens':>8}  {'Odds E':>6}  "
        f"{'Odds S':>6}  {'BTC cierre':>10}  {'Resultado':<6}  {'P&L':>10}"
    )
    logger.info(_SEPARATOR2)

    total_pnl = 0.0
    for i, op in enumerate(hour_ops, 1):
        direction  = op.get("direction", "—")
        window     = op.get("window", "—")
        entry_btc  = op.get("entry_btc", 0)
        entry_odds = op.get("entry_odds", 0)
        tokens     = op.get("tokens", 0)
        exit_odds  = op.get("exit_odds", 0)
        exit_btc   = op.get("exit_btc", 0)
        result     = op.get("result", "—")
        pnl        = op.get("pnl_usd", 0)
        sim        = " [SIM]" if op.get("simulated") else ""
        total_pnl += pnl

        pnl_str = f"{'+' if pnl >= 0 else ''}{pnl:,.2f}"
        logger.info(
            f"[MONITOR] {i:>2}.{sim}  {direction:<5} {window:<6}  "
            f"${entry_btc:>9,.2f}  {tokens:>8.4f}  {entry_odds:>6.4f}  "
            f"{exit_odds:>6.4f}  ${exit_btc:>9,.2f}  {result:<6}  "
            f"${pnl_str:>9}"
        )

    logger.info(_SEPARATOR2)
    hw   = hist_stats.get("wins", 0)
    hl   = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
    hp   = hist_stats.get("total_pnl", 0.0)
    hr   = round(hw / (hw + hl) * 100) if (hw + hl) > 0 else 0
    hs   = "+" if hp >= 0 else ""
    ht   = f"{'+' if total_pnl >= 0 else ''}{total_pnl:,.2f}"
    logger.info(
        f"[MONITOR] Hora: P&L ${ht}  |  "
        f"Acumulado: {hw}W/{hl}L WR={hr}%  P&L neto {hs}${hp:,.2f}"
    )
    logger.info(_SEPARATOR)


# ── Exit token price (stop loss) ──────────────────────────────────────────────

def _fetch_exit_token_price(active_bet: dict, cfg: dict) -> float | None:
    """
    Obtiene el precio actual del token en Polymarket vía CLOB midpoint.
    Fallback: Gamma API por conditionId.
    """
    import urllib.request, json

    market = active_bet.get("market", {})
    token_ids = market.get("clobTokenIds") or []
    direction = active_bet.get("direction", "UP")

    token_id = None
    if token_ids:
        token_id = token_ids[0] if direction == "UP" else token_ids[1]
    elif direction == "UP":
        token_id = market.get("token_yes") or market.get("tokenYes")
    else:
        token_id = market.get("token_no")  or market.get("tokenNo")

    if token_id:
        try:
            url = f"https://clob.polymarket.com/midpoint?token_id={token_id}"
            with urllib.request.urlopen(url, timeout=5) as r:
                data  = json.loads(r.read())
                mid   = data.get("mid")
                if mid is not None:
                    return float(mid)
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ CLOB midpoint falló: {e}")

    # Fallback: Gamma API
    condition_id = market.get("condition_id") or market.get("conditionId")
    if condition_id:
        try:
            url = f"https://gamma-api.polymarket.com/markets?conditionId={condition_id}"
            with urllib.request.urlopen(url, timeout=5) as r:
                data = json.loads(r.read())
                markets = data if isinstance(data, list) else data.get("markets", [])
                if markets:
                    tokens = markets[0].get("tokens", [])
                    for t in tokens:
                        outcome = t.get("outcome", "").upper()
                        if direction == "UP" and outcome in ("YES", "UP"):
                            return float(t.get("price", 0))
                        if direction == "DOWN" and outcome in ("NO", "DOWN"):
                            return float(t.get("price", 0))
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ Gamma fallback falló: {e}")

    return None


# ── Target con reintentos ─────────────────────────────────────────────────────

MAX_TARGET_RETRIES = 3
TARGET_RETRY_WAIT  = 10


def _fetch_target_with_retry(cfg: dict, hour_utc: int, slug: str | None = None) -> float | None:
    for attempt in range(1, MAX_TARGET_RETRIES + 1):
        try:
            t = get_target_price_1h_binance(slug=slug)
            if t:
                return t
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ Target intento {attempt}/{MAX_TARGET_RETRIES}: {e}")
        if attempt < MAX_TARGET_RETRIES:
            time.sleep(TARGET_RETRY_WAIT)
    notify_target_failed(cfg, hour_utc)
    return None


# ── Resolución de apuesta al cierre de vela ───────────────────────────────────

def _resolve_bet_at_candle_close(
    active_bet: dict,
    price: float,
    csv_path: str,
    cfg: dict,
    hour_ops: list,
    session_wins_ref: list,
    session_losses_ref: list,
    session_pnl_ref: list,
    session_invested_ref: list,
    hour_wins_ref: list,
    hour_losses_ref: list,
    stake_default: float,
    sim_: bool,
) -> str:
    """
    Resuelve la apuesta activa comparando precio final vs target.
    Usa listas de 1 elemento como referencias mutables para los contadores.
    Devuelve el resultado: "WIN", "LOSS" o "STOP" (si ya fue procesado).
    Escribe en CSV, actualiza hour_ops y contadores de sesión.
    """
    dir_         = active_bet["direction"]
    stake_       = active_bet.get("stake", stake_default)
    odds_        = active_bet.get("odds", 0.5)
    tokens_held  = round(stake_ / max(odds_, 0.001), 4)
    target_price = active_bet.get("target", 0.0)

    won = (dir_ == "UP"   and price > target_price) or \
          (dir_ == "DOWN"  and price < target_price)

    if won:
        exit_odds = 1.0
        pnl_usd   = round(tokens_held * exit_odds - stake_, 2)
        pnl_pct   = round((pnl_usd / stake_) * 100, 1) if stake_ > 0 else 0.0
        result    = "WIN"
        hour_wins_ref[0]      += 1
        session_wins_ref[0]   += 1
        notify_win(cfg, active_bet, price, simulated=sim_)
        logger.info(
            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
            f"Precio cierre ${price:,.2f} vs target ${target_price:,.2f}  "
            f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${tokens_held:.2f}  "
            f"P&L: +${pnl_usd:.2f} (+{pnl_pct:.1f}%)"
        )
        if not sim_:
            try:
                redimir_posicion(active_bet["market"], cfg)
            except Exception as e:
                logger.warning(f"[MONITOR] ⚠ Error en claim: {e}")
        else:
            logger.info("[MONITOR] [SIMULADO] Claim omitido en modo simulado")
    else:
        exit_odds = 0.0
        pnl_usd   = -stake_
        pnl_pct   = -100.0
        result    = "LOSS"
        hour_losses_ref[0]    += 1
        session_losses_ref[0] += 1
        notify_loss(cfg, active_bet, price, simulated=sim_)
        logger.info(
            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}❌ LOSS — "
            f"Precio cierre ${price:,.2f} vs target ${target_price:,.2f}  "
            f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = $0.00  "
            f"P&L: -${stake_:.2f} (-100%)"
        )

    ts_now = datetime.now(timezone.utc).isoformat()
    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
    _csv_write_row(csv_path, row)

    hour_ops.append({
        "direction":  dir_,
        "window":     active_bet["window"],
        "entry_btc":  active_bet["entry"],
        "entry_odds": odds_,
        "stake":      stake_,
        "tokens":     tokens_held,
        "exit_odds":  exit_odds,
        "exit_btc":   price,
        "result":     result,
        "pnl_usd":    pnl_usd,
        "simulated":  sim_,
    })

    session_pnl_ref[0]      += pnl_usd
    session_invested_ref[0] += stake_

    return result


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    stake         = cfg["capital"]["stake_usdc"]
    max_ops       = cfg["capital"]["max_operaciones_dia"]
    interval      = cfg["strategy"].get("monitor_intervalo_s", 5)
    stop_pct      = cfg["strategy"].get("stop_loss_pct", 5.0)
    simulate_mode = cfg.get("strategy", {}).get("simulate_mode", False)
    csv_path      = cfg.get("logging", {}).get("historial_csv", "logs/operaciones.csv")

    # ── Cargar y mostrar historial acumulado ──────────────────────────────
    hist_stats = _load_historical_stats(csv_path)
    _log_accumulated_stats(hist_stats)

    # Contadores de sesión como listas para paso por referencia a _resolve_bet
    session_pnl_ref      = [0.0]
    session_invested_ref = [0.0]
    session_wins_ref     = [0]
    session_losses_ref   = [0]

    notify_start(cfg)
    notify_startup_summary(cfg, hist_stats)

    # ── Estado de mercado/hora ────────────────────────────────────────────
    market       = None
    slug         = None
    target       = None
    active_bet   = None
    fired_window = None
    last_hour    = -1
    last_slug    = None
    last_price   = 0.0  # último precio conocido, para resolver apuestas en reset

    hour_wins   = 0
    hour_losses = 0
    ops_hoy     = 0
    hour_ops    = []

    last_notified_signal_key = None

    logger.info(_SEPARATOR)
    sim_tag = " [MODO SIMULADO]" if simulate_mode else ""
    logger.info(f"[MONITOR] 🚀 Bot iniciado{sim_tag} — esperando mercado activo…")
    logger.info(_SEPARATOR)

    try:
        while True:
            mins_left = _mins_to_close()
            now_hour  = datetime.now(timezone.utc).hour

            # ── Reset horario ─────────────────────────────────────────────
            # Se ejecuta cuando cambia la hora UTC. Ese cambio es la señal
            # definitiva de que la vela horaria anterior ha cerrado.
            if now_hour != last_hour:
                if last_hour >= 0:
                    # ── PASO 1: resolver apuesta pendiente si la hay ──────
                    # La vela acaba de cerrar. Si hay una apuesta activa,
                    # resolverla con el último precio conocido ANTES del reset.
                    if active_bet:
                        resolve_price = last_price if last_price > 0 else 0.0
                        sim_          = active_bet.get("simulated", False)
                        logger.info(
                            f"[MONITOR] 🔔 Vela cerrada — resolviendo apuesta pendiente "
                            f"({active_bet['direction']} @ ${resolve_price:,.2f} "
                            f"vs target ${active_bet.get('target', 0):,.2f})"
                        )
                        # Referencias mutables para los contadores
                        hw_ref = [hour_wins]
                        hl_ref = [hour_losses]
                        result = _resolve_bet_at_candle_close(
                            active_bet       = active_bet,
                            price            = resolve_price,
                            csv_path         = csv_path,
                            cfg              = cfg,
                            hour_ops         = hour_ops,
                            session_wins_ref = session_wins_ref,
                            session_losses_ref = session_losses_ref,
                            session_pnl_ref  = session_pnl_ref,
                            session_invested_ref = session_invested_ref,
                            hour_wins_ref    = hw_ref,
                            hour_losses_ref  = hl_ref,
                            stake_default    = stake,
                            sim_             = sim_,
                        )
                        hour_wins   = hw_ref[0]
                        hour_losses = hl_ref[0]
                        ops_hoy    += 0  # ops_hoy ya se incrementó al abrir la apuesta

                        hist_stats = _load_historical_stats(csv_path)
                        _log_accumulated_stats(hist_stats, label=f"TRAS {result}")

                        logger.info(
                            f"[MONITOR]    P&L sesión : "
                            f"{'+' if session_pnl_ref[0] >= 0 else ''}${session_pnl_ref[0]:,.2f} USDC  "
                            f"(invertido ${session_invested_ref[0]:,.2f})\n"
                            f"[MONITOR]    Acumulado  : "
                            f"{'+' if hist_stats['total_pnl'] >= 0 else ''}${hist_stats['total_pnl']:,.2f} USDC"
                        )
                        active_bet               = None
                        fired_window             = None
                        last_notified_signal_key = None

                    # ── PASO 2: resumen de hora (con todos los datos) ─────
                    hist_stats = _load_historical_stats(csv_path)
                    _log_hour_ops(last_hour, hour_ops, hist_stats)
                    notify_hour_summary(
                        cfg, last_hour,
                        hour_wins, hour_losses,
                        ops_hoy, target or 0.0,
                        hour_ops=hour_ops,
                        hist_stats=hist_stats,
                    )

                # ── PASO 3: notificar nueva hora y resetear contadores ────
                notify_new_hour(cfg, now_hour, slug, target or 0.0)
                hour_wins                = 0
                hour_losses              = 0
                last_hour                = now_hour
                ops_hoy                  = 0
                hour_ops                 = []
                fired_window             = None   # ← limpia estado entre horas
                last_notified_signal_key = None

            # ── Obtener mercado ───────────────────────────────────────────
            prev_slug = slug
            market    = get_active_market()
            slug      = market.get("slug") if market else None

            if market and slug != prev_slug:
                notify_market_found(cfg, market, mins_left)
                logger.info(
                    f"[MONITOR] 🎯 Mercado encontrado: {slug}\n"
                    f"           conditionId: {market.get('condition_id', '—')}"
                )
                last_slug = slug
                target    = None
                last_notified_signal_key = None

            if not market:
                if prev_slug:
                    notify_market_lost(cfg)
                    logger.warning("[MONITOR] ⚠ Mercado perdido — esperando nuevo mercado")
                time.sleep(interval)
                continue

            # ── Obtener target ────────────────────────────────────────────
            if target is None:
                hour_utc = datetime.now(timezone.utc).hour
                target   = _fetch_target_with_retry(cfg, hour_utc, slug=slug)
                if target:
                    notify_target_change(cfg, target, hour_utc)
                    logger.info(f"[MONITOR] 🎯 Price to Beat: ${target:,.2f}")
                else:
                    logger.warning("[MONITOR] ⚠ Target no disponible — reintentando en próximo ciclo")
                    time.sleep(interval)
                    continue

            # ── Obtener precio BTC ────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.warning(f"[MONITOR] ⚠ Precio BTC no disponible: {e} — saltando ciclo")
                time.sleep(interval)
                continue

            if not price:
                logger.warning("[MONITOR] ⚠ Precio BTC = None — saltando ciclo")
                time.sleep(interval)
                continue

            last_price = price  # guardar para resolución en cambio de hora
            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Stop loss en posición abierta ─────────────────────────────
            if active_bet:
                sim_ = active_bet.get("simulated", False)

                entry_price = active_bet.get("entry", price)
                if active_bet["direction"] == "UP":
                    pnl_btc = (price - entry_price) / entry_price * 100
                else:
                    pnl_btc = (entry_price - price) / entry_price * 100

                if pnl_btc <= -stop_pct:
                    exit_token_price = _fetch_exit_token_price(active_bet, cfg)
                    stake_           = active_bet.get("stake", stake)
                    entry_odds       = active_bet.get("odds", 0.5)
                    tokens_held      = round(stake_ / max(entry_odds, 0.001), 4)

                    if exit_token_price is not None:
                        pnl_usd  = round(tokens_held * exit_token_price - stake_, 2)
                        pnl_pct  = round((pnl_usd / stake_) * 100, 1) if stake_ > 0 else 0.0
                    else:
                        pnl_usd  = round(-stake_ * (stop_pct / 100), 2)
                        pnl_pct  = -stop_pct
                        exit_token_price = max(entry_odds + pnl_usd / tokens_held, 0.0) if tokens_held else 0.0

                    result = "STOP"
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}🛑 STOP LOSS — "
                        f"BTC movimiento: {pnl_btc:+.2f}%  "
                        f"P&L: ${pnl_usd:+.2f} ({pnl_pct:+.1f}%)"
                    )
                    notify_stop_loss(cfg, active_bet, price, pnl_usd, simulated=sim_)

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
                    _csv_write_row(csv_path, row)

                    hour_ops.append({
                        "direction":  active_bet["direction"],
                        "window":     active_bet["window"],
                        "entry_btc":  active_bet["entry"],
                        "entry_odds": entry_odds,
                        "stake":      stake_,
                        "tokens":     tokens_held,
                        "exit_odds":  exit_token_price,
                        "exit_btc":   price,
                        "result":     result,
                        "pnl_usd":    pnl_usd,
                        "simulated":  sim_,
                    })

                    session_pnl_ref[0]      += pnl_usd
                    session_invested_ref[0] += stake_
                    session_losses_ref[0]   += 1
                    hour_losses             += 1

                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label="TRAS STOP_LOSS")

                    logger.info(
                        f"[MONITOR]    P&L sesión : "
                        f"{'+' if session_pnl_ref[0] >= 0 else ''}${session_pnl_ref[0]:,.2f} USDC  "
                        f"(invertido ${session_invested_ref[0]:,.2f})\n"
                        f"[MONITOR]    Acumulado  : "
                        f"{'+' if hist_stats['total_pnl'] >= 0 else ''}${hist_stats['total_pnl']:,.2f} USDC"
                    )

                    active_bet               = None
                    fired_window             = None
                    last_notified_signal_key = None
                    time.sleep(interval)
                    continue

            # ── Evaluación de señal ───────────────────────────────────────
            if not target:
                time.sleep(interval)
                continue

            signal = evaluate(price, target, mins_left, cfg)

            if signal:
                signal_key = (signal.window, signal.direction.value)
                if signal_key != last_notified_signal_key:
                    notify_signal_eval(
                        cfg, price, target,
                        signal.distance, signal.umbral, signal.window,
                        signal.direction.value, mins_left,
                    )
                    last_notified_signal_key = signal_key

            # ── Ejecutar orden si señal accionable ────────────────────────
            if signal and signal.is_actionable and not active_bet and fired_window != signal.window:
                if ops_hoy < max_ops:
                    result_order = execute_order(signal, market, cfg)
                    if result_order:
                        ops_hoy      += 1
                        entry_odds    = result_order.get("odds", 0.5)
                        tokens_bought = round(stake / max(entry_odds, 0.001), 4)

                        active_bet = {
                            "id":          result_order.get("id", ""),
                            "direction":   signal.direction.value,
                            "window":      signal.window,
                            "entry":       price,
                            "target":      target,
                            "distance":    signal.distance,
                            "umbral":      signal.umbral,
                            "stake":       stake,
                            "odds":        entry_odds,
                            "tokens":      tokens_bought,
                            "market":      market,
                            "market_slug": slug,
                            "simulated":   result_order.get("simulated", False),
                            "ts_entrada":  datetime.now(timezone.utc).isoformat(),
                        }
                        fired_window = signal.window

                        retorno_est = round(tokens_bought, 2)
                        pnl_est     = round(retorno_est - stake, 2)
                        pct_est     = round((pnl_est / stake) * 100, 1) if stake > 0 else 0

                        sim_tag_log = " [SIMULADO]" if active_bet["simulated"] else ""
                        logger.info(
                            f"[MONITOR] {'🟢' if signal.direction == Direction.UP else '🔴'}"
                            f"{sim_tag_log} Apuesta {signal.direction.value} ejecutada\n"
                            f"           Entry     : ${price:,.2f}\n"
                            f"           Target    : ${target:,.2f}\n"
                            f"           Ventana   : {signal.window}\n"
                            f"           Stake     : ${stake:.2f} USDC\n"
                            f"           Odds      : {entry_odds:.4f}  ({entry_odds*100:.1f}%)\n"
                            f"           Tokens    : {tokens_bought:.4f}\n"
                            f"           Ret. est. : ${retorno_est:.2f} USDC  "
                            f"(+${pnl_est:.2f} / +{pct_est:.1f}%)"
                        )
                        notify_bet(cfg, active_bet, signal, simulated=active_bet["simulated"])
                    else:
                        # execute_order devolvió None — marcar fired_window para no reintentar
                        fired_window = signal.window
                        logger.error("[MONITOR] ❌ execute_order devolvió None — apuesta no abierta")
                        try:
                            notify_order_failed(cfg, signal)
                        except Exception:
                            pass
                else:
                    logger.info(
                        f"[MONITOR] ⛔ Límite diario alcanzado ({ops_hoy}/{max_ops}) — señal ignorada"
                    )

            time.sleep(interval)

    except KeyboardInterrupt:
        logger.info("[MONITOR] ⛔ Bot detenido por el usuario (KeyboardInterrupt)")
    except Exception as e:
        logger.error(f"[MONITOR] 💥 Error fatal: {e}", exc_info=True)
        notify_error(cfg, str(e))
    finally:
        notify_stop(cfg)
        final_stats = _load_historical_stats(csv_path)
        _log_hour_ops(last_hour, hour_ops, final_stats)
        _log_accumulated_stats(final_stats, label="FINAL DE SESIÓN")
        logger.info(
            f"[MONITOR] Sesión: {session_wins_ref[0]}W {session_losses_ref[0]}L  "
            f"P&L={'+' if session_pnl_ref[0] >= 0 else ''}${session_pnl_ref[0]:,.2f}  "
            f"Invertido=${session_invested_ref[0]:,.2f}"
        )
