"""
market_scanner.py  (raíz /bot/)
Detecta el mercado BTC Up/Down activo en Polymarket y obtiene el Price to Beat.

CORRECCIÓN: get_open_1h_binance() ahora usa limit=1 (no limit=2).
  Con limit=2 klines[0] = vela ANTERIOR cerrada (¡precio incorrecto!).
  Con limit=1 klines[0] = vela ACTUAL en curso  (correcto).
"""
import logging
import requests
from datetime import datetime, timezone

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
    from datetime import timedelta
    return utc_date + timedelta(hours=-4 if _is_dst(utc_date) else -5)


def _format_hour_12(h24: int) -> str:
    if h24 == 0:   return "12am"
    if h24 == 12:  return "12pm"
    return f"{h24}am" if h24 < 12 else f"{h24 - 12}pm"


def _build_slugs(now: datetime) -> list[str]:
    from datetime import timedelta
    slugs = []
    for offset in [0, -1, 1]:
        utc_d = now + timedelta(hours=offset)
        et_d  = _to_et(utc_d)
        slug  = (
            f"bitcoin-up-or-down-"
            f"{MONTHS[et_d.month - 1]}-{et_d.day}-"
            f"{_format_hour_12(et_d.hour)}-et"
        )
        if slug not in slugs:
            slugs.append(slug)
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

            m          = data[0]
            tokens     = m.get("tokens", [])
            yes_p      = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
            no_p       = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)
            end_ms     = _parse_end_ms(m)
            mins       = max(0, (end_ms - int(now.timestamp() * 1000)) / 60_000) if end_ms else None

            market = {
                "question":    m.get("question", "—"),
                "condition_id": m.get("conditionId", m.get("condition_id", "—")),
                "slug":        slug,
                "end_ms":      end_ms,
                "yes_price":   yes_p,
                "no_price":    no_p,
                "volume":      m.get("volume"),
                "liquidity":   m.get("liquidity"),
                "url":         f"https://polymarket.com/event/{slug}",
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

def get_open_1h_binance() -> float | None:
    """
    Devuelve el precio OPEN de la vela 1H ACTUAL de Binance (= Price to Beat).

    ⚠️  IMPORTANTE — por qué limit=1 y NO limit=2:
        Con limit=2 Binance devuelve en orden ASCENDENTE (la más antigua primero):
          klines[0] = vela ANTERIOR ya cerrada  → precio INCORRECTO
          klines[1] = vela ACTUAL en curso      → precio correcto
        Con limit=1 solo hay una entrada: la vela ACTUAL.
        Usar klines[0] con limit=2 devolvería el open de la hora anterior.
    """
    logger.info("[SCANNER] 🕯 Obteniendo vela 1H actual de Binance (Price to Beat)...")
    try:
        r = requests.get(
            BINANCE_KLINE,
            params={"symbol": "BTCUSDT", "interval": "1h", "limit": 1},  # ← limit=1, no 2
            timeout=TIMEOUT,
        )
        r.raise_for_status()

        kline      = r.json()[0]   # única entrada = vela actual en curso
        open_price = float(kline[1])
        high       = float(kline[2])
        low        = float(kline[3])
        close      = float(kline[4])
        open_ts    = datetime.fromtimestamp(kline[0] / 1000, tz=timezone.utc)
        close_ts   = datetime.fromtimestamp(kline[6] / 1000, tz=timezone.utc)

        now_utc    = datetime.now(timezone.utc)
        now_ms     = int(now_utc.timestamp() * 1000)
        close_ms   = int(kline[6])
        mins_left  = max(0, (close_ms - now_ms) / 60_000)
        mm, ss     = int(mins_left), int((mins_left % 1) * 60)

        # Validación: la vela debe corresponder a la hora UTC actual
        candle_hour = open_ts.hour
        current_hour = now_utc.hour
        if candle_hour != current_hour:
            logger.warning(
                f"[SCANNER] ⚠ La vela devuelta es de las {candle_hour:02d}h UTC "
                f"pero ahora son las {current_hour:02d}h UTC — posible desfase de Binance"
            )

        logger.info(_SEPARATOR)
        logger.info(f"[SCANNER] 🎯 PRICE TO BEAT (Binance 1H OPEN)")
        logger.info(f"[SCANNER]   Vela   : {open_ts.strftime('%H:%M UTC')} → {close_ts.strftime('%H:%M UTC')}")
        logger.info(f"[SCANNER]   Open   : ${open_price:>12,.2f}  ← TARGET OFICIAL")
        logger.info(f"[SCANNER]   High   : ${high:>12,.2f}")
        logger.info(f"[SCANNER]   Low    : ${low:>12,.2f}")
        logger.info(f"[SCANNER]   Close  : ${close:>12,.2f}  (precio actual de vela)")
        logger.info(f"[SCANNER]   Resta  : {mm:02d}:{ss:02d} para cerrar la vela")
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
    target = get_open_1h_binance()
    print(f"\nMercado : {market.get('question') if market else 'No encontrado'}")
    print(f"Target  : ${target:,.2f}" if target else "Target  : No disponible")
