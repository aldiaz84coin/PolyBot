"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v2.5 — Mejoras de consistencia y trazabilidad:
  - Polling adaptativo: 1s dentro de ventana activa, interval_s fuera
    → igual frecuencia de evaluación que el dashboard
  - CSV de operaciones: cada trade se persiste en logs/operaciones.csv
    (entrada y cierre con todos los detalles monetarios)
  - Detalles de operación completos en log: stake, odds, retorno estimado
  - notify_signal_eval() ahora se llama en CADA ciclo dentro de la ventana
    (no solo al entrar) para que Telegram refleje el estado en tiempo real

FIX: mercado se obtiene ANTES que el target para pasar el slug a Binance.
     get_open_1h_binance(slug=) usa startTime para pedir la vela exacta.
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
TARGET_RETRY_WAIT  = 10   # segundos entre reintentos

# Intervalo rápido DENTRO de ventana activa — iguala la frecuencia del dashboard
_WINDOW_POLL_S = 1


def _in_any_window(mins_left: float) -> bool:
    """Devuelve True si mins_left cae dentro de cualquier ventana de operación."""
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
    "retorno_estimado_usd",  # stake / odds (si gana)
    "pnl_usd", "pnl_pct",
    "resultado",             # WIN / LOSS / STOP / PENDING
    "market_slug",
    "simulado",
]


