"""
notifier.py — Notificaciones Telegram con verbosidad ampliada
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


# ── Ciclo de vida del bot ─────────────────────────────────────────────────────

def notify_start(cfg: dict):
    stake   = cfg.get("capital", {}).get("stake_usdc", "?")
    max_ops = cfg.get("capital", {}).get("max_operaciones_dia", "?")
    stop    = cfg.get("strategy", {}).get("stop_loss_pct", 0)
    t20     = cfg.get("strategy", {}).get("t20_umbral_usd", "?")
    t15     = cfg.get("strategy", {}).get("t15_umbral_usd", "?")
    t10     = cfg.get("strategy", {}).get("t10_umbral_usd", "?")
    t5      = cfg.get("strategy", {}).get("t5_umbral_usd", "?")
    _send(cfg, (
        f"🤖 <b>Bot iniciado</b>\n"
        f"<code>Stake   : ${stake} USDC</code>\n"
        f"<code>Max ops : {max_ops}/día</code>\n"
        f"<code>Stop    : {stop*100:.0f}%</code>\n"
        f"<code>Umbrales: T20=${t20} T15=${t15} T10=${t10} T5=${t5}</code>"
    ))


def notify_stop(cfg: dict):
    _send(cfg, "🛑 <b>Bot detenido</b>")


# ── Price to Beat ─────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, target: float, hour_utc: int, is_retry: bool = False):
    """
    Notifica el nuevo Price to Beat al inicio de cada hora.
    Incluye el slug del mercado si está disponible.
    """
    retry_tag = "  <i>(reintento exitoso)</i>" if is_retry else ""
    _send(cfg, (
        f"🎯 <b>Nuevo Price to Beat — {hour_utc:02d}:00 UTC</b>{retry_tag}\n"
        f"Target : <code>${target:,.2f}</code>\n"
        f"Vela   : <code>{hour_utc:02d}:00 → {(hour_utc+1)%24:02d}:00 UTC</code>\n"
        f"<i>Verificar con OPEN de vela 1H BTC/USDT en Binance.</i>"
    ))


def notify_target_failed(cfg: dict, hour_utc: int, attempt: int):
    _send(cfg, (
        f"🚨 <b>Price to Beat NO disponible — {hour_utc:02d}:00 UTC</b>\n"
        f"Intento {attempt} fallido. El bot no operará esta hora.\n"
        f"Verificar conectividad con Binance."
    ))


# ── Mercado Polymarket ────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float):
    """Notifica cuando se detecta un nuevo mercado activo."""
    slug     = market.get("slug", "—")
    question = market.get("question", "—")
    yes_p    = market.get("yes_price")
    no_p     = market.get("no_price")
    mm, ss   = int(mins_left), int((mins_left % 1) * 60)
    token_line = ""
    if yes_p and no_p:
        token_line = (
            f"\nYES (▲UP)  : <code>${yes_p:.4f}  ({yes_p*100:.1f}%)</code>"
            f"\nNO  (▼DOWN): <code>${no_p:.4f}  ({no_p*100:.1f}%)</code>"
        )
    _send(cfg, (
        f"◈ <b>Mercado detectado</b>\n"
        f"<i>{question}</i>\n"
        f"Slug   : <code>{slug}</code>\n"
        f"Cierre : <code>{mm:02d}:{ss:02d}</code> restantes"
        f"{token_line}"
    ))


def notify_market_lost(cfg: dict, slugs_tried: list):
    """Notifica cuando no se encuentra mercado activo."""
    slugs_txt = "\n".join(f"  · <code>{s}</code>" for s in (slugs_tried or []))
    _send(cfg, (
        f"⚠ <b>Mercado no encontrado</b>\n"
        f"Slugs probados:\n{slugs_txt or '  —'}\n"
        f"<i>Puede que el mercado aún no esté disponible.</i>"
    ))


# ── Evaluación de señal ───────────────────────────────────────────────────────

def notify_signal_eval(cfg: dict, price: float, target: float, dist: float,
                       umbral: float, window: str, direction: str, mins_left: float):
    """
    Notificación periódica de evaluación de señal (solo en ventana activa).
    Enviar con moderación: idealmente solo al entrar en ventana o al cambiar de dirección.
    """
    arrow = "▲" if dist > 0 else "▼"
    action = (
        f"✅ <b>{direction}</b> — señal accionable"
        if direction in ("UP", "DOWN")
        else f"⏳ WAIT — dist insuficiente"
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


# ── Apuestas ──────────────────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, signal):
    arrow = "🟢" if bet["direction"] == "UP" else "🔴"
    _send(cfg, (
        f"{arrow} <b>Apuesta {bet['direction']}</b>\n"
        f"Entry  : <code>${bet['entry']:,.2f}</code>\n"
        f"Target : <code>${bet['target']:,.2f}</code>\n"
        f"Dist   : <code>${abs(signal.distance):.0f}</code>  "
        f"Umbral: <code>${signal.umbral}</code>\n"
        f"Ventana: <code>{bet['window']}</code>\n"
        f"Stake  : <code>${bet['stake']} USDC</code>"
    ))


def notify_win(cfg: dict, bet: dict, close_price: float):
    pnl_est = (close_price - bet.get("entry", close_price)) / bet.get("entry", close_price) * 100
    _send(cfg, (
        f"✅ <b>WIN — Claim iniciado</b>\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Entry     : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>\n"
        f"Ventana   : <code>{bet.get('window', '—')}</code>"
    ))


def notify_loss(cfg: dict, bet: dict, close_price: float):
    _send(cfg, (
        f"❌ <b>LOSS</b>\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Entry     : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>\n"
        f"Ventana   : <code>{bet.get('window', '—')}</code>"
    ))


def notify_stop_loss(cfg: dict, bet: dict, pnl: float):
    _send(cfg, (
        f"🛑 <b>STOP LOSS activado</b>\n"
        f"P&L   : <code>{pnl:.1f}%</code>\n"
        f"Entry : <code>${bet.get('entry', 0):,.2f}</code>"
    ))


# ── Resumen horario ───────────────────────────────────────────────────────────

def notify_hour_summary(cfg: dict, hour_utc: int, wins: int, losses: int, ops: int, target: float):
    """Resumen al final de cada hora."""
    total  = wins + losses
    wr     = int(wins / total * 100) if total > 0 else 0
    result = "✅ Positiva" if wins > losses else "❌ Negativa" if losses > wins else "➖ Neutral"
    _send(cfg, (
        f"📈 <b>Resumen {hour_utc:02d}:00 UTC</b>\n"
        f"Resultado : {result}\n"
        f"Ops       : <code>{ops}</code>  "
        f"W: <code>{wins}</code>  L: <code>{losses}</code>  "
        f"WR: <code>{wr}%</code>\n"
        f"Target fue: <code>${target:,.2f}</code>"
    ))


# ── Errores ───────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, msg: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{msg[:400]}</code>")
