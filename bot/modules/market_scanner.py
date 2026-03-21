"""
market_scanner.py — Descubrimiento de mercado activo y Price to Beat

v7.0 — DATALAB (cero llamadas nuevas a APIs):
  _try_binance() renombrado a _try_binance_full() → devuelve dict completo
  con open, high, low, close, volume_btc, volume_usdt, trades_count, open_time_ms.
  get_open_1h_binance() extrae solo open_price del dict (compatibilidad total).
  get_1h_candle_full() expone el dict completo para que monitor.py lo persista.
  La misma única llamada por hora que antes — no hay llamadas nuevas.

v6.2 — FIX SLUG AÑO:
  Polymarket cambió el formato del slug para incluir el año:
    Antes : bitcoin-up-or-down-march-16-12pm-et
    Ahora : bitcoin-up-or-down-march-16-2026-12pm-et
  - _build_slugs()          → añade {et_open.year} entre día y hora
  - _slug_to_end_ms()       → lee año del slug (month+2), hora en month+3
  - _slug_to_candle_start_ms() → ídem

v6.1 — FALLBACK LISTA ACTIVA
v6.0 — PRECIOS LIVE CLOB
v5.0 — TOKENS REBUILD
v4.0 — BINANCE FALLBACK (Kraken como alternativa)

Destino: bot/modules/market_scanner.py
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
    Prueba la hora actual y las adyacentes (+1/-1) para mayor robustez.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    candle_open_now = now.replace(minute=0, second=0, microsecond=0)
    slugs = []

    for offset in [0, -1, 1]:
        candle_open = candle_open_now + timedelta(hours=offset)
        et          = _to_et(candle_open)
        slug = "-".join([
            "bitcoin-up-or-down",
            MONTHS[et.month - 1],
            str(et.day),
            str(et.year),
            _format_hour_12(et.hour),
            "et",
        ])
        if slug not in slugs:
            slugs.append(slug)

    return slugs


# ── Gamma API helpers ─────────────────────────────────────────────────────────

def _slug_to_end_ms(slug: str, now: datetime) -> int | None:
    """
    Parsea el slug para obtener el endTime UTC (ms) de la vela 1H.
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
        year     = int(parts[month_part_idx + 2])
        hour_str = parts[month_part_idx + 3]

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


