"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v3.2 — FIX NOTIFICACIONES TELEGRAM EN MODO SIMULADO:
  1. BUG CRÍTICO: notify_bet(cfg, active_bet) llamado sin argumento `signal`
     → TypeError → crash del loop → ninguna notificación posterior llegaba.
     FIXED: notify_bet(cfg, active_bet, signal)
  2. BUG: notify_signal_eval solo se llamaba si señal accionable.
     → Evaluaciones WAIT (distancia insuficiente) nunca llegaban al chat.
     FIXED: se llama para CUALQUIER señal en ventana, con tracker de cambio
     para evitar spam (solo notifica al entrar en ventana o cambiar dirección).
  3. BUG: notificaciones de apuesta/resultado no etiquetaban [SIMULADO].
     FIXED: sim_tag añadido a notify_bet, notify_win, notify_loss, notify_stop_loss.

v3.1 — FIX DEPLOY: imports relativos para paquete modules/
v3.0 — Pre-producción fixes (stop_pct, stats, simulate_mode).
v2.9 — BUG FIX: señal WAIT ya no dispara execute_order.
v2.8 — FIX: _fetch_exit_token_price usa CLOB live.
v2.7 — Retornos reales desde Polymarket + odds reales en active_bet.
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
    notify_hour_summary,
    notify_error,
    notify_startup_summary,
)

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

MAX_TARGET_RETRIES = 5
TARGET_RETRY_WAIT  = 10
_CLOB_MIDPOINT     = "https://clob.polymarket.com/midpoint"


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
    """
    Lee el CSV completo y devuelve stats acumuladas.
    FIX v3.0: se llama tras CADA cierre de operación (no solo al inicio).
    """
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
                    stats["total_pnl"]      += float(row.get("pnl_usd", 0))
                    stats["total_invested"]  += float(row.get("stake_usd", 0))
                except ValueError:
                    pass
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo historial CSV: {e}")
    return stats


