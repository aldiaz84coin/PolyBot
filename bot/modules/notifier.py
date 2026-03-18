"""
notifier.py — Notificaciones Telegram del bot PolyBot

v5.1 — notify_new_hour muestra config completa de estrategia
  - Acepta stop_pct, stake y umbrales como parámetros opcionales.
  - Mensaje de nueva hora incluye: SL%, stake, umbrales T20/T15/T10/T5.
  - target ya viene pre-cargado desde monitor (no llega None).

v5.0: Resumen al final de cada hora con desglose de operaciones.
v4.0: notify_startup_summary, notify_order_failed.
"""
import logging

import requests

logger = logging.getLogger(__name__)


# ── Helper de envío ───────────────────────────────────────────────────────────

def _send(cfg: dict, text: str):
    token   = cfg.get("telegram", {}).get("bot_token", "")
    chat_id = cfg.get("telegram", {}).get("chat_id", "")
    if not token or not chat_id:
        logger.debug("[NOTIFIER] Telegram no configurado — mensaje omitido")
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        r.raise_for_status()
    except Exception as e:
        logger.warning(f"[NOTIFIER] ⚠ Error enviando Telegram: {e}")


# ── Inicio / parada ───────────────────────────────────────────────────────────

def notify_start(cfg: dict):
    _send(cfg, "🤖 <b>PolyBot iniciado</b> — monitoreando mercados BTC")


def notify_stop(cfg: dict):
    _send(cfg, "🛑 <b>PolyBot detenido</b>")


# ── Resumen al arrancar ───────────────────────────────────────────────────────

