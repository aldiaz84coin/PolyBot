"""
notifier.py — Notificaciones Telegram + Dashboard del bot PolyBot

v5.7 — CLAIM NOTIFICATIONS ENRIQUECIDAS
  - notify_claim_scheduled(): muestra slug, conditionId (16ch), stake, tokens, odds.
    Describe la operación exacta que se va a reclamar para evitar ambigüedad.
  - notify_claim_retrying(): muestra mercado + operación + próximo intento estimado.
  - notify_claim_ok(): añade slug del mercado.
  - notify_claim_failed(): añade slug + conditionId.
  - notify_sell_fallback_failed(): acepta market_url= y lo muestra como link directo,
    junto con token_id (si disponible) para identificar la posición.

v5.6 — SELL FALLBACK + CLAIM SCHEDULED
  - notify_claim_scheduled(), notify_sell_fallback_ok(), notify_sell_fallback_failed()

v5.5 — NOTIFICACIONES DE CLAIM
  - notify_claim_ok(), notify_claim_retrying(), notify_claim_failed()

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
    _post_event(text)
    tg = cfg.get("telegram", {})
    token   = tg.get("token", "")
    chat_id = tg.get("chat_id", "")
    if not token or not chat_id:
        logger.warning("[NOTIF] Telegram no configurado (token o chat_id ausente)")
        return
    url = _SEND_URL.format(token=token)
    try:
        r = requests.post(
            url,
            json={
                "chat_id":    chat_id,
                "text":       text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=10,
        )
        if not r.ok:
            logger.warning(f"[NOTIF] Telegram respondió {r.status_code}: {r.text[:200]}")
    except Exception as e:
        logger.warning(f"[NOTIF] No se pudo enviar a Telegram: {e}")


# ── Arranque / parada ─────────────────────────────────────────────────────────

def notify_start(cfg: dict):
    _send(cfg, "🚀 <b>Bot iniciado</b>")


def notify_stop(cfg: dict):
    _send(cfg, "🛑 <b>Bot detenido</b>")


def notify_startup_summary(cfg: dict, mode: str, stake: float,
                           stop_pct: float, umbrales: dict):
    """v4.0: Resumen de configuración al arrancar."""
    u = umbrales or {}
    _send(cfg, (
        f"🤖 <b>PolyBot arrancado</b>\n"
        f"Modo     : <code>{mode}</code>\n"
        f"Stake    : <code>${stake:.2f} USDC</code>\n"
        f"Stop Loss: <code>{stop_pct}%</code>\n"
        f"Umbrales : T20=<code>{u.get('t20','—')}</code> "
        f"T15=<code>{u.get('t15','—')}</code> "
        f"T10=<code>{u.get('t10','—')}</code> "
        f"T5=<code>{u.get('t5','—')}</code>"
    ))


def notify_mode_change(cfg: dict, old_mode: str, new_mode: str,
                       stake: float = None, stop_pct: float = None):
    """v5.4: Notifica cambio de modo SIMULADO ↔ REAL."""
    lines = [
        f"🔄 <b>Cambio de modo</b>",
        f"Anterior : <code>{old_mode}</code>",
        f"Nuevo    : <code>{new_mode}</code>",
    ]
    if stake is not None:
        lines.append(f"Stake    : <code>${stake:.2f} USDC</code>")
    if stop_pct is not None:
        lines.append(f"Stop Loss: <code>{stop_pct}%</code>")
    _send(cfg, "\n".join(lines))


# ── Mercado ───────────────────────────────────────────────────────────────────

def notify_market_found(cfg: dict, slug: str, cond_id: str,
                        mins_left: float, market: dict):
    tokens = market.get("tokens", [])
    if isinstance(tokens, list):
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


# ── Target ────────────────────────────────────────────────────────────────────

def notify_target_change(cfg: dict, old_target: float, new_target: float,
                         mins_left: float = 0):
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


# ── Señal ─────────────────────────────────────────────────────────────────────

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
    """v5.0: Resumen al final de cada hora."""
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
            real_exit  = op.get("real_exit_odds")

            arrow   = "🟢" if direction == "UP" else "🔴"
            res_ico = {"WIN": "✅", "LOSS": "❌", "STOP": "🛑"}.get(result, "❓")
            pnl_s   = f"+${pnl:,.2f}" if pnl >= 0 else f"-${abs(pnl):,.2f}"
            sim_tag = " <i>[SIM]</i>" if simulated else ""

            line = (
                f"{i}. {arrow} {direction} [{window}]{sim_tag}\n"
                f"   Ent: <code>{entry_odds:.4f}</code>  "
                f"Sal: <code>{exit_odds:.4f}</code>  "
                f"{res_ico} <code>{pnl_s}</code>"
            )
            if simulated and real_exit is not None:
                line += f"\n   CLOB real: <code>{real_exit:.4f}</code>"
            lines.append(line)

    if hist_stats:
        total_all = hist_stats.get("total", 0)
        wins_all  = hist_stats.get("wins", 0)
        wr_all    = int(wins_all / total_all * 100) if total_all > 0 else 0
        pnl_all   = hist_stats.get("pnl_total", 0.0)
        sign_all  = "+" if pnl_all >= 0 else ""
        lines.append("")
        lines.append(
            f"📈 Histórico: <code>{total_all} ops</code>  "
            f"WR=<code>{wr_all}%</code>  "
            f"P&L=<code>{sign_all}${pnl_all:,.2f}</code>"
        )

    _send(cfg, "\n".join(lines))


# ── Apuesta ───────────────────────────────────────────────────────────────────

def notify_bet(cfg: dict, bet: dict, simulated: bool = False):
    sim     = simulated or bet.get("simulated", False)
    sim_tag = "  <i>[SIMULADO]</i>" if sim else ""
    direction  = bet.get("direction", "—")
    window     = bet.get("window", "—")
    odds       = bet.get("odds", 0)
    stake      = bet.get("stake", 0)
    tokens     = round(stake / max(odds, 0.001), 4)
    entry_btc  = bet.get("entry", 0)
    target     = bet.get("target", 0)
    ret_est    = round(tokens - stake, 2)
    pnl_est    = ret_est
    pct_est    = round((pnl_est / stake * 100) if stake else 0, 1)
    _send(cfg, (
        f"🎲 <b>Apuesta [{window}] — {direction}</b>{sim_tag}\n"
        f"Stake      : <code>${stake:.2f} USDC</code>\n"
        f"Odds       : <code>{odds:.4f}</code>  "
        f"({tokens:.4f} tokens)\n"
        f"BTC entrada: <code>${entry_btc:,.2f}</code>\n"
        f"BTC target : <code>${target:,.2f}</code>\n"
        f"Retorno est.: <code>${ret_est:.2f} (+${pnl_est:.2f} / +{pct_est:.1f}%)</code>"
    ))


def notify_order_failed(cfg: dict, signal):
    """v4.0: execute_order() devolvió None. Evita retries en la misma ventana."""
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
    sim       = simulated or bet.get("simulated", False)
    sim_tag   = "  <i>[SIMULADO]</i>" if sim else ""
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

def _bet_summary_lines(bet: dict) -> list[str]:
    """
    v5.7: Genera líneas de resumen de la operación para incluir en mensajes de claim.
    Identifica inequívocamente qué operación se está reclamando.
    """
    market     = bet.get("market", {})
    slug       = market.get("slug", "—")
    cond_id    = market.get("conditionId") or market.get("condition_id", "—")
    direction  = bet.get("direction", "—")
    stake      = bet.get("stake", 0.0)
    odds       = bet.get("odds", 0.5)
    tokens     = round(stake / max(odds, 0.001), 4)
    cond_short = f"{cond_id[:16]}…" if cond_id and cond_id != "—" else "—"

    return [
        f"Mercado    : <code>{slug}</code>",
        f"Dirección  : <code>{direction}</code>",
        f"Stake/Tkns : <code>${stake:.2f} USDC / {tokens:.4f} tokens</code>",
        f"Odds ent.  : <code>{odds:.4f}</code>",
        f"CondID     : <code>{cond_short}</code>",
    ]


def notify_claim_scheduled(cfg: dict, bet: dict, first_wait_secs: int, max_attempts: int):
    """
    v5.7: Se envía al lanzar el hilo de claim.
    Identifica la operación + informa cuándo será el primer intento.
    """
    h   = first_wait_secs // 3600
    m   = (first_wait_secs % 3600) // 60
    s   = first_wait_secs % 60

    if h > 0 and m > 0:
        wait_str = f"{h}h {m}m"
    elif h > 0:
        wait_str = f"{h}h"
    elif m > 0 and s > 0:
        wait_str = f"{m}m {s}s"
    elif m > 0:
        wait_str = f"{m}m"
    else:
        wait_str = f"{first_wait_secs}s"

    lines = [
        f"⏳ <b>Claim programado</b>",
        f"Primer intento: en <code>{wait_str}</code>",
        f"Máx intentos  : <code>{max_attempts}</code>",
        "",
    ] + _bet_summary_lines(bet) + [
        "",
        f"<i>Polymarket tarda ~1-2h en resolver on-chain.</i>",
    ]
    _send(cfg, "\n".join(lines))


def notify_claim_ok(cfg: dict, bet: dict, tx_hash: str, attempt: int, usdc_est: float):
    """v5.7: Claim confirmado on-chain — con slug del mercado."""
    market    = bet.get("market", {})
    slug      = market.get("slug", "—")
    stake     = bet.get("stake", 0.0)
    direction = bet.get("direction", "—")
    pnl_est   = round(usdc_est - stake, 2)
    short_tx  = f"{tx_hash[:10]}...{tx_hash[-6:]}" if len(tx_hash) > 16 else tx_hash
    _send(cfg, (
        f"💰 <b>CLAIM CONFIRMADO — {direction}</b>\n"
        f"Mercado    : <code>{slug}</code>\n"
        f"TX         : <code>{short_tx}</code>\n"
        f"Recuperado : <code>~{usdc_est:.4f} USDC</code>\n"
        f"P&amp;L neto   : <code>+${pnl_est:.2f}</code>\n"
        f"Intento    : <code>{attempt}</code>\n"
        f"🔗 <a href=\"https://polygonscan.com/tx/{tx_hash}\">Ver en Polygonscan</a>"
    ))


def notify_claim_retrying(cfg: dict, bet: dict, attempt: int, max_attempts: int,
                          reason: str, wait_secs: int):
    """
    v5.7: Se envía ANTES de dormir (2º intento en adelante).
    Incluye resumen de la operación + motivo + próximo intento.
    """
    h = wait_secs // 3600
    m = (wait_secs % 3600) // 60
    s = wait_secs % 60

    if h > 0 and m > 0:
        wait_str = f"{h}h {m}m"
    elif h > 0:
        wait_str = f"{h}h"
    elif m > 0:
        wait_str = f"{m}m"
    else:
        wait_str = f"{wait_secs}s"

    short_err = (reason[:200] + "…") if reason and len(reason) > 200 else (reason or "—")

    lines = [
        f"🔄 <b>Reintentando claim [{attempt}/{max_attempts}]</b>",
        "",
    ] + _bet_summary_lines(bet) + [
        "",
        f"Motivo     : <code>{short_err}</code>",
        f"Próximo    : en <code>{wait_str}</code>",
    ]
    _send(cfg, "\n".join(lines))


def notify_claim_failed(cfg: dict, bet: dict, reason: str, attempts: int):
    """v5.7: Fallo definitivo — muestra mercado + conditionId + aviso de fallback."""
    market    = bet.get("market", {})
    slug      = market.get("slug", "—")
    direction = bet.get("direction", "—")
    cond_id   = market.get("conditionId") or market.get("condition_id", "—")
    cond_short = f"{cond_id[:16]}…" if cond_id and cond_id != "—" else "—"
    short_err = (reason[:250] + "…") if reason and len(reason) > 250 else (reason or "—")
    _send(cfg, (
        f"🚨 <b>Claim fallido — {direction}</b>\n"
        f"Mercado    : <code>{slug}</code>\n"
        f"CondID     : <code>{cond_short}</code>\n"
        f"Intentos   : <code>{attempts}</code>\n"
        f"Último err : <code>{short_err}</code>\n"
        f"⚠️ Intentando SELL FALLBACK en CLOB...\n"
        f"Si falla: reclamar en "
        f"<a href=\"https://polymarket.com/portfolio\">polymarket.com/portfolio</a>"
    ))


# ── SELL Fallback (cuando claim on-chain falla definitivamente) ───────────────

def notify_sell_fallback_ok(cfg: dict, bet: dict, resp: dict,
                            sell_price: float, usdc_received: float):
    """v5.6: Venta en CLOB exitosa como alternativa al claim on-chain."""
    direction = bet.get("direction", "—")
    stake     = bet.get("stake", 0.0)
    pnl       = round(usdc_received - stake, 2)
    pnl_sign  = "+" if pnl >= 0 else ""
    order_id  = resp.get("id", "—")
    short_id  = f"{str(order_id)[:10]}..." if len(str(order_id)) > 10 else str(order_id)
    market    = bet.get("market", {})
    slug      = market.get("slug", "—")
    _send(cfg, (
        f"💸 <b>SELL FALLBACK OK — {direction}</b>\n"
        f"Mercado    : <code>{slug}</code>\n"
        f"Venta CLOB : <code>@ {sell_price:.4f}</code>\n"
        f"Recuperado : <code>~{usdc_received:.4f} USDC</code>\n"
        f"P&amp;L     : <code>{pnl_sign}${pnl:.2f} USDC</code>\n"
        f"Order ID   : <code>{short_id}</code>\n"
        f"<i>Claim on-chain no disponible — posición vendida en CLOB.</i>"
    ))


def notify_sell_fallback_failed(cfg: dict, bet: dict, reason: str,
                                market_url: str = "https://polymarket.com/portfolio"):
    """
    v5.7: Tanto el claim on-chain como el SELL CLOB fallaron.
    Incluye URL directa al mercado + conditionId para identificación manual.
    """
    market    = bet.get("market", {})
    slug      = market.get("slug", "—")
    direction = bet.get("direction", "—")
    stake     = bet.get("stake", 0.0)
    odds      = bet.get("odds", 0.5)
    tokens    = round(stake / max(odds, 0.001), 4)
    cond_id   = market.get("conditionId") or market.get("condition_id", "—")
    cond_short = f"{cond_id[:16]}…" if cond_id and cond_id != "—" else "—"
    short_err = (reason[:250] + "…") if reason and len(reason) > 250 else (reason or "—")

    _send(cfg, (
        f"🚨 <b>SELL FALLBACK FALLIDO — {direction}</b>\n"
        f"Mercado    : <code>{slug}</code>\n"
        f"CondID     : <code>{cond_short}</code>\n"
        f"Motivo     : <code>{short_err}</code>\n"
        f"Tokens     : <code>{tokens:.4f}</code>  "
        f"Stake: <code>${stake:.2f}</code>\n"
        f"\n"
        f"⚠️ <b>ACCIÓN MANUAL REQUERIDA:</b>\n"
        f"1. Ir a <a href=\"{market_url}\">{market_url[:60]}</a>\n"
        f"2. Buscar posición ganadora <b>{direction}</b>\n"
        f"3. Reclamar o vender manualmente"
    ))
