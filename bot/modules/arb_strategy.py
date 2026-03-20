"""
arb_strategy.py — Estrategia de arbitraje de pares UP/DOWN en Polymarket

Principio: comprar 1 token UP + 1 token DOWN del mismo mercado a coste total < $1.00.
Al cierre, uno vale $1.00 y el otro $0.00. El par siempre vale $1.00.
Si pair_cost = precio_UP + precio_DOWN < 1.00 → ganancia garantizada = 1.00 - pair_cost

Fases por minutos restantes al cierre:
  Fase 1 (60→30 min): Acumulación. Compra primera pata si precio ≤ entry_threshold.
                       Si ya hay pata, cubre la contraria si pair_cost_proyectado ≤ par_threshold_p1.
  Fase 2 (30→15 min): Monitoreo unilateral. Solo activa si Fase 1 dejó posición sin cubrir.
                       Umbral más relajado (par_threshold_p2).
  Fase 3 (15→0.5 min): Venta a mercado si sigue sin cubrir. PnL puede ser negativo.
  FIN   (<0.5 min):   Sin operaciones. Esperar resolución.
  FUERA (>60 min):    Sin mercado activo. En espera.

v1.0 — Implementación inicial
"""

import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# ── Límites de fases ──────────────────────────────────────────────────────────

PHASE1_MIN = 30.0   # mins restantes
PHASE1_MAX = 60.0
PHASE2_MIN = 15.0
PHASE2_MAX = 30.0
PHASE3_MIN = 0.5
PHASE3_MAX = 15.0


class ArbPhase(str, Enum):
    OUTSIDE = "OUTSIDE"   # > 60 min o < 0 → sin mercado
    PHASE1  = "PHASE1"    # 60 → 30 min: acumulación
    PHASE2  = "PHASE2"    # 30 → 15 min: monitoreo unilateral
    PHASE3  = "PHASE3"    # 15 → 0.5 min: venta a mercado
    END     = "END"       # < 0.5 min: esperar resolución


# ── Posición de arbitraje ─────────────────────────────────────────────────────

@dataclass
class ArbPosition:
    """Estado completo de una posición de arbitraje activa."""

    id:           str = field(default_factory=lambda: str(uuid.uuid4()))
    market_slug:  str = ""
    hour_utc:     int = 0

    # Patas
    up_leg_filled:   bool = False
    down_leg_filled: bool = False

    # Tokens comprados
    up_token_id:   str   = ""
    down_token_id: str   = ""
    up_tokens:     float = 0.0
    down_tokens:   float = 0.0

    # Coste real en USDC
    up_cost:   float = 0.0
    down_cost: float = 0.0

    # Precios/odds al entrar
    up_entry_odds:   float = 0.0
    down_entry_odds: float = 0.0

    # Fase en que se abrió la primera pata
    phase_entry: str = ""

    # Timestamps
    ts_up_entry:   Optional[str] = None
    ts_down_entry: Optional[str] = None
    ts_entrada:    str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    # Resultado
    balanced:         bool  = False
    phase3_exit:      bool  = False
    phase3_exit_leg:  str   = ""
    phase3_exit_odds: float = 0.0
    phase3_exit_proceeds: float = 0.0

    simulated: bool = True

    # ── Propiedades calculadas ────────────────────────────────────────────

    @property
    def total_cost(self) -> float:
        return round(self.up_cost + self.down_cost, 4)

    @property
    def pair_cost(self) -> float:
        """Coste normalizado por par (entrada de ambas patas)."""
        if self.up_leg_filled and self.down_leg_filled:
            min_t = min(self.up_tokens, self.down_tokens)
            if min_t > 0:
                # Coste total / pares completos
                pairs = min_t
                return round((self.up_cost + self.down_cost) / pairs, 6)
        return 0.0

    @property
    def ganancia_garantizada(self) -> float:
        """Ganancia neta garantizada si el par está completamente balanceado."""
        if not self.balanced:
            return 0.0
        min_t = min(self.up_tokens, self.down_tokens)
        return round((1.0 - self.pair_cost) * min_t, 4)

    @property
    def open_leg(self) -> Optional[str]:
        """'UP' | 'DOWN' según qué pata falta. None si balanceado."""
        if self.balanced:
            return None
        if self.up_leg_filled and not self.down_leg_filled:
            return "DOWN"
        if self.down_leg_filled and not self.up_leg_filled:
            return "UP"
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_phase(mins_left: float) -> ArbPhase:
    if mins_left > PHASE1_MAX:
        return ArbPhase.OUTSIDE
    elif mins_left >= PHASE1_MIN:
        return ArbPhase.PHASE1
    elif mins_left >= PHASE2_MIN:
        return ArbPhase.PHASE2
    elif mins_left >= PHASE3_MIN:
        return ArbPhase.PHASE3
    else:
        return ArbPhase.END


