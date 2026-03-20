"""
arb_monitor.py — Loop principal de arbitraje de pares UP/DOWN

Corre como hilo daemon paralelo al monitor.py principal.
Comparte mercado activo pero mantiene estado, CSV y modo simulate/real independientes.

Fases:
  OUTSIDE (>60 min)  : Espera próximo mercado. Reset de estado.
  PHASE1 (60→30 min) : Acumulación: busca primera pata y cubre si pair_cost < umbral.
  PHASE2 (30→15 min) : Monitoreo unilateral: solo cubre si ya hay pata abierta.
  PHASE3 (15→0.5 min): Venta forzada de pata descubierta.
  END    (<0.5 min)  : Sin operaciones. Espera resolución.

Resolución: al cruzar OUTSIDE (nueva hora), si el par estaba balanceado → WIN garantizado.

Control desde Supabase (polling cada 60s):
  arb_simulate_mode : "simulate" | "real"
  arb_enabled       : "true" | "false"
  arb_stake_usdc    : float como string

v1.0 — Implementación inicial
"""

import csv
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

import requests

from .market_scanner import get_active_market
from .arb_strategy import (
    ArbPhase, ArbPosition,
    get_phase, evaluate_arb, execute_arb_leg, execute_arb_sell,
)
from .arb_notifier import (
    notify_arb_start, notify_arb_phase_change,
    notify_arb_leg_bought, notify_arb_balanced,
    notify_arb_exit_phase3, notify_arb_resolution,
    notify_arb_hour_summary,
)
from . import db

logger = logging.getLogger(__name__)

_CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint"

