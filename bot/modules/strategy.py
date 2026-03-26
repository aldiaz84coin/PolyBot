# bot/modules/strategy.py
"""
strategy.py — Lógica de decisión UP/DOWN y ejecución de órdenes CLOB

v9.0 cambios:
  - Nuevas ventanas de evaluación: T-50, T-40, T-30, T-25 (antes de T-20)
    Permiten detectar condiciones y ejecutar órdenes en el primer tercio
    de la vela horaria. Cada ventana tiene su propio umbral configurable.
    Gaps intencionales: no hay ventana entre T-30 y T-40, ni entre T-40 y T-50.

v8.2 — sell_position (fallback de claim)
v8.1 — FIX CRÍTICO: id único en execute_order
v8.0 — min_retorno_pct
v3.0 — Modo SIMULADO explícito
"""
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class Direction(str, Enum):
    UP   = "UP"
    DOWN = "DOWN"
    WAIT = "WAIT"


# ── Ventanas de evaluación ────────────────────────────────────────────────────
# Orden: de más lejos al cierre a más cerca.
# Gaps intencionales: 32-37 min (entre T-30 y T-40) y 42-47 min (entre T-40 y T-50).
# min/max = minutos restantes antes del cierre de la vela.

WINDOWS = [
    {"key": "T-50", "min": 47, "max": 52, "config": "t50_umbral_usd"},
    {"key": "T-40", "min": 37, "max": 42, "config": "t40_umbral_usd"},
    {"key": "T-30", "min": 27, "max": 32, "config": "t30_umbral_usd"},
    {"key": "T-25", "min": 22, "max": 27, "config": "t25_umbral_usd"},
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


# ── Helper: construye ClobClient con Level 2 ─────────────────────────────────

def _build_clob_client(cfg: dict):
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import ApiCreds

    host        = cfg["polymarket"].get("clob_host", "https://clob.polymarket.com")
    chain_id    = int(cfg["polymarket"].get("chain_id", 137))
    api_key     = cfg["polymarket"]["api_key"]
    api_secret  = cfg["polymarket"]["api_secret"]
    api_pass    = cfg["polymarket"]["api_passphrase"]
    private_key = cfg["polymarket"]["private_key"]

    if not all([api_key, api_secret, api_pass, private_key]):
        raise ValueError("Faltan credenciales L2 en config (api_key/secret/passphrase/private_key)")

    creds  = ApiCreds(api_key=api_key, api_secret=api_secret, api_passphrase=api_pass)
    client = ClobClient(host, key=private_key, chain_id=chain_id, creds=creds)
    return client


# ── Ejecutar orden de compra ──────────────────────────────────────────────────

def execute_order(signal: Signal, market: dict, cfg: dict) -> dict | None:
    """
    Ejecuta una orden Market FOK en el CLOB de Polymarket.

    Devuelve el resultado de la orden o None si falla.
    Siempre incluye "odds" = precio real del token en Polymarket.

    MODO SIMULADO (cfg["strategy"]["simulate_mode"] = True):
      No se conecta al CLOB. Registra la operación como si fuera real,
      con la misma estructura de respuesta, marcada con simulated=True.
      Activar con env var SIMULATE_MODE=true en Railway.

    MARGEN MÍNIMO (cfg["strategy"]["min_retorno_pct"]):
      Si el retorno estimado (1/odds - 1)*100 es inferior al mínimo,
      la orden se descarta (devuelve None) antes de ejecutarse.
    """
    simulate_mode    = cfg["strategy"].get("simulate_mode", False)
    min_retorno_pct  = float(cfg["strategy"].get("min_retorno_pct", 0))
    stake            = float(cfg["strategy"].get("stake_usdc", 1.0))
    direction_val    = signal.direction.value

    # Token ID según dirección — usa market["tokens"] (formato estándar del bot)
    tokens_list    = market.get("tokens", [])
    target_outcome = "Yes" if signal.direction == Direction.UP else "No"
    token_obj      = next((t for t in tokens_list if t.get("outcome") == target_outcome), None)

    if not token_obj or not token_obj.get("token_id"):
        logger.error(
            f"[ORDER] ❌ Token {target_outcome} no encontrado en market.tokens\n"
            f"         Tokens disponibles: {[t.get('outcome') for t in tokens_list]}"
        )
        return None

    token_id = token_obj["token_id"]

    # Precio de entrada: midpoint CLOB live
    from .market_scanner import get_clob_price
    entry_odds = get_clob_price(token_id)
    if entry_odds is None or entry_odds <= 0:
        logger.error(f"[ORDER] ❌ No se pudo obtener precio CLOB para token {token_id[:12]}...")
        return None

    size = round(stake / entry_odds, 4)

    # Filtro de retorno mínimo
    retorno_est_pct = (1 / entry_odds - 1) * 100
    if min_retorno_pct > 0 and retorno_est_pct < min_retorno_pct:
        logger.info(
            f"[ORDER] ⛔ Retorno estimado {retorno_est_pct:.1f}% < mínimo {min_retorno_pct}% "
            f"— orden descartada"
        )
        return None

    logger.info(
        f"[ORDER] {'🟡 [SIMULADO]' if simulate_mode else '📤'} Preparando BUY "
        f"{direction_val}  Ventana: {signal.window}\n"
        f"         Odds: {entry_odds:.4f}  ({entry_odds*100:.1f}%)\n"
        f"         Size: {size:.4f} tokens\n"
        f"         Coste est.: ${entry_odds * size:.2f} USDC"
    )

    # ── MODO SIMULADO ─────────────────────────────────────────────────────
    if simulate_mode:
        op_id = str(uuid.uuid4())
        logger.warning(
            f"[ORDER] 🟡 [SIMULADO] Orden NO enviada al CLOB\n"
            f"         ID: {op_id}\n"
            f"         {direction_val} {size:.4f} tokens × {entry_odds:.4f} = ${stake} USDC"
        )
        return {
            "id":        op_id,
            "simulated": True,
            "direction": direction_val,
            "stake":     stake,
            "token_id":  token_id,
            "price":     entry_odds,
            "size":      size,
            "odds":      entry_odds,
        }

    # ── MODO REAL ─────────────────────────────────────────────────────────
    try:
        from py_clob_client.clob_types import OrderArgs, CreateOrderOptions

        neg_risk = bool(market.get("neg_risk", False))
        client   = _build_clob_client(cfg)

        order_args = OrderArgs(
            token_id=token_id,
            price=entry_odds,
            size=size,
            side="BUY",
        )

        logger.info("[ORDER] 📤 Enviando orden FOK BUY al CLOB...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = (
            resp.get("orderID")
            or resp.get("id")
            or str(uuid.uuid4())
        )
        fill_price  = resp.get("avgPrice") or resp.get("price") or resp.get("avg_price")
        actual_odds = float(fill_price) if fill_price else entry_odds

        logger.info(
            f"[ORDER] ✅ Orden BUY ejecutada:\n"
            f"         Order ID  : {order_id}\n"
            f"         Status    : {resp.get('status', '—')}\n"
            f"         Filled    : {resp.get('sizeFilled', resp.get('size_filled', '—'))}\n"
            f"         Odds real : {actual_odds:.4f}"
        )

        return {**resp, "id": order_id, "odds": actual_odds, "simulated": False}

    except ImportError:
        op_id = str(uuid.uuid4())
        logger.warning(
            f"[ORDER] ⚠ py-clob-client no instalado — modo SIMULACIÓN\n"
            f"         {direction_val} {size:.4f} tokens × {entry_odds:.4f}"
        )
        return {
            "id":        op_id,
            "simulated": True,
            "direction": direction_val,
            "stake":     stake,
            "token_id":  token_id,
            "price":     entry_odds,
            "size":      size,
            "odds":      entry_odds,
        }

    except ValueError as e:
        logger.error(f"[ORDER] ❌ Credenciales L2: {e}")
        return None

    except Exception as e:
        logger.error(
            f"[ORDER] ❌ Error ejecutando orden BUY en CLOB:\n"
            f"         Tipo  : {type(e).__name__}\n"
            f"         Error : {e}",
            exc_info=True,
        )
        return None


# ── Orden de venta (SELL) — fallback de claim ─────────────────────────────────

def sell_position(
    token_id:   str,
    tokens:     float,
    sell_price: float,
    cfg:        dict,
    market:     dict,
) -> dict | None:
    """
    v8.2: Vende tokens ganadores en el CLOB (fallback cuando el claim on-chain falla).
    """
    logger.info(
        f"[SELL] Preparando orden SELL\n"
        f"       Token ID   : {token_id[:16]}...\n"
        f"       Tokens     : {tokens:.4f}\n"
        f"       Sell price : {sell_price:.4f}\n"
        f"       USDC est.  : ~{tokens * sell_price:.4f}"
    )

    try:
        from py_clob_client.clob_types import OrderArgs, CreateOrderOptions

        neg_risk = bool(market.get("neg_risk", False))
        client   = _build_clob_client(cfg)

        order_args = OrderArgs(
            token_id=token_id,
            price=sell_price,
            size=tokens,
            side="SELL",
        )

        logger.info("[SELL] 📤 Enviando orden SELL al CLOB...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = resp.get("orderID") or resp.get("id") or str(uuid.uuid4())

        logger.info(
            f"[SELL] ✅ Orden SELL ejecutada:\n"
            f"       Order ID : {order_id}\n"
            f"       Status   : {resp.get('status', '—')}"
        )

        return {**resp, "id": order_id, "price": sell_price, "tokens": tokens}

    except ImportError:
        logger.error("[SELL] ❌ py-clob-client no disponible — SELL no ejecutado")
        return None

    except ValueError as e:
        logger.error(f"[SELL] ❌ Credenciales L2: {e}")
        return None

    except Exception as e:
        logger.error(
            f"[SELL] ❌ Error ejecutando SELL en CLOB:\n"
            f"       Tipo  : {type(e).__name__}\n"
            f"       Error : {e}",
            exc_info=True,
        )
        return None