# ── Evaluación de oportunidad ─────────────────────────────────────────────────

def evaluate_arb(
    up_price:  float,
    down_price: float,
    mins_left:  float,
    position:   Optional[ArbPosition],
    cfg:        dict,
) -> Tuple[str, str]:
    """
    Evalúa la situación de arbitraje y devuelve (accion, motivo).

    Acciones posibles:
      "BUY_UP"    — Comprar token UP
      "BUY_DOWN"  — Comprar token DOWN
      "SELL_UP"   — Vender UP a mercado (Fase 3)
      "SELL_DOWN" — Vender DOWN a mercado (Fase 3)
      "WAIT"      — Esperar
      "BALANCED"  — Par cubierto, esperando resolución
      "NONE"      — Fuera de ventana o sin acción
    """
    arb_cfg = cfg.get("arb_strategy", {})
    entry_threshold   = float(arb_cfg.get("entry_threshold",       0.48))
    pair_threshold_p1 = float(arb_cfg.get("pair_threshold_phase1", 0.98))
    pair_threshold_p2 = float(arb_cfg.get("pair_threshold_phase2", 0.99))

    phase         = get_phase(mins_left)
    pair_cost_live = round(up_price + down_price, 4)

    # ── Par ya balanceado ──────────────────────────────────────────────────
    if position and position.balanced:
        return (
            "BALANCED",
            f"Par balanceado ✅ par_cost={position.pair_cost:.4f} "
            f"ganancia=${position.ganancia_garantizada:.4f}"
        )

    # ── Fuera de ventana ───────────────────────────────────────────────────
    if phase == ArbPhase.OUTSIDE:
        return "NONE", "Fuera de ventana horaria"

    if phase == ArbPhase.END:
        return "NONE", "Últimos segundos — sin nuevas operaciones"

    # ── Fase 3: vender pata descubierta ───────────────────────────────────
    if phase == ArbPhase.PHASE3:
        if position and not position.balanced and not position.phase3_exit:
            leg = position.open_leg
            if leg == "UP":
                return "SELL_UP",   f"Fase 3: venta UP a mercado (precio={up_price:.4f})"
            elif leg == "DOWN":
                return "SELL_DOWN", f"Fase 3: venta DOWN a mercado (precio={down_price:.4f})"
        return "NONE", "Fase 3 — sin pata descubierta"

    # ── Fase 1 y Fase 2 ────────────────────────────────────────────────────
    threshold_par = pair_threshold_p1 if phase == ArbPhase.PHASE1 else pair_threshold_p2

    no_position = position is None or (
        not position.up_leg_filled and not position.down_leg_filled
    )

    if no_position:
        # Sin posición: buscar primera pata
        if pair_cost_live >= 1.00:
            return "WAIT", (
                f"Par muy caro: {pair_cost_live:.4f} ≥ 1.00 "
                f"(UP={up_price:.4f} DOWN={down_price:.4f})"
            )

        # Comprar la pata más barata si está bajo el umbral
        if up_price <= entry_threshold and down_price <= entry_threshold:
            # Ambas baratas → comprar la más barata
            leg = "UP" if up_price <= down_price else "DOWN"
            price = up_price if leg == "UP" else down_price
            return f"BUY_{leg}", (
                f"{phase.value}: {leg}={price:.4f} ≤ umbral={entry_threshold:.4f} "
                f"(ambas elegibles, comprando más barata)"
            )
        elif up_price <= entry_threshold:
            return "BUY_UP", (
                f"{phase.value}: UP={up_price:.4f} ≤ umbral={entry_threshold:.4f}"
            )
        elif down_price <= entry_threshold:
            return "BUY_DOWN", (
                f"{phase.value}: DOWN={down_price:.4f} ≤ umbral={entry_threshold:.4f}"
            )
        else:
            return "WAIT", (
                f"Sin oportunidad: UP={up_price:.4f} DOWN={down_price:.4f} "
                f"ambas > umbral={entry_threshold:.4f}"
            )

    elif position and not position.balanced:
        # Una pata abierta: buscar cubrir la contraria
        if position.up_leg_filled:
            # Ya tenemos UP → necesitamos DOWN
            projected = round(position.up_entry_odds + down_price, 4)
            if projected <= threshold_par:
                return "BUY_DOWN", (
                    f"Cubriendo: UP={position.up_entry_odds:.4f} + DOWN={down_price:.4f} "
                    f"= {projected:.4f} ≤ {threshold_par:.4f}"
                )
            return "WAIT", (
                f"Par proyectado caro: {projected:.4f} > {threshold_par:.4f}"
            )

        elif position.down_leg_filled:
            # Ya tenemos DOWN → necesitamos UP
            projected = round(up_price + position.down_entry_odds, 4)
            if projected <= threshold_par:
                return "BUY_UP", (
                    f"Cubriendo: UP={up_price:.4f} + DOWN={position.down_entry_odds:.4f} "
                    f"= {projected:.4f} ≤ {threshold_par:.4f}"
                )
            return "WAIT", (
                f"Par proyectado caro: {projected:.4f} > {threshold_par:.4f}"
            )

    return "WAIT", "Estado indeterminado"


