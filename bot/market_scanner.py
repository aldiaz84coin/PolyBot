"""
bot/market_scanner.py
Detecta el mercado BTC Up/Down activo en Polymarket y obtiene el Price to Beat.

FIX v3 (BUG SLUG HORA):
  Polymarket nombra cada mercado por la hora de APERTURA de la vela 1H (ET).
  Ejemplo a las 7:30am ET (= 11:30 UTC con EDT):
    · Vela activa   : 11:00–12:00 UTC = 7am–8am ET
    · Slug correcto : bitcoin-up-or-down-march-6-7am-et   ← hora APERTURA ✓
    · Bug anterior  : bitcoin-up-or-down-march-6-8am-et   ← hora CIERRE ❌

  La corrección es doble:
    1. Truncar `now` a la hora UTC actual (candle open boundary).
    2. Convertir ese candle open UTC → ET → usar su hora para el slug.
  El código anterior añadía +1h antes de convertir, cogiendo la hora de cierre.

FIX previo mantenido:
  get_open_1h_binance() usa limit=1 → klines[0] = vela actual en curso.
"""
import logging
import requests
from datetime import datetime, timedelta, timezone

logger     = logging.getLogger(__name__)
_SEPARATOR = "─" * 60

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
TIMEOUT       = 8

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]


# ── Helpers de timezone ET ────────────────────────────────────────────────────

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


def _build_slugs(now: datetime) -> list[str]:
    """
    Genera los slugs candidatos para el mercado activo.

    ⚠️ CLAVE — Polymarket usa la hora de APERTURA de la vela 1H (ET) en el slug.
    Ejemplo a las 7:30am ET (vela 7am–8am ET):
      · Slug correcto: bitcoin-up-or-down-march-6-7am-et  ← hora APERTURA

    Algoritmo:
      1. Truncar `now` a la hora UTC (= inicio de la vela actual).
      2. Convertir ese instante a ET → hora ET de apertura → usarla para el slug.
      3. Generar también ±1h como candidatos de respaldo.
    """
    # Truncar al inicio de la vela actual (candle open boundary)
    candle_open_now = now.replace(minute=0, second=0, microsecond=0)
    slugs = []

    for offset in [0, -1, 1]:
        candle_open = candle_open_now + timedelta(hours=offset)
        et_open     = _to_et(candle_open)

        slug = (
            f"bitcoin-up-or-down-"
            f"{MONTHS[et_open.month - 1]}-{et_open.day}-"
            f"{_format_hour_12(et_open.hour)}-et"
        )
        if slug not in slugs:
            slugs.append(slug)

    logger.debug(f"[SCANNER] Slugs candidatos (hora apertura ET): {slugs}")
    return slugs


def _parse_end_ms(raw: dict) -> int | None:
    candidate = (
        raw.get("endDateIso")   or raw.get("end_date_iso") or
        raw.get("endDate")      or raw.get("end_date")     or
        raw.get("closeTime")    or raw.get("close_time")
    )
    if candidate:
        if isinstance(candidate, (int, float)):
            return int(candidate * 1000 if candidate < 2e10 else candidate)
        try:
            return int(datetime.fromisoformat(
                candidate.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            pass
    return None


def _slug_to_end_ms(slug: str, now: datetime) -> int | None:
    """
    Fallback: deriva el timestamp de CIERRE del mercado directamente desde el slug.

    ⚠️ El slug contiene la hora de APERTURA en ET.
    Hora de cierre = hora de apertura + 1h.
    """
    try:
        parts = slug.split("-")
        month_idx     = -1
        month_part_idx = -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx      = MONTHS.index(p)
                month_part_idx = i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        hour_str = parts[month_part_idx + 2]  # "7am", "12pm", etc.

        # La hora del slug = hora de APERTURA en ET
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

        # Cierre = apertura + 1h
        close_hour_et = (open_hour_et + 1) % 24
        close_day     = day + 1 if open_hour_et == 23 else day  # cruce medianoche

        year      = now.year
        candidate = datetime(year, month_idx + 1, close_day, 12, 0, 0, tzinfo=timezone.utc)
        et_offset = 4 if _is_dst(candidate) else 5

        close_utc_ms = int(datetime(
            year, month_idx + 1, close_day,
            close_hour_et + et_offset, 0, 0,
            tzinfo=timezone.utc,
        ).timestamp() * 1000)

        # Sanity: debe estar en un rango razonable (±2h de ahora)
        diff = close_utc_ms - int(now.timestamp() * 1000)
        if diff < -7_200_000 or diff > 7_200_000:
            return None

        return close_utc_ms
    except Exception:
        return None


# ── Mercado activo ─────────────────────────────────────────────────────────────

def get_active_market() -> dict | None:
    now   = datetime.now(timezone.utc)
    slugs = _build_slugs(now)
    logger.info(f"[SCANNER] Buscando mercado activo — slugs: {slugs}")

    for slug in slugs:
        try:
            r = requests.get(GAMMA_API, params={"slug": slug}, timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            if not data:
                continue

            m      = data[0]
            tokens = m.get("tokens", [])
            yes_p  = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
            no_p   = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)

            # end_ms: primero desde Polymarket, fallback desde slug
            end_ms = _parse_end_ms(m)
            if not end_ms:
                end_ms = _slug_to_end_ms(slug, now)
                if end_ms:
                    logger.debug(f"[SCANNER] end_ms derivado del slug (fallback): {end_ms}")

            mins = max(0, (end_ms - int(now.timestamp() * 1000)) / 60_000) if end_ms else None

            market = {
                "question":     m.get("question", "—"),
                "condition_id": m.get("conditionId", m.get("condition_id", "—")),
                "slug":         slug,
                "end_ms":       end_ms,
                "yes_price":    yes_p,
                "no_price":     no_p,
                "volume":       m.get("volume"),
                "liquidity":    m.get("liquidity"),
                "url":          f"https://polymarket.com/event/{slug}",
            }

            logger.info(_SEPARATOR)
            logger.info(f"[SCANNER] ✅ Mercado encontrado: {market['question']}")
            if mins is not None:
                mm, ss = int(mins), int((mins % 1) * 60)
                logger.info(f"[SCANNER]   Cierre : {mm:02d}:{ss:02d}  ({mins:.1f} min)")
            if yes_p: logger.info(f"[SCANNER]   YES    : ${yes_p:.4f}  (▲ UP  {yes_p*100:.1f}%)")
            if no_p:  logger.info(f"[SCANNER]   NO     : ${no_p:.4f}  (▼ DOWN {no_p*100:.1f}%)")
            logger.info(_SEPARATOR)
            return market

        except Exception as e:
            logger.debug(f"[SCANNER] slug={slug} error: {e}")
            continue

    logger.warning("[SCANNER] ⚠ No se encontró mercado activo")
    return None


# ── Price to Beat ──────────────────────────────────────────────────────────────

def _slug_to_candle_start_ms(slug: str, now: datetime) -> int | None:
    """
    Parsea el slug para obtener el startTime UTC (ms) de la vela 1H del mercado.
    Consistente con parseCandleStartFromSlug() en app/api/target/route.js.

    ⚠️ El slug contiene la hora de APERTURA en ET → esa es directamente la hora de start.
    """
    try:
        parts = slug.split("-")
        month_idx     = -1
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
