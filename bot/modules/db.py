"""
db.py — v2.1  Capa de persistencia Supabase para PolyBot

v2.1 — LOGS LIMPIOS
  - Mensajes de operaciones individuales (upsert, close, log_signal,
    log_price_snapshot, upsert_session) bajados a DEBUG.
  - Solo son visibles en Railway: init/conexión, errores (WARNING/ERROR),
    y fetch_historical_stats.
  - Ningún cambio funcional.

v2.0 — get_config / set_config para modo simulado/real dinámico.
v1.0 — Persistencia inicial de operaciones, señales, snapshots y sesiones.

Destino: bot/modules/db.py
"""
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Cliente Supabase ───────────────────────────────────────────────────────

_client  = None
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
        logger.debug(f"[DB] log_signal OK: {ventana} {direccion}")
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
    simulado:     bool  = False,
) -> bool:
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
        logger.debug(f"[DB] log_price_snapshot OK: ${btc_price:,.0f}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ log_price_snapshot: {e}")
        return False


# ── Sesiones horarias ──────────────────────────────────────────────────────

def upsert_session(
    session_id:  str,
    fecha:       str,
    hour_utc:    int,
    market_slug: str,
    ops:         int   = 0,
    wins:        int   = 0,
    losses:      int   = 0,
    stops:       int   = 0,
    pnl_usd:     float = 0.0,
    stake_total: float = 0.0,
    simulado:    bool  = False,
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
        logger.debug(f"[DB] upsert_session OK: {session_id}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ upsert_session [{session_id}]: {e}")
        return False


# ── Estadísticas históricas ────────────────────────────────────────────────

def fetch_historical_stats() -> dict:
    if not is_enabled():
        return {}
    try:
        res = _client.table("operations") \
            .select("resultado, pnl_usd, stake_usd") \
            .in_("resultado", ["WIN", "LOSS", "STOP"]) \
            .execute()
        rows = res.data or []
        wins = losses = stops = 0
        total_pnl = total_inv = 0.0
        for r in rows:
            resultado = (r.get("resultado") or "").upper()
            if resultado == "WIN":    wins   += 1
            elif resultado == "LOSS": losses += 1
            elif resultado == "STOP": stops  += 1
            try:
                total_pnl += float(r.get("pnl_usd") or 0)
                total_inv += float(r.get("stake_usd") or 0)
            except (TypeError, ValueError):
                pass
        total_ops = wins + losses + stops
        logger.info(
            f"[DB] Historial: {total_ops} ops  "
            f"W={wins} L={losses} S={stops}  "
            f"P&L={'+' if total_pnl >= 0 else ''}${total_pnl:,.2f}"
        )
        return {
            "total_ops":     total_ops,
            "wins":          wins,
            "losses":        losses,
            "stops":         stops,
            "total_pnl":     round(total_pnl, 4),
            "total_invested": round(total_inv, 4),
        }
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_historical_stats: {e}")
        return {}


def fetch_operations(limit: int = 500, simulado: bool = None) -> list:
    if not is_enabled():
        return []
    try:
        q = _client.table("operations") \
            .select("*") \
            .order("ts_entrada", desc=True) \
            .limit(limit)
        if simulado is not None:
            q = q.eq("simulado", simulado)
        res = q.execute()
        logger.debug(f"[DB] fetch_operations: {len(res.data or [])} filas")
        return res.data or []
    except Exception as e:
        logger.warning(f"[DB] ⚠ fetch_operations: {e}")
        return []


# ── Config compartida bot ↔ dashboard ─────────────────────────────────────

def get_config(key: str, default=None):
    if not is_enabled():
        return default
    try:
        res = _client.table("bot_config") \
            .select("value") \
            .eq("key", key) \
            .limit(1) \
            .execute()
        if res.data:
            return res.data[0]["value"]
        return default
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
        logger.debug(f"[DB] set_config OK: {key}={value}")
        return True
    except Exception as e:
        logger.warning(f"[DB] ⚠ set_config [{key}]: {e}")
        return False
