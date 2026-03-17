"""
db.py — v1.0  (importaciones absolutas — para bot/monitor.py, bot/main.py)
Contenido idéntico a bot/modules/db.py salvo la ruta de importación.
Ver bot/modules/db.py para documentación completa.
"""
# Re-exportar todo desde el módulo canónico
from modules.db import (
    init,
    is_enabled,
    upsert_operation,
    close_operation,
    log_signal,
    log_price_snapshot,
    upsert_session,
    fetch_historical_stats,
    fetch_operations,
)

__all__ = [
    "init", "is_enabled",
    "upsert_operation", "close_operation",
    "log_signal", "log_price_snapshot",
    "upsert_session",
    "fetch_historical_stats", "fetch_operations",
]
