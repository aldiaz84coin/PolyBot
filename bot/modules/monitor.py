"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v10.0 — MODO SIMULADO/REAL DINÁMICO DESDE BD
  - El bot lee trading_mode desde bot_config en Supabase cada 60s.
  - Si el dashboard cambia el modo, el bot lo recoge sin reiniciarse.
  - process_pending_commands() ejecuta check_clob / check_balance / test_order.
  - Al arrancar y tras cada cambio de modo, el bot reporta su estado en BD.

v9.0 — PERSISTENCIA SUPABASE
  - Todas las operaciones se escriben en Supabase en tiempo real:
      · upsert_operation() al abrir apuesta (PENDING)
      · close_operation() al resolver (WIN/LOSS/STOP)
      · log_signal() para señales accionables
      · log_price_snapshot() cada 5 minutos
      · upsert_session() al cambio de hora
  - _load_historical_stats() intenta BD primero, cae a CSV si no hay BD.
  - El CSV de Railway sigue escribiéndose como backup secundario.
  - La BD nunca bloquea el bot: cualquier error de Supabase es warned y continúa.

v8.0 — T-5 alta frecuencia (intervalo 1s con posición abierta)
v7.0 — FIX CRÍTICO: resolución por rollover de minutos
v5.0 — FIXES NOTIFICACIONES
v4.0 — FIXES crash 429 + historial simulado
v3.2 — FIX TELEGRAM modo simulado
v3.0 — Pre-producción fixes
v2.9 — BUG FIX: señal WAIT ya no dispara execute_order
v2.8 — FIX: _fetch_exit_token_price usa CLOB live
v2.7 — Retornos reales desde Polymarket
"""
import csv
import logging
import os
import time
from datetime import datetime, timezone

import requests

from .price_feed     import get_btc_price
from .market_scanner import get_active_market, get_open_1h_binance
from .strategy       import evaluate, execute_order, Direction, WINDOWS
from .claimer        import redimir_posicion
from .notifier       import (
    notify_start, notify_stop,
    notify_bet, notify_win, notify_loss, notify_stop_loss,
    notify_target_change, notify_target_failed,
    notify_market_found, notify_market_lost,
    notify_signal_eval,
    notify_hour_summary, notify_new_hour,
    notify_error,
    notify_startup_summary,
    notify_order_failed,
)
from .command_handler import process_pending_commands
from . import db  # módulo de persistencia Supabase

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES      = 5
TARGET_RETRY_WAIT       = 10
_CLOB_MIDPOINT          = "https://clob.polymarket.com/midpoint"
_SNAPSHOT_EVERY_N_CYCLES = 10
_CONFIG_POLL_INTERVAL   = 60   # segundos entre lecturas de bot_config


def _in_any_window(mins_left: float) -> bool:
    for w in WINDOWS:
        if w["min"] <= mins_left < w["max"]:
            return True
    return False


def _mins_to_close() -> float:
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


# ── CSV de operaciones (backup local) ────────────────────────────────────────

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
    "real_exit_odds",
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
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error escribiendo CSV: {e}")


def _build_trade_row(bet, result, ts_cierre, pnl_usd, pnl_pct, real_exit_odds=None):
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
        "tokens_comprados":     bet.get("tokens", 0),
        "retorno_estimado_usd": retorno,
        "pnl_usd":              round(pnl_usd, 4),
        "pnl_pct":              round(pnl_pct, 2),
        "resultado":            result,
        "market_slug":          bet.get("market_slug", ""),
        "simulado":             bet.get("simulated", False),
        "real_exit_odds":       real_exit_odds,
    }


def _fetch_exit_token_price(token_id: str) -> float:
    """Lee el precio CLOB live para calcular P&L real al cerrar posición."""
    if not token_id:
        return 0.0
    try:
        r = requests.get(
            _CLOB_MIDPOINT,
            params={"token_id": token_id},
            timeout=5,
        )
        r.raise_for_status()
        return float(r.json().get("mid", 0.0))
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ No se pudo obtener precio CLOB exit: {e}")
        return 0.0


# ── Estadísticas históricas ───────────────────────────────────────────────────

def _load_historical_stats(csv_path: str) -> dict:
    """Intenta BD primero; si no disponible, cae a CSV local."""
    # Intentar desde Supabase
    if db.is_enabled():
        stats = db.fetch_historical_stats()
        if stats.get("total_ops", 0) > 0:
            return stats

    # Fallback CSV
    empty = {"total_ops": 0, "wins": 0, "losses": 0, "stops": 0,
             "total_pnl": 0.0, "total_invested": 0.0}
    if not os.path.exists(csv_path):
        return empty
    try:
        stats = {**empty}
        with open(csv_path, "r", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                r = (row.get("resultado") or "").upper()
                if r == "WIN":
                    stats["wins"] += 1
                elif r == "LOSS":
                    stats["losses"] += 1
                elif r == "STOP":
                    stats["stops"] += 1
                else:
                    continue
                stats["total_ops"]      += 1
                stats["total_pnl"]      += float(row.get("pnl_usd") or 0)
                stats["total_invested"] += float(row.get("stake_usd") or row.get("stake") or 0)
        return stats
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo CSV: {e}")
        return empty


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
            f"[MONITOR] {i:>2}.  {direction:<5} {window:<6}  "
            f"${entry_btc:>9,.0f}  {tokens:>8.4f}  {entry_odds:>6.4f}  "
            f"{exit_odds:>6.4f}  ${exit_btc:>9,.0f}  {result:<8}{sim}  ${pnl_str:>9}"
        )

    logger.info(_SEPARATOR2)
    sign = "+" if total_pnl >= 0 else ""
    logger.info(f"[MONITOR] P&L hora: {sign}${total_pnl:,.2f} USDC")
    logger.info(_SEPARATOR)
    _log_accumulated_stats(hist_stats, label="ACUMULADO")
    logger.info(_SEPARATOR)


# ── Sincronización de sesión horaria ─────────────────────────────────────────

def _session_id(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d-%H")


def _sync_session_to_db(
    now: datetime,
    market_slug: str,
    hour_wins: int,
    hour_losses: int,
    hour_stops: int,
    hour_pnl: float,
    hour_invested: float,
    simulado: bool,
):
    if not db.is_enabled():
        return
    sid = _session_id(now)
    db.upsert_session(
        session_id  = sid,
        fecha       = now.strftime("%Y-%m-%d"),
        hour_utc    = now.hour,
        market_slug = market_slug or "",
        ops         = hour_wins + hour_losses + hour_stops,
        wins        = hour_wins,
        losses      = hour_losses,
        stops       = hour_stops,
        pnl_usd     = hour_pnl,
        stake_total = hour_invested,
        simulado    = simulado,
    )


# ── Polling de modo desde BD ──────────────────────────────────────────────────

def _read_simulate_mode_from_db(current_simulate: bool) -> bool:
    """
    Lee el modo de operación desde Supabase (bot_config key='trading_mode').
    Si DB no disponible, devuelve el valor actual sin cambios.
    Loguea si el modo cambia.
    """
    try:
        db_mode = db.get_config("trading_mode", None)
        if db_mode is None:
            return current_simulate

        new_simulate = (db_mode == "simulate")
        if new_simulate != current_simulate:
            label_old = "SIMULADO" if current_simulate else "REAL"
            label_new = "SIMULADO" if new_simulate else "REAL"
            logger.warning(
                f"[MONITOR] 🔄 Cambio de modo detectado en BD: {label_old} → {label_new}"
            )
            db.set_config("bot_simulate_active", str(new_simulate).lower())
            db.set_config(
                "bot_mode_ack_at",
                datetime.now(timezone.utc).isoformat()
            )
        return new_simulate
    except Exception as e:
        logger.debug(f"[MONITOR] _read_simulate_mode_from_db: {e}")
        return current_simulate


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    # ── Config ────────────────────────────────────────────────────────────
    csv_path       = cfg.get("logging", {}).get("csv_path", "logs/operaciones.csv")
    interval       = cfg.get("monitor", {}).get("interval_s", 30)
    max_ops        = cfg.get("monitor", {}).get("max_ops_per_day", 4)
    stake          = float(cfg.get("capital", {}).get("stake_usdc", 10))
    stop_pct       = float(cfg.get("strategy", {}).get("stop_loss_pct", 15))
    simulate       = bool(cfg.get("strategy", {}).get("simulate_mode", False))
    t5_sl_interval = cfg.get("monitor", {}).get("t5_sl_interval_s", 1)

    # ── Inicializar Supabase ───────────────────────────────────────────────
    supabase_url = cfg.get("supabase", {}).get("url", "")
    supabase_key = cfg.get("supabase", {}).get("service_key", "")
    db_ok = db.init(supabase_url, supabase_key)
    if not db_ok:
        logger.warning("[MONITOR] Supabase no disponible — usando solo CSV local")

    # v10.0: leer modo desde BD (sobreescribe env var si BD disponible)
    if db_ok:
        simulate = _read_simulate_mode_from_db(simulate)
        db.set_config("bot_simulate_active", str(simulate).lower())
        db.set_config("bot_started_at", datetime.now(timezone.utc).isoformat())

    last_config_check = time.time()

    logger.info(
        f"[MONITOR] 🚀 Iniciando — stake=${stake}  stop={stop_pct}%  "
        f"max_ops={max_ops}  interval={interval}s  "
        f"simulate={'SÍ' if simulate else 'NO'}  "
        f"db={'✅' if db_ok else '❌'}"
    )

    notify_start(cfg)

    # ── Estado inicial ─────────────────────────────────────────────────────
    hist_stats = _load_historical_stats(csv_path)
    _log_accumulated_stats(hist_stats, label="HISTORIAL AL ARRANCAR")
    notify_startup_summary(cfg, hist_stats)

    active_bet               = None
    fired_window             = None
    last_notified_signal_key = None
    prev_mins_left           = None

    ops_hoy        = 0
    session_wins   = 0
    session_losses = 0
    session_pnl    = 0.0
    session_invested = 0.0

    # Contadores por hora para sesión
    hour_wins     = 0
    hour_losses   = 0
    hour_stops    = 0
    hour_pnl      = 0.0
    hour_invested = 0.0
    hour_ops      = []

    now_utc   = datetime.now(timezone.utc)
    last_hour = now_utc.hour
    market    = None
    target    = None
    slug      = None
    price     = 0.0

    _t5_hf_active = False
    cycle_count   = 0

    try:
        while True:
            cycle_count += 1
            now_utc   = datetime.now(timezone.utc)
            mins_left = _mins_to_close()
            hour_utc  = now_utc.hour

            # ── v10.0: Polling de config y comandos cada 60s ───────────────
            now_ts = time.time()
            if db_ok and now_ts - last_config_check >= _CONFIG_POLL_INTERVAL:
                simulate          = _read_simulate_mode_from_db(simulate)
                last_config_check = now_ts
                process_pending_commands(cfg)

            # ── Cambio de hora / cierre de vela ───────────────────────────
            candle_closed = (
                prev_mins_left is not None
                and prev_mins_left < 2
                and mins_left > 50
            ) or (mins_left < 0.5 and active_bet is not None)

            if hour_utc != last_hour or candle_closed:
                if active_bet:
                    # Cierre de vela — resolver apuesta
                    stake_  = active_bet.get("stake", 0)
                    odds_   = active_bet.get("odds", 0.5)
                    sim_    = active_bet.get("simulated", False)
                    tokens_held = round(stake_ / max(odds_, 0.001), 4)

                    # Determinar dirección ganadora
                    mkt_  = active_bet.get("market")
                    won   = False
                    exit_odds = 0.0

                    real_exit_token_id = None
                    if mkt_ and not sim_:
                        direction_ = active_bet.get("direction", "")
                        tokens_   = mkt_.get("tokens", {})
                        if direction_ == "UP":
                            real_exit_token_id = tokens_.get("yes", {}).get("token_id")
                        else:
                            real_exit_token_id = tokens_.get("no", {}).get("token_id")

                    # Precio live de salida
                    real_exit_odds_val = None
                    if real_exit_token_id:
                        real_exit_odds_val = _fetch_exit_token_price(real_exit_token_id)
                        exit_odds = real_exit_odds_val
                        won = exit_odds > 0.95
                    else:
                        # Modo simulado: comparar precio BTC vs target
                        tgt_ = active_bet.get("target", 0)
                        dir_ = active_bet.get("direction", "")
                        if tgt_ and price:
                            if dir_ == "UP":
                                won = price > tgt_
                            else:
                                won = price < tgt_
                        if sim_ and won:
                            exit_odds = 0.98
                        elif sim_:
                            exit_odds = 0.02
                            real_exit_odds_val = 1.0 if won else 0.0

                    if won:
                        retorno_real = round(tokens_held * exit_odds, 4)
                        pnl_usd  = round(retorno_real - stake_, 4)
                        pnl_pct  = round((pnl_usd / stake_) * 100, 2)
                        result   = "WIN"
                        hour_wins    += 1
                        session_wins += 1
                        notify_win(cfg, active_bet, price, simulated=sim_)
                        logger.info(
                            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
                            f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                            f"P&L: +${pnl_usd:.2f} (+{pnl_pct:.1f}%)"
                        )
                        if not sim_:
                            try:
                                redimir_posicion(cfg, active_bet)
                            except Exception as e:
                                logger.warning(f"[MONITOR] ⚠ Claim fallido: {e}")
                        else:
                            logger.info("[MONITOR] [SIMULADO] Claim omitido en modo simulado")
                    else:
                        pnl_usd  = -stake_
                        pnl_pct  = -100.0
                        result   = "LOSS"
                        exit_odds = 0.0
                        hour_losses    += 1
                        session_losses += 1
                        notify_loss(cfg, active_bet, price, simulated=sim_)
                        logger.info(
                            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}❌ LOSS — "
                            f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = $0.00  "
                            f"P&L: -${stake_:.2f} (-100%)"
                        )

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(
                        active_bet, result, ts_now, pnl_usd, pnl_pct, real_exit_odds_val
                    )
                    _csv_write_row(csv_path, row)

                    db.close_operation(
                        op_id            = active_bet.get("id", ""),
                        resultado        = result,
                        pnl_usd          = pnl_usd,
                        pnl_pct          = pnl_pct,
                        odds_salida      = exit_odds,
                        real_exit_odds   = real_exit_odds_val,
                        retorno_real_usd = round(tokens_held * exit_odds, 4) if won else 0.0,
                        ts_cierre        = ts_now,
                    )

                    hour_ops.append({
                        "direction":  active_bet["direction"],
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

                    session_pnl      += pnl_usd
                    session_invested += stake_
                    hour_pnl         += pnl_usd
                    hour_invested    += stake_

                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label=f"TRAS {result}")

                # Sincronizar sesión horaria en BD
                _sync_session_to_db(
                    now           = now_utc,
                    market_slug   = slug,
                    hour_wins     = hour_wins,
                    hour_losses   = hour_losses,
                    hour_stops    = hour_stops,
                    hour_pnl      = hour_pnl,
                    hour_invested = hour_invested,
                    simulado      = simulate,
                )

                notify_hour_summary(cfg, hour_utc, hour_wins, hour_losses, ops_hoy, target, hour_ops)
                _log_hour_ops(last_hour, hour_ops, hist_stats)

                # Reset de hora
                hour_ops      = []
                hour_wins     = 0
                hour_losses   = 0
                hour_stops    = 0
                hour_pnl      = 0.0
                hour_invested = 0.0
                last_hour     = hour_utc
                active_bet    = None
                fired_window  = None
                last_notified_signal_key = None

                notify_new_hour(cfg, hour_utc, slug, target)

            prev_mins_left = mins_left

            # ── Obtener precio BTC ─────────────────────────────────────────
            price = get_btc_price()
            if not price:
                time.sleep(interval)
                continue

            # ── Snapshot de precio (~cada 5 min) ──────────────────────────
            if cycle_count % _SNAPSHOT_EVERY_N_CYCLES == 0:
                db.log_price_snapshot(
                    btc_price    = price,
                    target_price = target,
                    market_slug  = slug,
                    hour_utc     = hour_utc,
                    mins_left    = mins_left,
                )

            # ── Mercado activo ─────────────────────────────────────────────
            new_market = get_active_market()
            if new_market:
                if not market or new_market.get("slug") != slug:
                    notify_market_found(cfg, new_market, mins_left)
                    slug = new_market.get("slug")
                market = new_market
            elif market:
                notify_market_lost(cfg)
                market = None
                slug   = None

            if not market:
                time.sleep(interval)
                continue

            # ── Target (Price to Beat) ─────────────────────────────────────
            target_retries = 0
            while not target and target_retries < MAX_TARGET_RETRIES:
                target = get_open_1h_binance()
                if not target:
                    target_retries += 1
                    if target_retries == 1:
                        notify_target_failed(cfg)
                    time.sleep(TARGET_RETRY_WAIT)

            if not target:
                time.sleep(interval)
                continue

            new_target = get_open_1h_binance()
            if new_target and abs((new_target - target) / target) > 0.001:
                notify_target_change(cfg, target, new_target)
                target = new_target

            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Stop loss de posición activa ───────────────────────────────
            if active_bet:
                entry_price = active_bet.get("entry", price)
                direction_  = active_bet.get("direction", "")
                pnl_pct_btc = (
                    ((price - entry_price) / entry_price) * 100
                    if direction_ == "UP"
                    else ((entry_price - price) / entry_price) * 100
                )

                if pnl_pct_btc <= -stop_pct:
                    stake_  = active_bet.get("stake", 0)
                    odds_   = active_bet.get("odds", 0.5)
                    sim_    = active_bet.get("simulated", False)
                    tokens_held = round(stake_ / max(odds_, 0.001), 4)

                    mkt_       = active_bet.get("market", {})
                    tokens_mkt = mkt_.get("tokens", {})
                    dir_       = active_bet.get("direction", "")
                    token_id   = (
                        tokens_mkt.get("yes", {}).get("token_id")
                        if dir_ == "UP"
                        else tokens_mkt.get("no", {}).get("token_id")
                    )
                    exit_token_price = _fetch_exit_token_price(token_id) if token_id else 0.0
                    entry_odds  = active_bet.get("odds", 0.5)

                    proceeds = tokens_held * exit_token_price
                    pnl_usd  = round(proceeds - stake_, 4)
                    pnl_pct  = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0
                    result   = "STOP"

                    notify_stop_loss(cfg, active_bet, price, pnl_usd, simulated=sim_)

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct, exit_token_price)
                    _csv_write_row(csv_path, row)

                    db.close_operation(
                        op_id            = active_bet.get("id", ""),
                        resultado        = result,
                        pnl_usd          = pnl_usd,
                        pnl_pct          = pnl_pct,
                        odds_salida      = exit_token_price,
                        real_exit_odds   = exit_token_price,
                        retorno_real_usd = proceeds,
                        ts_cierre        = ts_now,
                    )

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

                    session_pnl      += pnl_usd
                    session_invested += stake_
                    hour_pnl         += pnl_usd
                    hour_invested    += stake_
                    session_losses   += 1
                    hour_stops       += 1

                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label="TRAS STOP_LOSS")

                    sign_s = "+" if session_pnl >= 0 else ""
                    logger.info(
                        f"[MONITOR]    P&L sesión : {sign_s}${session_pnl:,.2f} USDC  "
                        f"(invertido ${session_invested:,.2f})\n"
                        f"[MONITOR]    Acumulado  : "
                        f"{'+' if hist_stats['total_pnl'] >= 0 else ''}${hist_stats['total_pnl']:,.2f} USDC"
                    )

                    active_bet               = None
                    fired_window             = None
                    last_notified_signal_key = None
                    time.sleep(interval)
                    continue

            # ── Evaluación de señal ────────────────────────────────────────
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

                # Registrar señales accionables en BD
                if signal.is_actionable:
                    db.log_signal(
                        btc_price    = price,
                        target_price = target,
                        distancia    = round(signal.distance, 2),
                        umbral       = signal.umbral,
                        ventana      = signal.window,
                        direccion    = signal.direction.value,
                        accionable   = True,
                        market_slug  = slug,
                        hour_utc     = hour_utc,
                        mins_left    = mins_left,
                        simulado     = simulate,
                    )

            # ── Ejecutar orden ─────────────────────────────────────────────
            if signal and signal.is_actionable and not active_bet and fired_window != signal.window:
                if ops_hoy < max_ops:
                    result_order = execute_order(signal, market, cfg)

                    if result_order is None:
                        notify_order_failed(cfg, signal)
                        fired_window = signal.window   # evitar retry infinito
                        logger.error(
                            f"[MONITOR] ❌ execute_order devolvió None — "
                            f"ventana {signal.window} marcada como fired"
                        )
                    else:
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
                            f"           Ret. est. : ${retorno_est:.2f}  P&L est: "
                            f"{'+'if pnl_est>=0 else ''}${pnl_est:.2f} ({pct_est:+.1f}%)"
                        )

                        notify_bet(cfg, active_bet, retorno_est, pnl_est, pct_est)

                        # Persistir en Supabase como PENDING
                        db.upsert_operation({
                            "id":                   active_bet["id"],
                            "ts_entrada":           active_bet["ts_entrada"],
                            "direccion":            active_bet["direction"],
                            "ventana":              active_bet["window"],
                            "entry_price":          price,
                            "target_price":         target,
                            "distancia":            round(signal.distance, 2),
                            "umbral":               signal.umbral,
                            "odds_entrada":         entry_odds,
                            "stake_usd":            stake,
                            "tokens_comprados":     tokens_bought,
                            "retorno_estimado_usd": retorno_est,
                            "resultado":            "PENDING",
                            "market_slug":          slug,
                            "simulado":             active_bet["simulated"],
                        })

            # ── Intervalo adaptativo ───────────────────────────────────────
            in_t5 = _in_any_window(mins_left) and mins_left < 7
            if in_t5 and active_bet:
                if not _t5_hf_active:
                    logger.info("[MONITOR] ⚡ T-5 con posición abierta → intervalo 1s")
                    _t5_hf_active = True
                time.sleep(t5_sl_interval)
            else:
                if _t5_hf_active:
                    logger.info(f"[MONITOR] ↩ Saliendo de T-5 HF → intervalo {interval}s")
                    _t5_hf_active = False
                time.sleep(interval)

    except KeyboardInterrupt:
        logger.info("[MONITOR] 🛑 Bot detenido manualmente")
        notify_stop(cfg)
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error fatal: {e}", exc_info=True)
        notify_error(cfg, str(e))
        raise
