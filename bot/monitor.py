"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v2.9 — BUG FIX CRÍTICO: señal WAIT ya no dispara execute_order
  - La condición de entrada ahora incluye `signal.is_actionable`
  - Antes: `if signal and not active_bet and fired_window != signal.window`
  - Ahora:  `if signal and signal.is_actionable and not active_bet and fired_window != signal.window`
  - Sin este check, una señal Direction.WAIT (truthy) pasaba el guard y llamaba
    a execute_order() aunque la distancia fuera insuficiente.

v2.8 — FIX: _fetch_exit_token_price usa CLOB live en lugar de Gamma cacheado:
  - Al activarse el stop loss, el precio del token ahora se obtiene del CLOB
    midpoint (precio real del orderbook), igual que durante la detección del
    mercado. Antes usaba Gamma API que devuelve precios cacheados → incorrecto.
  - Fallback: Gamma API por conditionId si el CLOB falla o no hay token_id.

v2.7 — Retornos reales desde Polymarket:
  - STOP LOSS: ya no usa porcentaje fijo (stake * stop_pct). Consulta el
    precio actual del token en Polymarket en el momento del stop y calcula:
    pnl = (shares * exit_price) - stake. Si la consulta falla, usa el
    porcentaje fijo como fallback.
  - execute_order ahora siempre devuelve "odds" = precio real del token
    en el CLOB, por lo que monitor.py ya no defaultea a 0.5.

