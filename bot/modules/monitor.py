"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v10.3 — FIX: tokens es lista, no dict
  - get_active_market() devuelve tokens como lista de dicts con "outcome".
  - En stop-loss y resolución de fin de hora se hacía .get("yes"/{}) sobre
    esa lista, causando AttributeError: 'list' object has no attribute 'get'.
  - Fix: nueva helper _tokens_to_dict() que convierte la lista a dict indexado
    por outcome en minúsculas antes de usarlo en ambos bloques.

v10.2 — DASHBOARD READONLY: publica stake_usdc en bot_config al arrancar
v10.1 — FIX P&L SIMULADO: precio real CLOB en modo simulado
v10.0 — MODO SIMULADO/REAL DINÁMICO DESDE BD
v9.0  — PERSISTENCIA SUPABASE
v8.0  — T-5 alta frecuencia (intervalo 1s con posición abierta)
v7.0  — FIX CRÍTICO: resolución por rollover de minutos
v5.0  — FIXES NOTIFICACIONES
v4.0  — FIXES crash 429 + historial simulado
v3.2  — FIX TELEGRAM modo simulado
v3.0  — Pre-producción fixes
v2.9  — BUG FIX: señal WAIT ya no dispara execute_order
v2.8  — FIX: _fetch_exit_token_price usa CLOB live
v2.7  — Retornos reales desde Polymarket
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
from . import db

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES       = 5
TARGET_RETRY_WAIT        = 10
_CLOB_MIDPOINT           = "https://clob.polymarket.com/midpoint"
_SNAPSHOT_EVERY_N_CYCLES = 10
_CONFIG_POLL_INTERVAL    = 60   # segundos entre lecturas de bot_config


# ── Helpers de tiempo ─────────────────────────────────────────────────────────

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


# ── Precio CLOB de salida ─────────────────────────────────────────────────────

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


# ── FIX v10.3: helper para normalizar tokens (lista → dict) ──────────────────

def _tokens_to_dict(tokens_raw) -> dict:
    """
    get_active_market() devuelve tokens como lista:
      [{"outcome": "Yes", "token_id": "...", "price": 0.62}, {"outcome": "No", ...}]

    Esta función la convierte en dict indexado por outcome en minúsculas:
      {"yes": {"token_id": "...", ...}, "no": {"token_id": "...", ...}}

    Acepta también dict (retrocompatibilidad) y None.
    """
    if isinstance(tokens_raw, dict):
        return tokens_raw
    if isinstance(tokens_raw, list):
        return {t.get("outcome", "").lower(): t for t in tokens_raw if isinstance(t, dict)}
    return {}


# ── Estadísticas históricas ───────────────────────────────────────────────────

