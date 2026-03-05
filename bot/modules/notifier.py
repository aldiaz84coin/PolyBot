"""
notifier.py — Notificaciones Telegram
"""
import logging
import requests

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


def _send(cfg: dict, text: str):
    token   = cfg.get("telegram", {}).get("bot_token")
    chat_id = cfg.get("telegram", {}).get("chat_id")
    if not token or not chat_id:
        return
    try:
        url = TELEGRAM_API.format(token=token)
        requests.post(url, json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"}, timeout=5)
    except Exception as e:
        logger.warning(f"Telegram error: {e}")


def notify_start(cfg):
    _send(cfg, "🤖 <b>Bot iniciado</b>\nPolymarket BTC Bot arrancado correctamente.")

def notify_stop(cfg):
    _send(cfg, "🛑 <b>Bot detenido</b>")

def notify_bet(cfg, bet: dict, signal):
    arrow = "🟢" if bet["direction"] == "UP" else "🔴"
    _send(cfg, (
        f"{arrow} <b>Apuesta {bet['direction']}</b>\n"
        f"Entry : <code>${bet['entry']:,.2f}</code>\n"
        f"Target: <code>${bet['target']:,.2f}</code>\n"
        f"Dist  : <code>${abs(signal.distance):.0f}</code>\n"
        f"Ventana: <code>{bet['window']}</code>\n"
        f"Stake : <code>${bet['stake']} USDC</code>"
    ))

def notify_win(cfg, bet: dict, close_price: float):
    _send(cfg, (
        f"✅ <b>WIN — Claim iniciado</b>\n"
        f"Dirección: <code>{bet['direction']}</code>\n"
        f"Cierre: <code>${close_price:,.2f}</code>"
    ))

def notify_loss(cfg, bet: dict, close_price: float):
    _send(cfg, (
        f"❌ <b>LOSS</b>\n"
        f"Dirección: <code>{bet['direction']}</code>\n"
        f"Cierre: <code>${close_price:,.2f}</code>"
    ))

def notify_stop_loss(cfg, bet: dict, pnl: float):
    _send(cfg, (
        f"🛑 <b>STOP LOSS activado</b>\n"
        f"P&L: <code>{pnl:.1f}%</code>\n"
        f"Entry: <code>${bet['entry']:,.2f}</code>"
    ))

def notify_error(cfg, msg: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{msg[:400]}</code>")
