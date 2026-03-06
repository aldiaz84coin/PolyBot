"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

Cambios v2.4:
  - notify_market_found() al detectar mercado activo
  - notify_market_lost() cuando no se encuentra mercado
  - notify_signal_eval() al entrar en nueva ventana
  - notify_hour_summary() al final de cada hora
  - Retry automático si get_open_1h_binance() falla
  - Validación: comprueba que la vela corresponde a la hora UTC actual
"""
import logging
import time
from datetime import datetime, timezone

from .price_feed     import get_btc_price
from .market_scanner import get_active_market, get_open_1h_binance
from .strategy       import evaluate, execute_order, Direction
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


def _fetch_target_with_retry(cfg: dict, hour_utc: int) -> float | None:
    """Obtiene el Price to Beat con reintentos y notificación Telegram."""
    for attempt in range(1, MAX_TARGET_RETRIES + 1):
        logger.info(f"[MONITOR] Obteniendo Price to Beat (intento {attempt}/{MAX_TARGET_RETRIES})...")
        target = get_open_1h_binance()

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
            logger.warning(f"[MONITOR] ⚠ Intento {attempt} fallido — reintentando en {TARGET_RETRY_WAIT}s...")
            time.sleep(TARGET_RETRY_WAIT)
        else:
            logger.error(
                f"[MONITOR] ❌ No se pudo obtener el Price to Beat tras "
                f"{MAX_TARGET_RETRIES} intentos — el bot no operará esta hora."
            )
            notify_target_failed(cfg, hour_utc, MAX_TARGET_RETRIES)

    return None


def run(cfg: dict):
    """Arranca el loop principal del bot."""
    interval  = cfg["strategy"]["monitor_intervalo_s"]
    stop_pct  = cfg["strategy"]["stop_loss_pct"]
    stake     = cfg["capital"]["stake_usdc"]
    max_ops   = cfg["capital"]["max_operaciones_dia"]

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 🤖 POLYMARKET BTC BOT — INICIADO")
    logger.info(f"[MONITOR] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(_SEPARATOR2)
    logger.info(f"[MONITOR] Configuración:")
    logger.info(f"[MONITOR]   Stake/op     : ${stake} USDC")
    logger.info(f"[MONITOR]   Max ops/día  : {max_ops}")
    logger.info(f"[MONITOR]   Stop loss    : {stop_pct * 100:.0f}%")
    logger.info(f"[MONITOR]   Intervalo    : {interval}s")
    logger.info(_SEPARATOR)

    notify_start(cfg)

    ops_hoy      = 0
    active_bet   = None
    fired_window = None
    target       = None
    current_hour = None
    hour_wins    = 0
    hour_losses  = 0
    last_market  = None
    last_window  = None   # para detectar transición de ventana

    try:
        while True:
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Cambio de hora ────────────────────────────────────────────────
            if hour != current_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVO CICLO HORARIO — {now.strftime('%Y-%m-%d %H:00 UTC')}")

                # Resumen de la hora anterior + notificación Telegram
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

                current_hour  = hour
                fired_window  = None
                last_window   = None

                # Apuesta sin resolver → descarta
                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta sin resolver al cambiar de hora — "
                        f"descartando: {active_bet['direction']} @ ${active_bet['entry']:,.2f}"
                    )
                    active_bet = None

                # Nuevo Price to Beat
                target = _fetch_target_with_retry(cfg, hour)

                # Nuevo mercado
                logger.info("[MONITOR] Buscando mercado activo en Polymarket...")
                last_market = get_active_market()
                if last_market:
                    mins_left = _mins_to_close()
                    notify_market_found(cfg, last_market, mins_left)
                else:
                    notify_market_lost(cfg, [])   # slugs se registran en market_scanner log

                logger.info(_SEPARATOR)

            # ── Precio BTC ────────────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.error(f"[MONITOR] ❌ Error obteniendo precio BTC: {e}")
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()
            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            if not target:
                logger.warning("[MONITOR] ⏸ Sin Price to Beat — no se puede operar")
                time.sleep(interval)
                continue

            # ── Stop Loss ─────────────────────────────────────────────────────
            if active_bet:
                entry = active_bet["entry"]
                dir_  = active_bet["direction"]
                pnl   = (
                    (price - entry) / entry * 100
                    if dir_ == "UP"
                    else (entry - price) / entry * 100
                )
                logger.debug(
                    f"[MONITOR] Posición activa — {dir_} entry=${entry:,.2f}  "
                    f"actual=${price:,.2f}  P&L={pnl:+.2f}%"
                )
                if pnl <= -(stop_pct * 100):
                    logger.warning(
                        f"[MONITOR] 🛑 STOP LOSS — P&L={pnl:.2f}%  "
                        f"Entry=${entry:,.2f}  Actual=${price:,.2f}"
                    )
                    notify_stop_loss(cfg, active_bet, pnl)
                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Resolución al cierre ──────────────────────────────────────────
            if active_bet and mins_left <= 0.1:
                dir_ = active_bet["direction"]
                won  = (
                    (dir_ == "UP"   and price > active_bet["target"]) or
                    (dir_ == "DOWN" and price < active_bet["target"])
                )
                logger.info(
                    f"[MONITOR] {'✅ WIN' if won else '❌ LOSS'} — "
                    f"{dir_}  Entry=${active_bet['entry']:,.2f}  "
                    f"Target=${active_bet['target']:,.2f}  Close=${price:,.2f}"
                )
                if won:
                    notify_win(cfg, active_bet, price)
                    hour_wins += 1
                    try:
                        tx = redimir_posicion(active_bet.get("market", {}), dir_, cfg)
                        logger.info(f"[MONITOR] ✅ Claim tx: {tx}")
                    except Exception as e:
                        logger.error(f"[MONITOR] ❌ Claim fallido: {e}", exc_info=True)
                        notify_error(cfg, f"Claim fallido: {e}")
                else:
                    notify_loss(cfg, active_bet, price)
                    hour_losses += 1

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
                    time.sleep(interval)
                    continue

                if fired_window == signal.window:
                    logger.debug(
                        f"[MONITOR] Señal {signal.direction.value} en ventana {signal.window} "
                        f"ya ejecutada — skip"
                    )
                    time.sleep(interval)
                    continue

                # Buscar mercado (refresco si no hay o es nuevo ciclo)
                if not last_market:
                    logger.info("[MONITOR] 🔍 Buscando mercado activo para ejecutar orden...")
                    last_market = get_active_market()
                    if last_market:
                        notify_market_found(cfg, last_market, mins_left)
                    else:
                        logger.warning(
                            f"[MONITOR] ⚠ Mercado no encontrado — señal "
                            f"{signal.direction.value} descartada en ventana {signal.window}"
                        )
                        notify_market_lost(cfg, [])
                        time.sleep(interval)
                        continue

                logger.info(
                    f"[MONITOR] 📊 Ejecutando orden — "
                    f"{signal.direction.value} | ventana {signal.window} | "
                    f"dist={signal.distance:+,.0f}"
                )
                result = execute_order(signal, last_market, cfg)

                if result:
                    fired_window = signal.window
                    ops_hoy     += 1
                    active_bet   = {
                        "direction": signal.direction.value,
                        "entry":     price,
                        "target":    target,
                        "window":    signal.window,
                        "stake":     stake,
                        "market":    last_market,
                    }
                    notify_bet(cfg, active_bet, signal)
                    logger.info(
                        f"[MONITOR] ✅ Apuesta registrada ({ops_hoy}/{max_ops}):\n"
                        f"           {signal.direction.value}  Entry=${price:,.2f}  "
                        f"Target=${target:,.2f}  Ventana={signal.window}"
                    )
                else:
                    logger.error(
                        f"[MONITOR] ❌ Orden fallida — señal {signal.direction.value} "
                        f"en ventana {signal.window} no ejecutada."
                    )
                    notify_error(cfg, f"Orden fallida: {signal.direction.value} en {signal.window}")

            elif ops_hoy >= max_ops:
                logger.debug(f"[MONITOR] Límite diario ({ops_hoy}/{max_ops}) — en pausa")

            time.sleep(interval)

    except KeyboardInterrupt:
        logger.info(_SEPARATOR)
        logger.info(f"[MONITOR] 🛑 Bot detenido por el usuario (Ctrl+C)")
        logger.info(f"[MONITOR] Resumen sesión: {ops_hoy} operaciones ejecutadas")
        logger.info(_SEPARATOR)
        notify_stop(cfg)

    except Exception as e:
        logger.critical(f"[MONITOR] 💥 ERROR CRÍTICO: {type(e).__name__}: {e}", exc_info=True)
        notify_error(cfg, str(e))
        raise
