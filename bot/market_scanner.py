"""
market_scanner.py — Detecta el mercado BTC Up/Down activo en Polymarket.

Sincronizado con app/api/market/route.js:
  - Slug formato: bitcoin-up-or-down-{month}-{day}-{hour}-et
  - Timezone ET con DST correcto (EEUU)
  - 3 estrategias de fallback: slug_et → upcoming_btc → tag_bitcoin
  - Obtiene Price to Beat desde Binance 1H open
"""
import logging
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
TIMEOUT       = 8

_SEPARATOR = "─" * 60

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]


# ── Helpers de timezone ET ────────────────────────────────────────────────────

def _is_dst(utc_date: datetime) -> bool:
    """DST en EEUU: 2º domingo de marzo → 1º domingo de noviembre."""
    year = utc_date.year
    march = datetime(year, 3, 1, tzinfo=timezone.utc)
    dst_start = datetime(year, 3, 8 + (7 - march.weekday() - 1) % 7, tzinfo=timezone.utc)
    nov = datetime(year, 11, 1, tzinfo=timezone.utc)
    dst_end = datetime(year, 11, 1 + (7 - nov.weekday() - 1) % 7, tzinfo=timezone.utc)
    return dst_start <= utc_date < dst_end


def _to_et(utc_date: datetime) -> datetime:
    offset_h = -4 if _is_dst(utc_date) else -5
    from datetime import timedelta
    return utc_date + timedelta(hours=offset_h)


def _format_hour_12(h24: int) -> str:
    if h24 == 0:  return "12am"
    if h24 == 12: return "12pm"
    return f"{h24}am" if h24 < 12 else f"{h24 - 12}pm"


def _build_slugs(now: datetime) -> list[str]:
    """
    Genera slugs para la hora actual ±1h (igual que el frontend).
    Formato: bitcoin-up-or-down-{month}-{day}-{hour}-et
    """
    from datetime import timedelta
    slugs = []
    for offset in [0, -1, 1]:
        utc_d = now + timedelta(hours=offset)
        et_d  = _to_et(utc_d)
        month = MONTHS[et_d.month - 1]
        day   = et_d.day
        hour  = _format_hour_12(et_d.hour)
        slug  = f"bitcoin-up-or-down-{month}-{day}-{hour}-et"
        if slug not in slugs:
            slugs.append(slug)
    return slugs


# ── Parseo robusto de end_date ────────────────────────────────────────────────

def _parse_end_ms(raw: dict) -> int | None:
    candidate = (
        raw.get("endDateIso")   or
        raw.get("end_date_iso") or
        raw.get("endDate")      or
        raw.get("end_date")     or
        raw.get("closeTime")    or
        raw.get("close_time")
    )
    if candidate:
        if isinstance(candidate, (int, float)):
            return int(candidate * 1000 if candidate < 2e10 else candidate)
        try:
            ms = int(datetime.fromisoformat(
                candidate.replace("Z", "+00:00")
            ).timestamp() * 1000)
            if ms > int(datetime.now(timezone.utc).timestamp() * 1000):
                return ms
        except Exception:
            pass
    # Fallback: fin de la hora UTC actual
    now = datetime.now(timezone.utc)
    from datetime import timedelta
    end = datetime(now.year, now.month, now.day, now.hour, 0, 0, tzinfo=timezone.utc) + timedelta(hours=1)
    return int(end.timestamp() * 1000)


def _normalize_market(raw: dict) -> dict:
    end_ms     = _parse_end_ms(raw)
    now_ms     = int(datetime.now(timezone.utc).timestamp() * 1000)
    mins_left  = max(0, (end_ms - now_ms) / 60_000)
    tokens     = raw.get("tokens", [])
    yes_token  = next((t for t in tokens if t.get("outcome") == "Yes"), tokens[0] if tokens else None)
    no_token   = next((t for t in tokens if t.get("outcome") == "No"),  tokens[1] if len(tokens) > 1 else None)

    return {
        "slug":          raw.get("slug"),
        "condition_id":  raw.get("conditionId") or raw.get("condition_id"),
        "question":      raw.get("question") or raw.get("title"),
        "end_ms":        end_ms,
        "end_date_iso":  datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat(),
        "mins_to_close": mins_left,
        "tokens":        tokens,
        "volume":        float(raw["volume"])    if raw.get("volume")    else None,
        "liquidity":     float(raw["liquidity"]) if raw.get("liquidity") else None,
        "url":           f"https://polymarket.com/event/{raw['slug']}" if raw.get("slug") else None,
    }


# ── Estrategias de búsqueda (mismas 3 que el frontend) ───────────────────────

