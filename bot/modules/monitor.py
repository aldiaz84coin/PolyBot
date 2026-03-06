"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución
"""
import logging
import time
from datetime import datetime, timezone

from .price_feed     import get_btc_price
from .market_scanner import get_active_market, get_open_1h_binance
from .strategy       import evaluate, execute_order, Direction
from .claimer        import redimir_posicion
from .notifier       import (
    notify_start, notify_stop, notify_bet,
    notify_win, notify_loss, notify_stop_loss, notify_error,
)

logger = logging.getLogger(__name__)

_SEPARATOR = "─" * 60


def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def _log_cycle_header(price: float, target: float | None, mins_left: float, ops_hoy: int, max_ops: int):
    """Imprime un resumen compacto del estado en cada ciclo."""
    dist_str = "—"
    if price and target:
        dist = price - target
        dist_str = f"{dist:+,.0f}"

    logger.debug(
        f"[MONITOR] Ciclo — "
        f"BTC=${price:,.2f}  "
        f"Target={f'${target:,.2f}' if target else '—'}  "
        f"Dist={dist_str}  "
        f"Mins={mins_left:.1f}  "
        f"Ops={ops_hoy}/{max_ops}"
    )


def run(cfg: dict):
    """Arranca el loop principal del bot."""
    interval   = cfg["strategy"]["monitor_intervalo_s"]
    stop_pct   = cfg["strategy"]["stop_loss_pct"]
    stake      = cfg["capital"]["stake_usdc"]
    max_ops    = cfg["capital"]["max_operaciones_dia"]

    logger.info(_SEPARATOR)
    logger.info(f"[MONITOR] 🤖 Bot iniciado")
    logger.info(f"[MONITOR] Configuración:")
    logger.info(f"[MONITOR]   Stake/op      : ${stake} USDC")
    logger.info(f"[MONITOR]   Max ops/día   : {max_ops}")
    logger.info(f"[MONITOR]   Stop loss     : {stop_pct*100:.0f}%")
    logger.info(f"[MONITOR]   Intervalo     : {interval}s")
    logger.info(f"[MONITOR]   Umbrales      : "
                f"T-20=${cfg['strategy']['t20_umbral_usd']}  "
                f"T-15=${cfg['strategy']['t15_umbral_usd']}  "
                f"T-10=${cfg['strategy']['t10_umbral_usd']}  "
                f"T-5=${cfg['strategy']['t5_umbral_usd']}")
    logger.info(_SEPARATOR)

    notify_start(cfg)

    ops_hoy      = 0
    active_bet   = None
    fired_window = None
    target       = None
    current_hour = None

    try:
        while True:
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Nuevo ciclo horario ───────────────────────────────────────
            if hour != current_hour:
                logger.info(_SEPARATOR)
                logger.info(
                    f"[MONITOR] 🕐 NUEVO CICLO HORARIO — {now.strftime('%Y-%m-%d %H:00 UTC')}"
                )
                if current_hour is not None:
                    logger.info(
                        f"[MONITOR] Resumen hora anterior: "
                        f"{ops_hoy} operaciones ejecutadas"
                    )

                current_hour = hour
                fired_window = None

                # Resetear apuesta activa si hay cambio de hora sin resolución
                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta activa sin resolver al cambiar de hora — "
                        f"descartando: {active_bet['direction']} @ ${active_bet['entry']:,.2f}"
                    )
                    active_bet = None

                # Obtener nuevo target
                logger.info(f"[MONITOR] Obteniendo Price to Beat (OPEN 1H Binance)...")
                target = get_open_1h_binance()
                if target:
                    logger.info(f"[MONITOR] ✅ Nuevo Price to Beat fijado: ${target:,.2f}")
                else:
                    logger.error(
                        f"[MONITOR] ❌ No se pudo obtener el Price to Beat. "
                        f"El bot esperará al siguiente ciclo."
                    )

                # Obtener mercado activo
                logger.info(f"[MONITOR] Buscando mercado activo en Polymarket...")
                market_info = get_active_market()
                if market_info:
                    logger.info(
                        f"[MONITOR] ✅ Mercado encontrado: {market_info.get('question', '—')}"
                    )
                else:
                    logger.warning(f"[MONITOR] ⚠ No se encontró mercado activo en Polymarket")

                logger.info(_SEPARATOR)

            if not target:
                logger.debug(f"[MONITOR] Sin target — skip ciclo")
                time.sleep(interval)
                continue

            # ── Obtener precio ────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.error(
                    f"[MONITOR] ❌ Error obteniendo precio BTC: {type(e).__name__}: {e}"
                )
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()
            _log_cycle_header(price, target, mins_left, ops_hoy, max_ops)

            # ── Monitor posición activa ────────────────────────────────────
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
                    logger.warning(
                        f"[MONITOR] 🛑 STOP LOSS activado\n"
                        f"           Dirección : {dir_}\n"
                        f"           Entry     : ${entry:,.2f}\n"
                        f"           Actual    : ${price:,.2f}\n"
                        f"           P&L       : {pnl:+.2f}%\n"
                        f"           Límite    : -{stop_pct*100:.0f}%"
                    )
                    notify_stop_loss(cfg, active_bet, pnl)
                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

                # Resolución al cierre
                if mins_left <= 0.1:
                    won = (
                        (dir_ == "UP"   and price > active_bet["target"]) or
                        (dir_ == "DOWN" and price < active_bet["target"])
                    )
                    result_tag = "✅ WIN" if won else "❌ LOSS"
                    logger.info(
                        f"[MONITOR] {result_tag} — Resolución al cierre\n"
                        f"           Dirección : {dir_}\n"
                        f"           Entry     : ${active_bet['entry']:,.2f}\n"
                        f"           Target    : ${active_bet['target']:,.2f}\n"
                        f"           Cierre    : ${price:,.2f}\n"
                        f"           Ventana   : {active_bet.get('window', '—')}"
                    )

                    if won:
                        logger.info("[MONITOR] 🏆 Evento ganado — iniciando claim automático on-chain")
                        try:
                            tx = redimir_posicion(active_bet["market"], active_bet["direction"], cfg)
                            logger.info(f"[MONITOR] ✅ Claim confirmado — tx: {tx}")
                        except Exception as e:
                            logger.error(
                                f"[MONITOR] ❌ Claim fallido: {type(e).__name__}: {e}",
                                exc_info=True,
                            )
                        notify_win(cfg, active_bet, price)
                    else:
                        logger.info("[MONITOR] 💔 Evento perdido — sin claim")
                        notify_loss(cfg, active_bet, price)

                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

            # ── Lógica de señal ───────────────────────────────────────────
            if not active_bet and ops_hoy < max_ops:
                signal = evaluate(price, target, mins_left, cfg)

                if signal is None:
                    time.sleep(interval)
                    continue

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

                # Buscar mercado activo
                logger.info(f"[MONITOR] 🔍 Buscando mercado activo para ejecutar orden...")
                market = get_active_market()
                if not market:
                    logger.warning(
                        f"[MONITOR] ⚠ Mercado no encontrado — señal {signal.direction.value} "
                        f"descartada en ventana {signal.window}"
                    )
                    time.sleep(interval)
                    continue

                logger.info(
                    f"[MONITOR] 📊 Ejecutando orden — "
                    f"{signal.direction.value} | ventana {signal.window} | "
                    f"dist={signal.distance:+,.0f} | umbral={signal.umbral}"
                )
                result = execute_order(signal, market, cfg)

                if result:
                    fired_window = signal.window
                    ops_hoy     += 1
                    active_bet   = {
                        "direction": signal.direction.value,
                        "entry":     price,
                        "target":    target,
                        "window":    signal.window,
                        "stake":     stake,
                        "market":    market,
                    }
                    notify_bet(cfg, active_bet, signal)
                    logger.info(
                        f"[MONITOR] ✅ Apuesta registrada ({ops_hoy}/{max_ops} hoy):\n"
                        f"           Dirección : {signal.direction.value}\n"
                        f"           Entry     : ${price:,.2f}\n"
                        f"           Target    : ${target:,.2f}\n"
                        f"           Distancia : ${abs(signal.distance):,.0f}\n"
                        f"           Umbral    : ${signal.umbral}\n"
                        f"           Ventana   : {signal.window}\n"
                        f"           Stake     : ${stake} USDC\n"
                        f"           Simul.    : {result.get('simulated', False)}"
                    )
                else:
                    logger.error(
                        f"[MONITOR] ❌ Orden fallida — señal {signal.direction.value} "
                        f"en ventana {signal.window} no ejecutada. "
                        f"Reintentando en el siguiente ciclo."
                    )

            elif ops_hoy >= max_ops:
                logger.debug(
                    f"[MONITOR] Límite diario alcanzado ({ops_hoy}/{max_ops}) — "
                    f"bot en pausa hasta nueva hora"
                )

            time.sleep(interval)

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
