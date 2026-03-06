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

_last_slug = None   # para detectar cambios de slug entre llamadas


def build_slugs() -> list[str]:
    """Genera los slugs para la hora actual y la siguiente."""
    now = datetime.now(timezone.utc)
    base = f"will-btc-be-higher-or-lower-{now.year}-{now.month:02d}-{now.day:02d}"
    slugs = [
        f"{base}t{now.hour:02d}00-00-000z",
        f"{base}t{(now.hour + 1) % 24:02d}00-00-000z",
    ]
    logger.debug(f"[SCANNER] Slugs candidatos: {slugs}")
    return slugs


def get_active_market() -> dict | None:
    """Devuelve el primer mercado BTC activo encontrado, o None."""
    global _last_slug
    slugs = build_slugs()

    for slug in slugs:
        url = f"{GAMMA_API}?slug={slug}"
        logger.debug(f"[SCANNER] GET {url}")
        try:
            r = requests.get(GAMMA_API, params={"slug": slug}, timeout=TIMEOUT)
            logger.debug(f"[SCANNER] HTTP {r.status_code} — slug={slug}")
            r.raise_for_status()
            data = r.json()

            if not data:
                logger.debug(f"[SCANNER] Sin resultados para slug={slug}")
                continue

            market = data[0]
            question   = market.get("question", "—")
            cond_id    = market.get("conditionId", market.get("condition_id", "—"))
            end_date   = market.get("endDateIso", market.get("end_date_iso", market.get("endDate", "—")))
            tokens     = market.get("tokens", [])
            yes_price  = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
            no_price   = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)

            # ── Detección de cambio de slug ────────────────────────────────
            if _last_slug is None:
                logger.info(f"[SCANNER] ✅ Mercado inicial detectado")
            elif _last_slug != slug:
                logger.info(
                    f"[SCANNER] 🔄 CAMBIO DE SLUG detectado:\n"
                    f"           Anterior : {_last_slug}\n"
                    f"           Nuevo    : {slug}"
                )
            else:
                logger.debug(f"[SCANNER] Slug sin cambios: {slug}")

            _last_slug = slug

            logger.info(
                f"[SCANNER] Mercado activo:\n"
                f"           Pregunta   : {question}\n"
                f"           Slug       : {slug}\n"
                f"           ConditionID: {cond_id}\n"
                f"           Cierre     : {end_date}\n"
                f"           YES price  : {yes_price:.4f}" if yes_price else "           YES price  : —"
            )
            if yes_price and no_price:
                logger.info(
                    f"[SCANNER] Precios de tokens — "
                    f"YES: {yes_price:.4f} ({yes_price*100:.1f}%)  "
                    f"NO: {no_price:.4f} ({no_price*100:.1f}%)"
                )

            return market

        except requests.exceptions.Timeout:
            logger.warning(f"[SCANNER] ⚠ Timeout ({TIMEOUT}s) en slug={slug}")
        except requests.exceptions.ConnectionError as e:
            logger.error(f"[SCANNER] ❌ Error de conexión para slug={slug}: {e}")
        except requests.exceptions.HTTPError as e:
            logger.warning(f"[SCANNER] ⚠ HTTP {r.status_code} para slug={slug}: {e}")
        except Exception as e:
            logger.error(f"[SCANNER] ❌ Error inesperado para slug={slug}: {type(e).__name__}: {e}")

    logger.warning(
        f"[SCANNER] ⚠ Ningún mercado encontrado para los slugs probados: {slugs}"
    )
    return None


def get_open_1h_binance() -> float | None:
    """Obtiene el precio OPEN de la vela 1H actual de Binance (= Price to Beat)."""
    url = BINANCE_KLINE
    params = {"symbol": "BTCUSDT", "interval": "1h", "limit": 1}
    logger.debug(f"[SCANNER] GET {url} params={params}")
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT)
        logger.debug(f"[SCANNER] HTTP {r.status_code} — Binance klines")
        r.raise_for_status()

        kline      = r.json()[0]
        open_price = float(kline[1])
        high       = float(kline[2])
        low        = float(kline[3])
        close      = float(kline[4])
        open_ts    = datetime.fromtimestamp(kline[0] / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC")
        close_ts   = datetime.fromtimestamp(kline[6] / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC")

        logger.info(
            f"[SCANNER] Vela 1H Binance:\n"
            f"           Open  : ${open_price:,.2f}  ← Price to Beat\n"
            f"           High  : ${high:,.2f}\n"
            f"           Low   : ${low:,.2f}\n"
            f"           Close : ${close:,.2f}\n"
            f"           Desde : {open_ts}  →  {close_ts}"
        )
        return open_price

    except requests.exceptions.Timeout:
        logger.error(f"[SCANNER] ❌ Timeout obteniendo vela 1H de Binance ({TIMEOUT}s)")
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[SCANNER] ❌ Error de conexión con Binance: {e}")
    except requests.exceptions.HTTPError as e:
        logger.error(f"[SCANNER] ❌ HTTP {r.status_code} de Binance klines: {e}")
    except (IndexError, KeyError, ValueError) as e:
        logger.error(f"[SCANNER] ❌ Error parseando respuesta de Binance: {type(e).__name__}: {e}")
    except Exception as e:
        logger.error(f"[SCANNER] ❌ Error inesperado: {type(e).__name__}: {e}")

    return None


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    market = get_active_market()
    target = get_open_1h_binance()
    print(f"Mercado: {market.get('question') if market else 'No encontrado'}")
    print(f"Target : ${target:,.2f}" if target else "Target: No disponible")
