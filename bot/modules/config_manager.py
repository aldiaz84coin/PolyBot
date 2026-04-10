"""
config_manager.py — Carga config.yaml + overrides desde variables de entorno (Railway)

v2.1 — Añade POLYMARKET_SIGNATURE_TYPE al env_map (Railway override para sig_type).
v2.0 — Añade SUPABASE_URL y SUPABASE_SERVICE_KEY para persistencia de BD.
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
        "POLYMARKET_PRIVATE_KEY":    ("polymarket", "private_key"),
        "POLYMARKET_FUNDER":         ("polymarket", "funder"),
        "POLYMARKET_SIGNATURE_TYPE": ("polymarket", "signature_type"),  # v2.1: 1=POLY_PROXY, 2=GNOSIS_SAFE
        # Polymarket CLOB API credentials (Level 2)
        "POLY_API_KEY":              ("polymarket", "api_key"),
        "POLY_API_SECRET":           ("polymarket", "api_secret"),
        "POLY_API_PASSPHRASE":       ("polymarket", "api_passphrase"),
        # Telegram
        "TELEGRAM_BOT_TOKEN":        ("telegram",   "bot_token"),
        "TELEGRAM_CHAT_ID":          ("telegram",   "chat_id"),
        # Capital / strategy
        "STAKE_USDC":                ("capital",    "stake_usdc"),
        "T50_UMBRAL_USD":            ("strategy",   "t50_umbral_usd"),
        "T40_UMBRAL_USD":            ("strategy",   "t40_umbral_usd"),
        "T30_UMBRAL_USD":            ("strategy",   "t30_umbral_usd"),
        "T25_UMBRAL_USD":            ("strategy",   "t25_umbral_usd"),
        "T20_UMBRAL_USD":            ("strategy",   "t20_umbral_usd"),
        "T15_UMBRAL_USD":            ("strategy",   "t15_umbral_usd"),
        "T10_UMBRAL_USD":            ("strategy",   "t10_umbral_usd"),
        "T5_UMBRAL_USD":             ("strategy",   "t5_umbral_usd"),
        "STOP_LOSS_PCT":             ("strategy",   "stop_loss_pct"),
        # Supabase (persistencia compartida bot ↔ dashboard)
        "SUPABASE_URL":              ("supabase",   "url"),
        "SUPABASE_SERVICE_KEY":      ("supabase",   "service_key"),
    }

    for env_var, (section, key) in env_map.items():
        val = os.environ.get(env_var)
        if val is not None:
            original = cfg.get(section, {}).get(key)
            if isinstance(original, (int, float)):
                try:
                    val = float(val) if "." in val else int(val)
                except ValueError:
                    pass
            cfg.setdefault(section, {})[key] = val

    # ── SIMULATE_MODE ────────────────────────────────────────────────────────
    simulate_env = os.environ.get("SIMULATE_MODE", "").lower()
    if simulate_env in ("1", "true", "yes", "on"):
        cfg.setdefault("strategy", {})["simulate_mode"] = True
    elif "simulate_mode" not in cfg.get("strategy", {}):
        cfg.setdefault("strategy", {})["simulate_mode"] = False

    return cfg


def get(cfg: dict, section: str, key: str, default=None):
    return cfg.get(section, {}).get(key, default)
