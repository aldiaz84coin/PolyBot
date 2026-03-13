"""
notifier.py — Alertas Telegram para el bot de Polymarket BTC

v4.0 — notify_hour_summary con detalle de operaciones:
  - Muestra tabla por operación: precio compra, tokens, precio venta, resultado, P&L
  - Muestra resumen acumulado (historial CSV)
  - Mensaje más rico e informativo cada hora
"""
import logging

import requests

logger = logging.getLogger(__name__)

_SEND_URL = "https://api.telegram.org/bot{token}/sendMessage"


def _send(cfg: dict, text: str):
    token   = cfg.get("telegram", {}).get("bot_token", "")
    chat_id = cfg.get("telegram", {}).get("chat_id", "")
    if not token or not chat_id:
        return
    try:
        requests.post(
            _SEND_URL.format(token=token),
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"[NOTIF] ⚠ Telegram error: {e}")


# ── Arranque / parada ────────────────────────────────────────────────────────

def notify_start(cfg: dict):
    _send(cfg, "🤖 <b>Bot iniciado</b> — Polymarket BTC Hourly")


def notify_stop(cfg: dict):
    _send(cfg, "⛔ <b>Bot detenido</b>")


def notify_startup_summary(cfg: dict, hist_stats: dict):
    wins    = hist_stats.get("wins", 0)
    losses  = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
    total   = hist_stats.get("total_ops", 0)
    pnl     = hist_stats.get("total_pnl", 0.0)
    wr      = int(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    sign    = "+" if pnl >= 0 else ""
    _send(cfg, (
        f"📊 <b>Historial previo cargado</b>\n"
        f"Ops    : <code>{total}</code>\n"
        f"W/L    : <code>{wins}W / {losses}L  WR={wr}%</code>\n"
        f"P&L    : <code>{sign}${pnl:,.2f} USDC</code>"
    ))


# ── Mercado ──────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float):
    slug = market.get("slug", "—")
    _send(cfg, (
        f"🎯 <b>Mercado encontrado</b>\n"
        f"Slug   : <code>{slug}</code>\n"
        f"Cierre : <code>{mins_left:.1f} min</code>"
    ))


def notify_market_lost(cfg: dict):
    _send(cfg, "⚠️ <b>Mercado perdido</b> — esperando próximo mercado")


# ── Target ───────────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, target: float, hour_utc):
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    _send(cfg, (
        f"🎯 <b>Price to Beat actualizado</b>\n"
        f"Hora   : <code>{hour_utc:02d}:00 UTC</code>\n"
        f"Target : <code>${target:,.2f}</code>"
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
    """
    FIX v3.2: se llama para CUALQUIER señal en ventana (no solo accionables).
    """
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


# ── Resumen horario ───────────────────────────────────────────────────────────

def notify_hour_summary(cfg: dict, hour_utc, hour_wins: int, hour_losses: int,
                        ops_hoy: int, target: float,
                        hour_ops: list | None = None,
                        hist_stats: dict | None = None):
    """
    v4.0: Resumen detallado al final de cada hora.
    - hour_ops: lista de dicts con info por operación cerrada en esa hora.
    - hist_stats: stats acumuladas del CSV para mostrar el total histórico.

    Cada entrada de hour_ops debe tener:
      direction, window, entry_btc, entry_odds (precio token compra),
      stake, tokens, exit_odds (precio token venta), exit_btc,
      result (WIN/LOSS/STOP), pnl_usd, simulated
    """
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"

    total_hora = hour_wins + hour_losses
    wr_hora    = int(hour_wins / total_hora * 100) if total_hora > 0 else 0
    pnl_hora   = sum(op.get("pnl_usd", 0) for op in (hour_ops or []))
    sign_h     = "+" if pnl_hora >= 0 else ""

    # ── Cabecera ──────────────────────────────────────────────────────────
    lines = [
        f"📋 <b>Resumen hora {hour_utc:02d}:00 UTC</b>",
        f"Ops    : <code>{ops_hoy}</code>   "
        f"W/L: <code>{hour_wins}W / {hour_losses}L  WR={wr_hora}%</code>",
        f"P&L hora : <code>{sign_h}${pnl_hora:,.2f} USDC</code>",
        f"Target   : <code>${target:,.2f}</code>",
    ]

    # ── Tabla de operaciones ──────────────────────────────────────────────
    if hour_ops:
        lines.append("")
        lines.append("━━━ Operaciones ━━━")
        for i, op in enumerate(hour_ops, 1):
            direction  = op.get("direction", "—")
            window     = op.get("window", "—")
            entry_btc  = op.get("entry_btc", 0)
            entry_odds = op.get("entry_odds", 0)
            tokens     = op.get("tokens", 0)
            exit_odds  = op.get("exit_odds", 0)
            exit_btc   = op.get("exit_btc", 0)
            result     = op.get("result", "—")
            pnl        = op.get("pnl_usd", 0)
            simulated  = op.get("simulated", False)

            arrow   = "🟢" if direction == "UP" else "🔴"
            res_ico = {"WIN": "✅", "LOSS": "❌", "STOP": "🛑"}.get(result, "❓")
            pnl_s   = f"+${pnl:,.2f}" if pnl >= 0 else f"-${abs(pnl):,.2f}"
            sim_tag = " <i>[SIM]</i>" if simulated else ""

            lines.append(
                f"{i}. {arrow} <b>{direction}</b> [{window}]{sim_tag}\n"
                f"   Compra : <code>${entry_btc:,.2f}</code> → "
                f"<code>{tokens:.4f} tokens × {entry_odds:.4f}</code>\n"
                f"   Venta  : <code>${exit_btc:,.2f}</code> → "
                f"<code>{tokens:.4f} tokens × {exit_odds:.4f}</code>\n"
                f"   {res_ico} {result}  <b>{pnl_s} USDC</b>"
            )

    # ── Acumulado histórico ───────────────────────────────────────────────
    if hist_stats:
        hw = hist_stats.get("wins", 0)
        hl = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
        hp = hist_stats.get("total_pnl", 0.0)
        hr = int(hw / (hw + hl) * 100) if (hw + hl) > 0 else 0
        hs = "+" if hp >= 0 else ""
        lines.append("")
        lines.append(
            f"📈 <b>Acumulado</b>: {hw}W/{hl}L WR={hr}%  "
            f"P&L neto: <code>{hs}${hp:,.2f} USDC</code>"
        )

    _send(cfg, "\n".join(lines))


# ── Apuestas ──────────────────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, signal, simulated: bool = False):
    """
    FIX v3.2:
      - `signal` es ahora un argumento requerido (era omitido → TypeError)
      - añade etiqueta [SIMULADO] cuando corresponde
    """
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    arrow   = "🟢" if bet["direction"] == "UP" else "🔴"
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    ret_est = round(stake / max(odds_v, 0.001), 2)
    pnl_est = round(ret_est - stake, 2)
    _send(cfg, (
        f"{arrow} <b>Apuesta {bet['direction']}</b>{sim_tag}\n"
        f"Ventana  : <code>{bet.get('window', '—')}</code>\n"
        f"BTC      : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Target   : <code>${bet.get('target', 0):,.2f}</code>\n"
        f"Dist     : <code>{bet.get('distance', 0):+,.0f}</code>  "
        f"Umbral: <code>${bet.get('umbral', 0)}</code>\n"
        f"Stake    : <code>${stake:.2f} USDC</code>\n"
        f"Odds     : <code>{odds_v:.4f}</code>  "
        f"Tokens: <code>{tokens:.4f}</code>\n"
        f"Ret. est.: <code>+${pnl_est:.2f} USDC</code>"
    ))


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
                     simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    sign    = "+" if pnl_usd >= 0 else ""
    _send(cfg, (
        f"🛑 <b>STOP LOSS — {bet['direction']}</b>{sim_tag}\n"
        f"BTC actual : <code>${price:,.2f}</code>\n"
        f"Tokens     : <code>{tokens:.4f} × {odds_v:.4f}</code>\n"
        f"P&L        : <code>{sign}${pnl_usd:.2f} USDC</code>"
    ))


# ── Error ────────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, message: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{message[:500]}</code>")
