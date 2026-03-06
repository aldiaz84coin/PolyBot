"""
market_scanner.py  ·  bot/modules/
Detecta el mercado BTC Up/Down activo en Polymarket Gamma API.

FIX: get_open_1h_binance() ahora acepta slug opcional para pedir la vela exacta
     por startTime (más robusto en transiciones de hora).
     Consistente con bot/market_scanner.py y /api/target?slug= del frontend.
"""
import logging
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GAMMA_API    = "https://gamma-api.polymarket.com/markets"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
TIMEOUT      = 10

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]

_last_slug = None


# ── DST helper ─────────────────────────────────────────────────────────────

def _is_dst(utc_dt: datetime) -> bool:
    year  = utc_dt.year
    # Segundo domingo de marzo
    march = datetime(year, 3, 1, tzinfo=timezone.utc)
    dst_start = datetime(year, 3, 8 + (6 - march.weekday()) % 7, tzinfo=timezone.utc)
    # Primer domingo de noviembre
    nov   = datetime(year, 11, 1, tzinfo=timezone.utc)
    dst_end = datetime(year, 11, 1 + (6 - nov.weekday()) % 7, tzinfo=timezone.utc)
    return dst_start <= utc_dt < dst_end


# ── Slug builders ──────────────────────────────────────────────────────────

def _format_hour_12(h24: int) -> str:
    if h24 == 0:  return "12am"
    if h24 == 12: return "12pm"
    return f"{h24}am" if h24 < 12 else f"{h24 - 12}pm"


def build_slugs(now: datetime | None = None) -> list[str]:
    """Genera slugs candidatos para el mercado activo (hora actual ± 1h)."""
    if now is None:
        now = datetime.now(timezone.utc)

    candle_open = now.replace(minute=0, second=0, microsecond=0)
    slugs = []
    for offset_h in [0, -1, 1]:
        from datetime import timedelta
        co = candle_open + timedelta(hours=offset_h)
        et_offset = 4 if _is_dst(co) else 5
        et_hour   = (co.hour - et_offset) % 24
        et_day    = co.day
        # ajuste día si la conversión cruza medianoche
        if co.hour < et_offset:
            from datetime import timedelta as _td
            et_day = (co - _td(days=1)).day
            month_idx = (co - _td(days=1)).month - 1
        else:
            month_idx = co.month - 1
        slug = f"bitcoin-up-or-down-{MONTHS[month_idx]}-{et_day}-{_format_hour_12(et_hour)}-et"
        if slug not in slugs:
            slugs.append(slug)
    return slugs


# ── Mercado activo ─────────────────────────────────────────────────────────

def get_active_market() -> dict | None:
    """Devuelve el primer mercado BTC Up/Down activo que encuentre en Polymarket."""
    global _last_slug
    slugs = build_slugs()

    for slug in slugs:
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


# ── Price to Beat (Binance 1H open) ───────────────────────────────────────

def _slug_to_candle_start_ms(slug: str, now: datetime) -> int | None:
    """
    Parsea el slug para obtener el startTime UTC (ms) de la vela 1H.

    ⚠️ El slug contiene la hora de APERTURA en ET → esa es directamente el start.
    Consistente con parseCandleStartFromSlug() en app/api/target/route.js.
    """
    try:
        parts = slug.split("-")
        month_idx      = -1
        month_part_idx = -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx      = MONTHS.index(p)
                month_part_idx = i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        hour_str = parts[month_part_idx + 2]

        # La hora del slug = hora de APERTURA en ET (directamente)
        if hour_str == "12am":
            open_hour_et = 0
        elif hour_str == "12pm":
            open_hour_et = 12
        elif hour_str.endswith("am"):
            open_hour_et = int(hour_str[:-2])
        elif hour_str.endswith("pm"):
            open_hour_et = int(hour_str[:-2]) + 12
        else:
            return None

        year      = now.year
        candidate = datetime(year, month_idx + 1, day, 12, 0, 0, tzinfo=timezone.utc)
        et_offset = 4 if _is_dst(candidate) else 5

        start_utc = datetime(
            year, month_idx + 1, day,
            open_hour_et + et_offset, 0, 0,
            tzinfo=timezone.utc,
        )
        return int(start_utc.timestamp() * 1000)
    except Exception:
        return None


def get_open_1h_binance(slug: str | None = None) -> float | None:
    """
    Devuelve el precio OPEN de la vela 1H del mercado activo (= Price to Beat).

    Si se pasa slug, pide la vela exacta por startTime (más robusto en
    transiciones de hora). Si no, pide la vela 1H actual con limit=1.

    FIX: antes no aceptaba el parámetro slug → TypeError al llamar con slug=slug.
    """
    now    = datetime.now(timezone.utc)
    params: dict = {"symbol": "BTCUSDT", "interval": "1h"}

    if slug:
        start_ms = _slug_to_candle_start_ms(slug, now)
        if start_ms:
            params["startTime"] = start_ms
            params["limit"]     = 1
            logger.debug(f"[SCANNER] Binance klines — startTime={start_ms} slug={slug}")
        else:
            logger.warning(f"[SCANNER] No se pudo parsear startTime del slug={slug}, usando limit=1")
            params["limit"] = 1
    else:
        params["limit"] = 1

    logger.debug(f"[SCANNER] GET {BINANCE_KLINE} params={params}")
    try:
        r = requests.get(BINANCE_KLINE, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        klines = r.json()

        if not klines:
            logger.error("[SCANNER] ❌ Binance devolvió lista vacía de klines")
            return None

        kline      = klines[0]
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
        logger.error(f"[SCANNER] ❌ Timeout ({TIMEOUT}s) — Binance klines")
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[SCANNER] ❌ Conexión fallida con Binance: {e}")
    except requests.exceptions.HTTPError as e:
        logger.error(f"[SCANNER] ❌ HTTP error Binance klines: {e}")
    except (IndexError, KeyError, ValueError) as e:
        logger.error(f"[SCANNER] ❌ Error parseando respuesta Binance: {type(e).__name__}: {e}")
    except Exception as e:
        logger.error(f"[SCANNER] ❌ Error inesperado: {type(e).__name__}: {e}")

    return None


if __name__ == "__main__":
    import logging as _log
    _log.basicConfig(
        level=_log.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    market = get_active_market()
    slug   = market.get("slug") if market else None
    target = get_open_1h_binance(slug=slug)
    print(f"\nMercado : {market.get('question') if market else 'No encontrado'}")
    print(f"Slug    : {slug or '—'}")
    print(f"Target  : ${target:,.2f}" if target else "Target  : No disponible")
