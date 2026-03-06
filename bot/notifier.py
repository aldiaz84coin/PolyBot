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
        requests.post(
            url,
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=5,
        )
    except Exception as e:
        logger.warning(f"Telegram error: {e}")


def notify_start(cfg: dict):
    _send(cfg, "🤖 <b>Bot iniciado</b>\nPolymarket BTC Bot arrancado correctamente.")


def notify_stop(cfg: dict):
    _send(cfg, "🛑 <b>Bot detenido</b>")


def notify_target_change(cfg: dict, target: float, hour_utc: int, is_retry: bool = False):
    """
    Notifica cuando se fija un nuevo Price to Beat al inicio de cada hora.
    Se envía siempre para poder verificar manualmente que el valor es correcto.
    """
    retry_tag = "  <i>(reintento)</i>" if is_retry else ""
    _send(cfg, (
        f"🎯 <b>Nuevo Price to Beat — {hour_utc:02d}:00 UTC</b>{retry_tag}\n"
        f"Target : <code>${target:,.2f}</code>\n"
        f"<i>Compara con el OPEN de la vela 1H de BTC/USDT en Binance.</i>"
    ))


def notify_target_failed(cfg: dict, hour_utc: int, attempt: int):
    """Avisa cuando no se puede obtener el Price to Beat tras varios intentos."""
    _send(cfg, (
        f"🚨 <b>Price to Beat NO disponible — {hour_utc:02d}:00 UTC</b>\n"
        f"Intento {attempt} fallido. El bot no operará esta hora sin target.\n"
        f"Verificar conectividad con Binance."
    ))


def notify_bet(cfg: dict, bet: dict, signal):
    arrow = "🟢" if bet["direction"] == "UP" else "🔴"
    _send(cfg, (
        f"{arrow} <b>Apuesta {bet['direction']}</b>\n"
        f"Entry  : <code>${bet['entry']:,.2f}</code>\n"
        f"Target : <code>${bet['target']:,.2f}</code>\n"
        f"Dist   : <code>${abs(signal.distance):.0f}</code>\n"
        f"Ventana: <code>{bet['window']}</code>\n"
        f"Stake  : <code>${bet['stake']} USDC</code>"
    ))


def notify_win(cfg: dict, bet: dict, close_price: float):
    _send(cfg, (
        f"✅ <b>WIN — Claim iniciado</b>\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>"
    ))


def notify_loss(cfg: dict, bet: dict, close_price: float):
    _send(cfg, (
        f"❌ <b>LOSS</b>\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>"
    ))


def notify_stop_loss(cfg: dict, bet: dict, pnl: float):
    _send(cfg, (
        f"🛑 <b>STOP LOSS activado</b>\n"
        f"P&L   : <code>{pnl:.1f}%</code>\n"
        f"Entry : <code>${bet['entry']:,.2f}</code>"
    ))


def notify_error(cfg: dict, msg: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{msg[:400]}</code>")
