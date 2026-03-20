"""
db.py — v3.0  Capa de persistencia Supabase para PolyBot
────────────────────────────────────────────────────────────────────────────
Tablas:
  operations      — Historial completo de trades (estrategia direccional)
  arb_operations  — Historial de operaciones de arbitraje (v3.0)
  signal_log      — Señales accionables evaluadas (calibración de umbrales)
  price_snapshots — Muestreo de precio BTC cada ~5 min
  market_sessions — Resumen por hora de mercado
  bot_config      — Configuración compartida bot ↔ dashboard
  bot_commands    — Canal de comandos dashboard → bot

Uso en monitor.py:
  import db
  db.init(url, service_key)
  db.upsert_operation(op_dict)
  db.close_operation(id, ...)
  db.log_signal(...)
  db.log_price_snapshot(...)
  db.upsert_session(...)
  db.get_config("trading_mode")
  db.set_config("bot_simulate_active", "true")

Uso en arb_monitor.py:
  db.upsert_arb_operation(op_dict)
  db.close_arb_operation(id, ...)
  db.fetch_arb_operations(...)
  db.fetch_arb_stats(...)

Diseño:
  - Todas las funciones son fire-and-forget con try/except interno.
  - El bot sigue funcionando aunque Supabase no esté disponible.
  - El CSV de Railway sigue escribiéndose como backup secundario.

v3.0 — Soporte tabla arb_operations (estrategia de arbitraje paralela)
v2.0 — get_config / set_config para sistema de modo simulado/real
v1.0 — Persistencia inicial de operaciones, señales, snapshots y sesiones

Destino: bot/modules/db.py
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
        from supabase import create_client
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


# ── Operaciones (estrategia direccional) ──────────────────────────────────

def upsert_operation(op: dict) -> bool:
    """
    Inserta o actualiza una operación direccional.
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
    resultado:        str,         # WIN | LOSS | STOP
    pnl_usd:          float,
    pnl_pct:          float,
    odds_salida:      float = None,
    real_exit_odds:   float = None,
    retorno_real_usd: float = None,
    ts_cierre:        str   = None,
) -> bool:
    """Cierra una operación direccional actualizando resultado y P&L."""
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
    direccion:    str,
    accionable:   bool,
    market_slug:  str   = None,
    hour_utc:     int   = None,
    mins_left:    float = None,
    simulado:     bool  = False,
) -> bool:
    """Registra una señal evaluada. Solo llamar para señales accionables (UP|DOWN)."""
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
    """Guarda un snapshot de precio BTC. Llamar cada ~5 min."""
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


# ── Estadísticas históricas (direccional) ─────────────────────────────────

def fetch_historical_stats(simulado: Optional[bool] = None) -> dict:
    """
    Devuelve estadísticas acumuladas de la estrategia direccional.
    simulado=None → todas | True → solo sim | False → solo real
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
    resultado: str  = None,
    date:      str  = None,
    simulado:  bool = None,
) -> list:
    """Devuelve operaciones direccionales recientes (más nuevas primero)."""
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


# ── Configuración compartida bot ↔ dashboard ──────────────────────────────

def get_config(key: str, default: str = None) -> Optional[str]:
    """
    Lee un valor de bot_config por clave.
    Devuelve el valor como string, o default si no existe / DB no disponible.
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
    """Escribe (upsert) un valor en bot_config."""
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


# ── ARB Operations (v3.0) ─────────────────────────────────────────────────

def upsert_arb_operation(op: dict) -> bool:
    """
    Inserta o actualiza una operación de arbitraje.
    Llamar al abrir la primera pata (resultado='PENDING') y al balancear el par.

    Campos esperados en op:
      id, ts_entrada, market_slug, hour_utc, fase_entrada,
      up_token_id, down_token_id, up_entry_odds, down_entry_odds,
      pair_cost, up_tokens, down_tokens, stake_total_usd,
      ganancia_garantizada, resultado, simulado
    """
    if not is_enabled():
        return False
    try:
        payload = {**op, "updated_at": _now()}
        _client.table("arb_operations").upsert(payload, on_conflict="id").execute()
        logger.debug(f"[DB] upsert_arb_operation OK: {op.get('id')}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ upsert_arb_operation [{op.get('id')}]: {e}")
        return False


def close_arb_operation(
    op_id:     str,
    resultado: str,         # BALANCED | PHASE3_EXIT | PARTIAL
    pnl_usd:   float,
    pnl_pct:   float,
    ts_cierre: str = None,
) -> bool:
    """
    Cierra una operación ARB actualizando resultado y P&L.
    Llamar al finalizar cada hora con posición abierta.
    """
    if not is_enabled():
        return False
    try:
        payload = {
            "resultado":  resultado,
            "pnl_usd":    _r4(pnl_usd),
            "pnl_pct":    _r2(pnl_pct),
            "ts_cierre":  ts_cierre or _now(),
            "updated_at": _now(),
        }
        _client.table("arb_operations").update(payload).eq("id", op_id).execute()
        logger.debug(f"[DB] close_arb_operation OK: {op_id} → {resultado}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ close_arb_operation [{op_id}]: {e}")
        return False


def fetch_arb_operations(
    limit:     int  = 200,
    resultado: str  = None,   # BALANCED | PHASE3_EXIT | PARTIAL | PENDING
    simulado:  bool = None,
) -> list:
    """Devuelve operaciones ARB recientes (más nuevas primero)."""
    if not is_enabled():
        return []
    try:
        q = (
            _client.table("arb_operations")
            .select("*")
            .order("ts_entrada", desc=True)
            .limit(limit)
        )
        if resultado:
            q = q.eq("resultado", resultado)
        if simulado is not None:
            q = q.eq("simulado", simulado)
        return q.execute().data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_arb_operations: {e}")
        return []


def fetch_arb_stats(simulado: Optional[bool] = None) -> dict:
    """
    Estadísticas agregadas de operaciones ARB.
    simulado=None → todas | True → solo sim | False → solo real
    """
    empty = {
        "total_ops": 0,
        "balanced": 0,
        "phase3_exits": 0,
        "parciales": 0,
        "total_pnl": 0.0,
        "total_invested": 0.0,
        "avg_pair_cost": 0.0,
        "avg_ganancia": 0.0,
    }
    if not is_enabled():
        return empty
    try:
        q = (
            _client.table("arb_operations")
            .select("resultado, pnl_usd, stake_total_usd, pair_cost, ganancia_garantizada")
            .neq("resultado", "PENDING")
        )
        if simulado is not None:
            q = q.eq("simulado", simulado)

        rows = q.execute().data or []
        stats = {**empty}
        pair_costs: list = []
        ganancias:  list = []

        for row in rows:
            r = (row.get("resultado") or "").upper()
            stats["total_ops"]      += 1
            stats["total_pnl"]      += float(row.get("pnl_usd") or 0)
            stats["total_invested"] += float(row.get("stake_total_usd") or 0)
            if row.get("pair_cost"):
                pair_costs.append(float(row["pair_cost"]))
            if row.get("ganancia_garantizada"):
                ganancias.append(float(row["ganancia_garantizada"]))
            if r == "BALANCED":
                stats["balanced"] += 1
            elif r == "PHASE3_EXIT":
                stats["phase3_exits"] += 1
            elif r == "PARTIAL":
                stats["parciales"] += 1

        stats["avg_pair_cost"] = round(sum(pair_costs) / len(pair_costs), 4) if pair_costs else 0.0
        stats["avg_ganancia"]  = round(sum(ganancias)  / len(ganancias),  4) if ganancias  else 0.0
        return stats
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_arb_stats: {e}")
        return empty
