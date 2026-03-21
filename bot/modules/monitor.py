"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v12.0 — DATALAB (cero llamadas nuevas a APIs):
  - Al inicio de cada hora, get_1h_candle_full() sustituye a get_open_1h_binance()
    → misma única llamada a Binance, ahora se captura el dict completo.
    → db.log_btc_candle() persiste open/high/low/close/volume/trades.
  - En el loop principal, cada _TOKEN_LOG_INTERVAL segundos (30s por defecto):
    → db.log_token_price() persiste YES/NO CLOB midpoint, ventana, BTC spot, target.
    → Los datos ya están en memoria (market dict), cero llamadas adicionales.

v11.3 — FIX CRÍTICO: ejecutar SELL CLOB al disparar Stop Loss
v11.2 — FIX CRÍTICO: sincronizar cfg["capital"]["stake_usdc"] tras leer stake desde BD
v11.1 — STAKE DINÁMICO DESDE SUPABASE
v11.0 — CLAIM AUTOMÁTICO CON RETRY + NOTIFICACIONES
v10.9 — FIX CRÍTICO: sincronizar cfg tras cambio de modo
v10.8 — MODO VISIBLE EN CICLO + NOTIFICACIÓN TELEGRAM AL CAMBIAR
v10.7 — DASHBOARD STATE REPORTING
v10.3 — FIX: tokens es lista, no dict (_tokens_to_dict helper)
v10.1 — FIX P&L SIMULADO: precio real CLOB en modo simulado
v10.0 — MODO SIMULADO/REAL DINÁMICO DESDE BD
v9.0  — PERSISTENCIA SUPABASE
v8.0  — T-5 alta frecuencia

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
from .market_scanner  import get_active_market, get_open_1h_binance, get_1h_candle_full
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

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES       = 5
TARGET_RETRY_WAIT        = 10
_CLOB_MIDPOINT           = "https://clob.polymarket.com/midpoint"
_SNAPSHOT_EVERY_N_CYCLES = 10
_CONFIG_POLL_INTERVAL    = 60   # segundos entre lecturas de bot_config

# ── v12.0 DataLab ─────────────────────────────────────────────────────────────
_TOKEN_LOG_INTERVAL = 30        # segundos entre registros de precio de token en Supabase


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


# ── Helper: normalizar tokens (lista → dict) ──────────────────────────────────

