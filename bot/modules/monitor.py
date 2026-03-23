"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v11.4 — DATALAB: inserción en token_price_log y btc_candle_data
  - Importa get_full_1h_candle() desde .market_scanner.
  - Nueva constante _TOKEN_LOG_EVERY_N_CYCLES = 6 (~30s con interval=5s).
  - Nueva variable _candle_logged_h para garantizar una sola vela por hora.
  - Al detectar nueva hora: llama db.log_btc_candle() con datos OHLCV completos.
  - Cada _TOKEN_LOG_EVERY_N_CYCLES ciclos: llama db.log_token_price() con
    precios YES/NO del mercado activo, ventana actual, BTC price y target.
  - Ambas llamadas están en try/except — nunca bloquean el loop.

v11.3 — FIX CRÍTICO: ejecutar SELL CLOB al disparar Stop Loss
  - Al detectar pnl_pct <= -stop_pct en modo LIVE (not sim_), se llama
    sell_position() para cerrar la posición en el CLOB ANTES de registrar
    el STOP contablemente.
  - sell_position añadido a la línea de imports de .strategy.
  - Precio de venta: max(0.01, round(exit_token_price - 0.005, 3))
    El pequeño margen (-0.005) asegura que la orden cruce el spread y haga fill.
  - En modo simulado el SELL no se ejecuta (no hay tokens reales que vender).
  - Si sell_position() devuelve None o lanza excepción, se logea el error
    pero el ciclo cierra la operación contablemente igualmente (STOP).

v11.2 — FIX CRÍTICO: sincronizar cfg["capital"]["stake_usdc"] tras leer stake desde BD
v11.1 — STAKE DINÁMICO DESDE SUPABASE
v11.0 — CLAIM AUTOMÁTICO CON RETRY + NOTIFICACIONES
v10.9 — FIX CRÍTICO: sincronizar cfg tras cambio de modo
v10.8 — MODO VISIBLE EN CICLO + NOTIFICACIÓN TELEGRAM AL CAMBIAR
v10.7 — DASHBOARD STATE REPORTING
v10.6 — FIX notify_new_hour
v10.5 — notify_stop_loss enriquecida
v10.4 — FIX KeyError 'name' + corrección de API
v10.3 — FIX: tokens es lista, no dict (_tokens_to_dict helper)
v10.2 — DASHBOARD READONLY: publica stake_usdc en bot_config al arrancar
v10.1 — FIX P&L SIMULADO: precio real CLOB en modo simulado
v10.0 — MODO SIMULADO/REAL DINÁMICO DESDE BD
v9.0  — PERSISTENCIA SUPABASE
v8.0  — T-5 alta frecuencia
v7.0  — FIX rollover de minutos
v5.0  — FIXES NOTIFICACIONES

