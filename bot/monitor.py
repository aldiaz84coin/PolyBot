"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

Cambios respecto a versión anterior:
  - notify_target_change() al fijar nuevo Price to Beat
  - notify_target_failed() tras MAX_TARGET_RETRIES intentos fallidos
  - Retry automático si get_open_1h_binance() falla al cambiar de hora
  - Validación: comprueba que la vela devuelta corresponde a la hora UTC actual
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
    notify_error,
)

logger = logging.getLogger(__name__)

_SEPARATOR  = "─" * 60
_SEPARATOR2 = "·" * 60

# Número máximo de reintentos para obtener el Price to Beat al cambiar de hora
MAX_TARGET_RETRIES = 5
TARGET_RETRY_WAIT  = 10   # segundos entre reintentos


def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def _log_cycle(
    price: float, target: float | None,
    mins_left: float, ops_hoy: int, max_ops: int,
):
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
    """
    Intenta obtener el Price to Beat hasta MAX_TARGET_RETRIES veces.
    Notifica por Telegram en cada caso (éxito o fallo definitivo).
    """
    for attempt in range(1, MAX_TARGET_RETRIES + 1):
        logger.info(
            f"[MONITOR] Obteniendo Price to Beat (intento {attempt}/{MAX_TARGET_RETRIES})..."
        )
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
            logger.warning(
                f"[MONITOR] ⚠ Intento {attempt} fallido — "
                f"reintentando en {TARGET_RETRY_WAIT}s..."
            )
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

    ops_hoy       = 0
    active_bet    = None
    fired_window  = None
    target        = None
    current_hour  = None
    hour_wins     = 0
    hour_losses   = 0

    try:
        while True:
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Cambio de hora: nuevo ciclo ───────────────────────────────────
            if hour != current_hour:
                logger.info(_SEPARATOR)
                logger.info(
                    f"[MONITOR] 🕐 NUEVO CICLO HORARIO — "
                    f"{now.strftime('%Y-%m-%d %H:00 UTC')}"
                )

                if current_hour is not None:
                    wr = hour_wins / (hour_wins + hour_losses) * 100 \
                         if (hour_wins + hour_losses) > 0 else 0
                    logger.info(
                        f"[MONITOR] Resumen hora anterior: "
                        f"W={hour_wins}  L={hour_losses}  WR={wr:.0f}%  "
                        f"Ops={ops_hoy}/{max_ops}"
                    )
                    hour_wins   = 0
                    hour_losses = 0

                current_hour = hour
                fired_window = None

                # Apuesta sin resolver al cambiar de hora → descartar
                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta sin resolver al cambiar de hora — "
                        f"descartando: {active_bet['direction']} @ ${active_bet['entry']:,.2f}"
                    )
                    active_bet = None

                # Obtener nuevo Price to Beat con reintentos + notificación
                target = _fetch_target_with_retry(cfg, hour)

            # ── Ciclo normal de monitoreo ─────────────────────────────────────
            price = get_btc_price()
            if not price:
                logger.warning("[MONITOR] ⚠ No se pudo obtener precio BTC — esperando...")
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()
            _log_cycle(price, target, mins_left, ops_hoy, max_ops)

            # Sin target no se puede operar
            if not target:
                logger.warning("[MONITOR] ⏸ Sin Price to Beat — no se puede operar")
                time.sleep(interval)
                continue

            # ── Stop loss ─────────────────────────────────────────────────────
            if active_bet:
                entry = active_bet["entry"]
                dir_  = active_bet["direction"]
                pnl   = (
                    (price - entry) / entry * 100
                    if dir_ == "UP"
                    else (entry - price) / entry * 100
                )
                if pnl <= -(stop_pct * 100):
                    logger.warning(
                        f"[MONITOR] 🛑 STOP LOSS — P&L={pnl:.2f}%  "
                        f"Entry=${entry:,.2f}  Actual=${price:,.2f}"
                    )
                    notify_stop_loss(cfg, active_bet, pnl)
                    active_bet = None

            # ── Resolución de apuesta al cierre ───────────────────────────────
            if active_bet and mins_left <= 0:
                dir_   = active_bet["direction"]
                won    = (dir_ == "UP" and price > target) or \
                         (dir_ == "DOWN" and price < target)
                if won:
                    logger.info(f"[MONITOR] ✅ WIN — {dir_}  Close=${price:,.2f}  Target=${target:,.2f}")
                    notify_win(cfg, active_bet, price)
                    hour_wins += 1
                    try:
                        redimir_posicion(cfg, active_bet)
                    except Exception as e:
                        logger.error(f"[MONITOR] Error redimiendo: {e}")
                        notify_error(cfg, f"Error claim: {e}")
                else:
                    logger.info(f"[MONITOR] ❌ LOSS — {dir_}  Close=${price:,.2f}  Target=${target:,.2f}")
                    notify_loss(cfg, active_bet, price)
                    hour_losses += 1
                active_bet = None
                fired_window = None

            # ── Evaluación de señal ───────────────────────────────────────────
            if not active_bet and ops_hoy < max_ops and target:
                signal = evaluate(price, target, mins_left, cfg)
                if signal and signal.window != fired_window:
                    order = execute_order(cfg, signal, price, target)
                    if order:
                        active_bet   = order
                        fired_window = signal.window
                        ops_hoy     += 1
                        notify_bet(cfg, order, signal)
                        logger.info(
                            f"[MONITOR] 📌 Apuesta ejecutada: "
                            f"{order['direction']}  "
                            f"Entry=${price:,.2f}  Target=${target:,.2f}  "
                            f"Ventana={signal.window}"
                        )

            time.sleep(interval)

    except KeyboardInterrupt:
        logger.info("[MONITOR] 🛑 Bot detenido por el usuario")
        notify_stop(cfg)
    except Exception as e:
        logger.exception(f"[MONITOR] 💥 Error fatal: {e}")
        notify_error(cfg, str(e))
        raise
