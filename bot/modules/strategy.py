"""
strategy.py — Lógica de decisión UP/DOWN y ejecución de órdenes CLOB
"""
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class Direction(str, Enum):
    UP   = "UP"
    DOWN = "DOWN"
    WAIT = "WAIT"


WINDOWS = [
    {"key": "T-20", "min": 17, "max": 22, "config": "t20_umbral_usd"},
    {"key": "T-15", "min": 12, "max": 17, "config": "t15_umbral_usd"},
    {"key": "T-10", "min":  7, "max": 12, "config": "t10_umbral_usd"},
    {"key": "T-5",  "min":  2, "max":  7, "config": "t5_umbral_usd" },
]


@dataclass
class Signal:
    direction:  Direction
    distance:   float
    target:     float
    price:      float
    umbral:     float
    window:     str
    ts:         datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def is_actionable(self) -> bool:
        return self.direction in (Direction.UP, Direction.DOWN)


def get_active_window(mins_left: float, cfg: dict) -> dict | None:
    for w in WINDOWS:
        if w["min"] <= mins_left < w["max"]:
            return w
    return None


def evaluate(price: float, target: float, mins_left: float, cfg: dict) -> Signal | None:
    """
    Evalúa si hay señal en la ventana activa.
    Devuelve Signal o None si estamos fuera de ventana.
    """
    window = get_active_window(mins_left, cfg)
    if window is None:
        return None

    umbral   = cfg["strategy"][window["config"]]
    distance = price - target

    if distance > umbral:
        direction = Direction.UP
    elif distance < -umbral:
        direction = Direction.DOWN
    else:
        direction = Direction.WAIT

    signal = Signal(
        direction=direction,
        distance=distance,
        target=target,
        price=price,
        umbral=umbral,
        window=window["key"],
    )

    logger.info(
        f"[{window['key']}] Price=${price:,.2f} Target=${target:,.2f} "
        f"Dist={distance:+.0f} Umbral={umbral} → {direction.value}"
    )
    return signal


def execute_order(signal: Signal, market: dict, cfg: dict) -> dict | None:
    """
    Ejecuta una orden Market FOK en el CLOB de Polymarket.
    Devuelve el resultado de la orden o None si falla.
    """
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds, OrderArgs, OrderType

        host        = "https://clob.polymarket.com"
        private_key = cfg["polymarket"]["private_key"]
        funder      = cfg["polymarket"]["funder"]
        chain_id    = cfg["polymarket"]["chain_id"]
        sig_type    = cfg["polymarket"]["signature_type"]
        stake       = cfg["capital"]["stake_usdc"]

        client = ClobClient(
            host,
            key=private_key,
            chain_id=chain_id,
            signature_type=sig_type,
            funder=funder,
        )

        # Token del outcome correcto
        tokens   = market.get("tokens", [])
        yes_tok  = next((t for t in tokens if t.get("outcome") == "Yes"), None)
        no_tok   = next((t for t in tokens if t.get("outcome") == "No"),  None)
        token    = yes_tok if signal.direction == Direction.UP else no_tok

        if not token:
            logger.error("Token UP/DOWN no encontrado en el mercado")
            return None

        token_id = token["token_id"]
        price    = float(token.get("price", 0.5))
        size     = round(stake / price, 4)

        order_args = OrderArgs(
            token_id=token_id,
            price=price,
            size=size,
            side="BUY",
        )

        resp = client.create_and_post_order(order_args, OrderType.FOK)
        logger.info(f"Orden ejecutada: {resp}")
        return resp

    except ImportError:
        logger.warning("py-clob-client no instalado — modo simulación")
        return {"simulated": True, "direction": signal.direction.value, "stake": cfg["capital"]["stake_usdc"]}
    except Exception as e:
        logger.error(f"Error ejecutando orden: {e}")
        return None
