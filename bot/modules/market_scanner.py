"""
market_scanner.py — Detecta el mercado BTC Up/Down activo en Polymarket
y obtiene el Price to Beat (open vela 1H de Binance)

FIX: Polymarket nombra cada mercado por la hora de CIERRE de la vela 1H (ET).
     Ejemplo a las 10:30 UTC (5:30am ET):
       · Vela activa: 10:00–11:00 UTC = 5am–6am ET
       · Slug correcto: bitcoin-up-or-down-march-6-6am-et  ← hora CIERRE
       · Bug anterior:  bitcoin-up-or-down-march-6-5am-et  ← hora apertura ❌

     Además se corrigió el formato del slug (era "will-btc-be-higher-or-lower-..."
     que ya no usa Polymarket).
"""
import logging
import requests
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
TIMEOUT       = 8

MONTHS = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
]


# ── Helpers timezone ET ───────────────────────────────────────────────────────

def _is_dst(utc_date: datetime) -> bool:
    year      = utc_date.year
    march     = datetime(year, 3, 1, tzinfo=timezone.utc)
    dst_start = datetime(year, 3, 8 + (7 - march.weekday() - 1) % 7, tzinfo=timezone.utc)
    nov       = datetime(year, 11, 1, tzinfo=timezone.utc)
    dst_end   = datetime(year, 11, 1 + (7 - nov.weekday() - 1) % 7, tzinfo=timezone.utc)
    return dst_start <= utc_date < dst_end


def _to_et(utc_date: datetime) -> datetime:
    return utc_date + timedelta(hours=-4 if _is_dst(utc_date) else -5)


def _format_hour_12(h24: int) -> str:
    if h24 == 0:   return "12am"
    if h24 == 12:  return "12pm"
    return f"{h24}am" if h24 < 12 else f"{h24 - 12}pm"


def build_slugs() -> list[str]:
    """
    Genera slugs candidatos para el mercado BTC Up/Down activo.

    ⚠️ CLAVE — el slug usa la hora de CIERRE de la vela 1H en ET, no la de apertura.
    La hora de cierre = hora de apertura UTC + 1h, convertida a ET.
    """
    now   = datetime.now(timezone.utc)
    slugs = []

    for offset in [0, -1, 1]:
        candle_open_utc  = now + timedelta(hours=offset)
        # Cierre = apertura + 1h → esto determina el slug en Polymarket
        candle_close_utc = candle_open_utc + timedelta(hours=1)
        et_close         = _to_et(candle_close_utc)

        slug = (
            f"bitcoin-up-or-down-"
            f"{MONTHS[et_close.month - 1]}-{et_close.day}-"
            f"{_format_hour_12(et_close.hour)}-et"
        )
        if slug not in slugs:
            slugs.append(slug)

    logger.debug(f"[SCANNER] Slugs candidatos (hora cierre ET): {slugs}")
    return slugs


_last_slug: str | None = None


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

            market    = data[0]
            question  = market.get("question", "—")
            cond_id   = market.get("conditionId", market.get("condition_id", "—"))
            end_date  = market.get("endDateIso", market.get("end_date_iso", market.get("endDate", "—")))
            tokens    = market.get("tokens", [])
            yes_price = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
            no_price  = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)

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
                f"           Cierre     : {end_date}"
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
    params = {"symbol": "BTCUSDT", "interval": "1h", "limit": 1}
    logger.debug(f"[SCANNER] GET {BINANCE_KLINE} params={params}")
    try:
        r = requests.get(BINANCE_KLINE, params=params, timeout=TIMEOUT)
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
