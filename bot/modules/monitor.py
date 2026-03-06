"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución

v2.4 — Notificaciones Telegram ampliadas:
  - notify_market_found() al detectar mercado activo
  - notify_market_lost() cuando no se encuentra mercado
  - notify_signal_eval() al entrar en nueva ventana o cambiar dirección
  - notify_hour_summary() al final de cada hora
  - notify_target_change() al obtener Price to Beat
  - notify_target_failed() si no se consigue el Price to Beat
  - Retry automático si get_open_1h_binance() falla

FIX: mercado se obtiene ANTES que el target para pasar el slug a Binance.
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
    logger.info(f"[MONITOR]   Umbrales     : "
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
    hour_wins    = 0
    hour_losses  = 0
    last_market  = None
    last_window  = None

    try:
        while True:
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Cambio de hora ────────────────────────────────────────────────
            if hour != current_hour:
                logger.info(_SEPARATOR)
                logger.info(f"[MONITOR] 🕐 NUEVO CICLO HORARIO — {now.strftime('%Y-%m-%d %H:00 UTC')}")

                # Resumen de la hora anterior
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
                    ops_hoy     = 0

                current_hour = hour
                fired_window = None
                last_window  = None

                # Apuesta sin resolver → descarta
                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta sin resolver al cambiar de hora — "
                        f"descartando: {active_bet['direction']} @ ${active_bet['entry']:,.2f}"
                    )
                    active_bet = None

                # ── Mercado PRIMERO para obtener el slug ──────────────────────
                logger.info(f"[MONITOR] 🔍 Buscando mercado activo en Polymarket...")
                last_market = get_active_market()

                if last_market:
                    slug = last_market.get("slug")
                    mins_now = _mins_to_close()
                    logger.info(f"[MONITOR] ✅ Mercado encontrado: {last_market.get('question', '—')}")
                    logger.info(f"[MONITOR]   Slug : {slug}")
                    notify_market_found(cfg, last_market, mins_now)
                else:
                    slugs_tried = []  # market_scanner puede exponer esto en el futuro
                    logger.warning(f"[MONITOR] ⚠ No se encontró mercado activo en Polymarket")
                    notify_market_lost(cfg, slugs_tried)
                    slug = None

                # ── Price to Beat con el slug del mercado activo ──────────────
                target = _fetch_target_with_retry(cfg, hour, slug=slug)

                if not target:
                    logger.error(
                        f"[MONITOR] ❌ Sin Price to Beat para la hora {hour:02d}:00 UTC. "
                        f"El bot esperará al siguiente ciclo horario."
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
                        hour_wins += 1
                        notify_win(cfg, active_bet, price)
                        logger.info("[MONITOR] 🏆 Evento ganado — iniciando claim automático on-chain")
                        try:
                            redimir_posicion(active_bet["market"], cfg)
                        except Exception as e:
                            logger.error(f"[MONITOR] ❌ Error en claim: {e}")
                    else:
                        hour_losses += 1
                        notify_loss(cfg, active_bet, price)

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

                # Notificar Telegram al entrar en nueva ventana o cambiar dirección
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
                        time.sleep(interval)
                        continue

                logger.info(
                    f"[MONITOR] 📊 Ejecutando orden — "
                    f"{signal.direction.value} | ventana {signal.window} | "
                    f"dist={signal.distance:+,.0f} | umbral={signal.umbral}"
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
                        f"en ventana {signal.window} no ejecutada."
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
