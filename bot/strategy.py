"""
strategy.py — Lógica de decisión UP/DOWN y ejecución de órdenes CLOB

v8.0 cambios:
  - min_retorno_pct: retorno mínimo estimado para entrar en una apuesta.
    Aplica en modo simulado Y real. Si odds implican retorno < umbral,
    execute_order() devuelve None sin ejecutar.
    Configurar en config.yaml: strategy.min_retorno_pct (0 = desactivado).

v3.0 cambios:
  - Modo SIMULADO explícito vía cfg["strategy"]["simulate_mode"] (env SIMULATE_MODE=true).
    Ya no dependemos de ImportError de py_clob_client para simular.
  - execute_order siempre devuelve "odds" (precio real del token).
  - Log claro [SIMULADO] en todas las operaciones simuladas.
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
    Siempre incluye "odds" = precio real del token en Polymarket.

    MODO SIMULADO (cfg["strategy"]["simulate_mode"] = True):
      No se conecta al CLOB. Registra la operación como si fuera real,
      con la misma estructura de respuesta, marcada con simulated=True.
      Activar con env var SIMULATE_MODE=true en Railway.

    MARGEN MÍNIMO (cfg["strategy"]["min_retorno_pct"]):
      Si el retorno estimado (1/odds - 1)*100 es inferior al mínimo,
      la orden se descarta (devuelve None) antes de ejecutarse.
    """
    simulate_mode = cfg.get("strategy", {}).get("simulate_mode", False)
    stake         = cfg["capital"]["stake_usdc"]
    tokens        = market.get("tokens", [])
    yes_tok       = next((t for t in tokens if t.get("outcome") == "Yes"), None)
    no_tok        = next((t for t in tokens if t.get("outcome") == "No"),  None)
    token         = yes_tok if signal.direction == Direction.UP else no_tok

    logger.info(
        f"[ORDER] {'[SIMULADO] ' if simulate_mode else ''}Preparando orden:\n"
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

    token_id   = token["token_id"]
    entry_odds = float(token.get("price", 0.5))
    size       = round(stake / max(entry_odds, 0.001), 4)

    # ── v8.0: Margen mínimo de retorno ────────────────────────────────────
    min_retorno_pct = cfg.get("strategy", {}).get("min_retorno_pct", 0.0)
    if min_retorno_pct > 0.0:
        retorno_est = (1.0 / max(entry_odds, 0.001) - 1.0) * 100
        if retorno_est < min_retorno_pct:
            logger.info(
                f"[ORDER] ⏭ Retorno estimado {retorno_est:.1f}% < mínimo {min_retorno_pct:.1f}% "
                f"(odds={entry_odds:.4f}) — apuesta descartada por margen insuficiente"
            )
            return None
        logger.info(
            f"[ORDER] ✅ Retorno estimado {retorno_est:.1f}% ≥ mínimo {min_retorno_pct:.1f}% "
            f"(odds={entry_odds:.4f}) — margen OK"
        )
    # ─────────────────────────────────────────────────────────────────────

    logger.info(
        f"[ORDER] Parámetros CLOB:\n"
        f"         Token ID  : {token_id}\n"
        f"         Precio    : {entry_odds:.4f}  (prob. implícita {entry_odds*100:.1f}%)\n"
        f"         Size      : {size:.4f} tokens\n"
        f"         Coste est.: ${entry_odds * size:.2f} USDC"
    )

    # ── MODO SIMULADO: no llamar al CLOB ─────────────────────────────────
    if simulate_mode:
        logger.warning(
            f"[ORDER] 🟡 [SIMULADO] Orden NO enviada al CLOB\n"
            f"         {signal.direction.value} {size:.4f} tokens × {entry_odds:.4f} = ${stake} USDC"
        )
        return {
            "simulated": True,
            "direction": signal.direction.value,
            "stake":     stake,
            "token_id":  token_id,
            "price":     entry_odds,
            "size":      size,
            "odds":      entry_odds,
        }

    # ── MODO REAL: ejecutar en CLOB ───────────────────────────────────────
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds, OrderArgs, CreateOrderOptions

        host        = "https://clob.polymarket.com"
        private_key = cfg["polymarket"]["private_key"]
        funder      = cfg["polymarket"]["funder"]
        chain_id    = cfg["polymarket"]["chain_id"]
        sig_type    = cfg["polymarket"]["signature_type"]

        api_key        = cfg["polymarket"].get("api_key", "")
        api_secret     = cfg["polymarket"].get("api_secret", "")
        api_passphrase = cfg["polymarket"].get("api_passphrase", "")

        if not all([api_key, api_secret, api_passphrase]):
            logger.error(
                "[ORDER] ❌ Faltan credenciales Level 2 en config:\n"
                "         Necesitas polymarket.api_key, api_secret y api_passphrase\n"
                "         (o las vars POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE)"
            )
            return None

        creds = ApiCreds(
            api_key=api_key,
            api_secret=api_secret,
            api_passphrase=api_passphrase,
        )

        neg_risk = bool(market.get("neg_risk", False))

        logger.debug(
            f"[ORDER] Conectando a CLOB — host={host}  chain={chain_id}  "
            f"sig_type={sig_type}  neg_risk={neg_risk}  "
            f"api_key={api_key[:8]}..."
        )

        client = ClobClient(
            host,
            key=private_key,
            chain_id=chain_id,
            signature_type=sig_type,
            funder=funder,
            creds=creds,
        )

        order_args = OrderArgs(
            token_id=token_id,
            price=entry_odds,
            size=size,
            side="BUY",
        )

        logger.info(f"[ORDER] 📤 Enviando orden FOK al CLOB...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = resp.get("orderID", resp.get("id", "—"))
        status   = resp.get("status", "—")
        filled   = resp.get("sizeFilled", resp.get("size_filled", "—"))

        fill_price  = resp.get("avgPrice") or resp.get("price") or resp.get("avg_price")
        actual_odds = float(fill_price) if fill_price else entry_odds

        logger.info(
            f"[ORDER] ✅ Orden ejecutada:\n"
            f"         Order ID  : {order_id}\n"
            f"         Status    : {status}\n"
            f"         Filled    : {filled}\n"
            f"         Odds real : {actual_odds:.4f}\n"
            f"         Raw resp  : {resp}"
        )

        return {**resp, "odds": actual_odds}

    except ImportError:
        logger.warning(
            f"[ORDER] ⚠ py-clob-client no instalado — ejecutando en modo SIMULACIÓN\n"
            f"         Orden simulada: {signal.direction.value} ${stake} USDC  "
            f"Odds: {entry_odds:.4f}"
        )
        return {
            "simulated": True,
            "direction": signal.direction.value,
            "stake":     stake,
            "token_id":  token_id,
            "price":     entry_odds,
            "size":      size,
            "odds":      entry_odds,
        }

    except Exception as e:
        logger.error(
            f"[ORDER] ❌ Error ejecutando orden en CLOB:\n"
            f"         Tipo  : {type(e).__name__}\n"
            f"         Error : {e}",
            exc_info=True,
        )
        return None
