#!/usr/bin/env python3
"""
main.py — Punto de entrada del Polymarket BTC Bot
Ejecutar: python main.py
"""
import logging
import os
import sys
from pathlib import Path

# Añade el directorio raíz al path
sys.path.insert(0, str(Path(__file__).parent))

from modules.config_manager import load_config
from modules.monitor import run


def setup_logging(cfg: dict):
    nivel_str = cfg.get("logging", {}).get("nivel", "INFO")
    nivel     = getattr(logging, nivel_str.upper(), logging.INFO)
    log_file  = cfg.get("logging", {}).get("archivo", "logs/bot.log")

    Path(log_file).parent.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=nivel,
        format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_file, encoding="utf-8"),
        ],
    )


def main():
    print("=" * 60)
    print("  POLYMARKET BTC BOT")
    print("=" * 60)

    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    try:
        cfg = load_config(cfg_path)
    except FileNotFoundError as e:
        print(f"\n❌ {e}")
        print("Ejecuta: cp config.example.yaml config.yaml")
        sys.exit(1)

    setup_logging(cfg)
    logger = logging.getLogger("main")
    logger.info("Configuración cargada correctamente")

    run(cfg)


if __name__ == "__main__":
    main()