def _tokens_to_dict(tokens_raw) -> dict:
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
            return db.fetch_historical_stats()
        except Exception as e:
            logger.debug(f"[MONITOR] _load_historical_stats BD: {e}")

    # Fallback CSV
    stats = {"total_ops": 0, "wins": 0, "losses": 0, "stops": 0, "total_pnl": 0.0}
    try:
        if not os.path.exists(csv_path):
            return stats
        with open(csv_path, "r", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                resultado = row.get("resultado", "")
                if resultado in ("WIN", "LOSS", "STOP"):
                    stats["total_ops"] += 1
                    if resultado == "WIN":   stats["wins"]   += 1
                    elif resultado == "LOSS": stats["losses"] += 1
                    elif resultado == "STOP": stats["stops"]  += 1
                    try:
                        stats["total_pnl"] += float(row.get("pnl_usd") or 0)
                    except ValueError:
                        pass
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo CSV stats: {e}")
    return stats


def _log_accumulated_stats(stats: dict, label: str = "ACUMULADO"):
    total = stats.get("total_ops", 0)
    wins  = stats.get("wins", 0)
    wr    = int(wins / total * 100) if total > 0 else 0
    pnl   = stats.get("total_pnl", 0)
    logger.info(
        f"[MONITOR] {label}: "
        f"{total} ops  {wins}W/{stats.get('losses',0)}L/{stats.get('stops',0)}S  "
        f"WR={wr}%  P&L={'+' if pnl>=0 else ''}${pnl:,.2f}"
    )


def _log_hour_ops(hour_utc: int, hour_ops: list, hist_stats: dict):
    if not hour_ops:
        return
    total = len(hour_ops)
    wins  = sum(1 for o in hour_ops if o.get("result") == "WIN")
    pnl   = sum(o.get("pnl_usd", 0) for o in hour_ops)
    logger.info(
        f"[MONITOR] Hora {hour_utc:02d}h — {total} ops  "
        f"{wins}W/{total-wins}L  P&L={'+' if pnl>=0 else ''}${pnl:,.2f}"
    )
    _log_accumulated_stats(hist_stats)


# ── Sincronización de sesión horaria con BD ───────────────────────────────────

def _sync_session_to_db(
    now, market_slug, hour_wins, hour_losses, hour_stops,
    hour_pnl, hour_invested, simulado,
):
    if not db.is_enabled():
        return
    try:
        session_id = now.strftime("%Y-%m-%d-%H")
        fecha      = now.date().isoformat()
        hour_utc   = now.hour
        db.upsert_session(
            session_id  = session_id,
            fecha       = fecha,
            hour_utc    = hour_utc,
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
        logger.debug(f"[MONITOR] _sync_session_to_db: {e}")


# ── Modo simulado desde BD ────────────────────────────────────────────────────

def _read_simulate_mode_from_db(current_simulate: bool, cfg: dict = None) -> bool:
    """
    Lee trading_mode desde Supabase.
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

    if db_ok:
        simulate = _read_simulate_mode_from_db(simulate)
        cfg.setdefault("strategy", {})["simulate_mode"] = simulate
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
                    cfg.setdefault("capital", {})["stake_usdc"] = stake
            except ValueError:
                logger.warning(f"[MONITOR] ⚠ stake_usdc inválido en BD: {_db_stake!r}")

        db.set_config("stake_usdc", str(stake))
        db.set_config("funder_address", cfg.get("polymarket", {}).get("funder", ""))

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

    market        = None
    slug          = None
    target        = None
    price         = None
    cycle_n       = 0
    hour_utc      = now_utc.hour
    _t5_hf_active = False

    # ── v12.0 DataLab: estado de logging ──────────────────────────────────
    _last_token_log_ts  = 0.0    # timestamp del último log_token_price
    _candle_logged_hour = -1     # hora UTC de la última vela registrada

    try:
        while True:
            cycle_n += 1

            # ── Polling de config desde BD cada _CONFIG_POLL_INTERVAL seg ──
            if db_ok and (time.time() - last_config_check) >= _CONFIG_POLL_INTERVAL:
                simulate = _read_simulate_mode_from_db(simulate, cfg)
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
                            cfg.setdefault("capital", {})["stake_usdc"] = stake
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
                    notify_hour_summary(
                        cfg, last_hour,
                        hour_wins, hour_losses,
                        ops_hoy, target or 0,
                        hour_ops   = hour_ops,
                        hist_stats = hist_stats,
                    )
                    _sync_session_to_db(
                        now_utc, slug or "",
                        hour_wins, hour_losses, hour_stops,
                        hour_pnl, hour_invested, simulate,
                    )

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

                # ── v12.0: Obtener vela completa + target en UNA sola llamada ──
                # get_1h_candle_full() hace exactamente la misma llamada a Binance
                # que antes hacía get_open_1h_binance(). La diferencia es que ahora
                # no descartamos high/low/close/volume/trades.
                target = None
                target_retries = 0
                _candle_data = None

                while not target and target_retries < MAX_TARGET_RETRIES:
                    _candle_data = get_1h_candle_full(slug)
                    if _candle_data:
                        target = _candle_data.get("open_price")
                    if not target:
                        target_retries += 1
                        if target_retries == 1:
                            notify_target_failed(cfg, cur_hour)
                        logger.warning(
                            f"[MONITOR] ⚠ Target no disponible (intento {target_retries}/{MAX_TARGET_RETRIES})"
                        )
                        time.sleep(TARGET_RETRY_WAIT)

                if target:
                    logger.info(f"[MONITOR] 🎯 Target hora {cur_hour:02d}h: ${target:,.2f}")

                    # ── v12.0: Persistir vela completa en Supabase ────────
                    if db_ok and _candle_data and cur_hour != _candle_logged_hour:
                        try:
                            db.log_btc_candle(
                                hour_utc     = cur_hour,
                                fecha        = now_utc.date().isoformat(),
                                market_slug  = slug or "",
                                open_price   = _candle_data.get("open_price", target),
                                high_price   = _candle_data.get("high_price"),
                                low_price    = _candle_data.get("low_price"),
                                close_price  = _candle_data.get("close_price"),
                                volume_btc   = _candle_data.get("volume_btc"),
                                volume_usdt  = _candle_data.get("volume_usdt"),
                                trades_count = _candle_data.get("trades_count"),
                                open_time_ms = _candle_data.get("open_time_ms"),
                                simulado     = simulate,
                            )
                            _candle_logged_hour = cur_hour
                            logger.info(
                                f"[MONITOR] 📊 Vela {cur_hour:02d}h guardada — "
                                f"vol={_candle_data.get('volume_btc', 0):.1f}BTC  "
                                f"trades={_candle_data.get('trades_count', 0):,}"
                            )
                        except Exception as _e:
                            logger.warning(f"[MONITOR] ⚠ log_btc_candle: {_e}")
                else:
                    logger.error("[MONITOR] ❌ Target no disponible tras reintentos — esperando")

                notify_new_hour(cfg, cur_hour, slug, target)
                time.sleep(interval)
                continue

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

            # ── Target (si aún no disponible — fuera del cambio de hora) ──
            if not target:
                target_retries = 0
                while not target and target_retries < MAX_TARGET_RETRIES:
                    _cd = get_1h_candle_full(slug)
                    if _cd:
                        target = _cd.get("open_price")
                        # Log de vela si aún no se hizo esta hora
                        if db_ok and target and cur_hour != _candle_logged_hour:
                            try:
                                db.log_btc_candle(
                                    hour_utc     = cur_hour,
                                    fecha        = now_utc.date().isoformat(),
                                    market_slug  = slug or "",
                                    open_price   = _cd.get("open_price", target),
                                    high_price   = _cd.get("high_price"),
                                    low_price    = _cd.get("low_price"),
                                    close_price  = _cd.get("close_price"),
                                    volume_btc   = _cd.get("volume_btc"),
                                    volume_usdt  = _cd.get("volume_usdt"),
                                    trades_count = _cd.get("trades_count"),
                                    open_time_ms = _cd.get("open_time_ms"),
                                    simulado     = simulate,
                                )
                                _candle_logged_hour = cur_hour
                            except Exception:
                                pass
                    if not target:
                        target_retries += 1
                        if target_retries == 1:
                            notify_target_failed(cfg, cur_hour)
                        time.sleep(TARGET_RETRY_WAIT)

            if not target:
                logger.error("[MONITOR] ❌ Target no disponible — ciclo siguiente")
                time.sleep(interval)
                continue

            # Detección de cambio de target (usando get_open_1h_binance para no
            # hacer una llamada a la API completa, solo el float)
            new_target = get_open_1h_binance(slug)
            if new_target and abs((new_target - target) / target) > 0.001:
                notify_target_change(cfg, target, new_target, mins_left)
                target = new_target

            _log_cycle(price, target, mins_left, ops_hoy, max_ops, simulate)


            # ── Reportar estado al dashboard (v10.7 restaurado en v12.0) ──
            _active_win_rep = next(
                (w["key"] for w in WINDOWS if w["min"] <= mins_left < w["max"]),
                None,
            )
            _signal_rep = evaluate(price, target, mins_left, cfg)
            report_state(
                market        = market,
                target        = target,
                price         = price,
                direction     = _signal_rep.direction.value if _signal_rep else None,
                window        = _active_win_rep,
                ops_today     = ops_hoy,
                bet_active    = active_bet is not None,
                simulate_mode = simulate,
            )
            # ── v12.0: Log precio de tokens YES/NO (throttle ~30s) ────────
            # Los datos ya están en market (dict en memoria) — cero llamadas nuevas
            _now_ts = time.time()
            if db_ok and market and (_now_ts - _last_token_log_ts) >= _TOKEN_LOG_INTERVAL:
                try:
                    tokens_dict  = _tokens_to_dict(market.get("tokens", []))
                    yes_tok      = tokens_dict.get("yes", {})
                    no_tok       = tokens_dict.get("no",  {})
                    yes_price_v  = market.get("yes_price") or 0.0
                    no_price_v   = market.get("no_price")  or 0.0
                    # Ventana activa en este momento
                    active_win = next(
                        (w["key"] for w in WINDOWS if w["min"] <= mins_left < w["max"]),
                        None,
                    )
                    if yes_price_v or no_price_v:   # solo loguear si tenemos precios
                        db.log_token_price(
                            hour_utc     = hour_utc,
                            market_slug  = slug or "",
                            yes_token_id = yes_tok.get("token_id", ""),
                            no_token_id  = no_tok.get("token_id",  ""),
                            yes_price    = yes_price_v,
                            no_price     = no_price_v,
                            ventana      = active_win,
                            mins_left    = mins_left,
                            btc_price    = price,
                            btc_target   = target,
                            simulado     = simulate,
                        )
                    _last_token_log_ts = _now_ts
                except Exception as _e:
                    logger.warning(f"[MONITOR] ⚠ log_token_price: {_e}")

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
                    tokens_mkt = _tokens_to_dict(mkt_.get("tokens", []))
                    dir_       = active_bet.get("direction", "")
                    token_id   = (
                        tokens_mkt.get("yes", {}).get("token_id")
                        if dir_ == "UP"
                        else tokens_mkt.get("no", {}).get("token_id")
                    )

                    exit_token_price = _fetch_exit_token_price(token_id) if token_id else 0.0

                    # v11.3: ejecutar SELL en CLOB en modo REAL antes de contabilizar
                    if not sim_ and token_id and exit_token_price > 0:
                        try:
                            sell_price = max(0.01, round(exit_token_price - 0.005, 3))
                            sell_resp  = sell_position(token_id, tokens_held, sell_price, cfg, mkt_)
                            if sell_resp:
                                logger.info(f"[MONITOR] ✅ SELL CLOB ejecutado al stop — precio {sell_price:.4f}")
                            else:
                                logger.error("[MONITOR] ❌ sell_position devolvió None en stop loss")
                        except Exception as _se:
                            logger.error(f"[MONITOR] ❌ sell_position excepción: {_se}")

                    real_exit = exit_token_price if exit_token_price else odds_
                    pnl_usd   = round((real_exit - odds_) * tokens_held, 4)
                    pnl_pct_f = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0

                    ts_cierre  = datetime.now(timezone.utc).isoformat()
                    trade_row  = _build_trade_row(
                        active_bet, "STOP", ts_cierre, pnl_usd, pnl_pct_f, real_exit
                    )
                    _csv_write_row(csv_path, trade_row)

                    if db_ok:
                        try:
                            db.close_operation(
                                op_id          = active_bet.get("id", ""),
                                resultado      = "STOP",
                                pnl_usd        = pnl_usd,
                                pnl_pct        = pnl_pct_f,
                                odds_salida    = exit_token_price,
                                real_exit_odds = real_exit,
                                ts_cierre      = ts_cierre,
                            )
                        except Exception as _e:
                            logger.warning(f"[MONITOR] ⚠ close_operation STOP: {_e}")

                    hour_stops   += 1
                    hour_pnl     += pnl_usd
                    session_pnl  += pnl_usd
                    hour_ops.append({**trade_row, "result": "STOP"})

                    op_entry = {
                        "direction":  dir_,
                        "window":     active_bet.get("window", "—"),
                        "entry_odds": odds_,
                        "exit_odds":  real_exit,
                        "tokens":     tokens_held,
                        "result":     "STOP",
                        "pnl_usd":   pnl_usd,
                        "simulated":  sim_,
                    }
                    notify_stop_loss(cfg, active_bet, op_entry, exit_token_price, pnl_usd)

                    active_bet   = None
                    fired_window = None
                    last_notified_signal_key = None
                    time.sleep(interval)
                    continue

            # ── Evaluación de señal ────────────────────────────────────────
            # Reutiliza el evaluate() ya llamado para report_state (evita doble llamada)
            signal = _signal_rep

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
                        fired_window = signal.window
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
                            f"           Ret. est. : ${retorno_est:.2f}  "
                            f"P&L est: {'+'if pnl_est>=0 else ''}${pnl_est:.2f} ({pct_est:+.1f}%)"
                        )

                        notify_bet(cfg, active_bet, signal)

                        if db_ok:
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
                                })
                            except Exception as _e:
                                logger.warning(f"[MONITOR] ⚠ upsert_operation: {_e}")
                else:
                    logger.info(
                        f"[MONITOR] ⛔ Señal {signal.direction.value} en {signal.window} — "
                        f"límite diario alcanzado ({ops_hoy}/{max_ops})"
                    )

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
