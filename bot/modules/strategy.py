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


_last_window: str | None = None   # para detectar transiciones de ventana


def evaluate(price: float, target: float, mins_left: float, cfg: dict) -> "Signal | None":
    """
    Evalúa si hay señal en la ventana activa.
    Devuelve Signal o None si estamos fuera de ventana.
    """
    global _last_window

    window = get_active_window(mins_left, cfg)

    # ── Fuera de ventana ──────────────────────────────────────────────────
    if window is None:
        if _last_window is not None:
            logger.info(
                f"[STRATEGY] ⏸  Salida de ventana {_last_window} — "
                f"mins_left={mins_left:.1f}  esperando próxima ventana"
            )
            _last_window = None
        else:
            logger.debug(f"[STRATEGY] Fuera de ventana — mins_left={mins_left:.1f}")
        return None

    # ── Transición de ventana ─────────────────────────────────────────────
    if _last_window != window["key"]:
        prev = _last_window or "—"
        logger.info(
            f"[STRATEGY] 🪟 NUEVA VENTANA: {prev} → {window['key']}  "
            f"({window['min']}–{window['max']} min antes del cierre)"
        )
        _last_window = window["key"]

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

    # ── Log detallado de evaluación ───────────────────────────────────────
    dist_abs  = abs(distance)
    dist_sign = "+" if distance >= 0 else ""
    action    = "✅ ACCIONABLE" if signal.is_actionable else "⏳ WAIT"

    logger.info(
        f"[STRATEGY] [{window['key']}] "
        f"Price=${price:,.2f}  Target=${target:,.2f}  "
        f"Dist={dist_sign}{distance:,.0f}  Umbral={umbral}  "
        f"→ {direction.value}  {action}"
    )

    if signal.is_actionable:
        logger.info(
            f"[STRATEGY] 🎯 Señal {direction.value}: "
            f"distancia ${dist_abs:,.0f} {'>' if direction == Direction.UP else '<'} "
            f"umbral ${umbral} en ventana {window['key']}"
        )
    else:
        logger.debug(
            f"[STRATEGY] Sin señal: |dist| ${dist_abs:,.0f} < umbral ${umbral}"
        )

    return signal


def execute_order(signal: Signal, market: dict, cfg: dict) -> dict | None:
    """
    Ejecuta una orden Market FOK en el CLOB de Polymarket.
    Devuelve el resultado de la orden o None si falla.
    """
    stake    = cfg["capital"]["stake_usdc"]
    tokens   = market.get("tokens", [])
    yes_tok  = next((t for t in tokens if t.get("outcome") == "Yes"), None)
    no_tok   = next((t for t in tokens if t.get("outcome") == "No"),  None)
    token    = yes_tok if signal.direction == Direction.UP else no_tok

    logger.info(
        f"[ORDER] Preparando orden:\n"
        f"         Dirección : {signal.direction.value}\n"
        f"         Ventana   : {signal.window}\n"
        f"         Price     : ${signal.price:,.2f}\n"
        f"         Target    : ${signal.target:,.2f}\n"
        f"         Dist      : {signal.distance:+,.0f}\n"
        f"         Stake     : ${stake} USDC"
    )

    if not token:
        logger.error(
            f"[ORDER] ❌ Token {signal.direction.value} no encontrado en el mercado.\n"
            f"         Tokens disponibles: {[t.get('outcome') for t in tokens]}"
        )
        return None

    token_id = token["token_id"]
    price    = float(token.get("price", 0.5))
    size     = round(stake / price, 4)

    logger.info(
        f"[ORDER] Parámetros CLOB:\n"
        f"         Token ID  : {token_id}\n"
        f"         Precio    : {price:.4f}  (prob. implícita {price*100:.1f}%)\n"
        f"         Size      : {size:.4f} tokens\n"
        f"         Coste est.: ${price * size:.2f} USDC"
    )

    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds, OrderArgs, OrderType

        host        = "https://clob.polymarket.com"
        private_key = cfg["polymarket"]["private_key"]
        funder      = cfg["polymarket"]["funder"]
        chain_id    = cfg["polymarket"]["chain_id"]
        sig_type    = cfg["polymarket"]["signature_type"]

        logger.debug(
            f"[ORDER] Conectando a CLOB — host={host}  chain={chain_id}  sig_type={sig_type}"
        )

        client = ClobClient(
            host,
            key=private_key,
            chain_id=chain_id,
            signature_type=sig_type,
            funder=funder,
        )

        order_args = OrderArgs(
            token_id=token_id,
            price=price,
            size=size,
            side="BUY",
        )

        logger.info(f"[ORDER] 📤 Enviando orden FOK al CLOB...")
        resp = client.create_and_post_order(order_args, OrderType.FOK)

        order_id = resp.get("orderID", resp.get("id", "—"))
        status   = resp.get("status", "—")
        filled   = resp.get("sizeFilled", resp.get("size_filled", "—"))

        logger.info(
            f"[ORDER] ✅ Orden ejecutada:\n"
            f"         Order ID  : {order_id}\n"
            f"         Status    : {status}\n"
            f"         Filled    : {filled}\n"
            f"         Raw resp  : {resp}"
        )
        return resp

    except ImportError:
        logger.warning(
            f"[ORDER] ⚠ py-clob-client no instalado — ejecutando en modo SIMULACIÓN\n"
            f"         Orden simulada: {signal.direction.value} ${stake} USDC"
        )
        return {
            "simulated": True,
            "direction": signal.direction.value,
            "stake": stake,
            "token_id": token_id,
            "price": price,
            "size": size,
        }

    except Exception as e:
        logger.error(
            f"[ORDER] ❌ Error ejecutando orden en CLOB:\n"
            f"         Tipo  : {type(e).__name__}\n"
            f"         Error : {e}",
            exc_info=True,
        )
        return None
