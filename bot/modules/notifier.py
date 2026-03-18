"""
notifier.py — Alertas Telegram para el bot de Polymarket BTC

v6.2 — notify_stop_loss enriquecida:
  - Muestra precio de compra, tokens comprados y total invertido
  - Muestra precio de venta (CLOB exit), tokens y total recuperado
  - Muestra resultado neto en USD y %
  - Muestra la condición exacta que disparó el SL (token entry→exit, pérdida vs umbral)

v6.1 — FIX CRÍTICO: añade notify_order_failed() que faltaba y causaba
       ImportError al arrancar, bloqueando todo el bot.

v5.0 — FIXES NOTIFICACIONES:
  1. _send() ahora loguea ERROR cuando token/chat_id están vacíos
  2. _send() loguea la respuesta HTTP de Telegram cuando falla (status != 200)
  3. notify_market_found() enriquecida: muestra YES/NO precios + conditionId
  4. notify_hour_summary() dispara SIEMPRE al cambio de hora (sin condición)
  5. notify_new_hour() nueva función: resumen de cambio de hora aunque no haya ops

Destinos:
  bot/notifier.py          (import absoluto)
  bot/modules/notifier.py  (import relativo)
"""
import logging

import requests

logger = logging.getLogger(__name__)

_SEND_URL = "https://api.telegram.org/bot{token}/sendMessage"