Destino: bot/modules/monitor.py
"""
import csv
import logging
import os
import threading
import time
from datetime import datetime, timezone

import requests

from .price_feed      import get_btc_price
from .market_scanner  import get_active_market, get_open_1h_binance, get_full_1h_candle
from .strategy        import evaluate, execute_order, sell_position, Direction, WINDOWS
from .claimer         import claim_with_retry
from .notifier        import (
    notify_start, notify_stop,
    notify_bet, notify_win, notify_loss, notify_stop_loss,
    notify_target_change, notify_target_failed,
    notify_market_found, notify_market_lost,
    notify_signal_eval,
    notify_hour_summary, notify_new_hour,
    notify_error,
    notify_startup_summary,
    notify_order_failed,
    notify_mode_change,
)
from .command_handler import process_pending_commands
from .state_reporter  import report_state, report_offline
from . import db
from . import boost_fetcher

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES        = 5
TARGET_RETRY_WAIT         = 10
_CLOB_MIDPOINT            = "https://clob.polymarket.com/midpoint"
_SNAPSHOT_EVERY_N_CYCLES  = 10   # ~50s con interval=5s
_TOKEN_LOG_EVERY_N_CYCLES = 6    # ~30s con interval=5s  ← v11.4
_CONFIG_POLL_INTERVAL     = 60   # segundos entre lecturas de bot_config

# BoostPower: lecturas capturadas por ventana en la hora activa
_boost_readings:        dict = {}    # {"T-20": 0.38, "T-15": 0.41, ...}
_boost_fetched_windows: set  = set() # ventanas ya consultadas esta hora


# ── Helpers de tiempo ─────────────────────────────────────────────────────────

def _in_any_window(mins_left: float) -> bool:
    for w in WINDOWS:
        if w["min"] <= mins_left < w["max"]:
            return True
    return False


def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def _log_cycle(price, target, mins_left, ops_hoy, max_ops, simulate: bool = True):
    dist_str = "—"
    if price and target:
        dist     = price - target
        dist_str = f"{dist:+,.0f}"
    modo = "SIM" if simulate else "REAL"
    logger.info(
        f"[MONITOR] [{modo}] Ciclo — "
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
        "distancia":            bet.get("distance", ""),
        "umbral":               bet.get("umbral", ""),
        "odds":                 odds,
        "stake_usd":            stake,
        "tokens_comprados":     round(stake / max(odds, 0.001), 4),
        "retorno_estimado_usd": retorno,
        "pnl_usd":              pnl_usd,
        "pnl_pct":              pnl_pct,
        "resultado":            result,
        "market_slug":          bet.get("market_slug", ""),
        "simulado":             bet.get("simulated", False),
        "real_exit_odds":       real_exit_odds or "",
    }


# ── Precio de salida CLOB ─────────────────────────────────────────────────────

def _fetch_exit_token_price(token_id: str) -> float:
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


# ── Helper: tokens lista → dict ───────────────────────────────────────────────

def _tokens_to_dict(tokens) -> dict:
    """Convierte tokens (lista o dict) a {yes: {...}, no: {...}}."""
    if isinstance(tokens, dict):
        return tokens
    result = {}
    for t in (tokens or []):
        outcome = (t.get("outcome") or "").lower()
        if outcome in ("yes", "up"):
            result["yes"] = t
        elif outcome in ("no", "down"):
            result["no"] = t
    return result


# ── Estadísticas históricas ───────────────────────────────────────────────────

def _load_historical_stats(csv_path: str) -> dict:
    """Intenta BD primero; si no disponible, cae a CSV local."""
    if db.is_enabled():
        stats = db.fetch_historical_stats()
        if stats.get("total_ops", 0) > 0:
            return stats

    empty = {
        "total_ops": 0, "wins": 0, "losses": 0, "stops": 0,
        "total_pnl": 0.0, "invested": 0.0,
    }
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
                stats["total_ops"] += 1
                stats["total_pnl"] += float(row.get("pnl_usd") or 0)
                stats["invested"]  += float(row.get("stake_usd") or row.get("stake") or 0)
        wl = stats["wins"] + stats["losses"]
        stats["win_rate"] = round(stats["wins"] / wl * 100, 1) if wl > 0 else 0
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ _load_historical_stats CSV: {e}")
    return stats


def _log_accumulated_stats(stats: dict, label: str = "ACUMULADO"):
    wins  = stats.get("wins", 0)
    loss  = stats.get("losses", 0)
    stops = stats.get("stops", 0)
    total = stats.get("total_ops", wins + loss + stops)
    wr    = stats.get("win_rate", round(wins / (wins + loss) * 100, 1) if (wins + loss) > 0 else 0)
    pnl   = stats.get("total_pnl", 0)
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
        tokens     = op.get("tokens", 0)
        entry_odds = op.get("entry_odds", 0)
        exit_odds  = op.get("exit_odds", 0)
        exit_btc   = op.get("exit_btc", 0)
        result     = op.get("result", "—")
        pnl_usd    = op.get("pnl_usd", 0)
        simulated  = op.get("simulated", False)
        sim        = " [S]" if simulated else "    "
        pnl_str    = f"{'+' if pnl_usd >= 0 else ''}{pnl_usd:,.2f}"
        total_pnl += pnl_usd
        logger.info(
            f"[MONITOR] {i:>2}.  "
            f"{direction:<5} {window:<6}  "
            f"${entry_btc:>9,.0f}  {tokens:>8.4f}  {entry_odds:>6.4f}  "
            f"{exit_odds:>6.4f}  ${exit_btc:>9,.0f}  {result:<8}{sim}  ${pnl_str:>9}"
        )
    logger.info(_SEPARATOR2)
    sign = "+" if total_pnl >= 0 else ""
    logger.info(f"[MONITOR] P&L hora: {sign}${total_pnl:,.2f} USDC")
    logger.info(_SEPARATOR)


def _log_hour_ops(hour_utc, hour_ops: list, hist_stats: dict):
    _log_hour_table(hour_ops)
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
    try:
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
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ _sync_session_to_db: {e}")


# ── Polling de modo desde BD ──────────────────────────────────────────────────

def _read_simulate_mode_from_db(current_simulate: bool, cfg: dict = None) -> bool:
    """
    Lee el modo de operación desde Supabase (bot_config key='trading_mode').
    Si DB no disponible, devuelve el valor actual sin cambios.
    v10.8: acepta cfg para llamar notify_mode_change() al detectar cambio.
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
            if cfg:
                try:
                    notify_mode_change(cfg, label_old, label_new)
                except Exception:
                    pass
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
    supabase_url = cfg.get("supabase", {}).get("url", "")
    supabase_key = cfg.get("supabase", {}).get("service_key", "")
    db_ok = db.init(supabase_url, supabase_key)
    if not db_ok:
        logger.warning("[MONITOR] Supabase no disponible — usando solo CSV local")

    # v10.0: leer modo desde BD (sobreescribe env var si BD disponible)
    if db_ok:
        simulate = _read_simulate_mode_from_db(simulate, cfg)
        cfg.setdefault("strategy", {})["simulate_mode"] = simulate  # v10.9 FIX
        db.set_config("bot_simulate_active", str(simulate).lower())
        db.set_config("bot_started_at", datetime.now(timezone.utc).isoformat())

        # v11.1: leer stake desde BD al arrancar
        _db_stake = db.get_config("stake_usdc", None)
        if _db_stake is not None:
            try:
                _v = float(_db_stake)
                if _v > 0:
                    if _v != stake:
                        logger.info(
                            f"[MONITOR] 💰 Stake desde Supabase: ${_v} "
                            f"(config.yaml tenía ${stake})"
                        )
                    stake = _v
                    cfg.setdefault("capital", {})["stake_usdc"] = stake  # v11.2 FIX
            except ValueError:
                logger.warning(f"[MONITOR] ⚠ stake_usdc inválido en BD: {_db_stake!r}")

        db.set_config("stake_usdc", str(stake))
        db.set_config("funder_address", cfg.get("polymarket", {}).get("funder", ""))

    last_config_check = time.time()

    # BoostPower (Crypto Detector v4) — opcional, sin bloquear el bot
    boost_fetcher.init(
        base_url = cfg.get("boost_power_url") or "",
        mode     = cfg.get("boost_power_mode", "normal"),
    )

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

    now_utc          = datetime.now(timezone.utc)
    last_hour        = now_utc.hour
    _candle_logged_h = -1          # v11.4: hora UTC de la última vela registrada

    market        = None
    slug          = None
    target        = None
    price         = None
    cycle_n       = 0
    hour_utc      = now_utc.hour
    mins_left     = _mins_to_close()
    _t5_hf_active = False

    try:
        while True:
            cycle_n += 1

            # ── Polling de config desde BD cada _CONFIG_POLL_INTERVAL seg ──
            if db_ok and (time.time() - last_config_check) >= _CONFIG_POLL_INTERVAL:
                simulate = _read_simulate_mode_from_db(simulate, cfg)
                # v10.9 FIX: sincronizar cfg para que execute_order() lea el modo correcto
                cfg.setdefault("strategy", {})["simulate_mode"] = simulate

                # v11.1: releer stake desde BD por si el dashboard lo cambió
                _db_stake = db.get_config("stake_usdc", None)
                if _db_stake is not None:
                    try:
                        _v = float(_db_stake)
                        if _v > 0 and _v != stake:
                            logger.info(
                                f"[MONITOR] 💰 Stake actualizado desde BD: "
                                f"${stake} → ${_v}"
                            )
                            stake = _v
                            cfg.setdefault("capital", {})["stake_usdc"] = stake  # v11.2 FIX
                    except ValueError:
                        pass

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
                        btc_price    = price,
                        target_price = target,
                        market_slug  = slug or "",
                        hour_utc     = hour_utc,
                        mins_left    = _mins_to_close(),
                    )
                except Exception:
                    pass

            mins_left = _mins_to_close()
            now_utc   = datetime.now(timezone.utc)
            cur_hour  = now_utc.hour
            hour_utc  = cur_hour

            # ── Detección de nueva hora ────────────────────────────────────
            if cur_hour != last_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVA HORA: {cur_hour:02d}:00 UTC")

                if hour_ops or hour_wins or hour_losses or hour_stops:
                    hist_stats = _load_historical_stats(csv_path)
                    _log_hour_ops(last_hour, hour_ops, hist_stats)
                    _sync_session_to_db(
                        now_utc, slug or "",
                        hour_wins, hour_losses, hour_stops,
                        hour_pnl, hour_invested, simulate,
                    )
                    notify_hour_summary(
                        cfg, last_hour,
                        hour_wins, hour_losses,
                        ops_hoy, target or 0,
                        hour_ops   = hour_ops,
                        hist_stats = hist_stats,
                    )

                # v11.4 ── DataLab: registrar vela 1H completa al inicio de hora ──
                if db_ok and _candle_logged_h != cur_hour:
                    try:
                        candle = get_full_1h_candle(slug)
                        if candle:
                            db.log_btc_candle(
                                hour_utc     = cur_hour,
                                fecha        = now_utc.strftime("%Y-%m-%d"),
                                market_slug  = slug or "",
                                simulado     = simulate,
                                **candle,
                            )
                            _candle_logged_h = cur_hour
                    except Exception as _e:
                        logger.debug(f"[MONITOR] log_btc_candle: {_e}")

                # Reset de hora
                hour_ops      = []
                hour_wins     = 0
                hour_losses   = 0
                hour_stops    = 0
                hour_pnl      = 0.0
                hour_invested = 0.0
                ops_hoy       = 0
                last_hour     = cur_hour
                active_bet    = None
                fired_window  = None
                last_notified_signal_key = None
                _boost_readings.clear()
                _boost_fetched_windows.clear()

                notify_new_hour(cfg, cur_hour, slug, target)

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
                target = get_open_1h_binance(slug)
                if not target:
                    target_retries += 1
                    if target_retries == 1:
                        notify_target_failed(cfg)
                    time.sleep(TARGET_RETRY_WAIT)

            if not target:
                logger.error("[MONITOR] ❌ Target no disponible tras reintentos — ciclo siguiente")
                time.sleep(interval)
                continue

            new_target = get_open_1h_binance(slug)
            if new_target and abs((new_target - target) / target) > 0.001:
                notify_target_change(cfg, target, new_target, mins_left)
                target = new_target

            _log_cycle(price, target, mins_left, ops_hoy, max_ops, simulate)

            # ── DataLab: precio CLOB tokens YES/NO (~cada 30s) ─────────────
            # v11.4: log_token_price() throttleado por _TOKEN_LOG_EVERY_N_CYCLES
            if db_ok and cycle_n % _TOKEN_LOG_EVERY_N_CYCLES == 0:
                try:
                    tokens_list = market.get("tokens", [])
                    yes_tok = next((t for t in tokens_list if t.get("outcome") == "Yes"), None)
                    no_tok  = next((t for t in tokens_list if t.get("outcome") == "No"),  None)
                    if yes_tok and yes_tok.get("token_id") and yes_tok.get("price"):
                        # Detectar ventana actual
                        ventana_actual = None
                        for w in WINDOWS:
                            if w["min"] <= mins_left < w["max"]:
                                ventana_actual = w.get("label") or w.get("name")
                                break
                        db.log_token_price(
                            hour_utc     = int(hour_utc),
                            market_slug  = slug or "",
                            yes_token_id = yes_tok.get("token_id", ""),
                            no_token_id  = no_tok.get("token_id", "") if no_tok else "",
                            yes_price    = float(yes_tok.get("price", 0)),
                            no_price     = float(no_tok.get("price", 0)) if no_tok else 0.0,
                            ventana      = ventana_actual,
                            mins_left    = mins_left,
                            btc_price    = price,
                            btc_target   = target,
                            simulado     = simulate,
                        )
                except Exception as _e:
                    logger.debug(f"[MONITOR] log_token_price: {_e}")

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

                    mkt_       = active_bet.get("market", {})
                    tokens_mkt = _tokens_to_dict(mkt_.get("tokens", []) if mkt_ else [])
                    dir_       = active_bet.get("direction", "")
                    token_id   = (
                        tokens_mkt.get("yes", {}).get("token_id")
                        if dir_ == "UP"
                        else tokens_mkt.get("no", {}).get("token_id")
                    )

                    exit_token_price = _fetch_exit_token_price(token_id) if token_id else 0.0

                    # v11.3: ejecutar SELL en CLOB si modo LIVE
                    if not sim_ and token_id and exit_token_price > 0:
                        try:
                            sell_price = max(0.01, round(exit_token_price - 0.005, 3))
                            sell_result = sell_position(
                                token_id    = token_id,
                                size        = tokens_held,
                                price       = sell_price,
                                cfg         = cfg,
                                market      = mkt_,
                            )
                            if sell_result is None:
                                logger.error("[MONITOR] ⚠ sell_position devolvió None — stop contabilizado igualmente")
                            else:
                                logger.info(f"[MONITOR] ✅ SELL CLOB ejecutado: {sell_result}")
                        except Exception as _se:
                            logger.error(f"[MONITOR] ⚠ sell_position error: {_se} — stop contabilizado igualmente")

                    proceeds = tokens_held * exit_token_price
                    pnl_usd  = round(proceeds - stake_, 4)
                    pnl_pct  = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0
                    result   = "STOP"

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct, exit_token_price)
                    _csv_write_row(csv_path, row)

                    try:
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
                    except Exception as e:
                        logger.warning(f"[MONITOR] ⚠ close_operation (STOP): {e}")

                    hour_ops.append({
                        "direction":  active_bet["direction"],
                        "window":     active_bet.get("window", "—"),
                        "entry_btc":  active_bet.get("entry", 0),
                        "entry_odds": odds_,
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

                    notify_stop_loss(
                        cfg, active_bet, price, pnl_usd,
                        pnl_pct          = pnl_pct,
                        exit_token_price = exit_token_price,
                        stop_pct         = stop_pct,
                        simulated        = sim_,
                    )
                    sign_s = "+" if session_pnl >= 0 else ""
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}🛑 STOP LOSS — "
                        f"P&L sesión: {sign_s}${session_pnl:.2f}"
                    )

                    active_bet               = None
                    fired_window             = None
                    last_notified_signal_key = None
                    time.sleep(interval)
                    continue

            # ── Resolución de fin de hora (posición abierta) ───────────────
            if active_bet and mins_left < 1.0:
                stake_      = active_bet.get("stake", 0)
                sim_        = active_bet.get("simulated", False)
                entry_odds  = active_bet.get("odds", 0.5)
                tokens_held = round(stake_ / max(entry_odds, 0.001), 4)
                dir_        = active_bet.get("direction", "")

                mkt_       = active_bet.get("market")
                tokens_mkt = _tokens_to_dict(mkt_.get("tokens", []) if mkt_ else [])
                real_exit_token_id = (
                    tokens_mkt.get("yes", {}).get("token_id")
                    if dir_ == "UP"
                    else tokens_mkt.get("no", {}).get("token_id")
                )

                # v10.1 FIX: simulado también consulta el CLOB real
                real_exit_price = _fetch_exit_token_price(real_exit_token_id) if real_exit_token_id else 0.0

                # Determinar resultado: WIN si precio del token ganador ≈ 1.0
                if real_exit_price >= 0.95:
                    exit_odds         = real_exit_price
                    real_exit_odds_val = real_exit_price
                    retorno_real      = round(tokens_held * exit_odds, 4)
                    pnl_usd           = round(retorno_real - stake_, 4)
                    pnl_pct           = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0
                    result            = "WIN"
                    hour_wins        += 1
                    session_wins     += 1
                    notify_win(cfg, active_bet, price, simulated=sim_)
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
                        f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                        f"P&L: ${pnl_usd:.2f} ({pnl_pct:.1f}%)"
                    )

                    # v11.0: claim automático en modo LIVE
                    # v11.5 FIX: orden de args corregido (era cfg, active_bet, token_id)
                    if not sim_ and real_exit_token_id:
                        _bet_for_claim = active_bet
                        def _do_claim():
                            try:
                                claim_with_retry(_bet_for_claim, cfg)
                            except TypeError as _te:
                                logger.error(f"[MONITOR] ❌ claim TypeError (firma incorrecta): {_te}", exc_info=True)
                            except Exception as _ce:
                                logger.error(f"[MONITOR] ❌ claim error: {_ce}", exc_info=True)
                        threading.Thread(target=_do_claim, daemon=True, name=f"claim-{active_bet.get('id','x')}").start()

                else:
                    exit_odds         = real_exit_price
                    real_exit_odds_val = real_exit_price
                    retorno_real      = round(tokens_held * max(exit_odds, 0.0), 4)
                    pnl_usd           = round(retorno_real - stake_, 4)
                    pnl_pct           = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0
                    result            = "LOSS"
                    hour_losses      += 1
                    session_losses   += 1
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

                try:
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
                except Exception as e:
                    logger.warning(f"[MONITOR] ⚠ close_operation: {e}")

                hour_ops.append({
                    "direction":  active_bet["direction"],
                    "window":     active_bet.get("window", "—"),
                    "entry_btc":  active_bet.get("entry", 0),
                    "entry_odds": active_bet.get("odds", 0),
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

            # ── BoostPower: capturar al entrar en cada ventana ────────────
            if boost_fetcher.is_enabled():
                for _w in WINDOWS:
                    if _w["min"] <= mins_left < _w["max"]:
                        _wkey = _w["key"]
                        if _wkey not in _boost_fetched_windows:
                            _boost_fetched_windows.add(_wkey)
                            _bp = boost_fetcher.fetch(_wkey)
                            if _bp is not None:
                                _boost_readings[_wkey] = _bp
                        break

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

                if signal.is_actionable and db_ok:
                    try:
                        db.log_signal(
                            btc_price    = price,
                            target_price = target,
                            distancia    = round(signal.distance, 2),
                            umbral       = signal.umbral,
                            ventana      = signal.window,
                            direccion    = signal.direction.value,
                            accionable   = True,
                            market_slug  = slug or "",
                            hour_utc     = hour_utc,
                            mins_left    = mins_left,
                            simulado     = simulate,
                        )
                    except Exception:
                        pass

            # ── Ejecutar orden ─────────────────────────────────────────────
            if (
                signal
                and signal.is_actionable
                and not active_bet
                and fired_window != signal.window
            ):
                if ops_hoy < max_ops:
                    result_order = execute_order(signal, market, cfg)

                    if result_order is None:
                        notify_order_failed(cfg, signal)
                        fired_window = signal.window  # evitar retry infinito
                        logger.error(
                            f"[MONITOR] ❌ execute_order devolvió None — "
                            f"ventana {signal.window} marcada, no se reintentará"
                        )
                    else:
                        entry_odds   = result_order.get("odds", signal.distance)
                        tokens_bought = round(stake / max(entry_odds, 0.001), 4)
                        retorno_est  = round(tokens_bought, 4)
                        pnl_est      = round(retorno_est - stake, 4)
                        pct_est      = round((pnl_est / stake) * 100, 2) if stake > 0 else 0.0

                        active_bet = {
                            "id":          result_order.get("id", f"bet-{int(time.time())}"),
                            "ts_entrada":  datetime.now(timezone.utc).isoformat(),
                            "direction":   signal.direction.value,
                            "window":      signal.window,
                            "entry":       price,
                            "target":      target,
                            "distance":    signal.distance,
                            "umbral":      signal.umbral,
                            "odds":        entry_odds,
                            "stake":       stake,
                            "market":      market,
                            "market_slug": slug or "",
                            "simulated":   simulate,
                            "boost_readings": dict(_boost_readings),
                        }
                        ops_hoy      += 1
                        fired_window  = signal.window

                        logger.info(
                            f"[MONITOR] {'[SIMULADO] ' if simulate else ''}🟢 APUESTA {signal.direction.value} — "
                            f"Ventana: {signal.window}  "
                            f"Odds: {entry_odds:.4f}  Stake: ${stake}  "
                            f"Tokens: {tokens_bought:.4f}  "
                            f"Retorno est.: ${retorno_est:.2f}  "
                            f"P&L est: {'+'if pnl_est>=0 else ''}${pnl_est:.2f} ({pct_est:+.1f}%)"
                        )

                        notify_bet(cfg, active_bet, signal)

                        try:
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
                                "market_slug":          slug or "",
                                "simulado":             active_bet["simulated"],
                                "boost_t20": active_bet["boost_readings"].get("T-20"),
                                "boost_t15": active_bet["boost_readings"].get("T-15"),
                                "boost_t10": active_bet["boost_readings"].get("T-10"),
                                "boost_t5":  active_bet["boost_readings"].get("T-5"),
                            })
                        except Exception as e:
                            logger.warning(f"[MONITOR] ⚠ upsert_operation: {e}")
                else:
                    logger.info(
                        f"[MONITOR] ⛔ Señal {signal.direction.value} en {signal.window} — "
                        f"límite diario alcanzado ({ops_hoy}/{max_ops})"
                    )

            # ── Dashboard state reporting ──────────────────────────────────
            try:
                report_state(
                    market        = market,
                    target        = target,
                    price         = price,
                    ops_today     = ops_hoy,
                    bet_active    = active_bet is not None,
                    simulate_mode = simulate,
                )
            except Exception:
                pass

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
        logger.info("[MONITOR] 🛑 Detenido por el usuario")
        notify_stop(cfg)
        report_offline()
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error fatal: {e}", exc_info=True)
        notify_error(cfg, str(e))
        report_offline()
        raise
