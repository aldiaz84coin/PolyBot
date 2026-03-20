"""
db.py — v2.0  Capa de persistencia Supabase para PolyBot
────────────────────────────────────────────────────────────────────────────
Tablas:
  operations      — Historial completo de trades
  signal_log      — Señales accionables evaluadas (calibración de umbrales)
  price_snapshots — Muestreo de precio BTC cada ~5 min
  market_sessions — Resumen por hora de mercado
  bot_config      — Configuración compartida bot ↔ dashboard (v2.0)
  bot_commands    — Canal de comandos dashboard → bot (v2.0)

Uso en monitor.py:
  import db
  db.init(url, service_key)            # una vez al arrancar
  db.upsert_operation(op_dict)         # al abrir apuesta (PENDING)
  db.close_operation(id, ...)          # al cerrar (WIN/LOSS/STOP)
  db.log_signal(signal_dict)           # señales accionables
  db.log_price_snapshot(...)           # cada N ciclos
  db.upsert_session(session_id, ...)   # al cambiar de hora
  db.get_config("trading_mode")        # leer configuración compartida (v2.0)
  db.set_config("bot_simulate_active", "true")  # escribir estado (v2.0)

Diseño:
  - Todas las funciones son fire-and-forget con try/except interno.
  - El bot sigue funcionando aunque Supabase no esté disponible.
  - El CSV de Railway sigue escribiéndose como backup secundario.

v2.0 — Añade get_config / set_config para sistema de modo simulado/real.
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
    """
    Inicializa el cliente Supabase.
    url  → SUPABASE_URL  (https://xxx.supabase.co)
    key  → SUPABASE_SERVICE_KEY  (service_role, no anon)
    Retorna True si la conexión fue exitosa.
    """
    global _client, _enabled
    if not url or not key:
        logger.warning("[DB] SUPABASE_URL / SUPABASE_SERVICE_KEY no configuradas — DB desactivada")
        return False
    try:
        from supabase import create_client  # pip install supabase>=2.0.0
        _client  = create_client(url, key)
        _enabled = True
        logger.info("[DB] ✅ Conectado a Supabase")
        return True
    except ImportError:
        logger.warning("[DB] ⚠ supabase-py no instalado (pip install supabase). DB desactivada.")
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

    Campos esperados en op:
      id, ts_entrada, direccion, ventana, entry_price, target_price,
      distancia, umbral, odds_entrada, stake_usd, tokens_comprados,
      retorno_estimado_usd, resultado, market_slug, simulado
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
    op_id:           str,
    resultado:       str,         # WIN | LOSS | STOP
    pnl_usd:         float,
    pnl_pct:         float,
    odds_salida:     float = None,
    real_exit_odds:  float = None,
    retorno_real_usd: float = None,
    ts_cierre:       str   = None,
) -> bool:
    """
    Cierra una operación actualizando resultado y P&L.
    Llamar tras WIN / LOSS / STOP.
    """
    if not is_enabled():
        return False
    try:
        data: dict = {
            "resultado":  resultado,
            "pnl_usd":    _r4(pnl_usd),
            "pnl_pct":    _r4(pnl_pct),
            "ts_cierre":  ts_cierre or _now(),
            "updated_at": _now(),
        }
        if odds_salida is not None:
            data["odds_salida"] = _r4(odds_salida)
        if real_exit_odds is not None:
            data["real_exit_odds"] = _r4(real_exit_odds)
        if retorno_real_usd is not None:
            data["retorno_real_usd"] = _r4(retorno_real_usd)

        _client.table("operations").update(data).eq("id", op_id).execute()
        logger.debug(f"[DB] close_operation OK: {op_id} → {resultado}  P&L={pnl_usd:+.2f}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ close_operation [{op_id}]: {e}")
        return False


# ── Señales evaluadas ──────────────────────────────────────────────────────

def log_signal(
    btc_price:    float,
    target_price: float,
    distancia:    float,
    umbral:       float,
    ventana:      str,
    direccion:    str,          # UP | DOWN | WAIT
    accionable:   bool,
    market_slug:  str   = None,
    hour_utc:     int   = None,
    mins_left:    float = None,
    simulado:     bool  = False,
) -> bool:
    """
    Registra una señal evaluada.
    Solo llamar para señales ACCIONABLES (dir UP|DOWN) para evitar ruido.
    """
    if not is_enabled():
        return False
    try:
        _client.table("signal_log").insert({
            "ts":           _now(),
            "btc_price":    _r2(btc_price),
            "target_price": _r2(target_price) if target_price else None,
            "distancia":    _r2(distancia),
            "umbral":       umbral,
            "ventana":      ventana,
            "direccion":    direccion,
            "accionable":   accionable,
            "market_slug":  market_slug,
            "hour_utc":     hour_utc,
            "mins_left":    round(mins_left, 2) if mins_left is not None else None,
            "simulado":     simulado,
        }).execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_signal: {e}")
        return False


# ── Snapshots de precio ────────────────────────────────────────────────────

def log_price_snapshot(
    btc_price:    float,
    target_price: float = None,
    market_slug:  str   = None,
    hour_utc:     int   = None,
    mins_left:    float = None,
) -> bool:
    """
    Guarda un snapshot de precio BTC.
    Llamar cada ~5 min para no generar demasiadas filas.
    """
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
    session_id:  str,    # YYYY-MM-DD-HH
    fecha:       str,    # YYYY-MM-DD
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
    """Actualiza el resumen de una sesión horaria."""
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


# ── Lectura — estadísticas históricas ─────────────────────────────────────

def fetch_historical_stats(simulado: Optional[bool] = None) -> dict:
    """
    Devuelve estadísticas acumuladas desde la BD.
    Equivalente a _load_historical_stats() del CSV pero usando Supabase.
    simulado=None  → todas | True → solo sim | False → solo real
    """
    empty = {"total_ops": 0, "wins": 0, "losses": 0, "stops": 0,
             "total_pnl": 0.0, "total_invested": 0.0}
    if not is_enabled():
        return empty
    try:
        q = _client.table("operations").select(
            "resultado, pnl_usd, stake_usd"
        ).neq("resultado", "PENDING")

        if simulado is not None:
            q = q.eq("simulado", simulado)

        rows = q.execute().data or []
        stats = {**empty}
        for row in rows:
            r = (row.get("resultado") or "").upper()
            if r == "WIN":
                stats["wins"] += 1
            elif r == "LOSS":
                stats["losses"] += 1
            elif r == "STOP":
                stats["stops"] += 1
            else:
                continue
            stats["total_ops"]      += 1
            stats["total_pnl"]      += float(row.get("pnl_usd") or 0)
            stats["total_invested"] += float(row.get("stake_usd") or 0)
        return stats
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_historical_stats: {e}")
        return empty


def fetch_operations(
    limit:     int  = 200,
    resultado: str  = None,   # WIN | LOSS | STOP | PENDING
    date:      str  = None,   # YYYY-MM-DD
    simulado:  bool = None,
) -> list:
    """Devuelve operaciones recientes (más nuevas primero)."""
    if not is_enabled():
        return []
    try:
        q = _client.table("operations").select("*").order("ts_entrada", desc=True).limit(limit)
        if resultado:
            q = q.eq("resultado", resultado)
        if date:
            q = q.gte("ts_entrada", f"{date}T00:00:00Z").lte("ts_entrada", f"{date}T23:59:59Z")
        if simulado is not None:
            q = q.eq("simulado", simulado)
        return q.execute().data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_operations: {e}")
        return []


# ── Configuración compartida bot ↔ dashboard (v2.0) ───────────────────────

def get_config(key: str, default: str = None) -> Optional[str]:
    """
    Lee un valor de bot_config por clave.
    Devuelve el valor como string, o default si no existe / DB no disponible.

    Ejemplo:
        mode = get_config("trading_mode", "simulate")
        simulate = (mode == "simulate")
    """
    if not is_enabled():
        return default
    try:
        res = _client.table("bot_config") \
            .select("value") \
            .eq("key", key) \
            .single() \
            .execute()
        if res.data:
            return res.data.get("value", default)
        return default
    except Exception as e:
        logger.debug(f"[DB] get_config [{key}]: {e}")
        return default


def set_config(key: str, value: str) -> bool:
    """
    Escribe (upsert) un valor en bot_config.
    Útil para que el bot reporte su estado actual al dashboard.

    Ejemplo:
        set_config("bot_simulate_active", "true")
        set_config("bot_started_at", datetime.now(timezone.utc).isoformat())
    """
    if not is_enabled():
        return False
    try:
        _client.table("bot_config").upsert(
            {"key": key, "value": str(value), "updated_at": _now()},
            on_conflict="key",
        ).execute()
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ set_config [{key}={value}]: {e}")
        return False