def _parse_end_ms(raw: dict) -> int | None:
    candidate = (
        raw.get("endDateIso") or raw.get("end_date_iso") or
        raw.get("endDate")    or raw.get("end_date")     or
        raw.get("closeTime")  or raw.get("close_time")   or None
    )
    if not candidate:
        return None
    if isinstance(candidate, (int, float)):
        return int(candidate) if candidate > 2e10 else int(candidate * 1000)
    try:
        return int(datetime.fromisoformat(str(candidate).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


# ── CLOB price helpers ────────────────────────────────────────────────────────

def _fetch_live_price(token_id: str) -> float | None:
    """
    Obtiene el precio LIVE del token desde el CLOB API (midpoint).
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
    Reemplaza los precios de Gamma (cacheados) por precios live del CLOB.
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
    Reconstruye tokens desde clobTokenIds cuando Gamma devuelve tokens:[].
    Índice 0 = YES (UP), índice 1 = NO (DOWN).
    """
    ids = market_raw.get("clobTokenIds") or market_raw.get("clob_token_ids") or []
    if not ids:
        return []
    tokens = [{"outcome": "Yes", "token_id": ids[0], "price": None, "price_source": "none"}]
    if len(ids) > 1:
        tokens.append({"outcome": "No", "token_id": ids[1], "price": None, "price_source": "none"})
    return tokens


# ── Gamma market fetch ────────────────────────────────────────────────────────

def get_active_market(cfg: dict | None = None) -> dict | None:
    """
    Descubre el mercado BTC Up/Down activo en Polymarket.
    Intenta con slug directo primero, luego búsqueda en lista activa.
    Retorna dict enriquecido con precios CLOB live o None si no encuentra.
    """
    global _last_slug
    now    = datetime.now(timezone.utc)
    slugs  = _build_slugs(now)

    raw_market = None
    found_slug = None

    # Intento 1: slug directo
    for slug in slugs:
        try:
            r = requests.get(
                GAMMA_API,
                params={"slug": slug},
                timeout=TIMEOUT,
            )
            r.raise_for_status()
            data = r.json()
            markets = data if isinstance(data, list) else data.get("markets", [])
            if markets:
                raw_market = markets[0]
                found_slug = slug
                break
        except Exception as e:
            logger.debug(f"[SCANNER] Gamma slug {slug}: {e}")

    # Intento 2: lista activa (fallback v6.1)
    if not raw_market:
        try:
            r = requests.get(
                GAMMA_API,
                params={"active": "true", "closed": "false", "limit": "100"},
                timeout=TIMEOUT,
            )
            r.raise_for_status()
            data    = r.json()
            markets = data if isinstance(data, list) else data.get("markets", [])
            for m in markets:
                s = m.get("slug", "")
                if "bitcoin-up-or-down" in s:
                    for slug in slugs:
                        if slug in s or s == slug:
                            raw_market = m
                            found_slug = slug
                            break
                if raw_market:
                    break
        except Exception as e:
            logger.warning(f"[SCANNER] Gamma lista activa: {e}")

    if not raw_market:
        logger.debug("[SCANNER] No se encontró mercado BTC activo")
        return None

    # ── Mercado encontrado ──────────────────────────────────────────────────
    m        = raw_market
    slug     = found_slug
    question = m.get("question", "—")
    cond_id  = m.get("conditionId", m.get("condition_id", "—"))
    end_date = m.get("endDateIso", m.get("end_date_iso", m.get("endDate", "—")))
    tokens   = m.get("tokens", [])

    if not tokens:
        tokens = _rebuild_tokens_from_clob(m)
        if tokens:
            m["tokens"] = tokens

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


# ── Price to Beat (Binance klines) ────────────────────────────────────────────

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
        year     = int(parts[month_part_idx + 2])
        hour_str = parts[month_part_idx + 3]

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


def _try_binance_full(slug: str | None, now: datetime) -> dict | None:
    """
    v7.0: Obtiene el dict COMPLETO de la vela 1H actual desde Binance.

    Formato del kline de Binance (índices):
      [0]  open_time_ms          [1]  open_price
      [2]  high_price            [3]  low_price
      [4]  close_price           [5]  volume_btc
      [6]  close_time_ms         [7]  volume_usdt (quote_asset_volume)
      [8]  trades_count          [9]  taker_buy_base_volume
      [10] taker_buy_quote_volume [11] ignore

    Retorna dict con todos los campos o None si todos los hosts fallan.
    """
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
            if not klines:
                continue
            k = klines[0]
            candle = {
                "open_price":    float(k[1]),
                "high_price":    float(k[2]),
                "low_price":     float(k[3]),
                "close_price":   float(k[4]),
                "volume_btc":    float(k[5]),
                "volume_usdt":   float(k[7]),
                "trades_count":  int(k[8]),
                "open_time_ms":  int(k[0]),
            }
            logger.info(
                f"[SCANNER] Binance 1H — "
                f"open=${candle['open_price']:,.2f}  "
                f"high=${candle['high_price']:,.2f}  "
                f"low=${candle['low_price']:,.2f}  "
                f"vol={candle['volume_btc']:.1f}BTC  "
                f"trades={candle['trades_count']:,}  ({host})"
            )
            return candle
        except Exception as e:
            logger.warning(f"[SCANNER] Binance no disponible ({host}): {e}")
    return None


def _try_kraken(now: datetime) -> float | None:
    """Fallback: obtiene la vela 1H open desde Kraken (solo open price)."""
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

        result   = data.get("result", {})
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
    Obtiene el precio OPEN de la vela 1H actual de BTC (solo float).
    Compatibilidad total con código existente.
    Internamente usa _try_binance_full() y extrae open_price.

    Para obtener el dict completo (volumen, trades, etc.) usar get_1h_candle_full().
    """
    now    = datetime.now(timezone.utc)
    candle = _try_binance_full(slug, now)
    if candle:
        return candle["open_price"]

    logger.warning("[SCANNER] Binance no disponible — intentando Kraken")
    price = _try_kraken(now)
    if price:
        return price

    logger.error("[SCANNER] ❌ No se pudo obtener Price to Beat (Binance + Kraken fallidos)")
    return None


def get_1h_candle_full(slug: str | None = None) -> dict | None:
    """
    v7.0 DataLab: Devuelve el dict COMPLETO de la vela 1H actual.

    Misma llamada que get_open_1h_binance() — cero llamadas adicionales.
    Usar en monitor.py al inicio de cada hora para persistir datos en Supabase.

    Campos del dict retornado:
      open_price, high_price, low_price, close_price  (float, USD)
      volume_btc, volume_usdt                          (float)
      trades_count                                     (int)
      open_time_ms                                     (int, epoch ms)

    Si Binance falla, retorna dict mínimo con solo open_price desde Kraken.
    Si Kraken también falla, retorna None.
    """
    now    = datetime.now(timezone.utc)
    candle = _try_binance_full(slug, now)
    if candle:
        return candle

    logger.warning("[SCANNER] Binance full candle fallido — intentando Kraken (solo open)")
    open_price = _try_kraken(now)
    if open_price:
        return {"open_price": open_price}

    logger.error("[SCANNER] ❌ No se pudo obtener vela 1H completa")
    return None


# ── Alias público (usado por command_handler) ─────────────────────────────────
get_clob_price = _fetch_live_price