_CSV_HEADERS = [
    "id", "ts_entrada", "ts_cierre",
    "market_slug", "hour_utc",
    "fase_entrada",
    "up_token_id", "down_token_id",
    "up_entry_odds", "down_entry_odds",
    "pair_cost",
    "up_tokens", "down_tokens",
    "stake_total_usd",
    "ganancia_garantizada",
    "resultado",
    "pnl_usd", "pnl_pct",
    "simulado",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mins_to_close() -> float:
    now = datetime.now(timezone.utc)
    return 60.0 - now.minute - now.second / 60.0


def _fetch_clob_prices(market: dict) -> tuple:
    """Obtiene precios UP y DOWN del CLOB en tiempo real. Devuelve (up, down)."""
    tokens = market.get("tokens", {})
    up_id   = tokens.get("UP",   {}).get("token_id", "")
    down_id = tokens.get("DOWN", {}).get("token_id", "")

    up_price   = 0.5
    down_price = 0.5

    try:
        if up_id:
            r = requests.get(f"{_CLOB_MIDPOINT}?token_id={up_id}", timeout=5)
            r.raise_for_status()
            up_price = float(r.json().get("mid", 0.5))
    except Exception as e:
        logger.debug(f"[ARB] precio UP CLOB: {e}")

    try:
        if down_id:
            r = requests.get(f"{_CLOB_MIDPOINT}?token_id={down_id}", timeout=5)
            r.raise_for_status()
            down_price = float(r.json().get("mid", 0.5))
    except Exception as e:
        logger.debug(f"[ARB] precio DOWN CLOB: {e}")

    return up_price, down_price


def _ensure_csv(path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=_CSV_HEADERS).writeheader()


def _csv_write(path: str, row: dict):
    try:
        _ensure_csv(path)
        with open(path, "a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=_CSV_HEADERS, extrasaction="ignore").writerow(row)
    except Exception as e:
        logger.warning(f"[ARB] ⚠ CSV write: {e}")


def _position_to_row(pos: ArbPosition, resultado: str, pnl_usd: float, pnl_pct: float, ts_cierre: str) -> dict:
    return {
        "id":                   pos.id,
        "ts_entrada":           pos.ts_entrada,
        "ts_cierre":            ts_cierre,
        "market_slug":          pos.market_slug,
        "hour_utc":             pos.hour_utc,
        "fase_entrada":         pos.phase_entry,
        "up_token_id":          pos.up_token_id,
        "down_token_id":        pos.down_token_id,
        "up_entry_odds":        pos.up_entry_odds,
        "down_entry_odds":      pos.down_entry_odds,
        "pair_cost":            pos.pair_cost,
        "up_tokens":            pos.up_tokens,
        "down_tokens":          pos.down_tokens,
        "stake_total_usd":      pos.total_cost,
        "ganancia_garantizada": pos.ganancia_garantizada,
        "resultado":            resultado,
        "pnl_usd":              pnl_usd,
        "pnl_pct":              pnl_pct,
        "simulado":             pos.simulated,
    }


def _position_to_db(pos: ArbPosition, resultado: str = "PENDING") -> dict:
    return {
        "id":                   pos.id,
        "ts_entrada":           pos.ts_entrada,
        "market_slug":          pos.market_slug,
        "hour_utc":             pos.hour_utc,
        "fase_entrada":         pos.phase_entry,
        "up_token_id":          pos.up_token_id,
        "down_token_id":        pos.down_token_id,
        "up_entry_odds":        pos.up_entry_odds,
        "down_entry_odds":      pos.down_entry_odds,
        "pair_cost":            pos.pair_cost,
        "up_tokens":            pos.up_tokens,
        "down_tokens":          pos.down_tokens,
        "stake_total_usd":      pos.total_cost,
        "ganancia_garantizada": pos.ganancia_garantizada,
        "resultado":            resultado,
        "simulado":             pos.simulated,
    }


# ── Resolución de hora ────────────────────────────────────────────────────────

def _close_position(
    pos:      ArbPosition,
    csv_path: str,
    cfg:      dict,
    simulate: bool,
):
    """Cierra y registra la posición al finalizar la hora."""
    ts_cierre = datetime.now(timezone.utc).isoformat()

    if pos.balanced:
        # Par completo → ganancia garantizada
        pnl_usd   = pos.ganancia_garantizada
        pnl_pct   = round((pnl_usd / max(pos.total_cost, 0.001)) * 100, 2)
        resultado = "BALANCED"
        logger.info(
            f"[ARB] 🎉 RESOLUCIÓN BALANCED: "
            f"par_cost={pos.pair_cost:.4f}  "
            f"PnL=${pnl_usd:+.4f} ({pnl_pct:+.1f}%)"
        )

    elif pos.phase3_exit:
        # Salida parcial ya registrada durante Fase 3
        pnl_usd   = round(pos.phase3_exit_proceeds - pos.total_cost, 4)
        pnl_pct   = round((pnl_usd / max(pos.total_cost, 0.001)) * 100, 2)
        resultado = "PHASE3_EXIT"
        logger.info(
            f"[ARB] ⚠ RESOLUCIÓN PHASE3_EXIT: "
            f"PnL=${pnl_usd:+.4f} ({pnl_pct:+.1f}%)"
        )

    else:
        # Posición no balanceada, no hubo venta
        pnl_usd   = -pos.total_cost
        pnl_pct   = -100.0
        resultado = "PARTIAL"
        logger.warning(
            f"[ARB] ❌ RESOLUCIÓN PARTIAL: "
            f"posición incompleta — pérdida ${pnl_usd:.4f}"
        )

    # Notificación
    notify_arb_resolution(cfg, pos, pnl_usd, pnl_pct, resultado, simulate)

    # CSV
    row = _position_to_row(pos, resultado, pnl_usd, pnl_pct, ts_cierre)
    _csv_write(csv_path, row)

    # Supabase
    try:
        db.close_arb_operation(
            op_id     = pos.id,
            resultado = resultado,
            pnl_usd   = pnl_usd,
            pnl_pct   = pnl_pct,
            ts_cierre = ts_cierre,
        )
    except Exception as e:
        logger.warning(f"[ARB] ⚠ close_arb_operation: {e}")

    return pnl_usd, resultado


# ── Loop principal ────────────────────────────────────────────────────────────

def run(cfg: dict):
    """
    Loop de arbitraje. Corre como hilo daemon lanzado desde monitor.py.
    No bloquea el loop principal.
    """
    arb_cfg  = cfg.get("arb_strategy", {})
    simulate = bool(arb_cfg.get("simulate_mode", True))
    interval = int(cfg.get("monitor", {}).get("interval_s", 30))
    csv_path = cfg.get("logging", {}).get("arb_csv_path", "logs/operaciones_arb.csv")

    logger.info(
        f"[ARB] 🚀 Loop ARB iniciado — "
        f"modo={'SIMULADO' if simulate else 'REAL'}  "
        f"interval={interval}s"
    )
    notify_arb_start(cfg, simulate)

    # ── Estado del loop ───────────────────────────────────────────────────
    position:           Optional[ArbPosition] = None
    current_market:     Optional[dict]        = None
    current_slug:       str                   = ""
    last_phase:         ArbPhase              = ArbPhase.OUTSIDE
    hour_ops:           list                  = []
    session_pnl:        float                 = 0.0
    last_config_poll:   float                 = 0.0
    last_market_fetch:  float                 = 0.0
    _MARKET_FETCH_SECS  = 300  # refrescar mercado cada 5 min

    while True:
        try:
            now_ts    = time.time()
            mins_left = _mins_to_close()
            phase     = get_phase(mins_left)

            # ── Poll configuración desde Supabase cada 60s ────────────────
            if now_ts - last_config_poll >= 60:
                last_config_poll = now_ts
                try:
                    db_sim = db.get_config("arb_simulate_mode", None)
                    if db_sim is not None:
                        new_sim = (db_sim == "simulate")
                        if new_sim != simulate:
                            old_l = "SIM" if simulate else "REAL"
                            new_l = "SIM" if new_sim else "REAL"
                            logger.warning(f"[ARB] 🔄 Cambio modo: {old_l} → {new_l}")
                            simulate = new_sim
                            cfg.setdefault("arb_strategy", {})["simulate_mode"] = simulate

                    db_enabled = db.get_config("arb_enabled", "true")
                    if db_enabled == "false":
                        logger.info("[ARB] Desactivado desde dashboard — deteniendo loop ARB")
                        return

                    db_stake = db.get_config("arb_stake_usdc", None)
                    if db_stake:
                        cfg.setdefault("arb_strategy", {})["stake_per_leg_usdc"] = float(db_stake)

                except Exception as e:
                    logger.debug(f"[ARB] poll config: {e}")

            # ── Detectar nueva hora / reset ───────────────────────────────
            if phase == ArbPhase.OUTSIDE:
                if last_phase != ArbPhase.OUTSIDE:
                    # Hora terminó
                    if position:
                        pnl, res = _close_position(position, csv_path, cfg, simulate)
                        hour_ops.append({"resultado": res, "pnl_usd": pnl})
                        session_pnl += pnl

                    notify_arb_hour_summary(cfg, hour_ops, session_pnl, simulate)
                    logger.info(
                        f"[ARB] ⏸ Fin de hora — session_pnl=${session_pnl:+.4f}  "
                        f"ops={len(hour_ops)}"
                    )

                    # Reset para la próxima hora
                    position       = None
                    hour_ops       = []
                    current_market = None
                    current_slug   = ""

                last_phase = phase
                time.sleep(interval)
                continue

            # ── Obtener mercado activo ─────────────────────────────────────
            if current_market is None or (now_ts - last_market_fetch >= _MARKET_FETCH_SECS):
                try:
                    result = get_active_market(cfg)
                    if result is None:
                        logger.debug("[ARB] Sin mercado activo")
                        time.sleep(interval)
                        continue
                    if isinstance(result, tuple):
                        current_market, current_slug = result
                    else:
                        current_market = result
                        current_slug   = result.get("market_slug", result.get("slug", ""))
                    last_market_fetch = now_ts
                    logger.info(f"[ARB] 📊 Mercado: {current_slug}")
                except Exception as e:
                    logger.warning(f"[ARB] get_active_market: {e}")
                    time.sleep(interval)
                    continue

            # ── Obtener precios CLOB en tiempo real ───────────────────────
            up_price, down_price = _fetch_clob_prices(current_market)
            pair_cost_live = round(up_price + down_price, 4)

            modo_tag = "[SIM]" if simulate else "[REAL]"
            logger.info(
                f"[ARB] {modo_tag} [{phase.value}] "
                f"mins={mins_left:.1f}  "
                f"UP={up_price:.4f}  DOWN={down_price:.4f}  "
                f"par={pair_cost_live:.4f} {'✅' if pair_cost_live < 1.0 else '❌'}"
            )

            # ── Cambio de fase ─────────────────────────────────────────────
            if phase != last_phase:
                logger.info(f"[ARB] 📍 {last_phase.value} → {phase.value}")
                notify_arb_phase_change(
                    cfg, last_phase.value, phase.value,
                    up_price, down_price, pair_cost_live, simulate,
                )
                last_phase = phase

            # ── Evaluar acción ─────────────────────────────────────────────
            action, reason = evaluate_arb(up_price, down_price, mins_left, position, cfg)

            if action != "WAIT" and action != "NONE":
                logger.info(f"[ARB] ▶ Acción={action}: {reason}")

            # ── Ejecutar BUY ───────────────────────────────────────────────
            if action in ("BUY_UP", "BUY_DOWN"):
                leg = "UP" if action == "BUY_UP" else "DOWN"
                result_order = execute_arb_leg(
                    leg=leg, market=current_market, cfg=cfg,
                    up_price=up_price, down_price=down_price,
                )

                if result_order:
                    # Crear posición si no existe
                    if position is None:
                        position = ArbPosition(
                            market_slug = current_slug,
                            hour_utc    = int(datetime.now(timezone.utc).hour),
                            phase_entry = phase.value,
                            simulated   = result_order["simulated"],
                        )

                    # Rellenar pata
                    if leg == "UP":
                        position.up_leg_filled  = True
                        position.up_token_id    = result_order["token_id"]
                        position.up_tokens      = result_order["tokens"]
                        position.up_cost        = result_order["stake"]
                        position.up_entry_odds  = result_order["odds"]
                        position.ts_up_entry    = datetime.now(timezone.utc).isoformat()
                    else:
                        position.down_leg_filled   = True
                        position.down_token_id     = result_order["token_id"]
                        position.down_tokens       = result_order["tokens"]
                        position.down_cost         = result_order["stake"]
                        position.down_entry_odds   = result_order["odds"]
                        position.ts_down_entry     = datetime.now(timezone.utc).isoformat()

                    notify_arb_leg_bought(
                        cfg, leg, result_order["odds"],
                        result_order["tokens"], result_order["stake"],
                        position, simulate,
                    )

                    # ¿Par balanceado?
                    if position.up_leg_filled and position.down_leg_filled:
                        position.balanced = True
                        notify_arb_balanced(cfg, position, simulate)
                        logger.info(
                            f"[ARB] ✅ PAR BALANCEADO — "
                            f"par_cost={position.pair_cost:.4f}  "
                            f"ganancia_garantizada=${position.ganancia_garantizada:.4f}"
                        )

                    # Guardar en Supabase (PENDING)
                    try:
                        db.upsert_arb_operation(_position_to_db(position, "PENDING"))
                    except Exception as e:
                        logger.warning(f"[ARB] ⚠ upsert_arb_operation: {e}")

            # ── Ejecutar SELL (Fase 3) ─────────────────────────────────────
            elif action in ("SELL_UP", "SELL_DOWN"):
                leg    = "UP" if action == "SELL_UP" else "DOWN"
                tokens = position.up_tokens if leg == "UP" else position.down_tokens
                price  = up_price if leg == "UP" else down_price

                result_sell = execute_arb_sell(
                    leg=leg, market=current_market, cfg=cfg,
                    tokens=tokens, current_price=price,
                )

                if result_sell:
                    position.phase3_exit          = True
                    position.phase3_exit_leg       = leg
                    position.phase3_exit_odds      = result_sell["odds"]
                    position.phase3_exit_proceeds  = result_sell["proceeds"]

                    cost_leg    = position.up_cost if leg == "UP" else position.down_cost
                    pnl_partial = round(result_sell["proceeds"] - cost_leg, 4)

                    notify_arb_exit_phase3(cfg, leg, result_sell, pnl_partial, position, simulate)

                    # Limpiar pata vendida
                    if leg == "UP":
                        position.up_leg_filled = False
                        position.up_tokens     = 0.0
                    else:
                        position.down_leg_filled = False
                        position.down_tokens     = 0.0

                    logger.info(
                        f"[ARB] ⚠ Fase 3 exit {leg}: "
                        f"tokens={tokens:.4f} @ {price:.4f} "
                        f"PnL_parcial=${pnl_partial:+.4f}"
                    )

            # ── Intervalo adaptativo ───────────────────────────────────────
            if phase == ArbPhase.PHASE3:
                sleep_s = 5
            elif phase in (ArbPhase.PHASE1, ArbPhase.PHASE2):
                # Más frecuente si tenemos pata descubierta
                sleep_s = 10 if (position and not position.balanced) else max(interval, 15)
            else:
                sleep_s = interval

            time.sleep(sleep_s)

        except Exception as e:
            logger.error(f"[ARB] ❌ Error en loop: {e}", exc_info=True)
            time.sleep(30)