# ── Ejecución de órdenes ──────────────────────────────────────────────────────

def execute_arb_leg(
    leg:       str,     # "UP" | "DOWN"
    market:    dict,
    cfg:       dict,
    up_price:  float,
    down_price: float,
) -> Optional[dict]:
    """
    Compra una pata (UP o DOWN) del par de arbitraje.

    Devuelve dict con: id, leg, token_id, odds, tokens, stake, simulated
    o None si falla.
    """
    arb_cfg  = cfg.get("arb_strategy", {})
    simulate = bool(arb_cfg.get("simulate_mode", True))
    stake    = float(arb_cfg.get("stake_per_leg_usdc", 5.0))

    # ── Obtener token ID ──────────────────────────────────────────────────
    tokens_dict = market.get("tokens", {})
    token_data  = tokens_dict.get(leg, {})
    token_id    = token_data.get("token_id", "")
    price       = up_price if leg == "UP" else down_price

    if not token_id:
        logger.error(f"[ARB_STRATEGY] token_id no encontrado para leg={leg}. tokens={tokens_dict}")
        return None

    tokens_bought = round(stake / max(price, 0.001), 4)

    # ── Modo simulado ─────────────────────────────────────────────────────
    if simulate:
        order_id = str(uuid.uuid4())
        logger.info(
            f"[ARB_STRATEGY] 🔵 [SIM] BUY {leg}: "
            f"odds={price:.4f}  stake=${stake:.2f}  tokens={tokens_bought:.4f}"
        )
        return {
            "id":        order_id,
            "leg":       leg,
            "token_id":  token_id,
            "odds":      price,
            "tokens":    tokens_bought,
            "stake":     stake,
            "simulated": True,
        }

    # ── Modo real ─────────────────────────────────────────────────────────
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import (
            ApiCreds, MarketOrderArgs, OrderType, CreateOrderOptions,
        )
        from py_clob_client.constants import POLYGON

        api_key  = os.environ.get("CLOB_API_KEY",  "")
        secret   = os.environ.get("CLOB_SECRET",   "")
        passph   = os.environ.get("CLOB_PASS",     "")
        pk       = os.environ.get("PRIVATE_KEY",   "")

        if not all([api_key, secret, passph, pk]):
            logger.error("[ARB_STRATEGY] Credenciales L2 incompletas")
            return None

        creds  = ApiCreds(api_key=api_key, api_secret=secret, api_passphrase=passph)
        client = ClobClient(
            "https://clob.polymarket.com",
            key=pk, chain_id=POLYGON,
            creds=creds, signature_type=1,
        )
        neg_risk    = bool(market.get("neg_risk", False))
        order_args  = MarketOrderArgs(token_id=token_id, amount=stake)
        signed      = client.create_market_order(
            order_args, CreateOrderOptions(neg_risk=neg_risk, tick_size=None)
        )
        resp = client.post_order(signed, OrderType.FOK)

        if not resp:
            logger.error(f"[ARB_STRATEGY] CLOB sin respuesta para BUY {leg}")
            return None

        order_id = resp.get("orderID") or resp.get("id") or str(uuid.uuid4())
        logger.info(
            f"[ARB_STRATEGY] ✅ BUY {leg}: "
            f"id={order_id}  odds={price:.4f}  stake=${stake:.2f}  tokens={tokens_bought:.4f}"
        )
        return {
            "id":        order_id,
            "leg":       leg,
            "token_id":  token_id,
            "odds":      price,
            "tokens":    tokens_bought,
            "stake":     stake,
            "simulated": False,
        }

    except Exception as e:
        logger.error(f"[ARB_STRATEGY] Error BUY {leg}: {e}")
        return None