def notify_startup_summary(cfg: dict, hist_stats: dict):
    wins   = hist_stats.get("wins", 0)
    losses = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
    total  = hist_stats.get("total_ops", 0)
    pnl    = hist_stats.get("total_pnl", 0.0)
    wr     = round(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    sign   = "+" if pnl >= 0 else ""
    _send(cfg, (
        f"📊 <b>Historial al arrancar</b>\n"
        f"Ops     : <code>{total}</code>   "
        f"W/L: <code>{wins}W / {losses}L  WR={wr}%</code>\n"
        f"P&L tot : <code>{sign}${pnl:,.2f} USDC</code>"
    ))


# ── Apuesta / resultado ───────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, signal=None):
    direction = bet.get("direction", "—")
    window    = bet.get("window", "—")
    entry     = bet.get("entry", 0)
    target    = bet.get("target", 0)
    distance  = bet.get("distance", 0)
    stake     = bet.get("stake", 0)
    odds      = bet.get("odds", 0.5)
    tokens    = bet.get("tokens", 0)
    simulated = bet.get("simulated", False)

    arrow   = "🟢" if direction == "UP" else "🔴"
    sim_tag = " <i>[SIMULADO]</i>" if simulated else ""
    retorno = round(stake / max(odds, 0.001), 2)
    pnl_est = round(retorno - stake, 2)

    _send(cfg, (
        f"{arrow} <b>Apuesta {direction}</b>{sim_tag}\n"
        f"Ventana  : <code>{window}</code>\n"
        f"BTC entry: <code>${entry:,.2f}</code>   "
        f"Target: <code>${target:,.2f}</code>\n"
        f"Distancia: <code>${distance:+,.0f}</code>\n"
        f"Stake    : <code>${stake:.2f} USDC</code>\n"
        f"Odds     : <code>{odds:.4f}  ({odds*100:.1f}%)</code>\n"
        f"Tokens   : <code>{tokens:.4f}</code>\n"
        f"Ret. est.: <code>${retorno:.2f}  (P&L est: +${pnl_est:.2f})</code>"
    ))


def notify_win(cfg: dict, bet: dict, price: float, pnl_usd: float = None, simulated: bool = False):
    sim_tag = " <i>[SIMULADO]</i>" if simulated else ""
    pnl_str = f"+${pnl_usd:,.2f}" if pnl_usd is not None else "—"
    _send(cfg, (
        f"✅ <b>WIN</b>{sim_tag}\n"
        f"BTC cierre : <code>${price:,.2f}</code>\n"
        f"P&L        : <code>{pnl_str} USDC</code>"
    ))


def notify_loss(cfg: dict, bet: dict, price: float, simulated: bool = False):
    sim_tag = " <i>[SIMULADO]</i>" if simulated else ""
    stake   = bet.get("stake", 0)
    _send(cfg, (
        f"❌ <b>LOSS</b>{sim_tag}\n"
        f"BTC cierre : <code>${price:,.2f}</code>\n"
        f"P&L        : <code>-${stake:.2f} USDC</code>"
    ))


def notify_stop_loss(cfg: dict, bet: dict, price: float, pnl_usd: float,
                     pnl_pct: float = None, exit_token_price: float = None,
                     stop_pct: float = None, simulated: bool = False):
    sim_tag   = " <i>[SIMULADO]</i>" if simulated else ""
    direction = bet.get("direction", "—")
    entry_btc = bet.get("entry", 0)
    odds_in   = bet.get("odds", 0)
    stake     = bet.get("stake", 0)
    pnl_str   = f"${pnl_usd:+,.2f}" if pnl_usd is not None else "—"
    pct_str   = f" ({pnl_pct:+.1f}%)" if pnl_pct is not None else ""

    lines = [
        f"🛑 <b>STOP LOSS</b>{sim_tag}",
        f"Dirección  : <code>{direction}</code>",
        f"BTC entrada: <code>${entry_btc:,.2f}</code>   "
        f"BTC actual: <code>${price:,.2f}</code>",
        f"Odds entrada: <code>{odds_in:.4f}</code>",
    ]
    if exit_token_price is not None:
        lines.append(f"Odds salida : <code>{exit_token_price:.4f}</code>")
    if stop_pct is not None:
        lines.append(f"Umbral SL   : <code>{stop_pct}%</code>")
    lines.append(f"P&L         : <code>{pnl_str} USDC{pct_str}</code>")

    _send(cfg, "\n".join(lines))


def notify_order_failed(cfg: dict, signal=None):
    window = getattr(signal, "window", "—") if signal else "—"
    direc  = getattr(signal, "direction", None)
    direc_str = direc.value if direc else "—"
    _send(cfg, (
        f"⚠️ <b>Orden fallida</b>\n"
        f"Ventana   : <code>{window}</code>\n"
        f"Dirección : <code>{direc_str}</code>\n"
        f"execute_order() devolvió None — revisar credenciales / CLOB"
    ))


# ── Mercado ───────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float = None):
    slug = market.get("slug", "—")
    _send(cfg, (
        f"🔍 <b>Mercado encontrado</b>\n"
        f"Slug : <code>{slug}</code>"
        + (f"\nMins : <code>{mins_left:.1f}</code>" if mins_left is not None else "")
    ))


def notify_market_lost(cfg: dict):
    _send(cfg, "⚠️ <b>Mercado perdido</b> — esperando nuevo slug")


# ── Target ────────────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, old_target: float, new_target: float):
    _send(cfg, (
        f"🎯 <b>Target actualizado</b>\n"
        f"Anterior : <code>${old_target:,.2f}</code>\n"
        f"Nuevo    : <code>${new_target:,.2f}</code>"
    ))


def notify_target_failed(cfg: dict, hour_utc=None):
    hour_str = f"{int(hour_utc):02d}:00 UTC" if hour_utc is not None else "—"
    _send(cfg, (
        f"⚠️ <b>Target no disponible</b>\n"
        f"Hora : <code>{hour_str}</code>\n"
        f"Reintentando obtener apertura Binance..."
    ))


# ── Evaluación de señal ───────────────────────────────────────────────────────

def notify_signal_eval(cfg: dict, price: float, target: float, distance: float,
                       umbral: float, window: str, direction: str, mins_left: float):
    arrow = "🟢" if direction == "UP" else ("🔴" if direction == "DOWN" else "⏳")
    _send(cfg, (
        f"{arrow} <b>Señal [{window}]</b> → <code>{direction}</code>\n"
        f"BTC    : <code>${price:,.2f}</code>   "
        f"Target : <code>${target:,.2f}</code>\n"
        f"Dist   : <code>${distance:+,.0f}</code>   "
        f"Umbral : <code>${umbral:,.0f}</code>\n"
        f"Mins   : <code>{mins_left:.1f}</code>"
    ))


# ── Nueva hora ────────────────────────────────────────────────────────────────

def notify_new_hour(
    cfg:      dict,
    hour_utc,
    slug:     str,
    target:   float,
    stop_pct: float = None,
    stake:    float = None,
    umbrales: dict  = None,
):
    """
    v5.1: Notificación de inicio de hora con config completa de estrategia.

    Parámetros nuevos (opcionales pero recomendados):
      stop_pct  : % de stop loss (ej. 50.0)
      stake     : USDC por operación
      umbrales  : dict con claves t20, t15, t10, t5
    """
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"

    target_str = f"${target:,.2f}" if target else "—"

    lines = [
        f"🕐 <b>Nueva hora: {hour_utc:02d}:00 UTC</b>",
        f"Mercado  : <code>{slug or '—'}</code>",
        f"Target   : <code>{target_str}</code>",
    ]

    # Config de estrategia
    if stop_pct is not None or stake is not None:
        sl_str    = f"SL={stop_pct}%" if stop_pct is not None else ""
        stake_str = f"Stake=${stake} USDC" if stake is not None else ""
        sep       = "   " if sl_str and stake_str else ""
        lines.append(f"Estrategia: <code>{sl_str}{sep}{stake_str}</code>")

    if umbrales:
        t20 = umbrales.get("t20", "—")
        t15 = umbrales.get("t15", "—")
        t10 = umbrales.get("t10", "—")
        t5  = umbrales.get("t5",  "—")
        lines.append(
            f"Umbrales  : <code>T20=${t20}  T15=${t15}  T10=${t10}  T5=${t5}</code>"
        )

    _send(cfg, "\n".join(lines))


# ── Resumen horario ───────────────────────────────────────────────────────────

def notify_hour_summary(cfg: dict, hour_utc, hour_wins: int, hour_losses: int,
                        ops_hoy: int, target: float,
                        hour_ops: list | None = None,
                        hist_stats: dict | None = None):
    """
    v5.0: Resumen al final de cada hora.
    SIEMPRE se envía (la condición de filtrado está en monitor.py).
    """
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"

    total_hora = hour_wins + hour_losses
    wr_hora    = int(hour_wins / total_hora * 100) if total_hora > 0 else 0
    pnl_hora   = sum(op.get("pnl_usd", 0) for op in (hour_ops or []))
    sign_h     = "+" if pnl_hora >= 0 else ""

    lines = [
        f"📋 <b>Resumen hora {hour_utc:02d}:00 UTC</b>",
        f"Ops    : <code>{ops_hoy}</code>   "
        f"W/L: <code>{hour_wins}W / {hour_losses}L  WR={wr_hora}%</code>",
        f"P&L hora : <code>{sign_h}${pnl_hora:,.2f} USDC</code>",
        f"Target   : <code>${target:,.2f}</code>",
    ]

    if hour_ops:
        lines.append("")
        lines.append("━━━ Operaciones ━━━")
        for i, op in enumerate(hour_ops, 1):
            direction  = op.get("direction", "—")
            window     = op.get("window", "—")
            entry_odds = op.get("entry_odds", 0)
            tokens     = op.get("tokens", 0)
            exit_odds  = op.get("exit_odds", 0)
            result     = op.get("result", "—")
            pnl        = op.get("pnl_usd", 0)
            simulated  = op.get("simulated", False)

            arrow   = "🟢" if direction == "UP" else "🔴"
            res_ico = {"WIN": "✅", "LOSS": "❌", "STOP": "🛑"}.get(result, "❓")
            pnl_s   = f"+${pnl:,.2f}" if pnl >= 0 else f"-${abs(pnl):,.2f}"
            sim_tag = " <i>[SIM]</i>" if simulated else ""

            lines.append(
                f"{i}. {arrow} {direction} [{window}]{sim_tag}\n"
                f"   Odds E/S: <code>{entry_odds:.4f} → {exit_odds:.4f}</code>   "
                f"Tokens: <code>{tokens:.4f}</code>\n"
                f"   {res_ico} <b>{result}</b>   P&L: <code>{pnl_s} USDC</code>"
            )

    if hist_stats:
        wins_t  = hist_stats.get("wins", 0)
        losses_t = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
        total_t  = hist_stats.get("total_ops", 0)
        pnl_t    = hist_stats.get("total_pnl", 0.0)
        wr_t     = round(wins_t / (wins_t + losses_t) * 100) if (wins_t + losses_t) > 0 else 0
        sign_t   = "+" if pnl_t >= 0 else ""
        lines.append("")
        lines.append(
            f"📊 <i>Global: {total_t} ops  {wins_t}W/{losses_t}L  "
            f"WR={wr_t}%  P&L={sign_t}${pnl_t:,.2f}</i>"
        )

    _send(cfg, "\n".join(lines))


# ── Error ─────────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, msg: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{msg[:500]}</code>")
