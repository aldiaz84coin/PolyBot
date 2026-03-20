"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v13.0 — FIX CRÍTICO: SELL real en CLOB al activar Stop Loss
  - Al dispararse el SL en modo real (not sim_), se llama a sell_position()
    de strategy.py para cerrar la posición en el CLOB antes de contabilizarla.
  - Precio de venta: midpoint live - 0.005, mínimo 0.90 (igual que sell_fallback_clob).
  - Si sell_position() devuelve None se logea el error pero la contabilidad continúa.
  - En modo simulado el SELL se omite (no hay tokens reales).

v12.0 — ESTRATEGIA ARB EN PARALELO
  - _launch_arb_thread(): lanza arb_monitor.run() como hilo daemon al arrancar.
  - Activación: arb_strategy.enabled: true en config.yaml
    OR arb_enabled="true" en bot_config de Supabase (sin redeploy).
  - El hilo ARB es daemon → se detiene automáticamente si el proceso principal termina.
  - El loop principal no se ve afectado en nada: el ARB corre 100% en paralelo.

v11.2 — FIX CRÍTICO: sincronizar cfg["capital"]["stake_usdc"] tras leer stake desde BD
v11.1 — STAKE DINÁMICO DESDE SUPABASE
v11.0 — CLAIM AUTOMÁTICO CON RETRY + NOTIFICACIONES
v10.9 — FIX CRÍTICO: sincronizar cfg tras cambio de modo
v10.8 — MODO VISIBLE EN CICLO + NOTIFICACIÓN TELEGRAM AL CAMBIAR
v10.7 — DASHBOARD STATE REPORTING
v10.6 — FIX notify_new_hour: target y config de estrategia
v10.5 — notify_stop_loss enriquecida con desglose completo de la operación
v10.4 — FIX KeyError 'name' + corrección de API evaluate / execute_order / notify
v10.3 — FIX: tokens es lista, no dict (_tokens_to_dict helper)
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
from .market_scanner  import get_active_market, get_open_1h_binance
from .strategy        import evaluate, execute_order, Direction, WINDOWS
from .claimer         import redimir_posicion, claim_with_retry
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
_CONFIG_POLL_INTERVAL    = 60  # segundos entre lecturas de bot_config


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


# ── FIX v10.3: helper para normalizar tokens (lista → dict) ──────────────────

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
        stats = db.fetch_historical_stats()
        if stats.get("total_ops", 0) > 0:
            return stats

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
            f"[MONITOR] {i:>2}.  "
            f"{direction:<5} {window:<6}  "
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

def _read_simulate_mode_from_db(current_simulate: bool, cfg: dict) -> bool:
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
            db.set_config("bot_simulate_active", str(new_simulate).lower())
            db.set_config("bot_mode_ack_at", datetime.now(timezone.utc).isoformat())
            notify_mode_change(cfg, label_old, label_new)
        return new_simulate
    except Exception as e:
        logger.debug(f"[MONITOR] _read_simulate_mode_from_db: {e}")
        return current_simulate


# ── v12.0: Lanzar estrategia ARB en hilo paralelo ────────────────────────────

