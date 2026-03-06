"""
bot/market_scanner.py
Detecta el mercado BTC Up/Down activo en Polymarket y obtiene el Price to Beat.

FIX: Polymarket nombra cada mercado por la hora de CIERRE de la vela 1H (ET),
     NO por la hora de apertura. Ejemplo:
       · Vela 10:00–11:00 UTC = 5am–6am ET
       · Slug correcto: bitcoin-up-or-down-march-6-6am-et  (hora de CIERRE)
       · Bug anterior:  bitcoin-up-or-down-march-6-5am-et  (hora de APERTURA ❌)

FIX: get_open_1h_binance() usa limit=1 (no limit=2).
  Con limit=2 klines[0] = vela ANTERIOR cerrada (precio incorrecto).
  Con limit=1 klines[0] = vela ACTUAL en curso  (correcto).

CONSISTENCIA con /api/target:
  get_open_1h_binance() acepta slug opcional. Si se pasa, parsea la hora
  del mercado desde el slug y usa startTime en Binance para pedir
  la vela exacta correspondiente al mercado activo.
"""
import logging
import requests
from datetime import datetime, timedelta, timezone

logger    = logging.getLogger(__name__)
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

    ⚠️ CLAVE — Polymarket usa la hora de CIERRE de la vela 1H (ET) en el slug,
    NO la hora de apertura. Ejemplo a las 10:30 UTC (5:30am ET, vela 5am–6am ET):
      · La vela ABRE a las 10:00 UTC = 5am ET
      · La vela CIERRA a las 11:00 UTC = 6am ET
      · Slug del mercado: "bitcoin-up-or-down-march-6-6am-et"  ← hora de cierre
    """
    slugs = []
    for offset in [0, -1, 1]:
        candle_open_utc  = now + timedelta(hours=offset)
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
    Fallback: deriva el timestamp de cierre del mercado directamente desde el slug.
    Consistente con slugToEndMs() en app/api/market/route.js.

    El slug contiene la hora de CIERRE en ET (p.ej. "6am-et").
    Convertimos esa hora ET a UTC ms.
    """
    try:
        parts = slug.split("-")
        month_idx = -1
        month_part_idx = -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx = MONTHS.index(p)
                month_part_idx = i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        hour_str = parts[month_part_idx + 2]  # "6am", "12pm", etc.

        if hour_str == "12am":
            close_hour_et = 0
        elif hour_str == "12pm":
            close_hour_et = 12
        elif hour_str.endswith("am"):
            close_hour_et = int(hour_str[:-2])
        elif hour_str.endswith("pm"):
            close_hour_et = int(hour_str[:-2]) + 12
        else:
            return None

        year = now.year
        candidate = datetime(year, month_idx + 1, day, 12, 0, 0, tzinfo=timezone.utc)
        et_offset = 4 if _is_dst(candidate) else 5

        close_utc_ms = int(datetime(
            year, month_idx + 1, day,
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

    El slug contiene la hora de CIERRE en ET → apertura = cierre - 1h.
    """
    try:
        parts = slug.split("-")
        month_idx = -1
        month_part_idx = -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx = MONTHS.index(p)
                month_part_idx = i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        hour_str = parts[month_part_idx + 2]

        if hour_str == "12am":
            close_hour_et = 0
        elif hour_str == "12pm":
            close_hour_et = 12
        elif hour_str.endswith("am"):
            close_hour_et = int(hour_str[:-2])
        elif hour_str.endswith("pm"):
            close_hour_et = int(hour_str[:-2]) + 12
        else:
            return None

        # Apertura = cierre - 1h
        open_hour_et = (close_hour_et - 1) % 24
        day_for_open = day - 1 if open_hour_et > close_hour_et else day  # cruce medianoche

        year      = now.year
        candidate = datetime(year, month_idx + 1, day_for_open, 12, 0, 0, tzinfo=timezone.utc)
        et_offset = 4 if _is_dst(candidate) else 5

        start_utc = datetime(
            year, month_idx + 1, day_for_open,
            open_hour_et + et_offset, 0, 0,
            tzinfo=timezone.utc,
        )
        return int(start_utc.timestamp() * 1000)
    except Exception:
        return None


def get_open_1h_binance(slug: str | None = None) -> float | None:
    """
    Devuelve el precio OPEN de la vela 1H del mercado activo (= Price to Beat).

    ⚠️  Por qué limit=1 y NO limit=2:
        Con limit=2 Binance devuelve en orden ASCENDENTE (la más antigua primero):
          klines[0] = vela ANTERIOR ya cerrada  → precio INCORRECTO
          klines[1] = vela ACTUAL en curso      → precio correcto
        Con limit=1 solo hay una entrada: la vela ACTUAL.

    Si se pasa `slug`, se parsea la hora del mercado y se solicita la vela
    exacta a Binance usando startTime (más robusto en transiciones de hora).
    Consistente con /api/target?slug= en el front-end.
    """
    logger.info("[SCANNER] 🕯 Obteniendo vela 1H (Price to Beat)...")

    now         = datetime.now(timezone.utc)
    params: dict = {"symbol": "BTCUSDT", "interval": "1h", "limit": 1}
    method_used = "limit=1 (vela actual)"

    if slug:
        start_ms = _slug_to_candle_start_ms(slug, now)
        if start_ms:
            params["startTime"] = start_ms
            method_used = f"startTime={start_ms} (desde slug)"
            logger.debug(f"[SCANNER] Vela solicitada por slug: {slug} → startTime={start_ms}")

    try:
        r = requests.get(BINANCE_KLINE, params=params, timeout=TIMEOUT)
        r.raise_for_status()

        kline      = r.json()[0]
        open_price = float(kline[1])
        high       = float(kline[2])
        low        = float(kline[3])
        close      = float(kline[4])
        open_ts    = datetime.fromtimestamp(kline[0] / 1000, tz=timezone.utc)
        close_ts   = datetime.fromtimestamp(kline[6] / 1000, tz=timezone.utc)

        now_ms    = int(now.timestamp() * 1000)
        close_ms  = int(kline[6])
        mins_left = max(0, (close_ms - now_ms) / 60_000)
        mm, ss    = int(mins_left), int((mins_left % 1) * 60)

        # Verificación de hora (detección de desfases)
        candle_hour  = open_ts.hour
        current_hour = now.hour
        if candle_hour != current_hour:
            logger.warning(
                f"[SCANNER] ⚠ Vela devuelta: {candle_hour:02d}h UTC | "
                f"Hora actual: {current_hour:02d}h UTC — posible desfase"
            )

        logger.info(_SEPARATOR)
        logger.info(f"[SCANNER] 🎯 PRICE TO BEAT (Binance 1H OPEN) [{method_used}]")
        logger.info(f"[SCANNER]   Vela   : {open_ts.strftime('%H:%M UTC')} → {close_ts.strftime('%H:%M UTC')}")
        logger.info(f"[SCANNER]   Open   : ${open_price:>12,.2f}  ← TARGET OFICIAL")
        logger.info(f"[SCANNER]   High   : ${high:>12,.2f}")
        logger.info(f"[SCANNER]   Low    : ${low:>12,.2f}")
        logger.info(f"[SCANNER]   Close  : ${close:>12,.2f}  (precio actual de vela)")
        logger.info(f"[SCANNER]   Resta  : {mm:02d}:{ss:02d} para cerrar la vela")
        if slug:
            logger.info(f"[SCANNER]   Slug   : {slug}")
        logger.info(_SEPARATOR)
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
