"""
state_reporter.py — Reporta el estado del bot al endpoint /api/bot-state del frontend.

v1.1 — SIMULATE_MODE en payload
  - report_state() acepta simulate_mode: bool | None y lo incluye en el payload.
    El GET de /api/bot-state hace { ...stored } → el campo llega al dashboard
    sin cambios adicionales en la ruta.

Uso:
    from .state_reporter import report_state, report_offline

    # En cada ciclo del monitor:
    report_state(market=market, target=target, price=price, simulate_mode=simulate)

Variables de entorno requeridas:
    FRONTEND_URL   → URL del dashboard Vercel, ej: https://tu-app.vercel.app
    BOT_SECRET     → Secret compartido con el frontend (opcional pero recomendado)
"""
import logging
import os
import threading
import requests

logger = logging.getLogger(__name__)

FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")
BOT_SECRET   = os.getenv("BOT_SECRET", "")
TIMEOUT      = 5   # segundos
_ENDPOINT    = "/api/bot-state"


def _post(payload: dict) -> None:
    """Envía el estado al frontend en un thread separado (no bloqueante)."""
    if not FRONTEND_URL:
        return  # no configurado, silencio

    url     = FRONTEND_URL + _ENDPOINT
    headers = {"Content-Type": "application/json"}
    if BOT_SECRET:
        headers["x-bot-secret"] = BOT_SECRET

    try:
        r = requests.post(url, json=payload, headers=headers, timeout=TIMEOUT)
        if r.ok:
            logger.debug(f"[REPORTER] ✅ Estado reportado al frontend ({r.status_code})")
        else:
            logger.warning(f"[REPORTER] ⚠ Frontend respondió {r.status_code}: {r.text[:120]}")
    except requests.exceptions.Timeout:
        logger.debug("[REPORTER] Timeout reportando estado al frontend")
    except requests.exceptions.ConnectionError:
        logger.debug("[REPORTER] No se pudo conectar al frontend (¿Vercel caído?)")
    except Exception as e:
        logger.debug(f"[REPORTER] Error inesperado: {e}")


def report_state(
    *,
    market:        dict | None  = None,
    target:        float | None = None,
    price:         float | None = None,
    direction:     str | None   = None,
    window:        str | None   = None,
    ops_today:     int | None   = None,
    bet_active:    bool | None  = None,
    simulate_mode: bool | None  = None,   # v1.1 — modo activo en runtime
    status:        str = "running",
) -> None:
    """
    Reporta el estado actual del bot al dashboard.
    La llamada es no-bloqueante (thread daemon).

    simulate_mode: True  → bot en modo simulado
                   False → bot en modo real
                   None  → desconocido (no se transmite al dashboard)
    """
    payload = {
        "status":        status,
        "market":        market,
        "target":        target,
        "price":         price,
        "slug":          market.get("slug") if market else None,
        "direction":     direction,
        "window":        window,
        "ops_today":     ops_today,
        "bet_active":    bet_active,
        "simulate_mode": simulate_mode,   # v1.1
    }
    t = threading.Thread(target=_post, args=(payload,), daemon=True)
    t.start()


def report_offline() -> None:
    """Marca el bot como offline en el frontend."""
    report_state(status="offline")
