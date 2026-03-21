"""
market_scanner.py — Descubrimiento de mercado activo y Price to Beat

v6.2 — FIX SLUG AÑO:
  Polymarket cambió el formato del slug para incluir el año:
    Antes : bitcoin-up-or-down-march-16-12pm-et
    Ahora : bitcoin-up-or-down-march-16-2026-12pm-et
  - _build_slugs()          → añade {et_open.year} entre día y hora
  - _slug_to_end_ms()       → lee año del slug (month+2), hora en month+3
  - _slug_to_candle_start_ms() → ídem

v6.1 — FALLBACK LISTA ACTIVA:
  Gamma devuelve [] para ?slug= aunque el slug sea correcto.
  Fallback: busca en lista de mercados activos filtrada por slug.

v6.0 — PRECIOS LIVE CLOB:
  Precios siempre desde CLOB midpoint; Gamma solo como fallback.

v5.0 — TOKENS REBUILD:
  Si Gamma devuelve tokens:[] vacío, se reconstruyen desde clobTokenIds.

v4.0 — BINANCE FALLBACK:
  Kraken OHLC como fuente alternativa cuando Binance está bloqueado en Railway.
"""
import json
import logging
import requests
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint"
BINANCE_KLINE = "https://api.binance.com/api/v3/klines"
KRAKEN_OHLC   = "https://api.kraken.com/0/public/OHLC"
TIMEOUT       = 10

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]

_last_slug = None


# ── DST helper ────────────────────────────────────────────────────────────────

def _is_dst(utc_dt: datetime) -> bool:
    year      = utc_dt.year
    march     = datetime(year, 3, 1, tzinfo=timezone.utc)
    dst_start = datetime(year, 3, 8 + (6 - march.weekday()) % 7, tzinfo=timezone.utc)
    nov       = datetime(year, 11, 1, tzinfo=timezone.utc)
    dst_end   = datetime(year, 11, 1 + (6 - nov.weekday()) % 7, tzinfo=timezone.utc)
    return dst_start <= utc_dt < dst_end


def _to_et(utc_dt: datetime) -> datetime:
    offset_h = 4 if _is_dst(utc_dt) else 5
    return utc_dt.replace(tzinfo=None) - timedelta(hours=offset_h)


# ── Slug builders ─────────────────────────────────────────────────────────────

def _format_hour_12(h24: int) -> str:
    if h24 == 0:  return "12am"
    if h24 == 12: return "12pm"
    return f"{h24}am" if h24 < 12 else f"{h24 - 12}pm"


