"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v2.6 — Historial persistente y stats acumuladas:
  - _load_historical_stats(): lee el CSV al arrancar y muestra el acumulado
    total (ops, invertido, P&L neto, W/L, win-rate) antes del primer ciclo
  - notify_startup_summary(): envía las stats acumuladas por Telegram al inicio
  - notify_hour_summary(): incluye ahora P&L de la sesión + P&L acumulado
  - Resumen de sesión al detener (Ctrl+C) incluye P&L de la sesión

v2.5 — Polling adaptativo, CSV de operaciones, detalles monetarios.
FIX: mercado se obtiene ANTES que el target para pasar el slug a Binance.
"""
import csv
import logging
import os
import time
from datetime import datetime, timezone

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
    notify_hour_summary,
    notify_error,
)

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES = 5
TARGET_RETRY_WAIT  = 10

_WINDOW_POLL_S = 1


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
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error escribiendo CSV: {e}")


def _build_trade_row(bet, result, ts_cierre, pnl_usd, pnl_pct):
    stake   = bet.get("stake", 0)
    odds    = bet.get("odds", 0.5)
    retorno = round(stake / odds, 2) if odds > 0 else 0
    return {
        "id":                    bet.get("id", ""),
        "ts_entrada":            bet.get("ts_entrada", ""),
        "ts_cierre":             ts_cierre,
        "direccion":             bet.get("direction", ""),
        "ventana":               bet.get("window", ""),
        "entry_price":           bet.get("entry", ""),
        "target_price":          bet.get("target", ""),
        "distancia":             round(bet.get("distance", 0), 2),
        "umbral":                bet.get("umbral", ""),
        "odds":                  odds,
        "stake_usd":             stake,
        "tokens_comprados":      bet.get("tokens", ""),
        "retorno_estimado_usd":  retorno,
        "pnl_usd":               round(pnl_usd, 2),
        "pnl_pct":               round(pnl_pct, 2),
        "resultado":             result,
        "market_slug":           bet.get("market_slug", ""),
        "simulado":              bet.get("simulated", False),
    }


# ── Historial acumulado ───────────────────────────────────────────────────────

def _load_historical_stats(csv_path: str) -> dict:
    """
    Lee el CSV de operaciones cerradas y devuelve las stats acumuladas.
    Solo cuenta filas con resultado WIN, LOSS o STOP (no PENDING).
    """
    stats = {
        "total_ops":      0,
        "wins":           0,
        "losses":         0,
        "stops":          0,
        "total_invested": 0.0,
        "total_pnl":      0.0,
    }
    if not os.path.exists(csv_path):
        return stats

    try:
        with open(csv_path, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                resultado = row.get("resultado", "").upper()
                if resultado not in ("WIN", "LOSS", "STOP"):
                    continue
                stats["total_ops"] += 1
                try:
                    stats["total_invested"] += float(row.get("stake_usd") or 0)
                    stats["total_pnl"]      += float(row.get("pnl_usd")   or 0)
                except ValueError:
                    pass
                if resultado == "WIN":
                    stats["wins"] += 1
                elif resultado == "LOSS":
                    stats["losses"] += 1
                elif resultado == "STOP":
                    stats["stops"] += 1
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo historial CSV: {e}")

    return stats


def _log_accumulated_stats(stats: dict):
    """Muestra las stats acumuladas en el log al arrancar el bot."""
    total    = stats["total_ops"]
    wins     = stats["wins"]
    losses   = stats["losses"] + stats["stops"]
    wr       = round(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    invested = stats["total_invested"]
    pnl      = stats["total_pnl"]
    sign     = "+" if pnl >= 0 else ""

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 📊 HISTORIAL ACUMULADO (CSV)")
    logger.info(f"[MONITOR]   Operaciones cerradas : {total}")
    logger.info(f"[MONITOR]   W / L+STOP           : {wins}W / {losses}L")
    logger.info(f"[MONITOR]   Win Rate              : {wr}%")
    logger.info(f"[MONITOR]   Total invertido       : ${invested:,.2f} USDC")
    logger.info(f"[MONITOR]   P&L neto acumulado    : {sign}${pnl:,.2f} USDC")
    logger.info(_SEPARATOR)


# ── Target con reintentos ─────────────────────────────────────────────────────

def _fetch_target_with_retry(cfg: dict, hour_utc: int, slug: str | None = None) -> float | None:
    for attempt in range(1, MAX_TARGET_RETRIES + 1):
        try:
            t = get_open_1h_binance(slug=slug)
            if t:
                return t
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ Target intento {attempt}/{MAX_TARGET_RETRIES}: {e}")
        if attempt < MAX_TARGET_RETRIES:
            time.sleep(TARGET_RETRY_WAIT)
    notify_target_failed(cfg, hour_utc)
    return None


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    stake      = cfg["capital"]["stake_usdc"]
    max_ops    = cfg["capital"]["max_operaciones_dia"]
    interval   = cfg["strategy"].get("monitor_intervalo_s", 5)
    stop_pct   = cfg["strategy"].get("stop_loss_pct", 0.5)
    csv_path   = cfg.get("logging", {}).get("historial_csv", "logs/operaciones.csv")

    # ── Cargar y mostrar historial acumulado ──────────────────────────────
    hist_stats  = _load_historical_stats(csv_path)
    _log_accumulated_stats(hist_stats)

    # Acumuladores de sesión (se suman al histórico para totales)
    session_pnl      = 0.0
    session_invested = 0.0
    session_wins     = 0
    session_losses   = 0

    # Variables de control
    target       = None
    prev_target  = None
    hour_wins    = 0
    hour_losses  = 0
    ops_hoy      = 0
    active_bet   = None
    fired_window = None
    prev_hour    = None
    prev_market  = None

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 🚀 Bot iniciado — stake=${stake} USDC  max_ops={max_ops}/día")
    logger.info(f"[MONITOR]    Stop loss: {stop_pct*100:.0f}%  Intervalo: {interval}s")
    logger.info(_SEPARATOR)
    notify_start(cfg)

    try:
        while True:
            now       = datetime.now(timezone.utc)
            mins_left = 60 - now.minute - now.second / 60
            cur_hour  = now.hour

            # ── Reinicio horario ──────────────────────────────────────────
            if prev_hour is not None and cur_hour != prev_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 Hora {prev_hour:02d}:00 UTC finalizada")
                logger.info(f"[MONITOR]    Sesión esta hora: {hour_wins}W / {hour_losses}L")

                # P&L acumulado total (histórico + sesión actual)
                total_pnl = hist_stats["total_pnl"] + session_pnl
                sign_t    = "+" if total_pnl >= 0 else ""
                sign_s    = "+" if session_pnl >= 0 else ""
                logger.info(
                    f"[MONITOR]    P&L sesión         : {sign_s}${session_pnl:,.2f} USDC "
                    f"(invertido ${session_invested:,.2f})"
                )
                logger.info(
                    f"[MONITOR]    P&L acumulado total: {sign_t}${total_pnl:,.2f} USDC"
                )
                logger.info(_SEPARATOR)

                notify_hour_summary(
                    cfg, prev_hour,
                    wins=hour_wins,
                    losses=hour_losses,
                    ops=hour_wins + hour_losses,
                    target=target or 0,
                )

                hour_wins   = 0
                hour_losses = 0
                target      = None
                active_bet  = None
                fired_window = None

            prev_hour = cur_hour

            # ── Mercado activo ────────────────────────────────────────────
            try:
                market = get_active_market()
            except Exception as e:
                logger.warning(f"[MONITOR] ⚠ Error obteniendo mercado: {e}")
                market = None

            if market and not prev_market:
                logger.info(f"[MONITOR] 🟢 Mercado detectado: {market.get('slug', '—')}")
                notify_market_found(cfg, market, mins_left)
            elif not market and prev_market:
                logger.warning(f"[MONITOR] 🔴 Mercado perdido")
                notify_market_lost(cfg, prev_market)

            prev_market = market
            slug = market.get("slug") if market else None

            if not market:
                time.sleep(interval)
                continue

            # ── Price to Beat ─────────────────────────────────────────────
            new_target = _fetch_target_with_retry(cfg, cur_hour, slug=slug)
            if new_target and new_target != prev_target:
                if prev_target:
                    logger.info(
                        f"[MONITOR] 🎯 Target actualizado: "
                        f"${prev_target:,.2f} → ${new_target:,.2f}"
                    )
                    notify_target_change(cfg, prev_target, new_target)
                else:
                    logger.info(f"[MONITOR] 🎯 Price to Beat: ${new_target:,.2f}")
                target      = new_target
                prev_target = new_target

            if not target:
                time.sleep(interval)
                continue

            # ── Precio BTC ────────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.warning(f"[MONITOR] ⚠ Error obteniendo precio: {e}")
                time.sleep(interval)
                continue

            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Stop loss ─────────────────────────────────────────────────
            if active_bet:
                dir_   = active_bet["direction"]
                stake_ = active_bet["stake"]
                pnl    = ((price - active_bet["entry"]) / active_bet["entry"] * 100
                          if dir_ == "UP"
                          else (active_bet["entry"] - price) / active_bet["entry"] * 100)

                if pnl <= -stop_pct * 100:
                    loss_usd = round(stake_ * (-stop_pct), 2)
                    logger.warning(
                        f"[MONITOR] 🛑 STOP LOSS —\n"
                        f"           P&L       : {pnl:+.2f}%  ({loss_usd:+.2f} USD)"
                    )
                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, "STOP", ts_now, loss_usd, -stop_pct * 100)
                    _csv_write_row(csv_path, row)

                    session_pnl      += loss_usd
                    session_invested += stake_
                    session_losses   += 1

                    notify_stop_loss(cfg, active_bet, price, pnl)
                    active_bet   = None
                    fired_window = None
                    hour_losses  += 1
                    time.sleep(interval)
                    continue

                # Resolución al cierre de vela
                if mins_left < 0.5:
                    won  = (dir_ == "UP"   and price > active_bet["target"]) or \
                           (dir_ == "DOWN" and price < active_bet["target"])
                    odds = active_bet.get("odds", 0.5)
                    if won:
                        pnl_usd = round(stake_ / odds - stake_, 2)
                        pnl_pct = round((pnl_usd / stake_) * 100, 2)
                        result  = "WIN"
                        hour_wins    += 1
                        session_wins += 1
                        notify_win(cfg, active_bet, price)
                        logger.info(
                            f"[MONITOR] ✅ WIN — "
                            f"Invertido: ${stake_:.2f}  "
                            f"Retorno: +${pnl_usd:.2f} USD (+{pnl_pct:.1f}%)"
                        )
                        try:
                            redimir_posicion(active_bet["market"], cfg)
                        except Exception as e:
                            logger.warning(f"[MONITOR] ⚠ Error en claim: {e}")
                    else:
                        pnl_usd = -stake_
                        pnl_pct = -100.0
                        result  = "LOSS"
                        hour_losses    += 1
                        session_losses += 1
                        notify_loss(cfg, active_bet, price)
                        logger.info(
                            f"[MONITOR] ❌ LOSS — "
                            f"Invertido: ${stake_:.2f}  "
                            f"P&L: -${stake_:.2f} (-100%)"
                        )

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
                    _csv_write_row(csv_path, row)

                    session_pnl      += pnl_usd
                    session_invested += stake_

                    # Log de P&L acumulado total tras cada cierre
                    total_pnl = hist_stats["total_pnl"] + session_pnl
                    sign_s    = "+" if session_pnl >= 0 else ""
                    sign_t    = "+" if total_pnl  >= 0 else ""
                    logger.info(
                        f"[MONITOR]    P&L sesión         : {sign_s}${session_pnl:,.2f} USDC  "
                        f"(invertido ${session_invested:,.2f})\n"
                        f"[MONITOR]    P&L acumulado total: {sign_t}${total_pnl:,.2f} USDC"
                    )

                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Evaluación de señal ───────────────────────────────────────
            signal = evaluate(price, target, mins_left, cfg)

            if signal and not active_bet and fired_window != signal.window:
                if ops_hoy < max_ops:
                    notify_signal_eval(
                        cfg, signal.direction.value, price, target,
                        signal.distance, signal.umbral, mins_left, signal.window,
                    )

                    result = execute_order(signal, market, cfg)
                    if result:
                        ops_hoy += 1
                        active_bet = {
                            "id":         result.get("id", ""),
                            "direction":  signal.direction.value,
                            "window":     signal.window,
                            "entry":      price,
                            "target":     target,
                            "distance":   signal.distance,
                            "umbral":     signal.umbral,
                            "stake":      stake,
                            "odds":       result.get("odds", 0.5),
                            "tokens":     result.get("tokens", ""),
                            "market":     market,
                            "market_slug": slug,
                            "simulated":  result.get("simulated", False),
                            "ts_entrada": datetime.now(timezone.utc).isoformat(),
                        }
                        fired_window = signal.window

                        # Retorno estimado y P&L estimado
                        odds_v      = active_bet["odds"]
                        retorno_est = round(stake / odds_v, 2) if odds_v > 0 else 0
                        pnl_est     = round(retorno_est - stake, 2)
                        pct_est     = round((pnl_est / stake) * 100, 1) if stake > 0 else 0

                        logger.info(
                            f"[MONITOR] {'🟢' if signal.direction == Direction.UP else '🔴'} "
                            f"Apuesta {signal.direction.value} ejecutada\n"
                            f"           Entry     : ${price:,.2f}\n"
                            f"           Target    : ${target:,.2f}\n"
                            f"           Ventana   : {signal.window}\n"
                            f"           Stake     : ${stake:.2f} USDC\n"
                            f"           Odds      : {odds_v:.3f}\n"
                            f"           Ret. est. : +${retorno_est:.2f} (+{pct_est:.1f}%)\n"
                            f"           Simulado  : {active_bet['simulated']}"
                        )
                        notify_bet(cfg, active_bet, signal)
                    else:
                        logger.error(
                            f"[MONITOR] ❌ Orden fallida — "
                            f"{signal.direction.value} en {signal.window}"
                        )
                        notify_error(cfg, f"Orden fallida: {signal.direction.value} en {signal.window}")

            elif ops_hoy >= max_ops:
                logger.debug(f"[MONITOR] Límite diario ({ops_hoy}/{max_ops}) — en pausa")

            sleep_s = _WINDOW_POLL_S if _in_any_window(mins_left) else interval
            time.sleep(sleep_s)

    except KeyboardInterrupt:
        total_pnl = hist_stats["total_pnl"] + session_pnl
        sign_s    = "+" if session_pnl >= 0 else ""
        sign_t    = "+" if total_pnl   >= 0 else ""
        logger.info(_SEPARATOR)
        logger.info(f"[MONITOR] 🛑 Bot detenido por el usuario")
        logger.info(f"[MONITOR] ── RESUMEN DE SESIÓN ──────────────────────")
        logger.info(f"[MONITOR]   Operaciones esta sesión: {ops_hoy}")
        logger.info(f"[MONITOR]   Invertido esta sesión  : ${session_invested:,.2f} USDC")
        logger.info(f"[MONITOR]   P&L esta sesión        : {sign_s}${session_pnl:,.2f} USDC")
        logger.info(f"[MONITOR]   P&L acumulado total    : {sign_t}${total_pnl:,.2f} USDC")
        logger.info(_SEPARATOR)
        notify_stop(cfg)

    except Exception as e:
        logger.critical(
            f"[MONITOR] 💥 ERROR CRÍTICO: {type(e).__name__}: {e}",
            exc_info=True,
        )
        notify_error(cfg, str(e))
        raise
