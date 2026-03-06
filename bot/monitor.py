"""
monitor.py — Loop principal del bot: ventana horaria, stop loss, resolución.

Logging enriquecido: estado completo en cada ciclo, tablas de señal,
resúmenes de sesión y hora.
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

_SEP  = "═" * 62
_SEP2 = "─" * 62
_SEP3 = "·" * 62

WINDOWS = [
    {"key": "T-20", "min": 17, "max": 22},
    {"key": "T-15", "min": 12, "max": 17},
    {"key": "T-10", "min":  7, "max": 12},
    {"key": "T-5",  "min":  2, "max":  7},
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60 - now.minute - now.second / 60


def _window_bar(mins_left: float) -> str:
    """Renderiza una barra ASCII de las 4 ventanas con cursor."""
    total = 60
    pos   = int(((total - mins_left) / total) * 40)
    pos   = max(0, min(39, pos))
    bar   = [" "] * 40
    # Marcar zonas de ventana
    for w in WINDOWS:
        lo = int(((total - w["max"]) / total) * 40)
        hi = int(((total - w["min"]) / total) * 40)
        for i in range(lo, hi):
            if 0 <= i < 40:
                bar[i] = "░"
    # Cursor
    if 0 <= pos < 40:
        bar[pos] = "█"
    return "│" + "".join(bar) + "│  " + f"{mins_left:.1f}m"


def _get_active_window_label(mins_left: float) -> str:
    for w in WINDOWS:
        if w["min"] <= mins_left < w["max"]:
            return w["key"]
    return "—"


def _log_cycle_full(
    price: float,
    target: float | None,
    mins_left: float,
    ops_hoy: int,
    max_ops: int,
    active_bet: dict | None,
    stop_pct: float,
    cycle_n: int,
):
    """Log detallado cada N ciclos o siempre si hay posición activa."""
    now_str = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    dist_str = "—"
    dist_arrow = ""
    if price and target:
        dist   = price - target
        sign   = "+" if dist >= 0 else ""
        dist_str   = f"{sign}${dist:,.0f}"
        dist_arrow = "▲" if dist >= 0 else "▼"

    window_label = _get_active_window_label(mins_left)
    bar = _window_bar(mins_left)
    mm  = int(mins_left)
    ss  = int((mins_left % 1) * 60)

    logger.debug(_SEP3)
    logger.debug(
        f"[MONITOR #{cycle_n}]  {now_str}  ·  ciclo #{cycle_n}"
    )
    logger.debug(
        f"  BTC precio     : ${price:>12,.2f}"
    )
    logger.debug(
        f"  Price to Beat  : ${target:>12,.2f}" if target else "  Price to Beat  : —"
    )
    if price and target:
        logger.debug(
            f"  Distancia      : {dist_str:>13}  {dist_arrow}"
        )
    logger.debug(
        f"  Tiempo restante: {mm:02d}:{ss:02d}  ({mins_left:.2f} min)"
    )
    logger.debug(f"  Ventana activa : {window_label}")
    logger.debug(f"  Progreso hora  : {bar}")
    logger.debug(f"  Ops hoy        : {ops_hoy} / {max_ops}")

    if active_bet:
        entry = active_bet["entry"]
        dir_  = active_bet["direction"]
        pnl   = (
            (price - entry) / entry * 100
            if dir_ == "UP"
            else (entry - price) / entry * 100
        )
        pnl_arrow = "▲" if pnl >= 0 else "▼"
        sl_pct    = stop_pct * 100
        sl_rem    = pnl - (-sl_pct)   # cuánto queda para el stop
        logger.debug(f"  {_SEP2[:50]}")
        logger.debug(f"  POSICIÓN ACTIVA:")
        logger.debug(f"    Dirección    : {dir_}  {'▲' if dir_ == 'UP' else '▼'}")
        logger.debug(f"    Entry        : ${entry:>12,.2f}")
        logger.debug(f"    Target       : ${active_bet['target']:>12,.2f}")
        logger.debug(f"    Actual       : ${price:>12,.2f}")
        logger.debug(f"    P&L actual   : {pnl:>+.2f}%  {pnl_arrow}")
        logger.debug(f"    Stop Loss    : -{sl_pct:.0f}%  (margen: {sl_rem:+.2f}%)")
        logger.debug(f"    Ventana orig.: {active_bet.get('window', '—')}")


def _log_signal_header(price: float, target: float, mins_left: float, window_key: str, umbral: float):
    dist  = price - target
    sign  = "+" if dist >= 0 else ""
    arrow = "▲ UP" if dist > umbral else ("▼ DOWN" if dist < -umbral else "⏳ WAIT")
    actionable = abs(dist) > umbral
    logger.info(_SEP2)
    logger.info(f"[STRATEGY] Evaluación de señal — ventana {window_key}")
    logger.info(f"[STRATEGY]   BTC precio   : ${price:,.2f}")
    logger.info(f"[STRATEGY]   Price to Beat: ${target:,.2f}")
    logger.info(f"[STRATEGY]   Distancia    : {sign}${dist:,.0f}")
    logger.info(f"[STRATEGY]   Umbral       : ${umbral:,.0f}")
    logger.info(f"[STRATEGY]   Decisión     : {arrow}  {'✅ ACCIONABLE' if actionable else '❌ DEBAJO DEL UMBRAL'}")
    logger.info(_SEP2)


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    interval   = cfg["strategy"]["monitor_intervalo_s"]
    stop_pct   = cfg["strategy"]["stop_loss_pct"]
    stake      = cfg["capital"]["stake_usdc"]
    max_ops    = cfg["capital"]["max_operaciones_dia"]

    logger.info(_SEP)
    logger.info(f"[MONITOR] 🤖 POLYMARKET BTC BOT — INICIADO")
    logger.info(f"[MONITOR] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(_SEP2)
    logger.info(f"[MONITOR] Configuración activa:")
    logger.info(f"[MONITOR]   Stake/op       : ${stake} USDC")
    logger.info(f"[MONITOR]   Max ops/día    : {max_ops}")
    logger.info(f"[MONITOR]   Stop Loss      : {stop_pct*100:.0f}%")
    logger.info(f"[MONITOR]   Intervalo loop : {interval}s")
    logger.info(f"[MONITOR]   Umbrales:")
    logger.info(f"[MONITOR]     T-20 (17-22 min) : ${cfg['strategy']['t20_umbral_usd']}")
    logger.info(f"[MONITOR]     T-15 (12-17 min) : ${cfg['strategy']['t15_umbral_usd']}")
    logger.info(f"[MONITOR]     T-10 ( 7-12 min) : ${cfg['strategy']['t10_umbral_usd']}")
    logger.info(f"[MONITOR]     T-5  ( 2- 7 min) : ${cfg['strategy']['t5_umbral_usd']}")
    logger.info(_SEP)

    notify_start(cfg)

    ops_hoy       = 0
    active_bet    = None
    fired_window  = None
    target        = None
    current_hour  = None
    cycle_n       = 0
    hour_wins     = 0
    hour_losses   = 0
    session_wins  = 0
    session_losses= 0

    try:
        while True:
            cycle_n += 1
            now  = datetime.now(timezone.utc)
            hour = now.hour

            # ── Nuevo ciclo horario ───────────────────────────────────────
            if hour != current_hour:
                # Resumen hora anterior
                if current_hour is not None:
                    logger.info(_SEP)
                    logger.info(
                        f"[MONITOR] 📊 RESUMEN HORA {current_hour:02d}:00 UTC"
                    )
                    logger.info(f"[MONITOR]   Operaciones : {ops_hoy}")
                    logger.info(f"[MONITOR]   Ganadas     : {hour_wins}")
                    logger.info(f"[MONITOR]   Perdidas    : {hour_losses}")
                    wr = (hour_wins / (hour_wins + hour_losses) * 100) if (hour_wins + hour_losses) > 0 else 0
                    logger.info(f"[MONITOR]   Win rate    : {wr:.0f}%")
                    logger.info(_SEP)

                current_hour  = hour
                fired_window  = None
                hour_wins     = 0
                hour_losses   = 0

                # Reset apuesta colgada
                if active_bet:
                    logger.warning(
                        f"[MONITOR] ⚠ Apuesta sin resolver al cambiar de hora — descartando\n"
                        f"[MONITOR]   Dir: {active_bet['direction']}  "
                        f"Entry: ${active_bet['entry']:,.2f}"
                    )
                    active_bet = None

                # Banner nuevo ciclo horario
                logger.info(_SEP)
                logger.info(
                    f"[MONITOR] 🕐 NUEVO CICLO HORARIO — "
                    f"{now.strftime('%Y-%m-%d %H:00 UTC')}"
                )

                # Price to Beat
                logger.info(f"[MONITOR] Cargando Price to Beat desde Binance 1H...")
                target = get_open_1h_binance()
                if target:
                    logger.info(
                        f"[MONITOR] ✅ Price to Beat confirmado: ${target:,.2f}"
                    )
                else:
                    logger.error(
                        f"[MONITOR] ❌ No se pudo obtener Price to Beat.\n"
                        f"[MONITOR]   Sin target, el bot no puede operar esta hora.\n"
                        f"[MONITOR]   Reintentará en {interval}s."
                    )

                # Mercado activo
                logger.info(f"[MONITOR] Buscando mercado activo en Polymarket...")
                market_info = get_active_market()
                if market_info:
                    q     = market_info.get("question", "—")
                    mins  = market_info.get("mins_to_close", 0)
                    mm    = int(mins)
                    ss    = int((mins % 1) * 60)
                    cond  = market_info.get("condition_id", "—")
                    tokens= market_info.get("tokens", [])
                    yes_p = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
                    no_p  = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)
                    logger.info(f"[MONITOR] ✅ Mercado OK")
                    logger.info(f"[MONITOR]   {q}")
                    logger.info(f"[MONITOR]   Cierre en  : {mm:02d}:{ss:02d}")
                    logger.info(f"[MONITOR]   ConditionID: {cond}")
                    if yes_p:
                        logger.info(f"[MONITOR]   YES (UP)   : ${yes_p:.4f}  ({yes_p*100:.1f}%)")
                    if no_p:
                        logger.info(f"[MONITOR]   NO  (DOWN) : ${no_p:.4f}  ({no_p*100:.1f}%)")
                else:
                    logger.warning(
                        f"[MONITOR] ⚠ Mercado no encontrado en Polymarket.\n"
                        f"[MONITOR]   El bot monitorizará precio y señal, pero no ejecutará\n"
                        f"[MONITOR]   hasta que el mercado esté disponible."
                    )

                logger.info(_SEP)

            # ── Sin target: esperar ───────────────────────────────────────
            if not target:
                logger.debug(f"[MONITOR] Sin target — reintentando en {interval}s")
                time.sleep(interval)
                continue

            # ── Obtener precio ────────────────────────────────────────────
            try:
                price = get_btc_price()
            except Exception as e:
                logger.error(
                    f"[MONITOR] ❌ Fallo al obtener precio BTC: {type(e).__name__}: {e}\n"
                    f"[MONITOR]   Reintentando en {interval}s..."
                )
                time.sleep(interval)
                continue

            mins_left = _mins_to_close()

            # Log detallado cada 12 ciclos (~1 min) o cuando hay posición
            if cycle_n % 12 == 0 or active_bet:
                _log_cycle_full(
                    price, target, mins_left,
                    ops_hoy, max_ops, active_bet, stop_pct, cycle_n,
                )

            # ── Monitor posición activa ────────────────────────────────────
            if active_bet:
                entry = active_bet["entry"]
                dir_  = active_bet["direction"]
                pnl   = (
                    (price - entry) / entry * 100
                    if dir_ == "UP"
                    else (entry - price) / entry * 100
                )

                # Stop Loss
                if pnl <= -stop_pct * 100:
                    logger.warning(_SEP)
                    logger.warning(f"[MONITOR] 🛑 STOP LOSS ACTIVADO")
                    logger.warning(f"[MONITOR]   Dirección : {dir_}  {'▲' if dir_ == 'UP' else '▼'}")
                    logger.warning(f"[MONITOR]   Entry     : ${entry:,.2f}")
                    logger.warning(f"[MONITOR]   Actual    : ${price:,.2f}")
                    logger.warning(f"[MONITOR]   P&L       : {pnl:+.2f}%  (límite -{stop_pct*100:.0f}%)")
                    logger.warning(f"[MONITOR]   Ventana   : {active_bet.get('window', '—')}")
                    logger.warning(_SEP)
                    notify_stop_loss(cfg, active_bet, pnl)
                    hour_losses += 1
                    session_losses += 1
                    active_bet   = None
                    fired_window = None
                    time.sleep(interval)
                    continue

                # Resolución al cierre de vela
                if mins_left <= 0.8:
                    won = (
                        (dir_ == "UP"   and price > active_bet["target"]) or
                        (dir_ == "DOWN" and price < active_bet["target"])
                    )
                    result_icon = "✅ WIN" if won else "❌ LOSS"
                    logger.info(_SEP)
                    logger.info(f"[MONITOR] {result_icon} — RESOLUCIÓN AL CIERRE")
                    logger.info(f"[MONITOR]   Dirección  : {dir_}  {'▲' if dir_ == 'UP' else '▼'}")
                    logger.info(f"[MONITOR]   Entry      : ${active_bet['entry']:,.2f}")
                    logger.info(f"[MONITOR]   Target     : ${active_bet['target']:,.2f}")
                    logger.info(f"[MONITOR]   Cierre BTC : ${price:,.2f}")
                    logger.info(f"[MONITOR]   Dist final : {price - active_bet['target']:+,.2f}")
                    logger.info(f"[MONITOR]   Ventana    : {active_bet.get('window', '—')}")
                    logger.info(_SEP)

                    if won:
                        hour_wins     += 1
                        session_wins  += 1
                        logger.info(f"[MONITOR] 🏆 Ganado — iniciando claim on-chain (Polygon)...")
                        try:
                            tx = redimir_posicion(active_bet["market"], active_bet["direction"], cfg)
                            logger.info(f"[MONITOR] ✅ Claim confirmado")
                            logger.info(f"[MONITOR]   TX: {tx}")
                            logger.info(f"[MONITOR]   Explorer: https://polygonscan.com/tx/{tx}")
                        except Exception as e:
                            logger.error(
                                f"[MONITOR] ❌ Claim fallido: {type(e).__name__}: {e}",
                                exc_info=True,
                            )
                        notify_win(cfg, active_bet, price)
                    else:
                        hour_losses   += 1
                        session_losses += 1
                        logger.info(f"[MONITOR] 💔 Perdido — sin claim")
                        notify_loss(cfg, active_bet, price)

                    # Mini-resumen running
                    total = session_wins + session_losses
                    wr    = (session_wins / total * 100) if total > 0 else 0
                    logger.info(f"[MONITOR] 📈 Sesión: {session_wins}W / {session_losses}L  ({wr:.0f}% WR)")

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
                        f"[MONITOR] Ventana {signal.window} ya disparada — esperando siguiente ventana"
                    )
                    time.sleep(interval)
                    continue

                # Buscar mercado para ejecutar
                logger.info(f"[MONITOR] 🔍 Señal {signal.direction.value} detectada — buscando mercado...")
                market = get_active_market()
                if not market:
                    logger.warning(
                        f"[MONITOR] ⚠ Mercado no disponible — señal {signal.direction.value} "
                        f"descartada en ventana {signal.window}"
                    )
                    time.sleep(interval)
                    continue

                logger.info(_SEP)
                logger.info(f"[MONITOR] 🚀 EJECUTANDO ORDEN")
                logger.info(f"[MONITOR]   Dirección  : {signal.direction.value}  {'▲' if signal.direction == Direction.UP else '▼'}")
                logger.info(f"[MONITOR]   Ventana    : {signal.window}")
                logger.info(f"[MONITOR]   BTC precio : ${signal.price:,.2f}")
                logger.info(f"[MONITOR]   Target     : ${signal.target:,.2f}")
                logger.info(f"[MONITOR]   Distancia  : {signal.distance:+,.0f}  (umbral ${signal.umbral})")
                logger.info(f"[MONITOR]   Stake      : ${stake} USDC")
                logger.info(_SEP2)

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
                    sim_flag = " (SIMULADO)" if result.get("simulated") else ""
                    logger.info(f"[MONITOR] ✅ APUESTA REGISTRADA{sim_flag}")
                    logger.info(f"[MONITOR]   Ops hoy    : {ops_hoy}/{max_ops}")
                    logger.info(f"[MONITOR]   Sesión     : {session_wins}W / {session_losses}L")
                    logger.info(_SEP)
                    notify_bet(cfg, active_bet, signal)
                else:
                    logger.error(
                        f"[MONITOR] ❌ ORDEN FALLIDA\n"
                        f"[MONITOR]   Señal {signal.direction.value} en ventana {signal.window} no ejecutada.\n"
                        f"[MONITOR]   Causa: ver logs de execute_order arriba.\n"
                        f"[MONITOR]   El bot reintentará en el siguiente ciclo si la señal persiste."
                    )

            elif ops_hoy >= max_ops:
                logger.debug(
                    f"[MONITOR] Límite diario alcanzado ({ops_hoy}/{max_ops}) — "
                    f"esperando nuevo ciclo horario"
                )

            time.sleep(interval)

    except KeyboardInterrupt:
        logger.info(_SEP)
        logger.info(f"[MONITOR] 🛑 Bot detenido por el usuario (Ctrl+C)")
        logger.info(f"[MONITOR] ── RESUMEN DE SESIÓN ──────────────────────────")
        logger.info(f"[MONITOR]   Operaciones totales : {session_wins + session_losses}")
        logger.info(f"[MONITOR]   Ganadas             : {session_wins}")
        logger.info(f"[MONITOR]   Perdidas            : {session_losses}")
        total = session_wins + session_losses
        wr    = (session_wins / total * 100) if total > 0 else 0
        logger.info(f"[MONITOR]   Win rate sesión     : {wr:.0f}%")
        logger.info(_SEP)
        notify_stop(cfg)

    except Exception as e:
        logger.critical(
            f"[MONITOR] 💥 ERROR CRÍTICO: {type(e).__name__}: {e}",
            exc_info=True,
        )
        notify_error(cfg, str(e))
        raise