def execute_arb_sell(
    leg:           str,
    market:        dict,
    cfg:           dict,
    tokens:        float,
    current_price: float,
) -> Optional[dict]:
    """
    Vende tokens de una pata descubierta en Fase 3.

    Devuelve dict con: leg, odds, tokens, proceeds, simulated
    o None si falla.
    """
    arb_cfg  = cfg.get("arb_strategy", {})
    simulate = bool(arb_cfg.get("simulate_mode", True))

    proceeds = round(tokens * current_price, 4)

    if simulate:
        logger.info(
            f"[ARB_STRATEGY] 🔵 [SIM] SELL {leg}: "
            f"{tokens:.4f} × {current_price:.4f} = ${proceeds:.4f}"
        )
        return {
            "leg":       leg,
            "odds":      current_price,
            "tokens":    tokens,
            "proceeds":  proceeds,
            "simulated": True,
        }

    # ── Modo real: sell order en CLOB ─────────────────────────────────────
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import (
            ApiCreds, MarketOrderArgs, OrderType, CreateOrderOptions,
        )
        from py_clob_client.constants import POLYGON

        tokens_dict = market.get("tokens", {})
        token_id    = tokens_dict.get(leg, {}).get("token_id", "")

        if not token_id:
            logger.error(f"[ARB_STRATEGY] token_id no encontrado para SELL {leg}")
            return None

        api_key = os.environ.get("CLOB_API_KEY", "")
        secret  = os.environ.get("CLOB_SECRET",  "")
        passph  = os.environ.get("CLOB_PASS",    "")
        pk      = os.environ.get("PRIVATE_KEY",  "")

        if not all([api_key, secret, passph, pk]):
            logger.error("[ARB_STRATEGY] Credenciales L2 incompletas para SELL")
            return None

        creds  = ApiCreds(api_key=api_key, api_secret=secret, api_passphrase=passph)
        client = ClobClient(
            "https://clob.polymarket.com",
            key=pk, chain_id=POLYGON,
            creds=creds, signature_type=1,
        )
        neg_risk   = bool(market.get("neg_risk", False))
        # Sell = market order del lado contrario (SELL side)
        order_args = MarketOrderArgs(token_id=token_id, amount=tokens, side="SELL")
        signed     = client.create_market_order(
            order_args, CreateOrderOptions(neg_risk=neg_risk, tick_size=None)
        )
        resp = client.post_order(signed, OrderType.FOK)

        if not resp:
            logger.error(f"[ARB_STRATEGY] CLOB sin respuesta para SELL {leg}")
            return None

        logger.info(
            f"[ARB_STRATEGY] ✅ SELL {leg}: "
            f"{tokens:.4f} tokens @ {current_price:.4f} = ${proceeds:.4f}"
        )
        return {
            "leg":       leg,
            "odds":      current_price,
            "tokens":    tokens,
            "proceeds":  proceeds,
            "simulated": False,
        }

    except Exception as e:
        logger.error(f"[ARB_STRATEGY] Error SELL {leg}: {e}")
        return None