def _load_historical_stats(csv_path: str) -> dict:
    """Intenta BD primero; si no disponible, cae a CSV local."""
    if db.is_enabled():
        try:
            stats = db.fetch_historical_stats()
            if stats:
                return stats
        except Exception as e:
            logger.debug(f"[MONITOR] _load_historical_stats DB: {e}")

    # Fallback CSV
    try:
        if not os.path.exists(csv_path):
            return {}
        wins = losses = stops = 0
        pnl_total = invested_total = 0.0
        with open(csv_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                res = row.get("resultado", "")
                pnl = float(row.get("pnl_usd", 0) or 0)
                stk = float(row.get("stake_usd", 0) or 0)
                pnl_total      += pnl
                invested_total += stk
                if res == "WIN":    wins   += 1
                elif res == "LOSS": losses += 1
                elif res == "STOP": stops  += 1
        total = wins + losses + stops
        return {
            "wins": wins, "losses": losses, "stops": stops, "total": total,
            "pnl_total": round(pnl_total, 2),
            "invested":  round(invested_total, 2),
            "win_rate":  round(wins / (wins + losses) * 100, 1) if (wins + losses) > 0 else 0,
        }
    except Exception as e:
        logger.debug(f"[MONITOR] _load_historical_stats CSV: {e}")
        return {}


def _log_accumulated_stats(stats: dict, label: str = "ACUMULADO"):
    if not stats:
        return
    wins  = stats.get("wins", 0)
    loss  = stats.get("losses", 0)
    stops = stats.get("stops", 0)
    total = stats.get("total", wins + loss + stops)
    wr    = stats.get("win_rate", round(wins / (wins + loss) * 100, 1) if (wins + loss) > 0 else 0)
    pnl   = stats.get("pnl_total", 0)
    inv   = stats.get("invested", 0)
    sign  = "+" if pnl >= 0 else ""
    logger.info(
        f"[MONITOR] {label}: "
        f"Total={total}  W={wins} L={loss} S={stops}  WR={wr:.1f}%  "
        f"P&L={sign}${pnl:,.2f}  Inv=${inv:,.2f}"
    )


def _log_hour_table(hour_ops: list):
    if not hour_ops:
        return
    logger.info(_SEPARATOR)
    logger.info(
        f"[MONITOR] {'DIR':<5} {'WIN':<6}  {'ENTRY$':>9}  {'TOKENS':>8}  "
        f"{'E-ODDS':>6}  {'X-ODDS':>6}  {'EXIT$':>9}  {'RESULT':<8}{'SIM':3}  {'P&L':>9}"
    )
    logger.info(_SEPARATOR2)
    total_pnl = 0.0
    for op in hour_ops:
        direction  = op.get("direction", "—")
        window     = op.get("window", "—")
        entry_btc  = op.get("entry_btc", 0)
        tokens     = op.get("tokens", 0)
        entry_odds = op.get("entry_odds", 0)
        exit_odds  = op.get("exit_odds", 0)
        exit_btc   = op.get("exit_btc", 0)
        result     = op.get("result", "—")
        pnl_usd    = op.get("pnl_usd", 0)
        simulated  = op.get("simulated", False)
        sim        = "[S]" if simulated else "   "
        pnl_str    = f"{pnl_usd:+,.2f}"
        total_pnl += pnl_usd
        logger.info(
            f"[MONITOR] {direction:<5} {window:<6}  "
            f"${entry_btc:>9,.0f}  {tokens:>8.4f}  {entry_odds:>6.4f}  "
            f"{exit_odds:>6.4f}  ${exit_btc:>9,.0f}  {result:<8}{sim}  ${pnl_str:>9}"
        )
    logger.info(_SEPARATOR2)
    sign = "+" if total_pnl >= 0 else ""
    logger.info(f"[MONITOR] P&L hora: {sign}${total_pnl:,.2f} USDC")
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
            db.set_config("bot_mode_ack_at", datetime.now(timezone.utc).isoformat())
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
    supabase_url = cfg.get("supabase", {}).get("url",
                   os.environ.get("SUPABASE_URL", ""))
    supabase_key = cfg.get("supabase", {}).get("service_key",
                   os.environ.get("SUPABASE_SERVICE_KEY", ""))
    db_ok = db.init(supabase_url, supabase_key)
    if not db_ok:
        logger.warning("[MONITOR] Supabase no disponible — usando solo CSV local")

    # v10.0: leer modo desde BD (sobreescribe env var si BD disponible)
    if db_ok:
        simulate = _read_simulate_mode_from_db(simulate)
        db.set_config("bot_simulate_active", str(simulate).lower())
        db.set_config("bot_started_at", datetime.now(timezone.utc).isoformat())
        # v10.2: publicar stake para que el dashboard lo lea
        db.set_config("stake_usdc", str(stake))

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
    prev_mins_left           = None  # noqa: F841  (reservado para futuro uso)

    ops_hoy          = 0
    session_wins     = 0
    session_losses   = 0
    session_pnl      = 0.0
    session_invested = 0.0

    hour_wins     = 0
    hour_losses   = 0
    hour_stops    = 0
    hour_pnl      = 0.0
    hour_invested = 0.0
    hour_ops      = []

    now_utc   = datetime.now(timezone.utc)
    last_hour = now_utc.hour

    market  = None
    slug    = None
    target  = None
    price   = None
    cycle_n = 0

    try:
        while True:
            cycle_n += 1

            # ── Modo: polling desde BD cada _CONFIG_POLL_INTERVAL segundos ─
            if db_ok and (time.time() - last_config_check) >= _CONFIG_POLL_INTERVAL:
                simulate          = _read_simulate_mode_from_db(simulate)
                last_config_check = time.time()
                process_pending_commands(cfg)

            # ── Precio BTC ─────────────────────────────────────────────────
            price = get_btc_price()
            if not price:
                logger.warning("[MONITOR] ⚠ Sin precio BTC — esperando")
                time.sleep(interval)
                continue

            # ── Snapshot de precio (cada N ciclos) ────────────────────────
            if db_ok and cycle_n % _SNAPSHOT_EVERY_N_CYCLES == 0:
                try:
                    db.log_price_snapshot(
                        price_btc   = price,
                        market_slug = slug or "",
                        simulado    = simulate,
                    )
                except Exception:
                    pass

            mins_left = _mins_to_close()

            # ── Detección de nueva hora ────────────────────────────────────
            now_utc  = datetime.now(timezone.utc)
            cur_hour = now_utc.hour
            if cur_hour != last_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVA HORA: {cur_hour:02d}:00 UTC")

                # Resumen de la hora que acaba de terminar
                if hour_ops or hour_wins or hour_losses:
                    _log_hour_table(hour_ops)
                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label="ACUMULADO")
                    notify_hour_summary(
                        cfg, last_hour,
                        hour_wins, hour_losses,
                        ops_hoy, target or 0,
                        hour_ops=hour_ops,
                        hist_stats=hist_stats,
                    )
                    _sync_session_to_db(
                        now_utc, slug,
                        hour_wins, hour_losses, hour_stops,
                        hour_pnl, hour_invested, simulate,
                    )

                # Reset contadores horarios
                hour_wins     = 0
                hour_losses   = 0
                hour_stops    = 0
                hour_pnl      = 0.0
                hour_invested = 0.0
                hour_ops      = []
                ops_hoy       = 0
                fired_window  = None
                last_hour     = cur_hour
                target        = None   # forzar recarga del target para la nueva hora

                notify_new_hour(cfg, cur_hour, slug, target)
                logger.info(_SEPARATOR)

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
                notify_target_change(cfg, target, new_target, mins_left)
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
                    stake_      = active_bet.get("stake", 0)
                    odds_       = active_bet.get("odds", 0.5)
                    sim_        = active_bet.get("simulated", False)
                    tokens_held = round(stake_ / max(odds_, 0.001), 4)

                    mkt_        = active_bet.get("market", {})
                    # FIX v10.3 — tokens es lista: convertir a dict por outcome
                    tokens_dict = _tokens_to_dict(mkt_.get("tokens", []))
                    dir_        = active_bet.get("direction", "")
                    token_id    = tokens_dict.get(
                        "yes" if dir_ == "UP" else "no", {}
                    ).get("token_id")

                    exit_token_price = _fetch_exit_token_price(token_id) if token_id else 0.0
                    entry_odds       = active_bet.get("odds", 0.5)

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
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}🛑 STOP LOSS — "
                        f"P&L sesión: {sign_s}${session_pnl:.2f}"
                    )

                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Resolución de fin de hora (posición abierta) ───────────────
            if active_bet and mins_left < 1.0:
                stake_      = active_bet.get("stake", 0)
                sim_        = active_bet.get("simulated", False)
                tokens_held = round(stake_ / max(active_bet.get("odds", 0.5), 0.001), 4)

                mkt_ = active_bet.get("market")
                won  = False

                # FIX v10.3 — tokens es lista: convertir a dict por outcome
                real_exit_token_id = None
                if mkt_:
                    direction_         = active_bet.get("direction", "")
                    tokens_dict        = _tokens_to_dict(mkt_.get("tokens", []))
                    real_exit_token_id = tokens_dict.get(
                        "yes" if direction_ == "UP" else "no", {}
                    ).get("token_id")

                # Precio live de salida (real y simulado usan CLOB)
                real_exit_odds_val = None
                if real_exit_token_id:
                    real_exit_odds_val = _fetch_exit_token_price(real_exit_token_id)
                    exit_odds = real_exit_odds_val
                    won = exit_odds > 0.95
                else:
                    # Fallback: sin token_id — comparar precio BTC vs target
                    tgt_ = active_bet.get("target", 0)
                    dir_ = active_bet.get("direction", "")
                    if tgt_ and price:
                        won = (price > tgt_) if dir_ == "UP" else (price < tgt_)
                    exit_odds          = 0.98 if won else 0.02
                    real_exit_odds_val = exit_odds

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
                            logger.warning(f"[MONITOR] ⚠ redimir_posicion: {e}")
                else:
                    retorno_real = round(tokens_held * exit_odds, 4)
                    pnl_usd  = round(retorno_real - stake_, 4)
                    pnl_pct  = round((pnl_usd / stake_) * 100, 2)
                    result   = "LOSS"
                    hour_losses    += 1
                    session_losses += 1
                    notify_loss(cfg, active_bet, price, simulated=sim_)
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}❌ LOSS — "
                        f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                        f"P&L: ${pnl_usd:.2f} ({pnl_pct:.1f}%)"
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
                    retorno_real_usd = retorno_real,
                    ts_cierre        = ts_now,
                )

                hour_ops.append({
                    "direction":  active_bet["direction"],
                    "window":     active_bet["window"],
                    "entry_btc":  active_bet["entry"],
                    "entry_odds": active_bet["odds"],
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

                active_bet   = None
                fired_window = None
                time.sleep(interval)
                continue

            # ── Evaluación de señal y apertura de posición ─────────────────
            if not active_bet and ops_hoy < max_ops:
                active_window = None
                for w in WINDOWS:
                    if w["min"] <= mins_left < w["max"]:
                        active_window = w
                        break

                if active_window and fired_window != active_window["name"]:
                    signal = evaluate(market, price, target, active_window, cfg)

                    signal_key = f"{active_window['name']}_{signal.direction}"
                    if signal_key != last_notified_signal_key:
                        notify_signal_eval(cfg, signal, price, target, mins_left)
                        last_notified_signal_key = signal_key

                        if db.is_enabled() and signal.is_actionable:
                            try:
                                db.log_signal({
                                    "ts":          datetime.now(timezone.utc).isoformat(),
                                    "ventana":     active_window["name"],
                                    "direccion":   signal.direction,
                                    "distancia":   signal.distance,
                                    "umbral":      signal.umbral,
                                    "accionable":  signal.is_actionable,
                                    "simulado":    simulate,
                                    "market_slug": slug or "",
                                })
                            except Exception:
                                pass

                    if signal.is_actionable:
                        fired_window = active_window["name"]
                        order = execute_order(cfg, market, signal, stake, simulate)

                        if order is None:
                            notify_order_failed(cfg, signal, active_window["name"])
                            logger.error(
                                f"[MONITOR] ❌ execute_order devolvió None — "
                                f"ventana {active_window['name']} descartada"
                            )
                        else:
                            ops_hoy += 1
                            ts_now   = datetime.now(timezone.utc).isoformat()
                            bet_id   = f"{slug}_{active_window['name']}_{ts_now}"

                            active_bet = {
                                "id":          bet_id,
                                "ts_entrada":  ts_now,
                                "direction":   signal.direction,
                                "window":      active_window["name"],
                                "entry":       price,
                                "target":      target,
                                "distance":    signal.distance,
                                "umbral":      signal.umbral,
                                "odds":        order.get("price", 0.5),
                                "stake":       stake,
                                "tokens":      round(stake / max(order.get("price", 0.5), 0.001), 4),
                                "market":      market,
                                "market_slug": slug or "",
                                "simulated":   simulate,
                            }

                            notify_bet(cfg, active_bet, simulated=simulate)

                            try:
                                db.upsert_operation({
                                    "id":               bet_id,
                                    "ts_entrada":       ts_now,
                                    "direccion":        signal.direction,
                                    "ventana":          active_window["name"],
                                    "entry_price":      price,
                                    "target_price":     target,
                                    "distancia":        signal.distance,
                                    "umbral":           signal.umbral,
                                    "odds_entrada":     order.get("price", 0.5),
                                    "stake_usd":        stake,
                                    "tokens_comprados": active_bet["tokens"],
                                    "resultado":        "PENDING",
                                    "market_slug":      slug or "",
                                    "simulado":         simulate,
                                })
                            except Exception as e:
                                logger.warning(f"[MONITOR] ⚠ upsert_operation: {e}")

            # ── Intervalo adaptativo ───────────────────────────────────────
            if active_bet and mins_left < 6:
                time.sleep(t5_sl_interval)
            else:
                time.sleep(interval)

    except KeyboardInterrupt:
        logger.info("[MONITOR] 🛑 Detenido por el usuario")
        notify_stop(cfg)
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error fatal: {e}", exc_info=True)
        notify_error(cfg, str(e))
        raise
