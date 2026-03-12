"""
config_manager.py — Carga config.yaml + overrides desde variables de entorno (Railway)
"""
import os
import yaml
from pathlib import Path


def load_config(path: str = "config.yaml") -> dict:
    cfg_path = Path(path)
    if not cfg_path.exists():
        raise FileNotFoundError(
            f"No se encontró {path}. Copia config.example.yaml a config.yaml."
        )
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    # ── Overrides desde variables de entorno (Railway) ──────────────────────
    env_map = {
        # Polymarket wallet
        "POLYMARKET_PRIVATE_KEY": ("polymarket", "private_key"),
        "POLYMARKET_FUNDER":      ("polymarket", "funder"),
        # Polymarket CLOB API credentials (Level 2) — necesarias para post_order
        "POLY_API_KEY":           ("polymarket", "api_key"),
        "POLY_API_SECRET":        ("polymarket", "api_secret"),
        "POLY_API_PASSPHRASE":    ("polymarket", "api_passphrase"),
        # Telegram
        "TELEGRAM_BOT_TOKEN":     ("telegram",   "bot_token"),
        "TELEGRAM_CHAT_ID":       ("telegram",   "chat_id"),
        # Capital / strategy
        "STAKE_USDC":             ("capital",    "stake_usdc"),
        "T20_UMBRAL_USD":         ("strategy",   "t20_umbral_usd"),
        "T15_UMBRAL_USD":         ("strategy",   "t15_umbral_usd"),
        "T10_UMBRAL_USD":         ("strategy",   "t10_umbral_usd"),
        "T5_UMBRAL_USD":          ("strategy",   "t5_umbral_usd"),
        "STOP_LOSS_PCT":          ("strategy",   "stop_loss_pct"),
    }

    for env_var, (section, key) in env_map.items():
        val = os.environ.get(env_var)
        if val is not None:
            # cast numérico si el valor original era número
            original = cfg.get(section, {}).get(key)
            if isinstance(original, (int, float)):
                try:
                    val = float(val) if "." in val else int(val)
                except ValueError:
                    pass
            cfg.setdefault(section, {})[key] = val

    # ── SIMULATE_MODE: no ejecutar órdenes reales en el CLOB ────────────────
    # Activa con: SIMULATE_MODE=true (Railway env var)
    # En modo simulado: la lógica es idéntica, las órdenes se registran en CSV
    # marcadas como [SIMULADO], pero NUNCA se envían al CLOB de Polymarket.
    simulate_env = os.environ.get("SIMULATE_MODE", "").lower()
    if simulate_env in ("1", "true", "yes", "on"):
        cfg.setdefault("strategy", {})["simulate_mode"] = True
    elif "simulate_mode" not in cfg.get("strategy", {}):
        cfg.setdefault("strategy", {})["simulate_mode"] = False

    return cfg


def get(cfg: dict, section: str, key: str, default=None):
    return cfg.get(section, {}).get(key, default)
