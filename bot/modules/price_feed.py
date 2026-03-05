"""
price_feed.py — Precio BTC en tiempo real (Binance, fallback CoinGecko)
"""
import logging
import requests

logger = logging.getLogger(__name__)

BINANCE_URL    = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
COINGECKO_URL  = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
TIMEOUT        = 5  # segundos


def get_btc_price() -> float:
    """Devuelve el precio actual de BTC en USD. Lanza excepción si ambas fuentes fallan."""
    # Primaria: Binance
    try:
        r = requests.get(BINANCE_URL, timeout=TIMEOUT)
        r.raise_for_status()
        price = float(r.json()["price"])
        logger.debug(f"BTC Binance: ${price:,.2f}")
        return price
    except Exception as e:
        logger.warning(f"Binance no disponible: {e} — usando CoinGecko")

    # Fallback: CoinGecko
    r = requests.get(COINGECKO_URL, timeout=TIMEOUT)
    r.raise_for_status()
    price = float(r.json()["bitcoin"]["usd"])
    logger.debug(f"BTC CoinGecko: ${price:,.2f}")
    return price


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    print(f"BTC: ${get_btc_price():,.2f}")
