"""
notifier.py — Notificaciones Telegram + Dashboard del bot PolyBot

v5.6 — SELL FALLBACK + CLAIM SCHEDULED
  - notify_claim_scheduled() : ⏳ Al lanzar el hilo de claim, informa que el
    primer intento será en N minutos (evita la confusión de ver silencio tras WIN).
  - notify_sell_fallback_ok() : 💸 Venta CLOB exitosa como fallback del claim.
  - notify_sell_fallback_failed() : 🚨 Venta CLOB también fallida + aviso manual.
  Llamadas exclusivamente desde claimer.py → _sell_fallback_clob().

v5.5 — NOTIFICACIONES DE CLAIM
  - notify_claim_ok()       : 💰 Claim confirmado on-chain (TX hash + P&L)
  - notify_claim_retrying() : 🔄 Reintentando claim (motivo + espera)
  - notify_claim_failed()   : 🚨 Claim fallido definitivo + aviso manual

v5.4 — notify_mode_change()
v5.3 — FIX: notify_signal_eval restaurada a firma de 8 argumentos
v5.2 — _post_event(): replica cada mensaje al dashboard (/api/events)
v5.1 — notify_new_hour muestra config completa de estrategia
v5.0 — Resumen al final de cada hora con desglose de operaciones.
v4.0 — notify_startup_summary, notify_order_failed.

Destino: bot/modules/notifier.py
"""
import logging
import os
import threading
import time

import requests

logger = logging.getLogger(__name__)

# ── Config del dashboard ──────────────────────────────────────────────────────

_FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")
_BOT_SECRET   = os.getenv("BOT_SECRET", "")
_EVENTS_PATH  = "/api/events"


# ── Helper: envío al dashboard (no-bloqueante) ────────────────────────────────

def _post_event(text: str) -> None:
    if not _FRONTEND_URL:
        return

    def _do_post():
        url     = _FRONTEND_URL + _EVENTS_PATH
        headers = {"Content-Type": "application/json"}
        if _BOT_SECRET:
            headers["x-bot-secret"] = _BOT_SECRET
        payload = {"text": text, "ts": int(time.time() * 1000)}
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=4)
            if not r.ok:
                logger.debug(f"[NOTIF/EVENT] Dashboard respondió {r.status_code}")
        except Exception as e:
            logger.debug(f"[NOTIF/EVENT] No se pudo enviar evento al dashboard: {e}")

    threading.Thread(target=_do_post, daemon=True).start()


# ── Helper: envío a Telegram ──────────────────────────────────────────────────

_SEND_URL = "https://api.telegram.org/bot{token}/sendMessage"


def _send(cfg: dict, text: str):
    """Envía a Telegram Y replica al dashboard (/api/events)."""
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
            logger.error(f"[NOTIF] ❌ Telegram HTTP {resp.status_code}: {resp.text[:300]}")
        else:
            logger.debug("[NOTIF] ✅ Telegram enviado correctamente")
    except requests.exceptions.Timeout:
        logger.warning("[NOTIF] ⚠ Telegram timeout (10s) — mensaje no enviado")
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[NOTIF] ❌ Telegram sin conexión: {e}")
    except Exception as e:
        logger.warning(f"[NOTIF] ⚠ Telegram error: {e}")

    _post_event(text)


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


# ── Modo ─────────────────────────────────────────────────────────────────────

def notify_mode_change(cfg: dict, old_mode: str, new_mode: str):
    icon_new = "🔵" if new_mode == "SIMULADO" else "🔴"
    icon_old = "🔴" if old_mode == "REAL"     else "🔵"
    _send(cfg, (
        f"{icon_new} <b>Modo de trading cambiado</b>\n"
        f"Anterior : {icon_old} <code>{old_mode}</code>\n"
        f"Nuevo    : {icon_new} <code>{new_mode}</code>\n"
        f"Efecto   : inmediato en el próximo ciclo"
    ))


# ── Mercado ──────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, market: dict, mins_left: float):
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
    """v5.3 FIX: firma de 8 argumentos."""
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