def _try_get(url: str, params: dict | None = None) -> list | dict | None:
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT)
        if not r.ok:
            return None
        return r.json()
    except Exception:
        return None


def _strategy_slug(slugs: list[str]) -> dict | None:
    """Busca por slug exacto ET (estrategia 1)."""
    for slug in slugs:
        data = _try_get(GAMMA_API, {"slug": slug})
        if isinstance(data, list) and data:
            logger.info(f"[SCANNER] ✅ Estrategia slug_et → encontrado: {slug}")
            return data[0]
    return None


def _strategy_upcoming() -> dict | None:
    """Busca entre los próximos mercados activos (estrategia 2)."""
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for limit in [50, 100]:
        data = _try_get(GAMMA_API, {
            "active": "true", "closed": "false",
            "limit": limit, "order": "endDate", "ascending": "true",
        })
        items = data if isinstance(data, list) else (data or {}).get("markets", [])
        for m in items:
            end_iso = m.get("endDateIso") or m.get("end_date_iso") or m.get("endDate")
            if not end_iso:
                continue
            try:
                end_ms = int(datetime.fromisoformat(
                    end_iso.replace("Z", "+00:00")
                ).timestamp() * 1000)
            except Exception:
                continue
            mins_left = (end_ms - now_ms) / 60_000
            q = (m.get("question") or m.get("title") or m.get("slug") or "").lower()
            if 0 < mins_left <= 62 and (
                "bitcoin" in q or "btc" in q
            ) and (
                "higher" in q or "lower" in q or "up" in q or "down" in q
            ):
                logger.info(f"[SCANNER] ✅ Estrategia upcoming_btc → {m.get('slug')}")
                return m
    return None


def _strategy_tag() -> dict | None:
    """Busca por tag bitcoin (estrategia 3)."""
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    data   = _try_get(GAMMA_API, {"tag": "bitcoin", "active": "true", "closed": "false", "limit": 50})
    items  = data if isinstance(data, list) else (data or {}).get("markets", [])
    candidates = []
    for m in items:
        end_iso = m.get("endDateIso") or m.get("end_date_iso") or m.get("endDate")
        if not end_iso:
            continue
        try:
            end_ms = int(datetime.fromisoformat(
                end_iso.replace("Z", "+00:00")
            ).timestamp() * 1000)
        except Exception:
            continue
        mins_left = (end_ms - now_ms) / 60_000
        q = (m.get("question") or m.get("title") or m.get("slug") or "").lower()
        if 0 < mins_left <= 62 and (
            "higher" in q or "lower" in q or "up" in q or "down" in q
        ):
            candidates.append((mins_left, m))
    if candidates:
        candidates.sort(key=lambda x: x[0])
        best = candidates[0][1]
        logger.info(f"[SCANNER] ✅ Estrategia tag_bitcoin → {best.get('slug')}")
        return best
    return None


# ── API pública ───────────────────────────────────────────────────────────────

