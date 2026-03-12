"""
notifier.py — Notificaciones Telegram con verbosidad ampliada

v1.2 — FIX v3.2 de monitor.py:
  - notify_bet:       acepta `signal` como 3er arg (FIX firma); añade [SIMULADO] tag
  - notify_win:       añade [SIMULADO] tag leyendo bet["simulated"]
  - notify_loss:      añade [SIMULADO] tag leyendo bet["simulated"]
  - notify_stop_loss: firma extendida → (cfg, bet, close_price, pnl_usd);
                      añade [SIMULADO] tag
  - Todos los cambios son retrocompatibles (kwargs con defaults).
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
    t5      = cfg.get("strategy", {}).get("t5_umbral_usd",  "?")
    sim     = cfg.get("strategy", {}).get("simulate_mode", False)
    sim_tag = "  <b>⚠ MODO SIMULADO</b>" if sim else ""
    _send(cfg, (
        f"🤖 <b>Bot iniciado</b>{sim_tag}\n"
        f"<code>Stake   : ${stake} USDC</code>\n"
        f"<code>Max ops : {max_ops}/día</code>\n"
        f"<code>Stop    : {stop:.1f}%</code>\n"
        f"<code>Umbrales: T20=${t20} T15=${t15} T10=${t10} T5=${t5}</code>"
    ))


def notify_stop(cfg: dict):
    _send(cfg, "🛑 <b>Bot detenido</b>")


# ── Resumen de arranque ───────────────────────────────────────────────────────

def notify_startup_summary(cfg: dict, hist_stats: dict):
    """Envía resumen del historial acumulado al arrancar el bot."""
    total    = hist_stats.get("total_ops", 0)
    wins     = hist_stats.get("wins", 0)
    losses   = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
    wr       = round(wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
    invested = hist_stats.get("total_invested", 0.0)
    pnl      = hist_stats.get("total_pnl", 0.0)
    sign     = "+" if pnl >= 0 else ""
    _send(cfg, (
        f"📊 <b>Historial acumulado</b>\n"
        f"Operaciones : <code>{total}</code>\n"
        f"W / L+STOP  : <code>{wins}W / {losses}L</code>  "
        f"WR: <code>{wr}%</code>\n"
        f"Invertido   : <code>${invested:,.2f} USDC</code>\n"
        f"P&L neto    : <code>{sign}${pnl:,.2f} USDC</code>"
    ))


# ── Price to Beat ─────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, target: float, hour_utc, is_retry: bool = False):
    """Notifica el nuevo Price to Beat al inicio de cada hora."""
    retry_tag = " (reintento)" if is_retry else ""
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    _send(cfg, (
        f"🎯 <b>Price to Beat{retry_tag}</b> — hora {hour_utc:02d}:00 UTC\n"
        f"<code>${target:,.2f}</code>"
    ))


def notify_target_failed(cfg: dict, hour_utc):
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    _send(cfg, (
        f"⚠ <b>Price to Beat no disponible</b> — hora {hour_utc:02d}:00 UTC\n"
        f"<i>Se reintentará en el próximo ciclo.</i>"
    ))


# ── Mercado ───────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float):
    slug    = market.get("slug", "—")
    cond_id = market.get("condition_id", "—")
    mm      = int(mins_left)
    ss      = int((mins_left % 1) * 60)
    _send(cfg, (
        f"🟡 <b>Mercado activo</b>\n"
        f"Slug  : <code>{slug}</code>\n"
        f"Cond  : <code>{cond_id[:16]}…</code>\n"
        f"Resta : <code>{mm:02d}:{ss:02d}</code>"
    ))


def notify_market_lost(cfg: dict, slugs_tried: list | None = None):
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
    Notificación al entrar en ventana o al cambiar de dirección/estado.
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

def notify_hour_summary(cfg: dict, hour_utc, wins: int, losses: int,
                        ops: int, target: float):
    """Resumen al final de cada hora."""
    try:
        hour_utc = int(hour_utc)
    except (TypeError, ValueError):
        hour_utc = "?"
    total = wins + losses
    wr    = int(wins / total * 100) if total > 0 else 0
    _send(cfg, (
        f"📋 <b>Resumen hora {hour_utc:02d}:00 UTC</b>\n"
        f"Ops    : <code>{ops}</code>\n"
        f"W/L    : <code>{wins}W / {losses}L</code>\n"
        f"WR     : <code>{wr}%</code>\n"
        f"Target : <code>${target:,.2f}</code>"
    ))


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
    ret_est = round(stake / max(odds_v, 0.001), 2)
    pnl_est = round(ret_est - stake, 2)
    _send(cfg, (
        f"{arrow} <b>Apuesta {bet['direction']}</b>{sim_tag}\n"
        f"Entry  : <code>${bet['entry']:,.2f}</code>\n"
        f"Target : <code>${bet['target']:,.2f}</code>\n"
        f"Dist   : <code>${abs(signal.distance):.0f}</code>  "
        f"Umbral: <code>${signal.umbral}</code>\n"
        f"Ventana: <code>{bet['window']}</code>\n"
        f"Stake  : <code>${stake} USDC</code>\n"
        f"Odds   : <code>{odds_v:.4f}</code>  "
        f"Ret.est: <code>+${pnl_est:.2f}</code>"
    ))


def notify_win(cfg: dict, bet: dict, close_price: float, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    stake   = bet.get("stake", 0)
    odds_   = bet.get("odds", 0.5)
    shares  = stake / max(odds_, 0.001)
    pnl     = round(shares - stake, 2)
    pct     = round((pnl / stake) * 100, 1) if stake > 0 else 0
    sign    = "+" if pnl >= 0 else ""
    _send(cfg, (
        f"✅ <b>WIN — Claim iniciado</b>{sim_tag}\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Entry     : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>\n"
        f"Ventana   : <code>{bet.get('window', '—')}</code>\n"
        f"P&L       : <code>{sign}${pnl:.2f} USDC ({sign}{pct:.1f}%)</code>"
    ))


def notify_loss(cfg: dict, bet: dict, close_price: float, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    stake   = bet.get("stake", 0)
    _send(cfg, (
        f"❌ <b>LOSS</b>{sim_tag}\n"
        f"Dirección : <code>{bet['direction']}</code>\n"
        f"Entry     : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>\n"
        f"Ventana   : <code>{bet.get('window', '—')}</code>\n"
        f"P&L       : <code>-${stake:.2f} USDC (-100%)</code>"
    ))


def notify_stop_loss(cfg: dict, bet: dict, close_price: float,
                     pnl_usd: float = 0.0, simulated: bool = False):
    """
    FIX v3.2: firma extendida → acepta close_price y pnl_usd.
    """
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    stake   = bet.get("stake", 0)
    pct     = round((pnl_usd / stake) * 100, 1) if stake > 0 else 0
    sign    = "+" if pnl_usd >= 0 else ""
    _send(cfg, (
        f"🛑 <b>STOP LOSS activado</b>{sim_tag}\n"
        f"Dirección : <code>{bet.get('direction', '—')}</code>\n"
        f"Entry     : <code>${bet.get('entry', 0):,.2f}</code>\n"
        f"Cierre    : <code>${close_price:,.2f}</code>\n"
        f"P&L       : <code>{sign}${pnl_usd:.2f} USDC ({sign}{pct:.1f}%)</code>"
    ))


# ── Errores ───────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, msg: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{msg[:400]}</code>")
