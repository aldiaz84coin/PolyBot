"""
price_feed.py — Precio BTC en tiempo real (Binance, fallback CoinGecko)

v4.0 — FIX CRÍTICO 429 CoinGecko:
  - CoinGecko devuelve 429 Too Many Requests en cuentas gratuitas.
  - Antes: raise_for_status() → HTTPError → burbujea → crash del bot.
  - Ahora:
    1. Binance sigue siendo la fuente primaria (sin cambios).
    2. CoinGecko: detecta 429 explícitamente y reintenta con backoff
       exponencial (5s, 15s, 30s) antes de rendirse.
    3. Si AMBAS fuentes fallan, devuelve _last_price (precio cacheado)
       en lugar de lanzar excepción → el bot NUNCA se cae por falta de precio.
    4. Solo lanza RuntimeError si no hay ningún precio cacheado disponible
       (primer arranque y ambas fuentes caídas).
"""
import logging
import time

import requests

logger = logging.getLogger(__name__)

BINANCE_URL   = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
TIMEOUT       = 5

# Backoff para reintentos de CoinGecko en caso de 429
_COINGECKO_BACKOFF = [5, 15, 30]  # segundos entre intentos

_last_price: float | None = None


def get_btc_price() -> float:
    """
    Devuelve el precio actual de BTC en USD.

    Orden de prioridad:
      1. Binance (primaria, sin rate limit)
      2. CoinGecko (fallback, con retry en 429)
      3. _last_price cacheado (si ambas fallan)
      4. RuntimeError solo si jamás hubo un precio válido
    """
    global _last_price

    # ── 1. Binance (primaria) ─────────────────────────────────────────────
    try:
        r = requests.get(BINANCE_URL, timeout=TIMEOUT)
        r.raise_for_status()
        price = float(r.json()["price"])
        _log_price_change(price, "Binance")
        _last_price = price
        return price
    except requests.exceptions.Timeout:
        logger.warning(f"[PRICE] ⚠ Timeout ({TIMEOUT}s) en Binance — intentando CoinGecko")
    except requests.exceptions.ConnectionError as e:
        logger.warning(f"[PRICE] ⚠ Conexión Binance: {e} — intentando CoinGecko")
    except requests.exceptions.HTTPError as e:
        logger.warning(f"[PRICE] ⚠ HTTP {r.status_code} Binance: {e} — intentando CoinGecko")
    except (KeyError, ValueError) as e:
        logger.warning(f"[PRICE] ⚠ Parse Binance: {e} — intentando CoinGecko")

    # ── 2. CoinGecko con retry en 429 ────────────────────────────────────
    for attempt, backoff in enumerate(_COINGECKO_BACKOFF, start=1):
        try:
            r = requests.get(COINGECKO_URL, timeout=TIMEOUT)

            # 429: demasiadas peticiones — esperar y reintentar
            if r.status_code == 429:
                retry_after = int(r.headers.get("Retry-After", backoff))
                wait = max(retry_after, backoff)
                logger.warning(
                    f"[PRICE] ⚠ CoinGecko 429 (intento {attempt}/{len(_COINGECKO_BACKOFF)}) "
                    f"— esperando {wait}s antes de reintentar"
                )
                time.sleep(wait)
                continue

            r.raise_for_status()
            price = float(r.json()["bitcoin"]["usd"])
            _log_price_change(price, "CoinGecko")
            _last_price = price
            return price

        except requests.exceptions.Timeout:
            logger.warning(f"[PRICE] ⚠ Timeout CoinGecko (intento {attempt})")
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"[PRICE] ⚠ Conexión CoinGecko (intento {attempt}): {e}")
        except requests.exceptions.HTTPError as e:
            logger.warning(f"[PRICE] ⚠ HTTP CoinGecko (intento {attempt}): {e}")
        except (KeyError, ValueError) as e:
            logger.warning(f"[PRICE] ⚠ Parse CoinGecko (intento {attempt}): {e}")

        # Esperar antes del siguiente intento (si no fue 429 con continue)
        if attempt < len(_COINGECKO_BACKOFF):
            time.sleep(backoff)

    # ── 3. Fallback: precio cacheado ──────────────────────────────────────
    if _last_price is not None:
        logger.warning(
            f"[PRICE] ⚠ Binance + CoinGecko no disponibles — "
            f"usando precio cacheado: ${_last_price:,.2f} (el bot continúa)"
        )
        return _last_price

    # ── 4. Sin precio disponible (solo en primer arranque) ───────────────
    logger.error("[PRICE] ❌ Sin precio BTC — ni fuentes activas ni caché disponible")
    raise RuntimeError("No hay precio BTC disponible — sin caché y sin fuentes activas")


def _log_price_change(price: float, source: str):
    """Loguea el precio con delta respecto al último valor conocido."""
    global _last_price
    if _last_price is None:
        logger.info(f"[PRICE] 💰 BTC=${price:,.2f}  (fuente: {source})")
        return
    delta = price - _last_price
    pct   = (delta / _last_price * 100) if _last_price else 0
    sign  = "+" if delta >= 0 else ""
    logger.debug(
        f"[PRICE] 💰 BTC=${price:,.2f}  "
        f"({sign}{delta:,.2f} / {sign}{pct:.3f}%)  "
        f"fuente: {source}"
    )
