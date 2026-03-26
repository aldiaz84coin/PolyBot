"""
db.py — v3.0  Capa de persistencia Supabase para PolyBot
────────────────────────────────────────────────────────────────────────────
Tablas:
  operations      — Historial completo de trades
  signal_log      — Señales accionables evaluadas (calibración de umbrales)
  price_snapshots — Muestreo de precio BTC cada ~5 min
  market_sessions — Resumen por hora de mercado
  bot_config      — Configuración compartida bot ↔ dashboard (v2.0)
  bot_commands    — Canal de comandos dashboard → bot (v2.0)
  token_price_log — Precio CLOB YES/NO cada ~30s (v3.0)
  btc_candle_data — Vela 1H completa de Binance (v3.0)

v3.0 — DataLab: log_token_price(), log_btc_candle(), fetch_token_prices(),
       fetch_candle_data(). Base de datos histórica para backtesting.
v2.0 — get_config / set_config para sistema de modo simulado/real.
v1.0 — Persistencia inicial de operaciones, señales, snapshots y sesiones.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Cliente Supabase (importación opcional) ────────────────────────────────

_client  = None   # supabase.Client | None
_enabled = False


def init(url: str, key: str) -> bool:
    global _client, _enabled
    if not url or not key:
        logger.warning("[DB] SUPABASE_URL / SUPABASE_SERVICE_KEY no configuradas — DB desactivada")
        return False
    try:
        from supabase import create_client
        _client  = create_client(url, key)
        _enabled = True
        logger.info("[DB] ✅ Conectado a Supabase")
        return True
    except ImportError:
        logger.warning("[DB] ⚠ supabase-py no instalado. DB desactivada.")
        return False
    except Exception as e:
        logger.error(f"[DB] ❌ Error conectando a Supabase: {e}")
        return False


def is_enabled() -> bool:
    return _enabled and _client is not None


# ── Helpers internos ───────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _r2(v) -> Optional[float]:
    return round(float(v), 2) if v is not None else None

def _r4(v) -> Optional[float]:
    return round(float(v), 4) if v is not None else None


# ── Operaciones ────────────────────────────────────────────────────────────

def upsert_operation(op: dict) -> bool:
    """
    Inserta o actualiza una operación.
    Llamar inmediatamente tras abrir apuesta (resultado='PENDING').
    """
    if not is_enabled():
        return False
    try:
        payload = {**op, "updated_at": _now()}
        _client.table("operations").upsert(payload, on_conflict="id").execute()
        logger.debug(f"[DB] upsert_operation OK: {op.get('id')}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ upsert_operation [{op.get('id')}]: {e}")
        return False


def close_operation(
    op_id:            str,
    resultado:        str,
    pnl_usd:          float,
    pnl_pct:          float,
    odds_salida:      float = None,
    real_exit_odds:   float = None,
    retorno_real_usd: float = None,
    ts_cierre:        str   = None,
) -> bool:
    """Cierra una operación actualizando resultado y P&L."""
    if not is_enabled():
        return False
    try:
        payload = {
            "resultado":        resultado,
            "pnl_usd":          _r4(pnl_usd),
            "pnl_pct":          _r2(pnl_pct),
            "ts_cierre":        ts_cierre or _now(),
            "updated_at":       _now(),
        }
        if odds_salida      is not None: payload["odds_salida"]       = _r4(odds_salida)
        if real_exit_odds   is not None: payload["real_exit_odds"]    = _r4(real_exit_odds)
        if retorno_real_usd is not None: payload["retorno_real_usd"]  = _r4(retorno_real_usd)

        _client.table("operations").update(payload).eq("id", op_id).execute()
        logger.debug(f"[DB] close_operation OK: {op_id} → {resultado}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ close_operation [{op_id}]: {e}")
        return False


# ── Señales ────────────────────────────────────────────────────────────────

def log_signal(signal_dict: dict) -> bool:
    """Registra una señal accionable para calibración de umbrales."""
    if not is_enabled():
        return False
    try:
        _client.table("signal_log").insert({**signal_dict, "ts": _now()}).execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_signal: {e}")
        return False


# ── Snapshots de precio BTC ────────────────────────────────────────────────

def log_price_snapshot(
    btc_price:    float,
    target_price: float | None = None,
    market_slug:  str | None = None,
    hour_utc:     int | None = None,
    mins_left:    float | None = None,
) -> bool:
    """Muestrea precio BTC cada ~5 min."""
    if not is_enabled():
        return False
    try:
        _client.table("price_snapshots").insert({
            "ts":           _now(),
            "btc_price":    _r2(btc_price),
            "target_price": _r2(target_price) if target_price else None,
            "market_slug":  market_slug,
            "hour_utc":     hour_utc,
            "mins_left":    round(mins_left, 2) if mins_left is not None else None,
        }).execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_price_snapshot: {e}")
        return False


# ── Sesiones de mercado ────────────────────────────────────────────────────

def upsert_session(
    session_id:  str,
    fecha:       str,
    hour_utc:    int,
    market_slug: str,
    ops:         int,
    wins:        int,
    losses:      int,
    stops:       int,
    pnl_usd:     float,
    stake_total: float,
    simulado:    bool = False,
) -> bool:
    if not is_enabled():
        return False
    try:
        _client.table("market_sessions").upsert({
            "id":          session_id,
            "fecha":       fecha,
            "hour_utc":    hour_utc,
            "market_slug": market_slug,
            "ops":         ops,
            "wins":        wins,
            "losses":      losses,
            "stops":       stops,
            "pnl_usd":     _r4(pnl_usd),
            "stake_total": _r4(stake_total),
            "simulado":    simulado,
            "updated_at":  _now(),
        }, on_conflict="id").execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ upsert_session [{session_id}]: {e}")
        return False


# ── v3.0: Token Price Log ──────────────────────────────────────────────────

def log_token_price(
    hour_utc:     int,
    market_slug:  str,
    yes_token_id: str,
    no_token_id:  str,
    yes_price:    float,
    no_price:     float,
    ventana:      str | None,
    mins_left:    float,
    btc_price:    float,
    btc_target:   float | None = None,
    simulado:     bool = False,
) -> bool:
    """
    Registra el precio CLOB de tokens YES/NO en cada ciclo.
    Llamar con throttle ~30s para no saturar la BD.
    ventana = None si estamos fuera de cualquier ventana de entrada.
    """
    if not is_enabled():
        return False
    try:
        _client.table("token_price_log").insert({
            "ts":           _now(),
            "hour_utc":     hour_utc,
            "market_slug":  market_slug,
            "yes_token_id": yes_token_id or None,
            "no_token_id":  no_token_id  or None,
            "yes_price":    _r4(yes_price)  if yes_price  else None,
            "no_price":     _r4(no_price)   if no_price   else None,
            "ventana":      ventana,
            "mins_left":    round(mins_left, 2) if mins_left is not None else None,
            "btc_price":    _r2(btc_price)  if btc_price  else None,
            "btc_target":   _r2(btc_target) if btc_target else None,
            "simulado":     simulado,
        }).execute()
        logger.debug(f"[DB] log_token_price OK — YES={yes_price:.4f} NO={no_price:.4f} ventana={ventana}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_token_price: {e}")
        return False


# ── v3.0: BTC Candle Data ─────────────────────────────────────────────────

def log_btc_candle(
    hour_utc:     int,
    fecha:        str,           # YYYY-MM-DD
    market_slug:  str,
    open_price:   float,
    high_price:   float | None = None,
    low_price:    float | None = None,
    close_price:  float | None = None,
    volume_btc:   float | None = None,
    volume_usdt:  float | None = None,
    trades_count: int   | None = None,
    open_time_ms: int   | None = None,
    simulado:     bool  = False,
) -> bool:
    """
    Registra los datos completos de la vela 1H de Binance al inicio de cada hora.
    Usa UPSERT sobre (fecha, hour_utc) → una fila por hora, se actualiza si ya existe.
    """
    if not is_enabled():
        return False
    try:
        _client.table("btc_candle_data").upsert({
            "ts":           _now(),
            "hour_utc":     hour_utc,
            "fecha":        fecha,
            "market_slug":  market_slug or "",
            "open_price":   _r2(open_price),
            "high_price":   _r2(high_price)   if high_price   else None,
            "low_price":    _r2(low_price)    if low_price    else None,
            "close_price":  _r2(close_price)  if close_price  else None,
            "volume_btc":   _r4(volume_btc)   if volume_btc   else None,
            "volume_usdt":  _r2(volume_usdt)  if volume_usdt  else None,
            "trades_count": int(trades_count) if trades_count else None,
            "open_time_ms": int(open_time_ms) if open_time_ms else None,
            "simulado":     simulado,
        }, on_conflict="fecha,hour_utc").execute()
        logger.info(
            f"[DB] log_btc_candle OK — {fecha} {hour_utc:02d}h  "
            f"open=${open_price:,.2f}  vol={volume_btc:.2f}BTC  trades={trades_count}"
        )
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_btc_candle [{fecha} {hour_utc}h]: {e}")
        return False


# ── v3.0: Fetchers para DataLab ───────────────────────────────────────────

def fetch_token_prices(
    market_slug: str | None = None,
    hour_utc:    int | None = None,
    fecha:       str | None = None,   # YYYY-MM-DD
    limit:       int = 1000,
) -> list:
    """
    Devuelve serie temporal de precios de tokens para el DataLab.
    Filtra por slug, hora UTC y/o fecha.
    """
    if not is_enabled():
        return []
    try:
        q = _client.table("token_price_log").select(
            "ts, hour_utc, market_slug, yes_price, no_price, "
            "ventana, mins_left, btc_price, btc_target, simulado"
        ).order("ts", desc=False).limit(limit)

        if market_slug:
            q = q.eq("market_slug", market_slug)
        if hour_utc is not None:
            q = q.eq("hour_utc", hour_utc)
        if fecha:
            # filtrar por fecha usando el campo ts
            q = q.gte("ts", f"{fecha}T00:00:00Z").lte("ts", f"{fecha}T23:59:59Z")

        resp = q.execute()
        return resp.data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_token_prices: {e}")
        return []


def fetch_candle_data(
    limit: int = 200,
    fecha_desde: str | None = None,  # YYYY-MM-DD
) -> list:
    """
    Devuelve historial de velas 1H para el DataLab.
    Ordenado de más reciente a más antiguo.
    """
    if not is_enabled():
        return []
    try:
        q = _client.table("btc_candle_data").select("*").order("fecha", desc=True).order("hour_utc", desc=True).limit(limit)
        if fecha_desde:
            q = q.gte("fecha", fecha_desde)
        resp = q.execute()
        return resp.data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_candle_data: {e}")
        return []


# ── Estadísticas históricas ────────────────────────────────────────────────

def fetch_historical_stats(simulado: Optional[bool] = None) -> dict:
    """Devuelve estadísticas acumuladas desde la BD."""
    if not is_enabled():
        return {"total_ops": 0, "wins": 0, "losses": 0, "stops": 0, "total_pnl": 0.0}
    try:
        q = _client.table("operations").select(
            "resultado, pnl_usd, stake_usd"
        ).in_("resultado", ["WIN", "LOSS", "STOP"])
        if simulado is not None:
            q = q.eq("simulado", simulado)
        resp = q.execute()
        rows = resp.data or []

        wins   = sum(1 for r in rows if r["resultado"] == "WIN")
        losses = sum(1 for r in rows if r["resultado"] == "LOSS")
        stops  = sum(1 for r in rows if r["resultado"] == "STOP")
        pnl    = sum(float(r.get("pnl_usd") or 0) for r in rows)

        return {
            "total_ops":   len(rows),
            "wins":        wins,
            "losses":      losses,
            "stops":       stops,
            "total_pnl":   round(pnl, 4),
        }
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_historical_stats: {e}")
        return {"total_ops": 0, "wins": 0, "losses": 0, "stops": 0, "total_pnl": 0.0}


def fetch_operations(
    limit:    int = 500,
    simulado: Optional[bool] = None,
) -> list:
    """Devuelve lista de operaciones recientes."""
    if not is_enabled():
        return []
    try:
        q = _client.table("operations").select("*").order("ts_entrada", desc=True).limit(limit)
        if simulado is not None:
            q = q.eq("simulado", simulado)
        resp = q.execute()
        return resp.data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_operations: {e}")
        return []


# ── Configuración compartida (v2.0) ───────────────────────────────────────

def get_config(key: str, default: str | None = None) -> str | None:
    if not is_enabled():
        return default
    try:
        resp = _client.table("bot_config").select("value").eq("key", key).execute()
        rows = resp.data or []
        return rows[0]["value"] if rows else default
    except Exception as e:
        logger.warning(f"[DB] ⚠ get_config [{key}]: {e}")
        return default


def set_config(key: str, value: str) -> bool:
    if not is_enabled():
        return False
    try:
        _client.table("bot_config").upsert(
            {"key": key, "value": value, "updated_at": _now()},
            on_conflict="key",
        ).execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ set_config [{key}]: {e}")
        return False