def get_active_market() -> dict | None:
    """
    Devuelve el mercado BTC Up/Down activo normalizado, o None.
    Idéntica lógica a app/api/market/route.js.
    """
    now   = datetime.now(timezone.utc)
    slugs = _build_slugs(now)
    et_now = _to_et(now)
    dst_label = "EDT (UTC-4)" if _is_dst(now) else "EST (UTC-5)"

    logger.info(_SEPARATOR)
    logger.info(f"[SCANNER] 🔍 Buscando mercado activo en Polymarket")
    logger.info(f"[SCANNER] Hora UTC : {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(f"[SCANNER] Hora ET  : {et_now.strftime('%Y-%m-%d %H:%M:%S')} {dst_label}")
    logger.info(f"[SCANNER] Slugs    : {slugs}")

    strategies = [
        ("slug_et_format", lambda: _strategy_slug(slugs)),
        ("upcoming_btc",   _strategy_upcoming),
        ("tag_bitcoin",    _strategy_tag),
    ]

    raw = None
    used_strategy = None
    for name, fn in strategies:
        logger.debug(f"[SCANNER] Probando estrategia: {name}")
        try:
            raw = fn()
        except Exception as e:
            logger.warning(f"[SCANNER] ⚠ Estrategia {name} falló: {e}")
            raw = None
        if raw:
            used_strategy = name
            break

    if not raw:
        logger.warning(
            f"[SCANNER] ⚠ Ninguna estrategia encontró mercado activo\n"
            f"[SCANNER]   Slugs probados  : {slugs}\n"
            f"[SCANNER]   Causa habitual  : mercado no creado aún o Polymarket API caída\n"
            f"[SCANNER]   Acción          : el bot esperará y reintentará en el próximo ciclo"
        )
        return None

    market = _normalize_market(raw)

    mins = market["mins_to_close"]
    mm   = int(mins)
    ss   = int((mins % 1) * 60)
    tokens = market["tokens"]
    yes_p  = next((float(t["price"]) for t in tokens if t.get("outcome") == "Yes"), None)
    no_p   = next((float(t["price"]) for t in tokens if t.get("outcome") == "No"),  None)

    logger.info(_SEPARATOR)
    logger.info(f"[SCANNER] ✅ MERCADO ACTIVO ENCONTRADO")
    logger.info(f"[SCANNER]   Estrategia   : {used_strategy}")
    logger.info(f"[SCANNER]   Pregunta     : {market['question']}")
    logger.info(f"[SCANNER]   Slug         : {market['slug']}")
    logger.info(f"[SCANNER]   Condition ID : {market['condition_id']}")
    logger.info(f"[SCANNER]   Cierre UTC   : {market['end_date_iso']}")
    logger.info(f"[SCANNER]   Tiempo rest. : {mm:02d}:{ss:02d}  ({mins:.1f} min)")
    if yes_p is not None:
        logger.info(f"[SCANNER]   Token YES    : ${yes_p:.4f}  → prob. {yes_p*100:.1f}%  (▲ UP)")
    if no_p is not None:
        logger.info(f"[SCANNER]   Token NO     : ${no_p:.4f}  → prob. {no_p*100:.1f}%  (▼ DOWN)")
    if market["volume"] is not None:
        logger.info(f"[SCANNER]   Volumen      : ${market['volume']:,.0f}")
    if market["liquidity"] is not None:
        logger.info(f"[SCANNER]   Liquidez     : ${market['liquidity']:,.0f}")
    if market["url"]:
        logger.info(f"[SCANNER]   URL          : {market['url']}")
    logger.info(_SEPARATOR)

    return market


def get_open_1h_binance() -> float | None:
    """
    Obtiene el precio OPEN de la vela 1H actual de Binance (= Price to Beat).
    Sincronizado con app/api/target/route.js.
    """
    logger.info("[SCANNER] 🕯 Obteniendo vela 1H de Binance (Price to Beat)...")
    try:
        r = requests.get(
            BINANCE_KLINE,
            params={"symbol": "BTCUSDT", "interval": "1h", "limit": 2},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        kline      = r.json()[0]
        open_price = float(kline[1])
        high       = float(kline[2])
        low        = float(kline[3])
        close      = float(kline[4])
        open_ts    = datetime.fromtimestamp(kline[0] / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC")
        close_ts   = datetime.fromtimestamp(kline[6] / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC")
        now_ms     = int(datetime.now(timezone.utc).timestamp() * 1000)
        close_ms   = int(kline[6])
        mins_left  = max(0, (close_ms - now_ms) / 60_000)
        mm, ss     = int(mins_left), int((mins_left % 1) * 60)

        logger.info(
            f"[SCANNER] 🎯 PRICE TO BEAT (Binance 1H OPEN)\n"
            f"[SCANNER]   Open  : ${open_price:>12,.2f}  ← TARGET OFICIAL\n"
            f"[SCANNER]   High  : ${high:>12,.2f}\n"
            f"[SCANNER]   Low   : ${low:>12,.2f}\n"
            f"[SCANNER]   Close : ${close:>12,.2f}  (precio actual de vela)\n"
            f"[SCANNER]   Vela  : {open_ts} → {close_ts}\n"
            f"[SCANNER]   Resta : {mm:02d}:{ss:02d} para cerrar la vela"
        )
        return open_price

    except requests.exceptions.Timeout:
        logger.error(f"[SCANNER] ❌ Timeout ({TIMEOUT}s) obteniendo vela 1H de Binance")
    except requests.exceptions.ConnectionError as e:
        logger.error(f"[SCANNER] ❌ Error de conexión con Binance: {e}")
    except requests.exceptions.HTTPError as e:
        logger.error(f"[SCANNER] ❌ HTTP {r.status_code} de Binance klines: {e}")
    except (IndexError, KeyError, ValueError) as e:
        logger.error(f"[SCANNER] ❌ Error parseando respuesta Binance: {type(e).__name__}: {e}")
    except Exception as e:
        logger.error(f"[SCANNER] ❌ Error inesperado: {type(e).__name__}: {e}")

    return None


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    market = get_active_market()
    target = get_open_1h_binance()
    print(f"\nMercado : {market.get('question') if market else 'No encontrado'}")
    print(f"Target  : ${target:,.2f}" if target else "Target  : No disponible")