def _log_accumulated_stats(stats: dict, label: str = "HISTORIAL"):
    wins     = stats["wins"]
    losses   = stats["losses"] + stats["stops"]
    wr       = round(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    sign     = "+" if stats["total_pnl"] >= 0 else ""
    logger.info(
        f"[MONITOR] 📊 {label}: "
        f"{stats['total_ops']} ops  "
        f"{wins}W/{losses}L  WR={wr}%  "
        f"P&L={sign}${stats['total_pnl']:,.2f}  "
        f"Invertido=${stats['total_invested']:,.2f}"
    )


# ── Exit token price (stop loss) ──────────────────────────────────────────────

def _fetch_exit_token_price(active_bet: dict, cfg: dict) -> float | None:
    """
    Obtiene el precio actual del token en Polymarket vía CLOB midpoint.
    Fallback: Gamma API por conditionId.
    """
    market         = active_bet.get("market", {})
    direction      = active_bet.get("direction", "UP")
    outcome_target = "Yes" if direction == "UP" else "No"
    token_id       = None

    tokens = market.get("tokens", [])
    for t in tokens:
        if t.get("outcome") == outcome_target:
            token_id = t.get("token_id")
            break

    if token_id:
        try:
            r = requests.get(_CLOB_MIDPOINT, params={"token_id": token_id}, timeout=8)
            r.raise_for_status()
            mid = r.json().get("mid")
            if mid is not None:
                price = float(mid)
                logger.info(f"[MONITOR] Exit token price (CLOB midpoint): {price:.4f}")
                return price
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ CLOB midpoint falló: {e}")

    # Fallback: Gamma API
    cond_id = market.get("condition_id", "")
    if cond_id:
        try:
            r = requests.get(
                "https://gamma-api.polymarket.com/markets",
                params={"conditionId": cond_id},
                timeout=8,
            )
            r.raise_for_status()
            data = r.json()
            if data:
                m_tokens = data[0].get("tokens", [])
                price_fallback = next(
                    (float(t.get("price", 0)) for t in m_tokens
                     if t.get("outcome") == outcome_target),
                    None,
                )
                if price_fallback is not None:
                    logger.warning(
                        f"[MONITOR] ⚠ Exit token price (Gamma fallback, puede ser cacheado): "
                        f"{price_fallback:.4f}"
                    )
                    return price_fallback
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ Gamma fallback falló para conditionId={cond_id}: {e}")

    logger.error("[MONITOR] ❌ No se pudo obtener exit token price — usando fallback % fijo")
    return None


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
    stake         = cfg["capital"]["stake_usdc"]
    max_ops       = cfg["capital"]["max_operaciones_dia"]
    interval      = cfg["strategy"].get("monitor_intervalo_s", 5)
    # FIX v3.0: stop_loss_pct es ya un porcentaje (ej: 5 = 5%).
    # NO multiplicar × 100 al comparar con pnl_btc.
    stop_pct      = cfg["strategy"].get("stop_loss_pct", 5.0)
    simulate_mode = cfg["strategy"].get("simulate_mode", False)
    csv_path      = cfg.get("logging", {}).get("historial_csv", "logs/operaciones.csv")

    # ── Cargar y mostrar historial acumulado ──────────────────────────────
    hist_stats = _load_historical_stats(csv_path)
    _log_accumulated_stats(hist_stats)

    # Acumuladores de sesión
    session_pnl      = 0.0
    session_invested = 0.0
    session_wins     = 0
    session_losses   = 0

    notify_start(cfg)
    notify_startup_summary(cfg, hist_stats)

    # ── Estado de mercado/hora ────────────────────────────────────────────
    market       = None
    slug         = None
    last_slug    = None
    target       = None
    active_bet   = None
    fired_window = None
    last_hour    = -1

    hour_wins   = 0
    hour_losses = 0
    ops_hoy     = 0

    # FIX v3.2: tracker para notify_signal_eval — evita spam enviando solo
    # cuando se entra en una ventana nueva o cambia la dirección evaluada.
    last_notified_signal_key = None   # (window_key, direction_value)

    logger.info(_SEPARATOR)
    sim_tag = " [MODO SIMULADO]" if simulate_mode else ""
    logger.info(f"[MONITOR] 🚀 Bot iniciado{sim_tag} — esperando mercado activo…")
    logger.info(_SEPARATOR)

    try:
        while True:
            mins_left = _mins_to_close()
            now_hour  = datetime.now(timezone.utc).hour

            # ── Reset horario ─────────────────────────────────────────────
            if now_hour != last_hour:
                if last_hour >= 0 and (hour_wins + hour_losses) > 0:
                    notify_hour_summary(
                        cfg, last_hour,
                        hour_wins, hour_losses,
                        ops_hoy, target,
                    )
                hour_wins                = 0
                hour_losses              = 0
                last_hour                = now_hour
                ops_hoy                  = 0
                last_notified_signal_key = None

            # ── Obtener mercado (primero) ─────────────────────────────────
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
                target    = None  # forzar re-fetch del target con nuevo slug
                last_notified_signal_key = None

            if not market:
                if prev_slug:
                    notify_market_lost(cfg)
                    logger.warning("[MONITOR] ⚠ Mercado perdido — esperando nuevo mercado")
                time.sleep(interval)
                continue

            # ── Obtener target (después del mercado, con slug) ────────────
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
            price = get_btc_price()
            if not price:
                logger.warning("[MONITOR] ⚠ Precio BTC no disponible")
                time.sleep(interval)
                continue

            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Stop loss en posición abierta ─────────────────────────────
            if active_bet:
                sim_ = active_bet.get("simulated", False)

                # Calcular P&L de BTC para el stop loss trigger
                entry_price = active_bet.get("entry", price)
                pnl_btc = ((price - entry_price) / entry_price) * 100
                if active_bet["direction"] == "DOWN":
                    pnl_btc = -pnl_btc

                if pnl_btc <= -stop_pct:
                    exit_price = _fetch_exit_token_price(active_bet, cfg)
                    stake_     = active_bet.get("stake", stake)
                    if exit_price is not None:
                        shares_  = stake_ / max(active_bet.get("odds", 0.5), 0.001)
                        pnl_usd  = round(shares_ * exit_price - stake_, 2)
                        pnl_pct  = round((pnl_usd / stake_) * 100, 1) if stake_ > 0 else 0.0
                    else:
                        pnl_usd = round(-stake_ * (stop_pct / 100), 2)
                        pnl_pct = -stop_pct

                    result = "STOP"
                    logger.info(
                        f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}🛑 STOP LOSS — "
                        f"BTC movimiento: {pnl_btc:+.2f}%  "
                        f"P&L: ${pnl_usd:+.2f} ({pnl_pct:+.1f}%)"
                    )
                    # FIX v3.2: sim_tag en notificación stop loss
                    notify_stop_loss(cfg, active_bet, price, pnl_usd,
                                     simulated=sim_)

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
                    _csv_write_row(csv_path, row)

                    session_pnl      += pnl_usd
                    session_invested += stake_
                    session_losses   += 1
                    hour_losses      += 1

                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label="TRAS STOP_LOSS")

                    active_bet               = None
                    fired_window             = None
                    last_notified_signal_key = None
                    time.sleep(interval)
                    continue

                # ── Resolución al cierre de vela ──────────────────────────
                if mins_left <= 0:
                    dir_    = active_bet["direction"]
                    stake_  = active_bet.get("stake", stake)

                    if dir_ == "UP":
                        won = price > active_bet["target"]
                    else:
                        won = price < active_bet["target"]

                    if won:
                        odds_   = active_bet.get("odds", 0.5)
                        shares  = stake_ / max(odds_, 0.001)
                        pnl_usd = round(shares - stake_, 2)
                        pnl_pct = round((pnl_usd / stake_) * 100, 1) if stake_ > 0 else 0
                        result  = "WIN"
                        hour_wins     += 1
                        session_wins  += 1
                        # FIX v3.2: sim_tag en notificación WIN
                        notify_win(cfg, active_bet, price, simulated=sim_)
                        logger.info(
                            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}✅ WIN — "
                            f"Invertido: ${stake_:.2f}  "
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
                        pnl_usd = -stake_
                        pnl_pct = -100.0
                        result  = "LOSS"
                        hour_losses    += 1
                        session_losses += 1
                        # FIX v3.2: sim_tag en notificación LOSS
                        notify_loss(cfg, active_bet, price, simulated=sim_)
                        logger.info(
                            f"[MONITOR] {'[SIMULADO] ' if sim_ else ''}❌ LOSS — "
                            f"Invertido: ${stake_:.2f}  "
                            f"P&L: -${stake_:.2f} (-100%)"
                        )

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row    = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
                    _csv_write_row(csv_path, row)

                    session_pnl      += pnl_usd
                    session_invested += stake_

                    # FIX v3.0: Recargar CSV y mostrar resumen real
                    hist_stats = _load_historical_stats(csv_path)
                    _log_accumulated_stats(hist_stats, label=f"TRAS {result}")

                    sign_s = "+" if session_pnl >= 0 else ""
                    logger.info(
                        f"[MONITOR]    P&L sesión : {sign_s}${session_pnl:,.2f} USDC  "
                        f"(invertido ${session_invested:,.2f})\n"
                        f"[MONITOR]    Acumulado  : {'+' if hist_stats['total_pnl'] >= 0 else ''}${hist_stats['total_pnl']:,.2f} USDC"
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

            # FIX v3.2: notify_signal_eval para CUALQUIER señal en ventana,
            # no solo accionables. Solo notifica cuando hay cambio real
            # (nueva ventana o cambio de dirección) para evitar spam.
            if signal:
                signal_key = (signal.window, signal.direction.value)
                if signal_key != last_notified_signal_key:
                    notify_signal_eval(
                        cfg, price, target,
                        signal.distance, signal.umbral, signal.window,
                        signal.direction.value, mins_left,
                    )
                    last_notified_signal_key = signal_key

            # FIX v2.9 + v3.2: solo ejecutar si accionable
            if signal and signal.is_actionable and not active_bet and fired_window != signal.window:
                if ops_hoy < max_ops:
                    result_order = execute_order(signal, market, cfg)
                    if result_order:
                        ops_hoy += 1
                        active_bet = {
                            "id":          result_order.get("id", ""),
                            "direction":   signal.direction.value,
                            "window":      signal.window,
                            "entry":       price,
                            "target":      target,
                            "distance":    signal.distance,
                            "umbral":      signal.umbral,
                            "stake":       stake,
                            "odds":        result_order.get("odds", 0.5),
                            "tokens":      result_order.get("tokens", ""),
                            "market":      market,
                            "market_slug": slug,
                            "simulated":   result_order.get("simulated", False),
                            "ts_entrada":  datetime.now(timezone.utc).isoformat(),
                        }
                        fired_window = signal.window

                        odds_v      = active_bet["odds"]
                        retorno_est = round(stake / max(odds_v, 0.001), 2)
                        pnl_est     = round(retorno_est - stake, 2)
                        pct_est     = round((pnl_est / stake) * 100, 1) if stake > 0 else 0

                        sim_tag = " [SIMULADO]" if active_bet["simulated"] else ""
                        logger.info(
                            f"[MONITOR] {'🟢' if signal.direction == Direction.UP else '🔴'}"
                            f"{sim_tag} Apuesta {signal.direction.value} ejecutada\n"
                            f"           Entry     : ${price:,.2f}\n"
                            f"           Target    : ${target:,.2f}\n"
                            f"           Ventana   : {signal.window}\n"
                            f"           Stake     : ${stake:.2f} USDC\n"
                            f"           Odds      : {odds_v:.4f}  ({odds_v*100:.1f}%)\n"
                            f"           Ret. est. : ${retorno_est:.2f} USDC  "
                            f"(+${pnl_est:.2f} / +{pct_est:.1f}%)"
                        )
                        # FIX v3.2: CORREGIDO — se pasa `signal` como 3er argumento
                        notify_bet(cfg, active_bet, signal,
                                   simulated=active_bet["simulated"])
                    else:
                        logger.error("[MONITOR] ❌ execute_order devolvió None — no se abre apuesta")
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
        _log_accumulated_stats(final_stats, label="FINAL DE SESIÓN")
        logger.info(
            f"[MONITOR] Sesión: {session_wins}W {session_losses}L  "
            f"P&L={'+' if session_pnl >= 0 else ''}${session_pnl:,.2f}  "
            f"Invertido=${session_invested:,.2f}"
        )