def notify_new_hour(cfg: dict, hour_utc, slug: str, target: float,
                    stop_pct: float = None, stake: float = None,
                    umbrales: dict = None):
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
    if stake is not None:
        lines.append(f"Stake    : <code>${stake:.2f} USDC</code>")
    if stop_pct is not None:
        lines.append(f"Stop Loss: <code>{stop_pct}%</code>")
    if umbrales:
        u = umbrales
        lines.append(
            f"Umbrales : T20=<code>{u.get('t20','—')}</code> "
            f"T15=<code>{u.get('t15','—')}</code> "
            f"T10=<code>{u.get('t10','—')}</code> "
            f"T5=<code>{u.get('t5','—')}</code>"
        )
    _send(cfg, "\n".join(lines))


# ── Resumen horario ───────────────────────────────────────────────────────────

def notify_hour_summary(cfg: dict, hour_utc, hour_wins: int, hour_losses: int,
                        ops_hoy: int, target: float,
                        hour_ops: list | None = None,
                        hist_stats: dict | None = None):
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
                f"   Odds: {entry_odds:.4f}→{exit_odds:.4f}  "
                f"Tokens: {tokens:.4f}  {res_ico} P&L: <code>{pnl_s}</code>"
            )

    if hist_stats:
        wins_h  = hist_stats.get("wins", 0)
        loss_h  = hist_stats.get("losses", 0) + hist_stats.get("stops", 0)
        wr_h    = int(wins_h / (wins_h + loss_h) * 100) if (wins_h + loss_h) > 0 else 0
        pnl_t   = hist_stats.get("total_pnl", 0.0)
        sign_t  = "+" if pnl_t >= 0 else ""
        lines.append(
            f"\n📊 <b>Acumulado total</b>: "
            f"{wins_h}W/{loss_h}L  WR={wr_h}%  P&L: <code>{sign_t}${pnl_t:,.2f}</code>"
        )

    _send(cfg, "\n".join(lines))


# ── Apuesta ──────────────────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, simulated: bool = False):
    sim_tag = "  <i>[SIMULADO]</i>" if simulated else ""
    direction  = bet.get("direction", "—")
    entry      = bet.get("entry", 0)
    target     = bet.get("target", 0)
    window     = bet.get("window", "—")
    stake      = bet.get("stake", 0)
    odds       = bet.get("odds", 0.5)
    tokens     = round(stake / max(odds, 0.001), 4)
    ret_est    = round(tokens, 2)
    pnl_est    = round(ret_est - stake, 2)
    pct_est    = round((pnl_est / stake) * 100, 1) if stake > 0 else 0
    arrow      = "🟢" if direction == "UP" else "🔴"
    _send(cfg, (
        f"{arrow} <b>APUESTA {direction}</b>{sim_tag}\n"
        f"BTC entrada : <code>${entry:,.2f}</code>\n"
        f"Target      : <code>${target:,.2f}</code>\n"
        f"Ventana     : <code>{window}</code>\n"
        f"Stake       : <code>${stake:.2f} USDC</code>\n"
        f"Odds        : <code>{odds:.4f}  ({odds*100:.1f}%)</code>\n"
        f"Tokens      : <code>{tokens:.4f}</code>\n"
        f"Ret. est.   : <code>${ret_est:.2f} (+${pnl_est:.2f} / +{pct_est:.1f}%)</code>"
    ))


def notify_order_failed(cfg: dict, signal):
    window    = getattr(signal, "window", "—")
    direction = getattr(signal, "direction", "—")
    _send(cfg, (
        f"⚠️ <b>Orden fallida [{window}]</b>\n"
        f"Dirección  : <code>{direction}</code>\n"
        f"execute_order() devolvió None — ventana marcada, no se reintentará."
    ))


# ── Resultados ────────────────────────────────────────────────────────────────