def _build_slugs(now: datetime | None = None) -> list[str]:
    """
    Genera slugs candidatos para el mercado activo.
    FIX v6.2: slug incluye año → bitcoin-up-or-down-{month}-{day}-{year}-{hour}-et
    """
    if now is None:
        now = datetime.now(timezone.utc)

    candle_open_now = now.replace(minute=0, second=0, microsecond=0)
    slugs = []

    for offset in [0, -1, 1]:
        candle_open = candle_open_now + timedelta(hours=offset)
        et_open     = _to_et(candle_open)

        slug = (
            f"bitcoin-up-or-down-"
            f"{MONTHS[et_open.month - 1]}-{et_open.day}-"
            f"{et_open.year}-"                        # ← FIX v6.2
            f"{_format_hour_12(et_open.hour)}-et"
        )
        if slug not in slugs:
            slugs.append(slug)

    logger.debug(f"[SCANNER] Slugs candidatos: {slugs}")
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
    Fallback: deriva el timestamp de CIERRE del mercado desde el slug.
    FIX v6.2: nuevo formato → month+1=día, month+2=año, month+3=hora
    """
    try:
        parts = slug.split("-")
        month_idx, month_part_idx = -1, -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx, month_part_idx = MONTHS.index(p), i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        year     = int(parts[month_part_idx + 2])   # ← FIX v6.2
        hour_str = parts[month_part_idx + 3]         # ← FIX v6.2 (era +2)

        if hour_str == "12am":        open_hour_et = 0
        elif hour_str == "12pm":      open_hour_et = 12
        elif hour_str.endswith("am"): open_hour_et = int(hour_str[:-2])
        elif hour_str.endswith("pm"): open_hour_et = int(hour_str[:-2]) + 12
        else: return None

        close_hour_et = (open_hour_et + 1) % 24
        close_day     = day + 1 if open_hour_et == 23 else day

        candidate = datetime(year, month_idx + 1, close_day, 12, 0, 0, tzinfo=timezone.utc)
        et_offset = 4 if _is_dst(candidate) else 5

        close_utc = datetime(
            year, month_idx + 1, close_day,
            close_hour_et + et_offset, 0, 0,
            tzinfo=timezone.utc,
        )
        return int(close_utc.timestamp() * 1000)
    except Exception:
        return None


# ── Helpers de tokens ─────────────────────────────────────────────────────────

def _fetch_live_price(token_id: str) -> float | None:
    """
    FIX v6: Obtiene el precio LIVE del token desde el CLOB API (midpoint).
    El midpoint es el precio justo entre el mejor bid y el mejor ask.
    Este es el precio real que Polymarket muestra en la UI.
    """
    try:
        r = requests.get(
            CLOB_MIDPOINT,
            params={"token_id": token_id},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        mid = r.json().get("mid")
        if mid is not None:
            return float(mid)
    except Exception as e:
        logger.debug(f"[SCANNER] CLOB midpoint error para token {str(token_id)[:16]}...: {e}")
    return None


def _enrich_token_prices(tokens: list) -> list:
    """
    FIX v6: Reemplaza los precios de Gamma (cacheados) por precios live del CLOB.
    Fallback: mantiene precio de Gamma si el CLOB no responde.
    """
    for t in tokens:
        token_id = t.get("token_id")
        if not token_id:
            continue
        live = _fetch_live_price(token_id)
        if live is not None:
            t["price"]        = live
            t["price_source"] = "clob"
        else:
            t["price_source"] = "gamma"
    return tokens


def _rebuild_tokens_from_clob(market_raw: dict) -> list:
    """
    FIX v6: Reconstruye tokens desde clobTokenIds cuando Gamma devuelve tokens:[].
    Índice 0 = YES (UP), índice 1 = NO (DOWN).
    """
    clob_raw = market_raw.get("clobTokenIds")
    if not clob_raw:
        return []

    try:
        clob_ids = json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
        if not isinstance(clob_ids, list) or len(clob_ids) < 2:
            logger.warning(f"[SCANNER] clobTokenIds inesperado: {clob_raw}")
            return []

        tokens = [
            {"outcome": "Yes", "token_id": clob_ids[0], "price": 0.5},
            {"outcome": "No",  "token_id": clob_ids[1], "price": 0.5},
        ]
        logger.warning(
            f"[SCANNER] ⚠ tokens[] vacío en Gamma API — reconstruidos desde clobTokenIds\n"
            f"           YES token_id: {str(clob_ids[0])[:16]}...\n"
            f"           NO  token_id: {str(clob_ids[1])[:16]}..."
        )
        return tokens
    except Exception as e:
        logger.error(f"[SCANNER] ❌ No se pudo parsear clobTokenIds: {e}")
        return []


# ── Fallback: búsqueda por lista activa (FIX v6.1) ───────────────────────────

def _find_market_in_active_list(slugs: list[str]) -> dict | None:
    """
    FIX v6.1: La Gamma API a veces devuelve [] para ?slug= aunque el slug sea correcto.
    Fallback: consulta la lista de mercados activos y filtra por slug coincidente.
    """
    slug_set = set(slugs)
    urls = [
        f"{GAMMA_API}?active=true&closed=false&limit=50&order=endDate&ascending=true",
        f"{GAMMA_API}?active=true&closed=false&limit=50&tag=bitcoin",
        f"{GAMMA_API}?active=true&closed=false&limit=100",
        f"{GAMMA_API}?active=true&closed=false&limit=300",
    ]

    for url in urls:
        try:
            r = requests.get(url, timeout=TIMEOUT)
            r.raise_for_status()
            markets = r.json()
            if not isinstance(markets, list):
                markets = markets.get("markets", [])

            for m in markets:
                m_slug = m.get("slug", "")
                if m_slug in slug_set:
                    logger.info(f"[SCANNER] ✅ Mercado encontrado via fallback lista activa — slug={m_slug}")
                    return m

        except Exception as e:
            logger.warning(f"[SCANNER] ⚠ Fallback lista activa error ({url}): {e}")

    return None


# ── Mercado activo ────────────────────────────────────────────────────────────

def get_active_market() -> dict | None:
    global _last_slug
    now   = datetime.now(timezone.utc)
    slugs = _build_slugs(now)
    logger.info(f"[SCANNER] Buscando mercado activo — slugs: {slugs}")

    raw_market = None
    found_slug = None

    # ── Intento 1: búsqueda directa por slug ─────────────────────────────────
    for slug in slugs:
        try:
            r = requests.get(GAMMA_API, params={"slug": slug}, timeout=TIMEOUT)
            logger.debug(f"[SCANNER] HTTP {r.status_code} — slug={slug}")
            r.raise_for_status()
            data = r.json()

            if not data:
                logger.debug(f"[SCANNER] Sin resultados para slug={slug}")
                continue

            raw_market = data[0]
            found_slug = slug
            break

        except requests.exceptions.Timeout:
            logger.warning(f"[SCANNER] ⚠ Timeout ({TIMEOUT}s) en slug={slug}")
        except requests.exceptions.ConnectionError as e:
            logger.error(f"[SCANNER] ❌ Error de conexión para slug={slug}: {e}")
        except requests.exceptions.HTTPError as e:
            logger.warning(f"[SCANNER] ⚠ HTTP {r.status_code} para slug={slug}: {e}")
        except Exception as e:
            logger.error(f"[SCANNER] ❌ Error inesperado en slug={slug}: {type(e).__name__}: {e}")

    # ── Intento 2: fallback por lista activa (FIX v6.1) ──────────────────────
    if raw_market is None:
        logger.warning("[SCANNER] ⚠ Slug search vacío — activando fallback por lista activa")
        raw_market = _find_market_in_active_list(slugs)
        if raw_market:
            found_slug = raw_market.get("slug", slugs[0])

    if raw_market is None:
        logger.warning(f"[SCANNER] ⚠ Ningún mercado encontrado — slugs probados: {slugs}")
        return None

    # ── Procesar el mercado encontrado ────────────────────────────────────────
    m        = raw_market
    slug     = found_slug
    question = m.get("question", "—")
    cond_id  = m.get("conditionId", m.get("condition_id", "—"))
    end_date = m.get("endDateIso", m.get("end_date_iso", m.get("endDate", "—")))
    tokens   = m.get("tokens", [])

    # FIX v5: fallback a clobTokenIds si tokens viene vacío
    if not tokens:
        tokens = _rebuild_tokens_from_clob(m)
        if tokens:
            m["tokens"] = tokens

    # FIX v6: enriquecer SIEMPRE con precios live del CLOB
    tokens = _enrich_token_prices(tokens)

    yes_p = next((t["price"] for t in tokens if t.get("outcome") == "Yes"), None)
    no_p  = next((t["price"] for t in tokens if t.get("outcome") == "No"),  None)

    end_ms = _parse_end_ms(m)
    if not end_ms:
        end_ms = _slug_to_end_ms(slug, now)
        if end_ms:
            logger.debug(f"[SCANNER] end_ms derivado del slug (fallback): {end_ms}")

    mins = max(0, (end_ms - int(now.timestamp() * 1000)) / 60_000) if end_ms else None

    if _last_slug is None:
        logger.info(f"[SCANNER] ✅ Mercado inicial detectado")
    elif _last_slug != slug:
        logger.info(
            f"[SCANNER] 🔄 CAMBIO DE SLUG:\n"
            f"           Anterior : {_last_slug}\n"
            f"           Nuevo    : {slug}"
        )
    _last_slug = slug

    sources = {t.get("outcome"): t.get("price_source", "?") for t in tokens}
    logger.info(
        f"[SCANNER] Mercado activo:\n"
        f"           Pregunta   : {question}\n"
        f"           Slug       : {slug}\n"
        f"           ConditionID: {cond_id}\n"
        f"           Cierre     : {end_date}\n"
        f"           YES price  : {yes_p:.4f} ({sources.get('Yes','?')})  "
        f"NO price: {no_p:.4f} ({sources.get('No','?')})"
    )

    return {
        "question":      question,
        "condition_id":  cond_id,
        "slug":          slug,
        "end_ms":        end_ms,
        "yes_price":     yes_p,
        "no_price":      no_p,
        "tokens":        tokens,
        "neg_risk":      m.get("neg_risk", False),
        "mins_to_close": round(mins, 2) if mins is not None else None,
    }


# ── Price to Beat ─────────────────────────────────────────────────────────────

def _slug_to_candle_start_ms(slug: str, now: datetime) -> int | None:
    """
    Parsea el slug para obtener el startTime UTC (ms) de la vela 1H.
    FIX v6.2: nuevo formato → month+1=día, month+2=año, month+3=hora
    """
    try:
        parts = slug.split("-")
        month_idx, month_part_idx = -1, -1
        for i, p in enumerate(parts):
            if p in MONTHS:
                month_idx, month_part_idx = MONTHS.index(p), i
                break
        if month_idx == -1:
            return None

        day      = int(parts[month_part_idx + 1])
        year     = int(parts[month_part_idx + 2])   # ← FIX v6.2
        hour_str = parts[month_part_idx + 3]         # ← FIX v6.2 (era +2)

        if hour_str == "12am":        open_hour_et = 0
        elif hour_str == "12pm":      open_hour_et = 12
        elif hour_str.endswith("am"): open_hour_et = int(hour_str[:-2])
        elif hour_str.endswith("pm"): open_hour_et = int(hour_str[:-2]) + 12
        else: return None

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


def _try_binance(slug: str | None, now: datetime) -> float | None:
    """Intenta obtener la vela 1H open desde Binance."""
    params: dict = {"symbol": "BTCUSDT", "interval": "1h", "limit": "1"}
    if slug:
        start_ms = _slug_to_candle_start_ms(slug, now)
        if start_ms:
            params["startTime"] = str(start_ms)
            logger.debug(f"[SCANNER] Binance startTime desde slug: {start_ms}")

    hosts = [
        "https://api.binance.com/api/v3/klines",
        "https://api1.binance.com/api/v3/klines",
        "https://api2.binance.com/api/v3/klines",
        "https://api3.binance.com/api/v3/klines",
    ]
    for host in hosts:
        try:
            r = requests.get(host, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            klines = r.json()
            if klines:
                open_price = float(klines[0][1])
                logger.info(f"[SCANNER] Binance 1H open: ${open_price:,.2f} ({host})")
                return open_price
        except Exception as e:
            logger.warning(f"[SCANNER] Binance no disponible ({host}): {e}")
    return None


def _try_kraken(now: datetime) -> float | None:
    """Fallback: obtiene la vela 1H open desde Kraken."""
    try:
        since = int(now.replace(minute=0, second=0, microsecond=0).timestamp())
        r = requests.get(
            KRAKEN_OHLC,
            params={"pair": "XBTUSD", "interval": 60, "since": since - 60},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("error"):
            logger.warning(f"[SCANNER] Kraken error: {data['error']}")
            return None

        result = data.get("result", {})
        pair_key = next((k for k in result if k != "last"), None)
        if not pair_key:
            return None

        candles = result[pair_key]
        if candles:
            open_price = float(candles[0][1])
            logger.info(f"[SCANNER] Kraken 1H open (fallback): ${open_price:,.2f}")
            return open_price
    except Exception as e:
        logger.warning(f"[SCANNER] Kraken no disponible: {e}")
    return None


def get_open_1h_binance(slug: str | None = None) -> float | None:
    """
    Obtiene el precio OPEN de la vela 1H actual de BTC.
    Intenta Binance primero (varios hosts), luego Kraken como fallback.
    """
    now = datetime.now(timezone.utc)

    price = _try_binance(slug, now)
    if price is not None:
        return price

    logger.warning("[SCANNER] Binance no disponible — intentando Kraken")
    price = _try_kraken(now)
    if price is not None:
        return price

    logger.error("[SCANNER] ❌ No se pudo obtener Price to Beat (Binance + Kraken fallidos)")
    return None


# Alias público — usado por command_handler para verificación CLOB
get_clob_price = _fetch_live_price
