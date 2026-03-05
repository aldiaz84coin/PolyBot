"""
market_scanner.py — Detecta el mercado BTC Up/Down activo en Polymarket
y obtiene el Price to Beat (open vela 1H de Binance)
"""
import logging
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
TIMEOUT       = 8


def build_slugs() -> list[str]:
    """Genera los slugs para la hora actual y la siguiente."""
    now = datetime.now(timezone.utc)
    base = f"will-btc-be-higher-or-lower-{now.year}-{now.month:02d}-{now.day:02d}"
    return [
        f"{base}t{now.hour:02d}00-00-000z",
        f"{base}t{(now.hour + 1) % 24:02d}00-00-000z",
    ]


def get_active_market() -> dict | None:
    """Devuelve el primer mercado BTC activo encontrado, o None."""
    for slug in build_slugs():
        try:
            r = requests.get(GAMMA_API, params={"slug": slug}, timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            if data:
                market = data[0]
                logger.info(f"Mercado activo: {market.get('question')}")
                return market
        except Exception as e:
            logger.debug(f"Slug {slug} no encontrado: {e}")
    return None


def get_open_1h_binance() -> float | None:
    """Obtiene el precio OPEN de la vela 1H actual de Binance (= Price to Beat)."""
    try:
        r = requests.get(
            BINANCE_KLINE,
            params={"symbol": "BTCUSDT", "interval": "1h", "limit": 1},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        kline = r.json()[0]
        open_price = float(kline[1])
        logger.info(f"Target 1H (OPEN Binance): ${open_price:,.2f}")
        return open_price
    except Exception as e:
        logger.error(f"Error obteniendo OPEN 1H: {e}")
        return None


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    market = get_active_market()
    target = get_open_1h_binance()
    print(f"Mercado: {market.get('question') if market else 'No encontrado'}")
    print(f"Target : ${target:,.2f}" if target else "Target: No disponible")
