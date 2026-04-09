"""
strategy.py — Lógica de decisión UP/DOWN y ejecución de órdenes CLOB

v8.3 — CTF Exchange V2 (abril 2026) + feeRateBps (febrero 2026)
  - fee_rate_bps=156 añadido a todos los OrderArgs (BUY y SELL).
    Polymarket exige este campo desde feb 2026; sin él las órdenes son
    rechazadas. 156 bps = 1.56% (máximo taker fee; el cargo real es menor
    o cero para makers — el campo es solo un acknowledgment de aceptación).
  - SDK mínimo: py-clob-client>=0.19.0 (requerido para CTF Exchange V2).

v8.2 — SELL POSITION (fallback de claim)
v8.1 — FIX CRÍTICO: id único en execute_order
v8.0 — min_retorno_pct
v3.0 — Modo SIMULADO explícito

Destino: bot/modules/strategy.py
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


_last_window: str | None = None


def evaluate(price: float, target: float, mins_left: float, cfg: dict) -> "Signal | None":
    global _last_window

    window = get_active_window(mins_left, cfg)

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

    host        = "https://clob.polymarket.com"
    private_key = cfg["polymarket"]["private_key"]
    funder      = cfg["polymarket"]["funder"]
    chain_id    = cfg["polymarket"]["chain_id"]
    sig_type    = cfg["polymarket"]["signature_type"]
    api_key     = cfg["polymarket"].get("api_key", "")
    api_secret  = cfg["polymarket"].get("api_secret", "")
    api_pass    = cfg["polymarket"].get("api_passphrase", "")

    if not all([api_key, api_secret, api_pass]):
        raise ValueError(
            "Faltan credenciales Level 2: polymarket.api_key / api_secret / api_passphrase"
        )

    creds = ApiCreds(api_key=api_key, api_secret=api_secret, api_passphrase=api_pass)
    client = ClobClient(
        host,
        key=private_key,
        chain_id=chain_id,
        signature_type=sig_type,
        funder=funder,
        creds=creds,
    )
    return client


# ── Orden de compra (BUY) ─────────────────────────────────────────────────────

def execute_order(signal: Signal, market: dict, cfg: dict) -> dict | None:
    """
    Ejecuta una orden BUY en el CLOB de Polymarket.

    v8.3: fee_rate_bps=156 incluido en OrderArgs — requerido desde feb 2026.
    """
    simulate_mode = cfg.get("strategy", {}).get("simulate_mode", False)
    stake         = cfg["capital"]["stake_usdc"]

    tokens_raw = market.get("tokens", [])
    if not isinstance(tokens_raw, list):
        tokens_raw = []

    direction_val = signal.direction.value

    token_id   = None
    entry_odds = 0.5
    for t in tokens_raw:
        outcome = t.get("outcome", "").lower()
        if direction_val == "UP" and outcome == "yes":
            token_id   = t.get("token_id")
            entry_odds = float(t.get("price", 0.5))
            break
        if direction_val == "DOWN" and outcome == "no":
            token_id   = t.get("token_id")
            entry_odds = float(t.get("price", 0.5))
            break

    if not token_id:
        logger.error(
            f"[ORDER] ❌ No se encontró token_id para {direction_val} — "
            f"tokens en mercado: {[t.get('outcome') for t in tokens_raw]}"
        )
        return None

    size = round(stake / max(entry_odds, 0.001), 4)

    min_ret_pct = cfg.get("strategy", {}).get("min_retorno_pct", 0)
    if min_ret_pct > 0:
        ret_est_pct = ((1.0 / max(entry_odds, 0.001)) - 1.0) * 100
        if ret_est_pct < min_ret_pct:
            logger.info(
                f"[ORDER] ⏭ Retorno estimado {ret_est_pct:.1f}% < mínimo {min_ret_pct}% — "
                f"orden no ejecutada (odds={entry_odds:.4f})"
            )
            return None

    logger.info(
        f"[ORDER] {'[SIMULADO] ' if simulate_mode else ''}Preparando orden {direction_val}\n"
        f"         Token ID  : {token_id[:16]}...\n"
        f"         Odds impl.: {entry_odds:.4f}  ({entry_odds*100:.1f}%)\n"
        f"         Size      : {size:.4f} tokens\n"
        f"         Coste est.: ${entry_odds * size:.2f} USDC"
    )

    if simulate_mode:
        op_id = str(uuid.uuid4())
        logger.warning(
            f"[ORDER] 🟡 [SIMULADO] Orden NO enviada al CLOB\n"
            f"         ID        : {op_id}\n"
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

    try:
        from py_clob_client.clob_types import OrderArgs, CreateOrderOptions

        neg_risk = bool(market.get("neg_risk", False))
        client   = _build_clob_client(cfg)

        order_args = OrderArgs(
            token_id=token_id,
            price=entry_odds,
            size=size,
            side="BUY",
            fee_rate_bps=156,   # ← v8.3: obligatorio desde feb 2026 (CTF Exchange V2)
        )

        logger.info(f"[ORDER] 📤 Enviando orden FOK BUY al CLOB (fee_rate_bps=156)...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = (
            resp.get("orderID")
            or resp.get("id")
            or str(uuid.uuid4())
        )
        status     = resp.get("status", "—")
        filled     = resp.get("sizeFilled", resp.get("size_filled", "—"))
        fill_price = resp.get("avgPrice") or resp.get("price") or resp.get("avg_price")
        actual_odds = float(fill_price) if fill_price else entry_odds

        logger.info(
            f"[ORDER] ✅ Orden BUY ejecutada:\n"
            f"         Order ID  : {order_id}\n"
            f"         Status    : {status}\n"
            f"         Filled    : {filled}\n"
            f"         Odds real : {actual_odds:.4f}\n"
            f"         Raw resp  : {resp}"
        )

        return {**resp, "id": order_id, "odds": actual_odds, "simulated": False}

    except ImportError:
        op_id = str(uuid.uuid4())
        logger.warning(
            f"[ORDER] ⚠ py-clob-client no instalado — modo SIMULACIÓN\n"
            f"         ID        : {op_id}\n"
            f"         Orden simulada: {direction_val} ${stake} USDC  Odds: {entry_odds:.4f}"
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
    v8.3: fee_rate_bps=0 en SELL — los makers no pagan fee en CTF Exchange V2.
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
            fee_rate_bps=0,     # ← v8.3: makers sin fee en CTF Exchange V2
        )

        logger.info(f"[SELL] 📤 Enviando orden SELL al CLOB (fee_rate_bps=0)...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = (
            resp.get("orderID")
            or resp.get("id")
            or str(uuid.uuid4())
        )
        status = resp.get("status", "—")
        filled = resp.get("sizeFilled", resp.get("size_filled", "—"))

        logger.info(
            f"[SELL] ✅ Orden SELL ejecutada:\n"
            f"       Order ID : {order_id}\n"
            f"       Status   : {status}\n"
            f"       Filled   : {filled}\n"
            f"       Raw resp : {resp}"
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