v2.6 — Historial persistente y stats acumuladas.
v2.5 — Polling adaptativo, CSV de operaciones, detalles monetarios.
FIX: mercado se obtiene ANTES que el target para pasar el slug a Binance.
"""
import csv
import logging
import os
import time
from datetime import datetime, timezone

import requests

from price_feed     import get_btc_price
from market_scanner import get_active_market, get_open_1h_binance
from strategy       import evaluate, execute_order, Direction, WINDOWS
from claimer        import redimir_posicion
from notifier       import (
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

_WINDOW_POLL_S  = 1
_CLOB_MIDPOINT  = "https://clob.polymarket.com/midpoint"


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
        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                result = row.get("resultado", "").upper()
                if result not in ("WIN", "LOSS", "STOP"):
                    continue
                stats["total_ops"] += 1
                try:
                    stats["total_invested"] += float(row.get("stake_usd", 0))
                    stats["total_pnl"]      += float(row.get("pnl_usd", 0))
                except (ValueError, TypeError):
                    pass
                if result == "WIN":
                    stats["wins"]   += 1
                elif result == "LOSS":
                    stats["losses"] += 1
                elif result == "STOP":
                    stats["stops"]  += 1
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error leyendo historial CSV: {e}")
    return stats


def _log_accumulated_stats(stats: dict):
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


# ── Precio real de salida desde Polymarket (para STOP LOSS) ──────────────────

def _fetch_exit_token_price(bet: dict) -> float | None:
    """
    FIX v2.8: obtiene el precio LIVE del token desde el CLOB (midpoint) al
    momento del stop loss.

    Antes consultaba Gamma API (precios cacheados) — incorrecto e inconsistente
    con el resto del sistema que ya usa CLOB para todos los precios de tokens.

    Lógica:
      1. Extraer token_id del market guardado en la apuesta (ya enriquecido
         con CLOB durante get_active_market())
      2. Consultar CLOB midpoint → precio real del orderbook
      3. Fallback: Gamma API por conditionId si CLOB falla o no hay token_id

    Retorna el precio del token (0.0–1.0) o None si todo falla.
    """
    market    = bet.get("market", {})
    direction = bet.get("direction", "")
    tokens    = market.get("tokens", [])

    # ── 1. Intentar CLOB midpoint con token_id ────────────────────────────
    outcome_target = "Yes" if direction == "UP" else "No"
    token_id = next(
        (t.get("token_id") for t in tokens if t.get("outcome") == outcome_target),
        None,
    )

    if token_id:
        try:
            r = requests.get(
                _CLOB_MIDPOINT,
                params={"token_id": token_id},
                timeout=5,
            )
            r.raise_for_status()
            mid = float(r.json().get("mid", 0))
            logger.info(
                f"[MONITOR] 💹 Exit token price (CLOB midpoint): {mid:.4f}  "
                f"token_id={str(token_id)[:16]}…"
            )
            return mid
        except Exception as e:
            logger.warning(f"[MONITOR] ⚠ CLOB midpoint falló para token {str(token_id)[:16]}: {e}")

    # ── 2. Fallback: Gamma API por conditionId ────────────────────────────
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
    stake      = cfg["capital"]["stake_usdc"]
    max_ops    = cfg["capital"]["max_operaciones_dia"]
    interval   = cfg["strategy"].get("monitor_intervalo_s", 5)
    stop_pct   = cfg["strategy"].get("stop_loss_pct", 0.5)
    csv_path   = cfg.get("logging", {}).get("historial_csv", "logs/operaciones.csv")

    # ── Cargar y mostrar historial acumulado ──────────────────────────────
    hist_stats = _load_historical_stats(csv_path)
    _log_accumulated_stats(hist_stats)

    # Acumuladores de sesión (se suman al histórico para totales)
    session_pnl      = 0.0
    session_invested = 0.0
    session_wins     = 0
    session_losses   = 0

    notify_start(cfg)
    from notifier import notify_startup_summary
    notify_startup_summary(cfg, hist_stats)

    # ── Estado de mercado/hora ────────────────────────────────────────────
    market       = None
    slug         = None
    target       = None
    active_bet   = None
    fired_window = None
    last_hour    = -1

    hour_wins   = 0
    hour_losses = 0
    ops_hoy     = 0

    logger.info(_SEPARATOR)
    logger.info("[MONITOR] 🚀 Bot iniciado — esperando mercado activo…")
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
                        session_pnl, hist_stats["total_pnl"] + session_pnl,
                    )
                hour_wins   = 0
                hour_losses = 0
                last_hour   = now_hour
                ops_hoy     = 0

            # ── Obtener mercado (primero) ─────────────────────────────────
            prev_slug = slug
            market    = get_active_market()
            slug      = market.get("slug") if market else None

            if market and slug != prev_slug:
                notify_market_found(cfg, market, mins_left)
                logger.info(f"[MONITOR] ◈ Mercado: {slug}")
                target = None  # forzar re-fetch del target con nuevo slug

            if not market:
                if prev_slug:
                    notify_market_lost(cfg)
                    logger.warning("[MONITOR] ⚠ Mercado perdido")
                time.sleep(interval)
                continue

            # ── Obtener target (después del mercado, con slug) ────────────
            if target is None:
                target = _fetch_target_with_retry(cfg, now_hour, slug=slug)
                if target:
                    notify_target_change(cfg, target, now_hour)
                    logger.info(f"[MONITOR] 🎯 Target: ${target:,.2f}")

            price = get_btc_price()
            if not price:
                time.sleep(interval)
                continue

            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Gestión de apuesta activa ─────────────────────────────────
            if active_bet:
                dir_    = active_bet["direction"]
                stake_  = active_bet["stake"]
                # P&L BTC-based para trigger del stop loss
                pnl_btc = (
                    (price - active_bet["entry"]) / active_bet["entry"] * 100
                    if dir_ == "UP"
                    else (active_bet["entry"] - price) / active_bet["entry"] * 100
                )

                # ── Stop Loss ─────────────────────────────────────────────
                if pnl_btc <= -stop_pct * 100:
                    # FIX v2.8: precio CLOB live (no Gamma cacheado)
                    exit_token_price = _fetch_exit_token_price(active_bet)

                    if exit_token_price is not None:
                        # Cálculo REAL: shares comprados × precio actual del token
                        entry_odds   = active_bet.get("odds", 0.5)
                        shares       = stake_ / max(entry_odds, 0.001)
                        proceeds     = round(shares * exit_token_price, 2)
                        loss_usd     = round(proceeds - stake_, 2)
                        pnl_pct_stop = round((loss_usd / stake_) * 100, 2) if stake_ > 0 else 0
                        logger.warning(
                            f"[MONITOR] 🛑 STOP LOSS (precio real CLOB)\n"
                            f"           Odds entrada  : {entry_odds:.4f}\n"
                            f"           Shares        : {shares:.4f}\n"
                            f"           Exit price    : {exit_token_price:.4f}\n"
                            f"           Proceeds      : ${proceeds:.2f}\n"
                            f"           P&L real      : {pnl_pct_stop:+.2f}%  ({loss_usd:+.2f} USD)"
                        )
                    else:
                        # Fallback: porcentaje fijo si Polymarket no responde
                        loss_usd     = round(stake_ * (-stop_pct), 2)
                        pnl_pct_stop = round(-stop_pct * 100, 2)
                        logger.warning(
                            f"[MONITOR] 🛑 STOP LOSS (fallback % fijo — Polymarket no disponible)\n"
                            f"           P&L   : {pnl_pct_stop:+.2f}%  ({loss_usd:+.2f} USD)"
                        )

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, "STOP", ts_now, loss_usd, pnl_pct_stop)
                    _csv_write_row(csv_path, row)

                    session_pnl      += loss_usd
                    session_invested += stake_
                    session_losses   += 1

                    notify_stop_loss(cfg, active_bet, price, pnl_btc)
                    active_bet   = None
                    fired_window = None
                    hour_losses  += 1
                    time.sleep(interval)
                    continue

                # ── Resolución al cierre de vela ──────────────────────────
                if mins_left < 0.5:
                    won  = (dir_ == "UP"   and price > active_bet["target"]) or \
                           (dir_ == "DOWN" and price < active_bet["target"])
                    # Odds reales de entrada (corregido desde v2.7)
                    odds = active_bet.get("odds", 0.5)

                    if won:
                        # WIN: cada share resuelve a $1 → retorno real = stake / odds
                        pnl_usd = round(stake_ / odds - stake_, 2)
                        pnl_pct = round((pnl_usd / stake_) * 100, 2)
                        result  = "WIN"
                        hour_wins    += 1
                        session_wins += 1
                        notify_win(cfg, active_bet, price)
                        logger.info(
                            f"[MONITOR] ✅ WIN — "
                            f"Invertido: ${stake_:.2f}  "
                            f"Odds: {odds:.4f}  "
                            f"Retorno: +${pnl_usd:.2f} USD (+{pnl_pct:.1f}%)"
                        )
                        try:
                            redimir_posicion(active_bet["market"], cfg)
                        except Exception as e:
                            logger.warning(f"[MONITOR] ⚠ Error en claim: {e}")
                    else:
                        # LOSS: cada share resuelve a $0 → pnl = -stake
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

            # FIX v2.9: se añade signal.is_actionable para no ejecutar con WAIT
            if signal and signal.is_actionable and not active_bet and fired_window != signal.window:
                if ops_hoy < max_ops:
                    notify_signal_eval(
                        cfg, price, target,
                        signal.distance, signal.umbral, signal.window,
                        signal.direction.value, mins_left,
                    )

                    result_order = execute_order(signal, market, cfg)
                    if result_order:
                        ops_hoy += 1
                        # FIX v2.7: result_order["odds"] siempre contiene el
                        # precio real del token (no defaultea a 0.5)
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

                        # Retorno estimado con odds reales
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
                            f"           Odds      : {odds_v:.4f}  "
                            f"(prob. {odds_v*100:.1f}%)\n"
                            f"           Ret. est. : ${retorno_est:.2f} USDC  "
                            f"(+${pnl_est:.2f} / +{pct_est:.1f}%)"
                        )
                        notify_bet(cfg, active_bet, retorno_est)
                else:
                    logger.info(
                        f"[MONITOR] ⏭ Señal ignorada — límite diario alcanzado "
                        f"({ops_hoy}/{max_ops})"
                    )

            time.sleep(interval)

    except KeyboardInterrupt:
        sign_s = "+" if session_pnl >= 0 else ""
        logger.info(_SEPARATOR)
        logger.info(f"[MONITOR] 🛑 Bot detenido por el usuario")
        logger.info(f"[MONITOR]   Sesión:  {session_wins}W / {session_losses}L  "
                    f"P&L: {sign_s}${session_pnl:,.2f} USDC")
        logger.info(_SEPARATOR)
        notify_stop(cfg, session_wins, session_losses, session_pnl)
