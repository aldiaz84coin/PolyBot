"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v10.4 — FIX KeyError 'name' + corrección de API evaluate / execute_order / notify
  - Bloque de evaluación de señal completamente reescrito con la API correcta:
    · evaluate(price, target, mins_left, cfg)  ← elimina active_window["name"]
    · execute_order(signal, market, cfg)        ← firma corregida
    · notify_order_failed(cfg, signal)          ← sin args extra
    · notify_signal_eval con kwargs posicionales correctos
    · db.log_signal con kwargs en vez de dict
    · active_bet["direction"] almacena signal.direction.value (string, no enum)
  - _t5_hf_active: log explícito de entrada/salida del modo T-5 HF

v10.3 — FIX: tokens es lista, no dict
  - get_active_market() devuelve tokens como lista de dicts con "outcome".
  - Fix: _tokens_to_dict() convierte la lista a dict indexado por outcome
    antes de usarlo en stop-loss y resolución de fin de hora.

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

from .price_feed      import get_btc_price
from .market_scanner  import get_active_market, get_open_1h_binance
from .strategy        import evaluate, execute_order, Direction, WINDOWS
from .claimer         import redimir_posicion
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
      [{"outcome": "Yes", "token_id": "...", "price": 0.62}, ...]
    Convierte a dict indexado por outcome en minúsculas:
      {"yes": {"token_id": "...", ...}, "no": {...}}
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
            "wins":     wins,
            "losses":   losses,
            "stops":    stops,
            "total":    total,
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
    _t5_hf_active = False   # v10.4: tracking para log de entrada/salida T-5 HF

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
            now_utc   = datetime.now(timezone.utc)
            cur_hour  = now_utc.hour
            hour_utc  = cur_hour   # alias para uso en log_signal / notify

            # ── Detección de nueva hora ────────────────────────────────────
            if cur_hour != last_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVA HORA: {cur_hour:02d}:00 UTC")

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
                        now_utc, slug or "",
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
                        notify_target_failed(cfg, cur_hour)
                    logger.warning(
                        f"[MONITOR] ⚠ Target no disponible "
                        f"(intento {target_retries}/{MAX_TARGET_RETRIES})"
                    )
                    time.sleep(TARGET_RETRY_WAIT)

            if not target:
                logger.error("[MONITOR] ❌ Target no disponible tras reintentos — ciclo siguiente")
                time.sleep(interval)
                continue

            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Stop loss (posición abierta) ───────────────────────────────
            if active_bet:
                stake_      = active_bet.get("stake", 0)
                sim_        = active_bet.get("simulated", False)
                entry_odds  = active_bet.get("odds", 0.5)
                tokens_held = round(stake_ / max(entry_odds, 0.001), 4)

                mkt_       = active_bet.get("market")
                tokens_mkt = _tokens_to_dict(mkt_.get("tokens", {})) if mkt_ else {}
                dir_       = active_bet.get("direction", "")
                token_id   = (
                    tokens_mkt.get("yes", {}).get("token_id")
                    if dir_ == "UP"
                    else tokens_mkt.get("no", {}).get("token_id")
                )
                exit_token_price = _fetch_exit_token_price(token_id) if token_id else 0.0

                if exit_token_price > 0:
                    proceeds = tokens_held * exit_token_price
                    pnl_usd  = round(proceeds - stake_, 4)
                    pnl_pct  = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0

                    if pnl_pct <= -stop_pct:
                        result = "STOP"
                        ts_now = datetime.now(timezone.utc).isoformat()
                        row    = _build_trade_row(
                            active_bet, result, ts_now, pnl_usd, pnl_pct, exit_token_price
                        )
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
                            logger.warning(f"[MONITOR] ⚠ close_operation STOP: {e}")

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

                        notify_stop_loss(cfg, active_bet, price, pnl_usd, simulated=sim_)
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
                entry_odds  = active_bet.get("odds", 0.5)
                tokens_held = round(stake_ / max(entry_odds, 0.001), 4)
                dir_        = active_bet.get("direction", "")

                mkt_  = active_bet.get("market")

                # FIX v10.3 — tokens es lista: convertir a dict por outcome
                tokens_mkt = _tokens_to_dict(mkt_.get("tokens", {})) if mkt_ else {}
                real_exit_token_id = (
                    tokens_mkt.get("yes", {}).get("token_id")
                    if dir_ == "UP"
                    else tokens_mkt.get("no", {}).get("token_id")
                )

                # v10.1 FIX: precio real CLOB tanto en live como simulado
                real_exit_odds_val = (
                    _fetch_exit_token_price(real_exit_token_id)
                    if real_exit_token_id else 0.0
                )

                won = False
                if price and target:
                    price_went_up = price > target
                    won = (dir_ == "UP" and price_went_up) or (dir_ == "DOWN" and not price_went_up)

                # Fallback si no hay precio CLOB disponible
                if real_exit_odds_val <= 0:
                    exit_odds = 0.98 if won else 0.02
                else:
                    exit_odds = real_exit_odds_val

                retorno_real = tokens_held * exit_odds
                pnl_usd      = round(retorno_real - stake_, 4)
                pnl_pct      = round((pnl_usd / stake_) * 100, 2) if stake_ > 0 else 0.0
                result       = "WIN" if won else "LOSS"

                if won:
                    session_wins += 1
                    hour_wins    += 1
                    notify_win(cfg, active_bet, price, simulated=sim_)
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
                        f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                        f"P&L: ${pnl_usd:.2f} ({pnl_pct:.1f}%)"
                    )
                else:
                    session_losses += 1
                    hour_losses    += 1
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
                    logger.warning(f"[MONITOR] ⚠ close_operation fin-hora: {e}")

                hour_ops.append({
                    "direction":  active_bet["direction"],
                    "window":     active_bet["window"],
                    "entry_btc":  active_bet["entry"],
                    "entry_odds": entry_odds,
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
                    f"{'+' if hist_stats.get('pnl_total', 0) >= 0 else ''}"
                    f"${hist_stats.get('pnl_total', 0):,.2f} USDC"
                )

                active_bet               = None
                fired_window             = None
                last_notified_signal_key = None
                time.sleep(interval)
                continue

            # ── Evaluación de señal ────────────────────────────────────────
            # v10.4 FIX: evaluate() recibe (price, target, mins_left, cfg)
            # Devuelve Signal (con .window, .direction, .is_actionable) o None.
            # Ya NO se itera WINDOWS manualmente ni se usa active_window["name"].
            signal = evaluate(price, target, mins_left, cfg)

            if signal:
                signal_key = (signal.window, signal.direction.value)
                if signal_key != last_notified_signal_key:
                    notify_signal_eval(
                        cfg,
                        price, target,
                        signal.distance, signal.umbral,
                        signal.window, signal.direction.value,
                        mins_left,
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
                    # v10.4 FIX: execute_order(signal, market, cfg)
                    result_order = execute_order(signal, market, cfg)

                    if result_order is None:
                        # v10.4 FIX: notify_order_failed(cfg, signal) sin args extra
                        notify_order_failed(cfg, signal)
                        fired_window = signal.window   # evitar retry infinito
                        logger.error(
                            f"[MONITOR] ❌ execute_order devolvió None — "
                            f"ventana {signal.window} marcada como fired"
                        )
                    else:
                        ops_hoy       += 1
                        entry_odds     = result_order.get("odds", 0.5)
                        tokens_bought  = round(stake / max(entry_odds, 0.001), 4)

                        # v10.4 FIX: direction almacenada como string (.value), no enum
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
                            "market_slug": slug or "",
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

                        # v10.4 FIX: notify_bet(cfg, bet, signal) — firma correcta
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
                            })
                        except Exception as e:
                            logger.warning(f"[MONITOR] ⚠ upsert_operation: {e}")
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
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error fatal: {e}", exc_info=True)
        notify_error(cfg, str(e))
        raise
