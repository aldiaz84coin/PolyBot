"""
arb_notifier.py — Notificaciones Telegram para la estrategia de arbitraje

Todas las funciones son fire-and-forget.
Usan el mismo TELEGRAM_TOKEN / TELEGRAM_CHAT_ID del bot principal.

v1.0 — Implementación inicial
"""

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


def _send(cfg: dict, text: str):
    """Envía un mensaje HTML a Telegram. Fire-and-forget."""
    try:
        import requests
        token   = cfg.get("telegram", {}).get("token", "")
        chat_id = cfg.get("telegram", {}).get("chat_id", "")
        if not token or not chat_id:
            return
        requests.post(
            _TELEGRAM_API.format(token=token),
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=5,
        )
    except Exception as e:
        logger.debug(f"[ARB_NOTIFIER] Error Telegram: {e}")


def _modo(simulate: bool) -> str:
    return "🔵 SIMULADO" if simulate else "🔴 REAL"


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S UTC")


# ── Notificaciones ────────────────────────────────────────────────────────────

def notify_arb_start(cfg: dict, simulate: bool):
    _send(cfg, (
        f"⚖️ <b>ARB BOT INICIADO</b>\n"
        f"Modo: {_modo(simulate)}\n"
        f"Estrategia: Arbitraje de pares UP/DOWN\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_phase_change(
    cfg:       dict,
    old_phase: str,
    new_phase: str,
    up_price:  float,
    down_price: float,
    pair_cost: float,
    simulate:  bool,
):
    phase_labels = {
        "PHASE1": "Fase 1 — Acumulación (60→30 min)",
        "PHASE2": "Fase 2 — Monitoreo unilateral (30→15 min)",
        "PHASE3": "Fase 3 — Venta a mercado (15→0.5 min)",
        "END":    "FIN — Esperando resolución",
        "OUTSIDE": "Fuera de ventana",
    }
    label = phase_labels.get(new_phase, new_phase)
    _send(cfg, (
        f"⚖️ <b>ARB — {label}</b>  {_modo(simulate)}\n"
        f"UP: <code>{up_price:.4f}</code>  "
        f"DOWN: <code>{down_price:.4f}</code>\n"
        f"Par: <code>{pair_cost:.4f}</code>  "
        f"{'✅ &lt;1.00' if pair_cost < 1.0 else '❌ ≥1.00'}\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_leg_bought(
    cfg:      dict,
    leg:      str,
    odds:     float,
    tokens:   float,
    stake:    float,
    position,
    simulate: bool,
):
    icon = "🟢" if leg == "UP" else "🔴"
    _send(cfg, (
        f"⚖️ {icon} <b>ARB — PATA {leg} COMPRADA</b>  {_modo(simulate)}\n"
        f"Precio: <code>{odds:.4f}</code>\n"
        f"Stake: <code>${stake:.2f}</code>  "
        f"Tokens: <code>{tokens:.4f}</code>\n"
        f"Pata contraria pendiente: <b>{position.open_leg or '—'}</b>\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_balanced(cfg: dict, position, simulate: bool):
    """Par completo: ganancia garantizada."""
    _send(cfg, (
        f"⚖️ ✅ <b>PAR BALANCEADO — GANANCIA GARANTIZADA</b>  {_modo(simulate)}\n\n"
        f"UP:   <code>{position.up_entry_odds:.4f}</code>  "
        f"({position.up_tokens:.4f} tokens)\n"
        f"DOWN: <code>{position.down_entry_odds:.4f}</code>  "
        f"({position.down_tokens:.4f} tokens)\n\n"
        f"Par cost:  <code>{position.pair_cost:.4f}</code>\n"
        f"Invertido: <code>${position.total_cost:.4f}</code>\n"
        f"Ganancia:  <b>${position.ganancia_garantizada:.4f}</b>  "
        f"({((position.ganancia_garantizada / max(position.total_cost, 0.001)) * 100):.2f}%)\n\n"
        f"Esperando resolución del mercado… 🏁\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_exit_phase3(
    cfg:         dict,
    leg:         str,
    sell_result: dict,
    pnl_partial: float,
    position,
    simulate:    bool,
):
    """Venta forzada en Fase 3 (pata sin cubrir)."""
    sign = "+" if pnl_partial >= 0 else ""
    _send(cfg, (
        f"⚖️ ⚠️ <b>ARB — VENTA FASE 3</b>  {_modo(simulate)}\n"
        f"Leg vendida: <b>{leg}</b>\n"
        f"Precio venta: <code>{sell_result['odds']:.4f}</code>\n"
        f"Tokens: <code>{sell_result['tokens']:.4f}</code>\n"
        f"Ingreso: <code>${sell_result['proceeds']:.4f}</code>\n"
        f"PnL parcial: <b>{sign}${pnl_partial:.4f}</b>\n"
        f"<i>Par no balanceado. PnL final depende del mercado.</i>\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_resolution(
    cfg:       dict,
    position,
    pnl_usd:   float,
    pnl_pct:   float,
    resultado: str,
    simulate:  bool,
):
    """Resolución del mercado al cierre de hora."""
    sign = "+" if pnl_usd >= 0 else ""
    icon = "🎉" if resultado == "BALANCED" else ("⚠️" if resultado == "PHASE3_EXIT" else "❌")
    resultado_label = {
        "BALANCED":    "PAR BALANCEADO — ganancia realizada",
        "PHASE3_EXIT": "Salida parcial en Fase 3",
        "PARTIAL":     "Posición incompleta al cierre",
    }.get(resultado, resultado)

    _send(cfg, (
        f"⚖️ {icon} <b>ARB — RESOLUCIÓN</b>  {_modo(simulate)}\n\n"
        f"Resultado: <b>{resultado_label}</b>\n"
        f"PnL: <b>{sign}${pnl_usd:.4f}</b>  ({sign}{pnl_pct:.1f}%)\n"
        f"Invertido: <code>${position.total_cost:.4f}</code>\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_hour_summary(
    cfg:       dict,
    hour_ops:  list,
    pnl_total: float,
    simulate:  bool,
):
    """Resumen de operaciones ARB de la hora."""
    if not hour_ops:
        return
    n       = len(hour_ops)
    bal     = sum(1 for o in hour_ops if o.get("resultado") == "BALANCED")
    sign    = "+" if pnl_total >= 0 else ""
    _send(cfg, (
        f"⚖️ 📊 <b>ARB — RESUMEN HORA</b>  {_modo(simulate)}\n"
        f"Operaciones: <code>{n}</code>  "
        f"Balanceadas: <code>{bal}</code>\n"
        f"PnL hora: <b>{sign}${pnl_total:.4f}</b>\n"
        f"<i>{_ts()}</i>"
    ))


def notify_arb_no_opportunity(cfg: dict, up_price: float, down_price: float, simulate: bool):
    """Log silencioso — no enviar Telegram, solo usar en debug si hace falta."""
    pass
