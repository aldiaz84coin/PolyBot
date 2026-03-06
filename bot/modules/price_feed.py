"""
price_feed.py — Precio BTC en tiempo real (Binance, fallback CoinGecko)
"""
import logging
import requests

logger = logging.getLogger(__name__)

BINANCE_URL    = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
COINGECKO_URL  = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
TIMEOUT        = 5

_last_price: float | None = None


def get_btc_price() -> float:
    """Devuelve el precio actual de BTC en USD. Lanza excepción si ambas fuentes fallan."""
    global _last_price

    # ── Primaria: Binance ─────────────────────────────────────────────────
    logger.debug(f"[PRICE] GET {BINANCE_URL}")
    try:
        r = requests.get(BINANCE_URL, timeout=TIMEOUT)
        logger.debug(f"[PRICE] HTTP {r.status_code} — Binance")
        r.raise_for_status()

        price = float(r.json()["price"])
        _log_price_change(price, "Binance")
        _last_price = price
        return price

    except requests.exceptions.Timeout:
        logger.warning(f"[PRICE] ⚠ Timeout ({TIMEOUT}s) en Binance — intentando CoinGecko")
    except requests.exceptions.ConnectionError as e:
        logger.warning(f"[PRICE] ⚠ Error de conexión con Binance: {e} — intentando CoinGecko")
    except requests.exceptions.HTTPError as e:
        logger.warning(f"[PRICE] ⚠ HTTP {r.status_code} de Binance: {e} — intentando CoinGecko")
    except (KeyError, ValueError) as e:
        logger.warning(f"[PRICE] ⚠ Error parseando respuesta de Binance: {e} — intentando CoinGecko")

    # ── Fallback: CoinGecko ───────────────────────────────────────────────
    logger.debug(f"[PRICE] GET {COINGECKO_URL}")
    try:
        r = requests.get(COINGECKO_URL, timeout=TIMEOUT)
        logger.debug(f"[PRICE] HTTP {r.status_code} — CoinGecko")
        r.raise_for_status()

        price = float(r.json()["bitcoin"]["usd"])
        _log_price_change(price, "CoinGecko")
        _last_price = price
        return price

    except requests.exceptions.Timeout:
        logger.error(f"[PRICE] ❌ Timeout ({TIMEOUT}s) también en CoinGecko — sin precio disponible")
        raise
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[PRICE] ❌ Error de conexión con CoinGecko: {e}")
        raise
    except requests.exceptions.HTTPError as e:
        logger.error(f"[PRICE] ❌ HTTP {r.status_code} de CoinGecko: {e}")
        raise
    except (KeyError, ValueError) as e:
        logger.error(f"[PRICE] ❌ Error parseando respuesta de CoinGecko: {e}")
        raise


def _log_price_change(price: float, source: str):
    """Loguea el precio con delta respecto al último valor conocido."""
    if _last_price is None:
        logger.info(f"[PRICE] 💲 BTC = ${price:,.2f}  (fuente: {source})")
        return

    delta     = price - _last_price
    delta_pct = (delta / _last_price) * 100
    arrow     = "▲" if delta >= 0 else "▼"
    color_tag = "+" if delta >= 0 else ""

    logger.debug(
        f"[PRICE] 💲 BTC = ${price:,.2f}  {arrow} {color_tag}{delta:+.2f} ({color_tag}{delta_pct:+.4f}%)  [{source}]"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    print(f"BTC: ${get_btc_price():,.2f}")
