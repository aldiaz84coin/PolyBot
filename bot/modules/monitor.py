"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución
"""
import logging
import time
from datetime import datetime, timezone

from .price_feed    import get_btc_price
from .market_scanner import get_active_market, get_open_1h_binance
from .strategy       import evaluate, execute_order, Direction
from .claimer        import redimir_posicion
from .notifier       import (
    notify_start, notify_stop, notify_bet,
    notify_win, notify_loss, notify_stop_loss, notify_error,
)

logger = logging.getLogger(__name__)


def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def run(cfg: dict):
    """Arranca el loop principal del bot."""
    interval   = cfg["strategy"]["monitor_intervalo_s"]
    stop_pct   = cfg["strategy"]["stop_loss_pct"]
    stake      = cfg["capital"]["stake_usdc"]
    max_ops    = cfg["capital"]["max_operaciones_dia"]

    notify_start(cfg)
    logger.info("Bot iniciado")

    ops_hoy       = 0
    active_bet    = None      # dict con datos de la apuesta activa
    fired_window  = None      # ventana en la que ya disparamos
    target        = None
    current_hour  = None

    try:
        while True:
            now   = datetime.now(timezone.utc)
            hour  = now.hour

            # ── Nuevo ciclo horario ───────────────────────────────────────
            if hour != current_hour:
                current_hour = hour
                fired_window = None
                active_bet   = None
                target       = get_open_1h_binance()
                logger.info(f"Nueva hora — Target fijado: ${target:,.2f}" if target else "Nueva hora — Target no disponible")

            if not target:
                time.sleep(interval)
                continue

            # ── Obtener precio ────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.error(f"Error obteniendo precio: {e}")
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()

            # ── Monitor de posición activa (stop loss + resolución) ────────
            if active_bet:
                entry = active_bet["entry"]
                dir_  = active_bet["direction"]
                pnl   = (price - entry) / entry * 100 if dir_ == "UP" else (entry - price) / entry * 100

                # Stop loss
                if pnl <= -stop_pct * 100:
                    logger.warning(f"🛑 STOP LOSS activado — P&L: {pnl:.1f}%")
                    notify_stop_loss(cfg, active_bet, pnl)
                    active_bet = None
                    fired_window = None
                    time.sleep(interval)
                    continue

                # Resolución al cierre
                if mins_left <= 0.1:
                    won = (dir_ == "UP" and price > active_bet["target"]) or \
                          (dir_ == "DOWN" and price < active_bet["target"])
                    if won:
                        logger.info("✅ Evento ganado — iniciando claim automático")
                        try:
                            redimir_posicion(active_bet["market"], active_bet["direction"], cfg)
                        except Exception as e:
                            logger.error(f"Claim fallido: {e}")
                        notify_win(cfg, active_bet, price)
                    else:
                        logger.info("❌ Evento perdido")
                        notify_loss(cfg, active_bet, price)
                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Lógica de señal (solo si no hay posición activa) ──────────
            if not active_bet and ops_hoy < max_ops:
                signal = evaluate(price, target, mins_left, cfg)

                if signal and signal.is_actionable and fired_window != signal.window:
                    market = get_active_market()
                    if not market:
                        logger.warning("Mercado no encontrado — skip")
                    else:
                        result = execute_order(signal, market, cfg)
                        if result:
                            fired_window = signal.window
                            ops_hoy += 1
                            active_bet = {
                                "direction": signal.direction.value,
                                "entry":     price,
                                "target":    target,
                                "window":    signal.window,
                                "stake":     stake,
                                "market":    market,
                            }
                            notify_bet(cfg, active_bet, signal)
                            logger.info(f"Apuesta ejecutada: {signal.direction.value} @ ${price:,.2f}")
                        else:
                            logger.error("Orden fallida — reintentando en el siguiente ciclo")

            time.sleep(interval)

    except KeyboardInterrupt:
        notify_stop(cfg)
        logger.info("Bot detenido por el usuario (Ctrl+C)")
    except Exception as e:
        notify_error(cfg, str(e))
        logger.critical(f"Error crítico: {e}", exc_info=True)
        raise
