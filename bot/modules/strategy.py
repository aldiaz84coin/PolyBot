"""
strategy.py — Lógica de decisión UP/DOWN y ejecución de órdenes CLOB

v8.3 — DIAGNÓSTICO firma en _build_clob_client
  - Log WARNING con signer, funder, sig_type, api_key en cada intento de orden.
  - Eliminar el bloque DIAGNÓSTICO una vez confirmados los valores correctos.

v8.2 — SELL POSITION (fallback de claim)
  - Nueva función pública sell_position(token_id, tokens, sell_price, cfg, market).
  - Usada por claimer.py como fallback cuando el claim on-chain falla tras
    agotar todos los reintentos: vende los tokens ganadores en el CLOB al
    precio de mercado actual (~0.999) recuperando casi el 100% del valor.
  - Comparte la misma infraestructura de credenciales y ClobClient que execute_order().
  - side="SELL" con los tokens del lado ganador como size.

v8.1 — FIX CRÍTICO: id único en execute_order
  - Modo simulado (simulate_mode=True): genera uuid propio → cada operación
    tiene id distinto → upsert_operation no sobrescribe filas anteriores.
  - Modo simulado por ImportError: igual, uuid generado.
  - Modo real (CLOB): normaliza id desde resp.get("orderID") o resp.get("id");
    si ninguno presente, genera uuid para garantizar unicidad.

v8.0 cambios:
  - min_retorno_pct: retorno mínimo estimado para entrar en una apuesta.

v3.0 cambios:
  - Modo SIMULADO explícito vía cfg["strategy"]["simulate_mode"].
  - execute_order siempre devuelve "odds" (precio real del token).

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
    """
    Construye y devuelve un ClobClient autenticado (Level 2).
    Lanza ImportError si py_clob_client no está disponible.
    Lanza ValueError si faltan credenciales.
    """
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

    # ── DIAGNÓSTICO — eliminar tras confirmar funder y sig_type correctos ──
    try:
        from eth_account import Account
        signer_address = Account.from_key(private_key).address
    except Exception:
        signer_address = "error-derivando-address"

    logger.warning(
        f"[ORDER] 🔑 Diagnóstico firma:\n"
        f"         sig_type  = {sig_type}\n"
        f"         signer    = {signer_address}\n"
        f"         funder    = {funder}\n"
        f"         api_key   = {api_key[:8]}…\n"
        f"         chain_id  = {chain_id}"
    )
    # ── FIN DIAGNÓSTICO ────────────────────────────────────────────────────

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
    Ejecuta una orden Market FOK BUY en el CLOB de Polymarket.

    Devuelve el resultado de la orden o None si falla.
    Siempre incluye:
      - "id"        : identificador único (uuid si simulado o CLOB no devuelve id)
      - "odds"      : precio real del token en Polymarket
      - "simulated" : bool

    MODO SIMULADO (cfg["strategy"]["simulate_mode"] = True):
      No se conecta al CLOB. Registra la operación como si fuera real,
      con la misma estructura de respuesta, marcada con simulated=True.
      Activar con env var SIMULATE_MODE=true en Railway.

    MARGEN MÍNIMO (cfg["strategy"]["min_retorno_pct"]):
      Si el retorno estimado (1/odds - 1)*100 es inferior al mínimo,
      la orden se descarta (devuelve None) antes de ejecutarse.
    """
    simulate_mode  = cfg.get("strategy", {}).get("simulate_mode", False)
    stake          = float(cfg.get("capital", {}).get("stake_usdc", 2.0))
    min_retorno    = float(cfg.get("strategy", {}).get("min_retorno_pct", 0))
    direction_val  = signal.direction.value

    # ── Seleccionar token según dirección ─────────────────────────────────
    # Prioridad: market["tokens"] (lista con outcome) → clobTokenIds (índice)
    tokens_list = market.get("tokens", [])
    token_id    = None

    if isinstance(tokens_list, list) and tokens_list:
        target_outcome = "yes" if signal.direction == Direction.UP else "no"
        for t in tokens_list:
            if t.get("outcome", "").lower() == target_outcome:
                token_id = t.get("token_id")
                break

    if not token_id:
        # fallback: clobTokenIds[0]=YES/UP, [1]=NO/DOWN
        clob_raw = market.get("clobTokenIds")
        if clob_raw:
            import json as _json
            try:
                clob_ids = _json.loads(clob_raw) if isinstance(clob_raw, str) else clob_raw
                if isinstance(clob_ids, list) and len(clob_ids) >= 2:
                    token_id = clob_ids[0] if signal.direction == Direction.UP else clob_ids[1]
            except Exception:
                pass

    # Soporte para test_order (token_id inyectado directamente en el market dict)
    token_id = market.get("_test_token_id") or token_id

    if not token_id:
        logger.error("[ORDER] ❌ No se pudo obtener token_id del mercado")
        return None

    # ── Precio CLOB real ──────────────────────────────────────────────────
    try:
        import requests as _req
        r = _req.get(
            f"https://clob.polymarket.com/midpoint?token_id={token_id}",
            timeout=5,
        )
        entry_odds = float(r.json().get("mid", 0))
    except Exception as e:
        logger.warning(f"[ORDER] No se pudo obtener midpoint CLOB: {e} — usando signal.distance como fallback")
        entry_odds = 0.0

    if entry_odds <= 0:
        logger.error("[ORDER] ❌ Precio CLOB inválido (0) — orden cancelada")
        return None

    # ── Retorno mínimo ────────────────────────────────────────────────────
    if min_retorno > 0:
        retorno_est = (1 / entry_odds - 1) * 100
        if retorno_est < min_retorno:
            logger.warning(
                f"[ORDER] ⛔ Retorno estimado {retorno_est:.1f}% < mínimo {min_retorno}% — orden descartada\n"
                f"         Odds: {entry_odds:.4f}  Token: {token_id[:16]}…"
            )
            return None

    size = round(stake / entry_odds, 4)

    logger.info(
        f"[ORDER] Preparando orden {direction_val}\n"
        f"         Token ID  : {token_id[:16]}...\n"
        f"         Odds impl.: {entry_odds:.4f}  ({entry_odds*100:.1f}%)\n"
        f"         Size      : {size:.4f} tokens\n"
        f"         Coste est.: ${entry_odds * size:.2f} USDC"
    )

    # ── Fee rate dinámico ─────────────────────────────────────────────────
    try:
        import requests as _req
        r = _req.get(
            f"https://clob.polymarket.com/fee-rate?token_id={token_id}",
            timeout=5,
        )
        fee_data = r.json()
        fee_rate_bps = int(fee_data.get("base_fee", 0))
        logger.info(
            f"[ORDER] feeRateBps dinámico = {fee_rate_bps} para token {token_id[:16]}…"
            f"  (raw: {fee_data})"
        )
    except Exception as e:
        fee_rate_bps = 0
        logger.warning(f"[ORDER] No se pudo obtener fee-rate: {e} — usando 0")

    # ── MODO SIMULADO ─────────────────────────────────────────────────────
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

        logger.info(f"[ORDER] 📤 Enviando orden FOK BUY al CLOB (fee_rate_bps={fee_rate_bps})...")

        resp = client.create_and_post_order(
            order_args,
            CreateOrderOptions(neg_risk=neg_risk, tick_size=None),
        )

        order_id = (
            resp.get("orderID")
            or resp.get("id")
            or str(uuid.uuid4())
        )
        status      = resp.get("status", "—")
        filled      = resp.get("sizeFilled", resp.get("size_filled", "—"))
        fill_price  = resp.get("avgPrice") or resp.get("price") or resp.get("avg_price")
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
    v8.2: Vende tokens ganadores en el CLOB (fallback cuando el claim on-chain falla).

    Parámetros:
      token_id   : ID del token a vender (YES si UP, NO si DOWN)
      tokens     : cantidad de tokens a vender
      sell_price : precio de venta (ej. midpoint - margen, ~0.990)
      cfg        : configuración del bot (mismas credenciales que execute_order)
      market     : dict del mercado activo (para neg_risk)

    Devuelve el dict de respuesta del CLOB o None si falla.
    Llamada exclusivamente desde claimer._sell_fallback_clob().
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

        logger.info(f"[SELL] 📤 Enviando orden SELL al CLOB...")

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