def _ensure_csv(path: str):
    """Crea el archivo CSV con cabecera si no existe."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=_CSV_HEADERS)
            writer.writeheader()


def _csv_write_row(path: str, row: dict):
    """Añade una fila al CSV (crea cabecera si el archivo es nuevo)."""
    try:
        _ensure_csv(path)
        with open(path, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=_CSV_HEADERS, extrasaction="ignore")
            writer.writerow(row)
    except Exception as e:
        logger.warning(f"[MONITOR] ⚠ Error escribiendo CSV: {e}")


def _build_trade_row(
    bet: dict,
    result: str,
    ts_cierre: str,
    pnl_usd: float,
    pnl_pct: float,
) -> dict:
    """Construye el dict para una fila del CSV."""
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


# ── Target con reintentos ─────────────────────────────────────────────────────

def _fetch_target_with_retry(cfg: dict, hour_utc: int, slug: str | None = None) -> float | None:
    """
    Obtiene el Price to Beat con reintentos y notificación Telegram.
    Si se pasa slug, get_open_1h_binance() usará startTime para pedir
    la vela exacta del mercado activo.
    """
    for attempt in range(1, MAX_TARGET_RETRIES + 1):
        logger.info(
            f"[MONITOR] Obteniendo Price to Beat (intento {attempt}/{MAX_TARGET_RETRIES})"
            + (f" — slug: {slug}" if slug else "") + "..."
        )
        target = get_open_1h_binance(slug=slug) if slug else get_open_1h_binance()

        if target is not None:
            is_retry = attempt > 1
            logger.info(
                f"[MONITOR] ✅ Price to Beat fijado: ${target:,.2f}  "
                f"(hora {hour_utc:02d}:00 UTC)"
                + ("  ← reintento exitoso" if is_retry else "")
            )
            notify_target_change(cfg, target, hour_utc, is_retry=is_retry)
            return target

        if attempt < MAX_TARGET_RETRIES:
            logger.warning(
                f"[MONITOR] ⚠ Intento {attempt} fallido — reintentando en {TARGET_RETRY_WAIT}s..."
            )
            time.sleep(TARGET_RETRY_WAIT)
        else:
            logger.error(
                f"[MONITOR] ❌ No se pudo obtener el Price to Beat tras "
                f"{MAX_TARGET_RETRIES} intentos — el bot no operará esta hora."
            )
            notify_target_failed(cfg, hour_utc, MAX_TARGET_RETRIES)

    return None


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    """Arranca el loop principal del bot."""
    interval  = cfg["strategy"]["monitor_intervalo_s"]
    stop_pct  = cfg["strategy"]["stop_loss_pct"]
    stake     = cfg["capital"]["stake_usdc"]
    max_ops   = cfg["capital"]["max_operaciones_dia"]
    csv_path  = cfg.get("logging", {}).get("historial_csv", "logs/operaciones.csv")

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 🤖 POLYMARKET BTC BOT — INICIADO")
    logger.info(f"[MONITOR] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(_SEPARATOR2)
    logger.info(f"[MONITOR] Configuración:")
    logger.info(f"[MONITOR]   Stake/op     : ${stake} USDC")
    logger.info(f"[MONITOR]   Max ops/día  : {max_ops}")
    logger.info(f"[MONITOR]   Stop loss    : {stop_pct * 100:.0f}%")
    logger.info(f"[MONITOR]   Intervalo    : {interval}s (ventana activa: {_WINDOW_POLL_S}s)")
    logger.info(f"[MONITOR]   CSV trades   : {csv_path}")
    logger.info(f"[MONITOR]   Umbrales     : "
                f"T-20=${cfg['strategy']['t20_umbral_usd']}  "
                f"T-15=${cfg['strategy']['t15_umbral_usd']}  "
                f"T-10=${cfg['strategy']['t10_umbral_usd']}  "
                f"T-5=${cfg['strategy']['t5_umbral_usd']}")
    logger.info(_SEPARATOR)

    _ensure_csv(csv_path)
    notify_start(cfg)

    ops_hoy      = 0
    active_bet   = None
    fired_window = None
    target       = None
    current_hour = None
    hour_wins    = 0
    hour_losses  = 0
    last_market  = None
    last_window  = None
    op_counter   = 0   # ID secuencial de operación

    try:
        while True:
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Cambio de hora ────────────────────────────────────────────────
            if hour != current_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVO CICLO HORARIO — {now.strftime('%Y-%m-%d %H:00 UTC')}")

                if current_hour is not None:
                    wr = int(hour_wins / (hour_wins + hour_losses) * 100) \
                         if (hour_wins + hour_losses) > 0 else 0
                    logger.info(
                        f"[MONITOR] Resumen hora anterior: "
                        f"W={hour_wins}  L={hour_losses}  WR={wr}%  Ops={ops_hoy}/{max_ops}"
                    )
                    if target:
                        notify_hour_summary(cfg, current_hour, hour_wins, hour_losses, ops_hoy, target)
                    hour_wins   = 0
                    hour_losses = 0

                current_hour = hour
                fired_window = None
                last_window  = None

                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta sin resolver al cambiar de hora — "
                        f"descartando: {active_bet['direction']} @ ${active_bet['entry']:,.2f}"
                    )
                    # Registrar en CSV como PENDIENTE sin cerrar
                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, "ABANDONED", ts_now, 0.0, 0.0)
                    _csv_write_row(csv_path, row)
                    active_bet = None

                # ── Mercado PRIMERO para obtener el slug ──────────────────────
                logger.info("[MONITOR] 🔍 Buscando mercado activo...")
                last_market = get_active_market()
                slug = last_market.get("slug") if last_market else None
                if last_market:
                    notify_market_found(cfg, last_market, _mins_to_close())
                    logger.info(f"[MONITOR] 📌 Mercado: {slug}")
                else:
                    logger.warning("[MONITOR] ⚠ No se encontró mercado activo para la nueva hora.")
                    notify_market_lost(cfg, [])

                # ── Target (Price to Beat) ────────────────────────────────────
                target = _fetch_target_with_retry(cfg, hour, slug=slug)
                if not target:
                    logger.warning(
                        f"[MONITOR] ⚠ Sin Price to Beat — "
                        f"el bot no operará esta hora."
                    )

                logger.info(_SEPARATOR)

            # ── Sin target → esperar ──────────────────────────────────────────
            if not target:
                logger.debug(f"[MONITOR] Sin target — skip ciclo")
                time.sleep(interval)
                continue

            # ── Obtener precio BTC ────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.error(f"[MONITOR] ❌ Error obteniendo precio BTC: {type(e).__name__}: {e}")
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()
            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # ── Monitor posición activa ───────────────────────────────────────
            if active_bet:
                entry = active_bet["entry"]
                dir_  = active_bet["direction"]
                pnl   = (
                    (price - entry) / entry * 100
                    if dir_ == "UP"
                    else (entry - price) / entry * 100
                )

                logger.debug(
                    f"[MONITOR] Posición activa — "
                    f"{dir_} entry=${entry:,.2f}  "
                    f"actual=${price:,.2f}  "
                    f"P&L={pnl:+.2f}%  "
                    f"stop_loss=-{stop_pct*100:.0f}%"
                )

                # Stop loss
                if pnl <= -stop_pct * 100:
                    loss_usd = -round(stake * stop_pct, 2)
                    logger.warning(
                        f"[MONITOR] 🛑 STOP LOSS activado\n"
                        f"           Dirección : {dir_}\n"
                        f"           Entry     : ${entry:,.2f}\n"
                        f"           Actual    : ${price:,.2f}\n"
                        f"           P&L       : {pnl:+.2f}%  ({loss_usd:+.2f} USD)"
                    )
                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, "STOP", ts_now, loss_usd, -stop_pct * 100)
                    _csv_write_row(csv_path, row)

                    notify_stop_loss(cfg, active_bet, price, pnl)
                    active_bet   = None
                    fired_window = None
                    hour_losses += 1
                    time.sleep(interval)
                    continue

                # Resolución al cierre de vela (< 0.5 min restantes)
                if mins_left < 0.5:
                    won     = (dir_ == "UP" and price > active_bet["target"]) or \
                              (dir_ == "DOWN" and price < active_bet["target"])
                    odds    = active_bet.get("odds", 0.5)
                    if won:
                        pnl_usd = round(stake / odds - stake, 2)
                        pnl_pct = round((pnl_usd / stake) * 100, 2)
                        result  = "WIN"
                        hour_wins   += 1
                        notify_win(cfg, active_bet, price)
                        logger.info(
                            f"[MONITOR] ✅ WIN — "
                            f"Retorno: +${pnl_usd:.2f} USD (+{pnl_pct:.1f}%)"
                        )
                        try:
                            redimir_posicion(active_bet["market"], cfg)
                        except Exception as e:
                            logger.warning(f"[MONITOR] ⚠ Error en claim: {e}")
                    else:
                        pnl_usd = -stake
                        pnl_pct = -100.0
                        result  = "LOSS"
                        hour_losses += 1
                        notify_loss(cfg, active_bet, price)
                        logger.info(
                            f"[MONITOR] ❌ LOSS — "
                            f"Pérdida: -${stake:.2f} USD (-100%)"
                        )

                    ts_now = datetime.now(timezone.utc).isoformat()
                    row = _build_trade_row(active_bet, result, ts_now, pnl_usd, pnl_pct)
                    _csv_write_row(csv_path, row)
                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Evaluación de señal ───────────────────────────────────────────
            if not active_bet and ops_hoy < max_ops:
                signal = evaluate(price, target, mins_left, cfg)

                if signal is None:
                    if last_window is not None:
                        last_window = None
                    # Fuera de ventana → dormir el intervalo largo
                    time.sleep(interval)
                    continue

                # Notificar Telegram al entrar en nueva ventana
                if signal.window != last_window:
                    last_window = signal.window
                    logger.info(f"[MONITOR] 🪟 Entrando en ventana {signal.window}")
                    notify_signal_eval(
                        cfg, price, target, signal.distance,
                        signal.umbral, signal.window, signal.direction.value, mins_left,
                    )

                if not signal.is_actionable:
                    # Dentro de ventana pero sin señal → polling rápido
                    time.sleep(_WINDOW_POLL_S)
                    continue

                if fired_window == signal.window:
                    logger.debug(
                        f"[MONITOR] Señal {signal.direction.value} en ventana {signal.window} "
                        f"ya ejecutada — skip"
                    )
                    time.sleep(_WINDOW_POLL_S)
                    continue

                # Refrescar mercado si no hay uno en caché
                if not last_market:
                    logger.info("[MONITOR] 🔍 Buscando mercado activo para ejecutar orden...")
                    last_market = get_active_market()
                    if last_market:
                        notify_market_found(cfg, last_market, mins_left)
                    else:
                        logger.warning(
                            f"[MONITOR] ⚠ Mercado no encontrado — señal {signal.direction.value} "
                            f"descartada en ventana {signal.window}"
                        )
                        notify_market_lost(cfg, [])
                        time.sleep(_WINDOW_POLL_S)
                        continue

                logger.info(
                    f"[MONITOR] 📊 Ejecutando orden — "
                    f"{signal.direction.value} | ventana {signal.window} | "
                    f"dist={signal.distance:+,.0f} | umbral={signal.umbral}"
                )
                result = execute_order(signal, last_market, cfg)

                if result:
                    op_counter += 1
                    fired_window = signal.window
                    ops_hoy     += 1

                    # Extraer odds del resultado CLOB (o fallback a 0.5)
                    odds   = float(result.get("price", 0.5))
                    tokens = float(result.get("sizeFilled", result.get("size", stake / odds)))
                    retorno_estimado = round(stake / odds, 2) if odds > 0 else 0

                    active_bet = {
                        "id":           f"OP{op_counter:04d}",
                        "direction":    signal.direction.value,
                        "entry":        price,
                        "target":       target,
                        "window":       signal.window,
                        "umbral":       signal.umbral,
                        "distance":     signal.distance,
                        "stake":        stake,
                        "odds":         odds,
                        "tokens":       tokens,
                        "retorno_est":  retorno_estimado,
                        "market":       last_market,
                        "market_slug":  last_market.get("slug", ""),
                        "simulated":    result.get("simulated", False),
                        "ts_entrada":   datetime.now(timezone.utc).isoformat(),
                    }
                    notify_bet(cfg, active_bet, signal)
                    logger.info(
                        f"[MONITOR] ✅ Operación #{op_counter} registrada ({ops_hoy}/{max_ops} hoy):\n"
                        f"           ID        : {active_bet['id']}\n"
                        f"           Dirección : {signal.direction.value}\n"
                        f"           Entry     : ${price:,.2f}\n"
                        f"           Target    : ${target:,.2f}\n"
                        f"           Distancia : ${abs(signal.distance):,.0f}\n"
                        f"           Umbral    : ${signal.umbral}\n"
                        f"           Ventana   : {signal.window}\n"
                        f"           Stake     : ${stake:.2f} USDC\n"
                        f"           Odds      : {odds:.3f}  ({odds*100:.1f}% prob)\n"
                        f"           Tokens    : {tokens:.4f}\n"
                        f"           Retorno   : ${retorno_estimado:.2f} USDC (si gana)\n"
                        f"           Simul.    : {active_bet['simulated']}"
                    )
                else:
                    logger.error(
                        f"[MONITOR] ❌ Orden fallida — señal {signal.direction.value} "
                        f"en ventana {signal.window} no ejecutada."
                    )
                    notify_error(cfg, f"Orden fallida: {signal.direction.value} en {signal.window}")

            elif ops_hoy >= max_ops:
                logger.debug(f"[MONITOR] Límite diario alcanzado ({ops_hoy}/{max_ops}) — en pausa")

            # ── Sleep adaptativo ──────────────────────────────────────────────
            # Dentro de ventana: 1s (igual que el dashboard)
            # Fuera de ventana: interval_s (más eficiente)
            sleep_s = _WINDOW_POLL_S if _in_any_window(mins_left) else interval
            time.sleep(sleep_s)

    except KeyboardInterrupt:
        logger.info(_SEPARATOR)
        logger.info(f"[MONITOR] 🛑 Bot detenido por el usuario (Ctrl+C)")
        logger.info(f"[MONITOR] Resumen sesión: {ops_hoy} operaciones ejecutadas")
        logger.info(_SEPARATOR)
        notify_stop(cfg)

    except Exception as e:
        logger.critical(
            f"[MONITOR] 💥 ERROR CRÍTICO: {type(e).__name__}: {e}",
            exc_info=True,
        )
        notify_error(cfg, str(e))
        raise
