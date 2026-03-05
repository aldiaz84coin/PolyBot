"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)
"""
import logging
from web3 import Web3

logger = logging.getLogger(__name__)

CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
POLYGON_RPC  = "https://polygon-rpc.com"
CHAIN_ID     = 137
GAS_MARGIN   = 1.20   # 20% de margen sobre estimación
CONFIRM_TIMEOUT = 60  # segundos

CTF_ABI = [
    {
        "name": "redeemPositions",
        "type": "function",
        "inputs": [
            {"name": "collateralToken",    "type": "address"},
            {"name": "parentCollectionId", "type": "bytes32"},
            {"name": "conditionId",        "type": "bytes32"},
            {"name": "indexSets",          "type": "uint256[]"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    }
]

USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"


def redimir_posicion(market: dict, direction: str, cfg: dict) -> str:
    """
    Llama a redeemPositions() en el contrato CTF de Polymarket.
    Devuelve el tx hash si tiene éxito. Lanza excepción si falla.
    """
    private_key  = cfg["polymarket"]["private_key"]
    funder       = cfg["polymarket"]["funder"]
    condition_id = market.get("conditionId") or market.get("condition_id")

    if not condition_id:
        raise ValueError("conditionId no encontrado en el mercado")

    # index_set: 1 = Yes (UP), 2 = No (DOWN)
    index_set = [1] if direction == "UP" else [2]

    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))
    if not w3.is_connected():
        raise ConnectionError("No se pudo conectar a Polygon RPC")

    account = w3.eth.account.from_key(private_key)
    ctf     = w3.eth.contract(address=w3.to_checksum_address(CTF_ADDRESS), abi=CTF_ABI)

    # Construir tx
    fn = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,                        # parentCollectionId = 0x0
        w3.to_hex(hexstr=condition_id),
        index_set,
    )

    gas_estimate = fn.estimate_gas({"from": account.address})
    gas          = int(gas_estimate * GAS_MARGIN)
    gas_price    = w3.eth.gas_price

    tx = fn.build_transaction({
        "from":     account.address,
        "gas":      gas,
        "gasPrice": gas_price,
        "nonce":    w3.eth.get_transaction_count(account.address),
        "chainId":  CHAIN_ID,
    })

    signed = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)

    logger.info(f"Claim enviado — tx: {tx_hash.hex()}")

    # Esperar confirmación
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=CONFIRM_TIMEOUT)

    if receipt["status"] != 1:
        raise RuntimeError(f"Transacción fallida: {tx_hash.hex()}")

    logger.info(f"✅ Claim confirmado — tx: {tx_hash.hex()}")
    return tx_hash.hex()