def _launch_arb_thread(cfg: dict, db_ok: bool):
    """Lanza el loop de arbitraje como hilo daemon si está habilitado."""
    enabled_cfg = bool(cfg.get("arb_strategy", {}).get("enabled", False))
    enabled_db  = False
    if db_ok:
        try:
            enabled_db = db.get_config("arb_enabled", "false") == "true"
        except Exception:
            pass

    if not (enabled_cfg or enabled_db):
        logger.info(
            "[MONITOR] ℹ ARB desactivado — para activar: "
            "arb_strategy.enabled: true en config.yaml "
            "o arb_enabled=true en bot_config de Supabase"
        )
        return

    try:
        from .arb_monitor import run as arb_run
        arb_thread = threading.Thread(
            target=arb_run,
            args=(cfg,),
            daemon=True,
            name="arb-loop",
        )
        arb_thread.start()
        logger.info("[MONITOR] 🔀 Loop ARB lanzado en hilo paralelo (daemon)")
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error lanzando loop ARB: {e}")


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
        simulate = _read_simulate_mode_from_db(simulate, cfg)
        # v10.9 FIX: sincronizar cfg para que execute_order() lea el modo correcto
        cfg.setdefault("strategy", {})["simulate_mode"] = simulate
        db.set_config("bot_simulate_active", str(simulate).lower())
        db.set_config("bot_started_at", datetime.now(timezone.utc).isoformat())

        # v11.1: leer stake desde BD — el dashboard puede haberlo cambiado
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

    # v12.0: Lanzar estrategia ARB en hilo daemon paralelo
    _launch_arb_thread(cfg, db_ok)

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
    _t5_hf_active = False

    try:
        while True:
            cycle_n += 1
            now_utc   = datetime.now(timezone.utc)
            mins_left = _mins_to_close()
            hour_utc  = int(now_utc.hour)

            # ── Polling de config desde BD cada _CONFIG_POLL_INTERVAL segundos ─
            if db_ok and (time.time() - last_config_check) >= _CONFIG_POLL_INTERVAL:
                simulate = _read_simulate_mode_from_db(simulate, cfg)
                # v10.9 FIX: sincronizar cfg para que execute_order() lea el modo correcto
                cfg.setdefault("strategy", {})["simulate_mode"] = simulate

                # v11.1: releer stake desde BD por si el dashboard lo cambió
                _db_stake = db.get_config("stake_usdc", None)
                if _db_stake is not None:
                    try:
                        _v = float(_db_stake)
                        if _v > 0:
                            if _v != stake:
                                logger.info(
                                    f"[MONITOR] 💰 Stake desde Supabase: ${_v} "
                                    f"(tenía ${stake})"
                                )
                            stake = _v
                            cfg.setdefault("capital", {})["stake_usdc"] = stake  # v11.2 FIX
                    except ValueError:
                        logger.warning(f"[MONITOR] ⚠ stake_usdc inválido en BD: {_db_stake!r}")

                db.set_config("stake_usdc", str(stake))
                last_config_check = time.time()
                process_pending_commands(cfg)

            # ── Obtener precio BTC ─────────────────────────────────────────
            try:
                price = get_btc_price(cfg)
            except Exception as e:
                logger.warning(f"[MONITOR] Error obteniendo precio BTC: {e}")
                time.sleep(interval)
                continue

            if not price:
                time.sleep(interval)
                continue

            # ── Obtener mercado activo ─────────────────────────────────────
            if market is None:
                try:
                    result_market = get_active_market(cfg)
                    if result_market:
                        if isinstance(result_market, tuple):
                            market, slug = result_market
                        else:
                            market = result_market
                            slug   = market.get("slug", market.get("market_slug", ""))
                        # Obtener target (apertura de vela 1H Binance)
                        target_retries = 0
                        while target is None and target_retries < MAX_TARGET_RETRIES:
                            target = get_open_1h_binance()
                            if target is None:
                                target_retries += 1
                                logger.warning(
                                    f"[MONITOR] ⚠ Target no disponible "
                                    f"(intento {target_retries}/{MAX_TARGET_RETRIES}) — "
                                    f"reintentando en {TARGET_RETRY_WAIT}s"
                                )
                                time.sleep(TARGET_RETRY_WAIT)
                        if not target:
                            logger.error("[MONITOR] ❌ Target no disponible tras reintentos — ciclo siguiente")
                            time.sleep(interval)
                            continue
                        notify_market_found(cfg, slug, target, simulate)
                    else:
                        if slug:
                            notify_market_lost(cfg)
                        slug   = None
                        market = None
                except Exception as e:
                    logger.warning(f"[MONITOR] get_active_market: {e}")

            if not market:
                time.sleep(interval)
                continue

            # ── Refresh de target por si la vela cambió ───────────────────
            if target and cycle_n % 6 == 0:
                try:
                    new_target = get_open_1h_binance()
                    if new_target and abs((new_target - target) / target) > 0.001:
                        notify_target_change(cfg, target, new_target, mins_left)
                        target = new_target
                except Exception:
                    pass

            # ── Log de ciclo ──────────────────────────────────────────────
            _log_cycle(price, target, mins_left, ops_hoy, max_ops, simulate)

            # ── Reportar estado al dashboard ──────────────────────────────
            report_state(
                market        = market,
                target        = target,
                price         = price,
                direction     = active_bet.get("direction") if active_bet else None,
                ops_today     = ops_hoy,
                bet_active    = bool(active_bet),
                simulate_mode = simulate,
            )

            # ── Snapshot de precio (~cada N ciclos) ───────────────────────
            if cycle_n % _SNAPSHOT_EVERY_N_CYCLES == 0 and db_ok:
                try:
                    db.log_price_snapshot(
                        btc_price    = price,
                        target_price = target,
                        market_slug  = slug or "",
                        hour_utc     = hour_utc,
                        mins_left    = mins_left,
                    )
                except Exception:
                    pass

            # ── Stop loss (posición abierta) ──────────────────────────────
            if active_bet:
                stake_      = active_bet.get("stake", 0)
                sim_        = active_bet.get("simulated", False)
                entry_odds  = active_bet.get("odds", 0.5)
                tokens_held = round(stake_ / max(entry_odds, 0.001), 4)

                mkt_       = active_bet.get("market", {})
                tokens_mkt = _tokens_to_dict(mkt_.get("tokens", {})) if mkt_ else {}
                dir_       = active_bet.get("direction", "")
                real_exit_token_id = (
                    tokens_mkt.get("yes", {}).get("token_id")
                    if dir_ == "UP"
                    else tokens_mkt.get("no", {}).get("token_id")
                )

                exit_token_price   = _fetch_exit_token_price(real_exit_token_id) if real_exit_token_id else 0.0
                real_exit_odds_val = exit_token_price if exit_token_price > 0 else None

                if exit_token_price > 0:
                    retorno_actual = tokens_held * exit_token_price
                    pnl_usd_sl     = retorno_actual - stake_
                    pnl_pct_sl     = (pnl_usd_sl / stake_) * 100 if stake_ > 0 else 0
                else:
                    pnl_usd_sl = -stake_
                    pnl_pct_sl = -100.0

                if pnl_pct_sl <= -stop_pct:
                    ts_now       = datetime.now(timezone.utc).isoformat()
                    result       = "STOP"
                    retorno_real = round(tokens_held * exit_token_price, 4) if exit_token_price > 0 else 0.0
                    pnl_usd      = round(retorno_real - stake_, 4)
                    pnl_pct      = round(pnl_pct_sl, 2)

                    # ── v13.0 FIX: ejecutar SELL real en CLOB al activar SL ──
                    if not sim_ and real_exit_token_id and exit_token_price > 0:
                        from .strategy import sell_position
                        sl_sell_price = max(0.90, round(exit_token_price - 0.005, 3))
                        logger.info(
                            f"[MONITOR] 🛑 Stop Loss — ejecutando SELL en CLOB\n"
                            f"          Token    : {real_exit_token_id[:16]}...\n"
                            f"          Tokens   : {tokens_held:.4f}\n"
                            f"          Sell @   : {sl_sell_price:.4f}  (mid={exit_token_price:.4f})"
                        )
                        sl_sell_resp = sell_position(
                            real_exit_token_id, tokens_held, sl_sell_price, cfg, mkt_
                        )
                        if sl_sell_resp is None:
                            logger.error(
                                "[MONITOR] ❌ SELL de stop loss devolvió None — "
                                "posición NO cerrada en CLOB, revisar manualmente"
                            )
                        else:
                            logger.info("[MONITOR] ✅ SELL de stop loss ejecutado en CLOB")
                    elif sim_:
                        logger.info(
                            "[MONITOR] 🔵 [SIMULADO] Stop Loss — SELL omitido (modo simulación)"
                        )
                    else:
                        logger.warning(
                            "[MONITOR] ⚠ Stop Loss — SELL omitido: "
                            "sin token_id o precio CLOB no disponible"
                        )
                    # ── FIN v13.0 FIX ────────────────────────────────────

                    row = _build_trade_row(
                        active_bet, result, ts_now, pnl_usd, pnl_pct, real_exit_odds_val
                    )
                    _csv_write_row(csv_path, row)

                    try:
                        db.close_operation(
                            op_id            = active_bet.get("id", ""),
                            resultado        = result,
                            pnl_usd          = pnl_usd,
                            pnl_pct          = pnl_pct,
                            odds_salida      = exit_token_price,
                            real_exit_odds   = real_exit_odds_val,
                            retorno_real_usd = retorno_real,
                            ts_cierre        = ts_now,
                        )
                    except Exception as e:
                        logger.warning(f"[MONITOR] ⚠ close_operation stop_loss: {e}")

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

                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Resolución de fin de hora (posición abierta, mins < 1) ────
            if active_bet and mins_left < 1.0:
                stake_      = active_bet.get("stake", 0)
                sim_        = active_bet.get("simulated", False)
                entry_odds  = active_bet.get("odds", 0.5)
                tokens_held = round(stake_ / max(entry_odds, 0.001), 4)
                dir_        = active_bet.get("direction", "")

                mkt_       = active_bet.get("market")
                tokens_mkt = _tokens_to_dict(mkt_.get("tokens", {})) if mkt_ else {}
                real_exit_token_id = (
                    tokens_mkt.get("yes", {}).get("token_id")
                    if dir_ == "UP"
                    else tokens_mkt.get("no", {}).get("token_id")
                )

                exit_token_price   = _fetch_exit_token_price(real_exit_token_id) if real_exit_token_id else 0.0
                real_exit_odds_val = exit_token_price if exit_token_price > 0 else None

                if exit_token_price > 0:
                    won       = exit_token_price >= 0.95
                    exit_odds = exit_token_price
                else:
                    won = (
                        (dir_ == "UP"   and price > (active_bet.get("target") or price)) or
                        (dir_ == "DOWN" and price < (active_bet.get("target") or price))
                    )
                    exit_odds = 0.98 if won else 0.02

                retorno_real = round(tokens_held * exit_odds, 4)
                pnl_usd      = round(retorno_real - stake_, 4)
                pnl_pct      = round((pnl_usd / max(stake_, 0.001)) * 100, 2)
                result       = "WIN" if won else "LOSS"
                ts_now       = datetime.now(timezone.utc).isoformat()

                if won:
                    hour_wins    += 1
                    session_wins += 1
                    notify_win(cfg, active_bet, price, simulated=sim_)
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
                        f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                        f"P&L: +${pnl_usd:.2f} (+{pnl_pct:.1f}%)"
                    )
                    if not sim_:
                        threading.Thread(
                            target=claim_with_retry,
                            args=(active_bet, cfg),
                            daemon=True,
                            name=f"claim-{active_bet.get('id', 'x')}",
                        ).start()
                else:
                    hour_losses    += 1
                    session_losses += 1
                    notify_loss(cfg, active_bet, price, simulated=sim_)
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}❌ LOSS — "
                        f"Tokens: {tokens_held:.4f} × {exit_odds:.4f} = ${retorno_real:.2f}  "
                        f"P&L: ${pnl_usd:.2f} ({pnl_pct:.1f}%)"
                    )

                row = _build_trade_row(
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
                    f"{'+' if hist_stats['total_pnl'] >= 0 else ''}${hist_stats['total_pnl']:,.2f} USDC"
                )

                active_bet               = None
                fired_window             = None
                last_notified_signal_key = None
                time.sleep(interval)
                continue

            # ── Cambio de hora (sin posición abierta) ─────────────────────
            if hour_utc != last_hour:
                hist_stats = _load_historical_stats(csv_path)

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
                hour_wins     = 0
                hour_losses   = 0
                hour_stops    = 0
                hour_pnl      = 0.0
                hour_invested = 0.0
                hour_ops      = []
                ops_hoy       = 0
                last_hour     = hour_utc

                # Reset de mercado/target para nueva hora
                active_bet               = None
                fired_window             = None
                last_notified_signal_key = None
                market                   = None
                slug                     = None
                target                   = None

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
                            f"({'+' if pnl_est >= 0 else ''}{pct_est:.1f}%)"
                        )

                        notify_bet(cfg, active_bet)

                        if db_ok:
                            try:
                                db.upsert_operation(
                                    op_id       = active_bet["id"],
                                    direccion   = active_bet["direction"],
                                    ventana     = active_bet["window"],
                                    btc_entry   = price,
                                    btc_target  = target,
                                    distancia   = round(signal.distance, 2),
                                    umbral      = signal.umbral,
                                    odds        = entry_odds,
                                    stake_usd   = stake,
                                    tokens      = tokens_bought,
                                    retorno_est = retorno_est,
                                    market_slug = slug or "",
                                    hour_utc    = hour_utc,
                                    simulado    = active_bet["simulated"],
                                    ts_entrada  = active_bet["ts_entrada"],
                                )
                            except Exception as e:
                                logger.warning(f"[MONITOR] ⚠ upsert_operation: {e}")
                else:
                    logger.info(f"[MONITOR] 🚫 Límite diario alcanzado ({max_ops} ops)")

            # ── Intervalo adaptativo ───────────────────────────────────────
            _in_t5 = _in_any_window(mins_left)
            if active_bet and _in_t5:
                if not _t5_hf_active:
                    logger.info(f"[MONITOR] ⚡ Alta frecuencia activada (T-5, {t5_sl_interval}s)")
                    _t5_hf_active = True
                time.sleep(t5_sl_interval)
            else:
                if _t5_hf_active:
                    logger.info("[MONITOR] 🐢 Volviendo a intervalo normal")
                    _t5_hf_active = False
                time.sleep(interval)

    except KeyboardInterrupt:
        logger.info("[MONITOR] ⛔ KeyboardInterrupt — deteniendo bot")
        report_offline()
        notify_stop(cfg)
    except Exception as e:
        logger.error(f"[MONITOR] ❌ Error fatal en loop: {e}", exc_info=True)
        report_offline()
        notify_error(cfg, str(e))
        raise