def notify_win(cfg: dict, bet: dict, price: float,
               pnl_usd: float = None, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    odds_v  = bet.get("odds", 0.5)
    stake   = bet.get("stake", 0)
    tokens  = round(stake / max(odds_v, 0.001), 4)
    pnl     = pnl_usd if pnl_usd is not None else round(tokens - stake, 2)
    _send(cfg, (
        f"✅ <b>WIN — {bet['direction']}</b>{sim_tag}\n"
        f"BTC cierre : <code>${price:,.2f}</code>\n"
        f"Compra     : <code>{tokens:.4f} tokens × {odds_v:.4f}</code>\n"
        f"Venta      : <code>{tokens:.4f} tokens × 1.0000</code>\n"
        f"P&L        : <code>+${pnl:.2f} USDC</code>"
    ))


def notify_loss(cfg: dict, bet: dict, price: float,
                pnl_usd: float = None, simulated: bool = False):
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
                     pnl_pct: float = None, exit_token_price: float = None,
                     stop_pct: float = None, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    direction = bet.get("direction", "—")
    entry_btc = bet.get("entry", 0)
    odds_in   = bet.get("odds", 0)
    pnl_str   = f"${pnl_usd:+,.2f}" if pnl_usd is not None else "—"
    pct_str   = f" ({pnl_pct:+.1f}%)" if pnl_pct is not None else ""

    lines = [
        f"🛑 <b>STOP LOSS — {direction}</b>{sim_tag}",
        f"BTC entrada: <code>${entry_btc:,.2f}</code>",
        f"BTC actual : <code>${price:,.2f}</code>",
        f"Odds entrada: <code>{odds_in:.4f}</code>",
    ]
    if exit_token_price is not None:
        lines.append(f"Odds salida : <code>{exit_token_price:.4f}</code>")
    if stop_pct is not None:
        lines.append(f"SL umbral  : <code>{stop_pct}%</code>")
    lines.append(f"P&L        : <code>{pnl_str} USDC{pct_str}</code>")
    _send(cfg, "\n".join(lines))


# ── Error ─────────────────────────────────────────────────────────────────────

def notify_error(cfg: dict, message: str):
    _send(cfg, f"🚨 <b>Error crítico</b>\n<code>{message[:500]}</code>")


# ── Claim on-chain ────────────────────────────────────────────────────────────

def notify_claim_scheduled(cfg: dict, bet: dict, first_wait_secs: int, max_attempts: int):
    """
    v5.6: Se envía al lanzar el hilo de claim.
    Informa que el primer intento será en N min (el mercado necesita tiempo para
    resolverse on-chain — intentarlo de inmediato siempre fallaba).
    """
    direction = bet.get("direction", "—")
    mins      = first_wait_secs // 60
    secs_rem  = first_wait_secs % 60
    if mins > 0 and secs_rem > 0:
        wait_str = f"{mins}m {secs_rem}s"
    elif mins > 0:
        wait_str = f"{mins}m"
    else:
        wait_str = f"{first_wait_secs}s"
    _send(cfg, (
        f"⏳ <b>Claim programado — {direction}</b>\n"
        f"Primer intento en : <code>{wait_str}</code>\n"
        f"Máx intentos      : <code>{max_attempts}</code>\n"
        f"<i>El mercado necesita tiempo para resolverse on-chain.</i>"
    ))


def notify_claim_ok(cfg: dict, bet: dict, tx_hash: str, attempt: int, usdc_est: float):
    """v5.5: Claim confirmado on-chain."""
    direction = bet.get("direction", "—")
    stake     = bet.get("stake", 0.0)
    pnl_est   = round(usdc_est - stake, 2)
    short_tx  = f"{tx_hash[:10]}...{tx_hash[-6:]}" if len(tx_hash) > 16 else tx_hash
    _send(cfg, (
        f"💰 <b>CLAIM CONFIRMADO — {direction}</b>\n"
        f"TX         : <code>{short_tx}</code>\n"
        f"Recuperado : <code>~{usdc_est:.4f} USDC</code>\n"
        f"P&amp;L neto   : <code>+${pnl_est:.2f}</code>\n"
        f"Intento    : <code>{attempt}</code>\n"
        f"🔗 <a href=\"https://polygonscan.com/tx/{tx_hash}\">Ver en Polygonscan</a>"
    ))


def notify_claim_retrying(cfg: dict, bet: dict, attempt: int, max_attempts: int,
                          reason: str, wait_secs: int):
    """v5.5: Se envía ANTES de dormir (2º intento en adelante)."""
    direction = bet.get("direction", "—")
    mins      = wait_secs // 60
    secs_rem  = wait_secs % 60
    if mins > 0 and secs_rem > 0:
        wait_str = f"{mins}m {secs_rem}s"
    elif mins > 0:
        wait_str = f"{mins}m"
    else:
        wait_str = f"{wait_secs}s"
    short_err = (reason[:150] + "…") if reason and len(reason) > 150 else (reason or "—")
    _send(cfg, (
        f"🔄 <b>Reintentando claim [{attempt}/{max_attempts}]</b>\n"
        f"Dirección  : <code>{direction}</code>\n"
        f"Motivo     : <code>{short_err}</code>\n"
        f"Próximo    : en <code>{wait_str}</code>"
    ))


def notify_claim_failed(cfg: dict, bet: dict, reason: str, attempts: int):
    """v5.5: Fallo definitivo + aviso manual."""
    direction = bet.get("direction", "—")
    short_err = (reason[:200] + "…") if reason and len(reason) > 200 else (reason or "—")
    _send(cfg, (
        f"🚨 <b>Claim fallido — {direction}</b>\n"
        f"Intentos   : <code>{attempts}</code>\n"
        f"Último err : <code>{short_err}</code>\n"
        f"⚠️ Intentando SELL FALLBACK en CLOB...\n"
        f"Si también falla: reclamar manualmente en "
        f"<a href=\"https://polymarket.com\">polymarket.com</a>"
    ))


# ── SELL Fallback (cuando claim on-chain falla definitivamente) ───────────────

def notify_sell_fallback_ok(cfg: dict, bet: dict, resp: dict,
                            sell_price: float, usdc_received: float):
    """
    v5.6: Venta en CLOB exitosa como alternativa al claim on-chain.
    Se activa cuando el claim falla tras agotar todos los reintentos.
    """
    direction  = bet.get("direction", "—")
    stake      = bet.get("stake", 0.0)
    pnl        = round(usdc_received - stake, 2)
    pnl_sign   = "+" if pnl >= 0 else ""
    order_id   = resp.get("id", "—")
    short_id   = f"{order_id[:10]}..." if len(str(order_id)) > 10 else str(order_id)
    _send(cfg, (
        f"💸 <b>SELL FALLBACK OK — {direction}</b>\n"
        f"Venta CLOB : <code>@ {sell_price:.4f}</code>\n"
        f"Recuperado : <code>~{usdc_received:.4f} USDC</code>\n"
        f"P&amp;L     : <code>{pnl_sign}${pnl:.2f} USDC</code>\n"
        f"Order ID   : <code>{short_id}</code>\n"
        f"<i>Claim on-chain no disponible — posición vendida en CLOB.</i>"
    ))


def notify_sell_fallback_failed(cfg: dict, bet: dict, reason: str):
    """
    v5.6: Tanto el claim on-chain como el SELL CLOB fallaron.
    El usuario debe actuar manualmente.
    """
    direction = bet.get("direction", "—")
    short_err = (reason[:200] + "…") if reason and len(reason) > 200 else (reason or "—")
    _send(cfg, (
        f"🚨 <b>SELL FALLBACK FALLIDO — {direction}</b>\n"
        f"Motivo : <code>{short_err}</code>\n"
        f"⚠️ <b>ACCIÓN MANUAL REQUERIDA:</b>\n"
        f"1. Ve a <a href=\"https://polymarket.com\">polymarket.com</a>\n"
        f"2. Verifica tu posición ganadora\n"
        f"3. Reclama o vende manualmente"
    ))