def _send(cfg: dict, text: str):
    token   = cfg.get("telegram", {}).get("bot_token", "")
    chat_id = cfg.get("telegram", {}).get("chat_id", "")

    if not token:
        logger.error("[NOTIF] ❌ telegram.bot_token vacío — mensaje no enviado")
        return
    if not chat_id:
        logger.error("[NOTIF] ❌ telegram.chat_id vacío — mensaje no enviado")
        return

    try:
        resp = requests.post(
            _SEND_URL.format(token=token),
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        if resp.status_code != 200:
            logger.error(
                f"[NOTIF] ❌ Telegram HTTP {resp.status_code}: {resp.text[:300]}"
            )
        else:
            logger.debug("[NOTIF] ✅ Telegram enviado correctamente")
    except requests.exceptions.Timeout:
        logger.warning("[NOTIF] ⚠ Telegram timeout (10s) — mensaje no enviado")
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[NOTIF] ❌ Telegram sin conexión: {e}")
    except Exception as e:
        logger.warning(f"[NOTIF] ⚠ Telegram error: {e}")


# ── Arranque / parada ────────────────────────────────────────────────────────

def notify_start(cfg: dict):
    _send(cfg, "🤖 <b>Bot iniciado</b> — Polymarket BTC Hourly")


def notify_stop(cfg: dict):
    _send(cfg, "⛔ <b>Bot detenido</b>")


def notify_startup_summary(cfg: dict, hist_stats: dict):
    wins   = hist_stats.get("wins", 0)
    losses = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
    total  = hist_stats.get("total_ops", 0)
    pnl    = hist_stats.get("total_pnl", 0.0)
    wr     = int(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    sign   = "+" if pnl >= 0 else ""
    _send(cfg, (
        f"📊 <b>Historial previo cargado</b>\n"
        f"Ops    : <code>{total}</code>\n"
        f"W/L    : <code>{wins}W / {losses}L  WR={wr}%</code>\n"
        f"P&L    : <code>{sign}${pnl:,.2f} USDC</code>"
    ))


# ── Mercado ──────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float):
    """
    v5.0: muestra YES/NO precios + conditionId además del slug.
    """
    slug    = market.get("slug", "—")
    cond_id = market.get("condition_id", "—")
    tokens  = market.get("tokens", {})

    if isinstance(tokens, dict):
        yes_p = tokens.get("yes", {}).get("price")
        no_p  = tokens.get("no",  {}).get("price")
    elif isinstance(tokens, list):
        yes_p = next((t.get("price") for t in tokens if t.get("outcome") == "Yes"), None)
        no_p  = next((t.get("price") for t in tokens if t.get("outcome") == "No"),  None)
    else:
        yes_p = no_p = None

    yes_str = f"{yes_p:.4f}" if yes_p is not None else "—"
    no_str  = f"{no_p:.4f}"  if no_p  is not None else "—"

    _send(cfg, (
        f"🎯 <b>Nuevo mercado detectado</b>\n"
        f"Slug     : <code>{slug}</code>\n"
        f"Cierre   : <code>{mins_left:.1f} min</code>\n"
        f"YES      : <code>{yes_str}</code>   "
        f"NO: <code>{no_str}</code>\n"
        f"CondID   : <code>{cond_id[:16]}…</code>"
    ))


def notify_market_lost(cfg: dict):
    _send(cfg, "⚠️ <b>Mercado perdido</b> — esperando próximo mercado")


# ── Target ───────────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, old_target: float, new_target: float, mins_left: float = 0):
    delta = new_target - old_target
    sign  = "+" if delta >= 0 else ""
    mm    = int(mins_left)
    _send(cfg, (
        f"🔄 <b>Target cambiado</b>\n"
        f"Anterior : <code>${old_target:,.2f}</code>\n"
        f"Nuevo    : <code>${new_target:,.2f}</code>\n"
        f"Δ        : <code>{sign}${delta:,.2f}</code>\n"
        f"⏱ Quedan : <code>{mm} min</code>"
    ))


def notify_target_failed(cfg: dict, hour_utc):
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    _send(cfg, f"🚨 <b>Target no disponible</b> — hora {hour_utc:02d}:00 UTC")


# ── Señal ────────────────────────────────────────────────────────────────────

def notify_signal_eval(cfg: dict, price: float, target: float,
                       dist: float, umbral: float, window: str,
                       direction: str, mins_left: float):
    arrow  = "▲" if dist > 0 else "▼"
    action = (
        f"✅ <b>{direction}</b> — señal accionable"
        if direction in ("UP", "DOWN")
        else "⏳ WAIT — dist insuficiente"
    )
    mm, ss = int(mins_left), int((mins_left % 1) * 60)
    _send(cfg, (
        f"📊 <b>Evaluación [{window}]</b>\n"
        f"BTC    : <code>${price:,.2f}</code>\n"
        f"Target : <code>${target:,.2f}</code>\n"
        f"Dist   : <code>{arrow}${abs(dist):,.0f}</code>  Umbral: <code>${umbral}</code>\n"
        f"Resta  : <code>{mm:02d}:{ss:02d}</code>\n"
        f"{action}"
    ))


# ── Cambio de hora ────────────────────────────────────────────────────────────

def notify_new_hour(cfg: dict, hour_utc, slug: str, target: float):
    """
    v5.0: notificación de cambio de hora aunque no haya habido operaciones.
    """
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    target_str = f"${target:,.2f}" if target else "—"
    _send(cfg, (
        f"🕐 <b>Nueva hora: {hour_utc:02d}:00 UTC</b>\n"
        f"Mercado  : <code>{slug or '—'}</code>\n"
        f"Target   : <code>{target_str}</code>"
    ))


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
                f"   Compra: <code>{entry_odds:.4f}</code>  "
                f"Venta: <code>{exit_odds:.4f}</code>  "
                f"Tokens: <code>{tokens:.4f}</code>\n"
                f"   {res_ico} {result}  P&L: <code>{pnl_s}</code>"
            )

    if hist_stats:
        h_wins  = hist_stats.get("wins", 0)
        h_loss  = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
        h_total = hist_stats.get("total_ops", 0)
        h_pnl   = hist_stats.get("total_pnl", 0.0)
        h_wr    = int(h_wins / (h_wins + h_loss) * 100) if (h_wins + h_loss) > 0 else 0
        h_sign  = "+" if h_pnl >= 0 else ""
        lines.append("")
        lines.append(
            f"📈 <b>Acumulado total</b>\n"
            f"Ops: <code>{h_total}</code>  "
            f"W/L: <code>{h_wins}W/{h_loss}L  WR={h_wr}%</code>\n"
            f"P&L: <code>{h_sign}${h_pnl:,.2f} USDC</code>"
        )

    _send(cfg, "\n".join(lines))


# ── Apuesta ──────────────────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, signal, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    pnl_est = round(tokens - stake, 2)
    ret_est = round(tokens, 2)
    _send(cfg, (
        f"{'🟢' if bet['direction'] == 'UP' else '🔴'} "
        f"<b>Apuesta {bet['direction']} [{bet.get('window','—')}]</b>{sim_tag}\n"
        f"BTC entry  : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Odds       : <code>{odds_v:.4f}</code>\n"
        f"Stake      : <code>${stake:.2f} USDC</code>\n"
        f"Tokens     : <code>{tokens:.4f}</code>\n"
        f"Ret. est.  : <code>${ret_est:.2f} USDC</code>  "
        f"(+${pnl_est:.2f} / +{round((pnl_est/stake*100) if stake else 0, 1):.1f}%)"
    ))


# ── Orden fallida ─────────────────────────────────────────────────────────────

def notify_order_failed(cfg: dict, signal):
    """
    v6.1: Alerta cuando execute_order() devuelve None.
    Evita que el bot reintente indefinidamente en la misma ventana.
    """
    window    = getattr(signal, "window", "—")
    direction = getattr(signal, "direction", "—")
    _send(cfg, (
        f"⚠️ <b>Orden fallida [{window}]</b>\n"
        f"Dirección  : <code>{direction}</code>\n"
        f"execute_order() devolvió None — ventana marcada, no se reintentará."
    ))


# ── Resultados ────────────────────────────────────────────────────────────────

def notify_win(cfg: dict, bet: dict, price: float, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    pnl     = round(tokens - stake, 2)
    _send(cfg, (
        f"✅ <b>WIN — {bet['direction']}</b>{sim_tag}\n"
        f"BTC cierre : <code>${price:,.2f}</code>\n"
        f"Compra     : <code>{tokens:.4f} tokens × {odds_v:.4f}</code>\n"
        f"Venta      : <code>{tokens:.4f} tokens × 1.0000</code>\n"
        f"P&L        : <code>+${pnl:.2f} USDC</code>"
    ))


def notify_loss(cfg: dict, bet: dict, price: float, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    _send(cfg, (
        f"❌ <b>LOSS — {bet['direction']}</b>{sim_tag}\n"
        f"BTC cierre : <code>${price:,.2f}</code>\n"
        f"Compra     : <code>{tokens:.4f} tokens × {odds_v:.4f}</code>\n"
        f"Venta      : <code>{tokens:.4f} tokens × 0.0000</code>\n"
        f"P&L        : <code>-${stake:.2f} USDC</code>"
    ))


def notify_stop_loss(cfg: dict, bet: dict, price: float, pnl_usd: float,
                     pnl_pct: float = 0.0, exit_token_price: float = 0.0,
                     stop_pct: float = 0.0, simulated: bool = False):
    """
    v6.2: mensaje completo de Stop Loss con desglose de la operación.
    Muestra compra, venta, resultado neto y la condición exacta que disparó el SL.
    """
    sim         = simulated or bet.get("simulated", False)
    sim_tag     = "  <i>[SIMULADO]</i>" if sim else ""
    entry_odds  = bet.get("odds", 0.5)
    stake       = bet.get("stake", 0)
    tokens      = round(stake / max(entry_odds, 0.001), 4)
    total_venta = round(tokens * exit_token_price, 2)
    sign        = "+" if pnl_usd >= 0 else ""

    _send(cfg, (
        f"🛑 <b>STOP LOSS — {bet['direction']}</b>{sim_tag}\n"
        f"\n"
        f"📥 <b>Compra</b>\n"
        f"  Precio  : <code>{entry_odds:.4f}</code>\n"
        f"  Tokens  : <code>{tokens:.4f}</code>\n"
        f"  Total   : <code>${stake:.2f} USDC</code>\n"
        f"\n"
        f"📤 <b>Venta</b>\n"
        f"  Precio  : <code>{exit_token_price:.4f}</code>\n"
        f"  Tokens  : <code>{tokens:.4f}</code>\n"
        f"  Total   : <code>${total_venta:.2f} USDC</code>\n"
        f"\n"
        f"💰 <b>Resultado</b> : <code>{sign}${pnl_usd:.2f} USDC  ({sign}{pnl_pct:.1f}%)</code>\n"
        f"\n"
        f"⚠️ <b>Condición SL</b>\n"
        f"  Token:   <code>{entry_odds:.4f}</code> → <code>{exit_token_price:.4f}</code>\n"
        f"  Pérdida  <code>{abs(pnl_pct):.1f}%</code> ≥ umbral <code>{stop_pct:.0f}%</code>\n"
        f"  BTC      : <code>${price:,.2f}</code>"
    ))


# ── Error ─────────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, message: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{message[:500]}</code>")
