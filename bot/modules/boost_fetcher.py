"""
boost_fetcher.py — v1.0
────────────────────────────────────────────────────────────────────────────
Consulta el endpoint /api/btc/boost-power de Crypto Detector v4 y devuelve
el BoostPower calculado por el Algoritmo A para Bitcoin.

Se llama al entrar en cada ventana temporal (T-20, T-15, T-10, T-5) para
capturar la tendencia BTC en el momento exacto del análisis de señal.

Configuración (env vars):
  BOOST_POWER_URL   — URL base del endpoint, ej: https://tu-dominio.com
                       Si no está definida, el módulo queda desactivado.
  BOOST_POWER_MODE  — "normal" (default) | "speculative"

Destino: bot/modules/boost_fetcher.py
"""

import logging
import os
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ── Constantes ────────────────────────────────────────────────────────────────

_ENDPOINT_PATH = "/api/btc/boost-power"
_TIMEOUT_S     = 10        # timeout por request
_RETRY_WAIT_S  = 2         # espera entre reintentos
_MAX_RETRIES   = 2         # reintentos ante error de red


# ── Estado del módulo ─────────────────────────────────────────────────────────

_base_url:    str | None = None
_mode:        str        = "normal"
_initialized: bool       = False


def init(base_url: str | None = None, mode: str = "normal") -> bool:
    """
    Inicializa el módulo. Llamar desde monitor.py al arrancar.
    Devuelve True si el endpoint está configurado y activo.
    """
    global _base_url, _mode, _initialized

    url = base_url or os.getenv("BOOST_POWER_URL", "").rstrip("/")
    _mode = mode or os.getenv("BOOST_POWER_MODE", "normal")

    if not url:
        logger.info("[BOOST] ℹ️  BOOST_POWER_URL no configurada — módulo desactivado")
        _initialized = False
        return False

    _base_url    = url
    _initialized = True
    logger.info(f"[BOOST] ✅ Inicializado — url={url}  mode={_mode}")
    return True


def is_enabled() -> bool:
    return _initialized and bool(_base_url)


def fetch(window_key: str, fresh: bool = False) -> Optional[float]:
    """
    Consulta el endpoint y devuelve el boostPower (0.0 – 1.0).
    Devuelve None si el módulo está desactivado o hay error.

    Args:
        window_key: "T-20" | "T-15" | "T-10" | "T-5"  (solo para logging)
        fresh:      Si True, fuerza recálculo ignorando la caché Redis.
    """
    if not is_enabled():
        return None

    url    = f"{_base_url}{_ENDPOINT_PATH}"
    params = {"mode": _mode}
    if fresh:
        params["fresh"] = "true"

    for attempt in range(1, _MAX_RETRIES + 2):
        try:
            resp = requests.get(url, params=params, timeout=_TIMEOUT_S)
            resp.raise_for_status()
            data = resp.json()

            if not data.get("success"):
                logger.warning(f"[BOOST] {window_key} — API error: {data.get('error', '?')}")
                return None

            bp      = data["analysis"]["boostPower"]
            bp_pct  = data["analysis"].get("boostPowerPercent", round(bp * 100, 2))
            clf     = data["analysis"].get("classification", "?")
            cached  = "caché" if data.get("cached") else "fresco"

            logger.info(
                f"[BOOST] {window_key} → BP={bp:.4f} ({bp_pct:.1f}%)  "
                f"clf={clf}  mode={_mode}  [{cached}]"
            )
            return round(bp, 6)

        except requests.exceptions.Timeout:
            logger.warning(f"[BOOST] {window_key} — timeout (intento {attempt})")
        except requests.exceptions.RequestException as e:
            logger.warning(f"[BOOST] {window_key} — error red (intento {attempt}): {e}")
        except (KeyError, ValueError) as e:
            logger.warning(f"[BOOST] {window_key} — respuesta inesperada: {e}")
            return None  # no reintentar si es problema de schema

        if attempt <= _MAX_RETRIES:
            time.sleep(_RETRY_WAIT_S)

    logger.warning(f"[BOOST] {window_key} — fallando tras {_MAX_RETRIES + 1} intentos")
    return None
