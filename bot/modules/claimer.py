"""
claimer.py — Redención automática de tokens ganadores on-chain (Polygon)
"""
import logging
from web3 import Web3

logger = logging.getLogger(__name__)

CTF_ADDRESS     = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
POLYGON_RPC     = "https://polygon-rpc.com"
CHAIN_ID        = 137
GAS_MARGIN      = 1.20
CONFIRM_TIMEOUT = 60

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

    logger.info(
        f"[CLAIMER] Iniciando redención on-chain\n"
        f"          Dirección    : {direction}\n"
        f"          Condition ID : {condition_id}\n"
        f"          Funder       : {funder}\n"
        f"          RPC          : {POLYGON_RPC}"
    )

    if not condition_id:
        logger.error("[CLAIMER] ❌ conditionId no encontrado en el mercado")
        raise ValueError("conditionId no encontrado en el mercado")

    # index_set: 1 = Yes (UP), 2 = No (DOWN)
    index_set = [1] if direction == "UP" else [2]
    logger.info(f"[CLAIMER] Index set: {index_set}  (1=YES/UP, 2=NO/DOWN)")

    # Conectar a Polygon
    logger.info(f"[CLAIMER] Conectando a Polygon RPC...")
    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))
    if not w3.is_connected():
        logger.error(f"[CLAIMER] ❌ No se pudo conectar a {POLYGON_RPC}")
        raise ConnectionError("No se pudo conectar a Polygon RPC")
    logger.info(f"[CLAIMER] ✅ Conectado a Polygon (chain_id={w3.eth.chain_id})")

    account = w3.eth.account.from_key(private_key)
    logger.info(f"[CLAIMER] Wallet: {account.address}")

    # Balance MATIC para gas
    try:
        balance_wei  = w3.eth.get_balance(account.address)
        balance_matic = w3.from_wei(balance_wei, "ether")
        logger.info(f"[CLAIMER] Balance MATIC: {balance_matic:.6f}")
        if balance_matic < 0.001:
            logger.warning(
                f"[CLAIMER] ⚠ Balance MATIC bajo ({balance_matic:.6f}) — "
                f"puede no alcanzar para gas"
            )
    except Exception as e:
        logger.warning(f"[CLAIMER] ⚠ No se pudo consultar balance MATIC: {e}")

    ctf = w3.eth.contract(
        address=w3.to_checksum_address(CTF_ADDRESS),
        abi=CTF_ABI,
    )

    fn = ctf.functions.redeemPositions(
        w3.to_checksum_address(USDC_POLYGON),
        b"\x00" * 32,
        w3.to_hex(hexstr=condition_id),
        index_set,
    )

    # Estimación de gas
    logger.info("[CLAIMER] Estimando gas...")
    try:
        gas_estimate = fn.estimate_gas({"from": account.address})
        gas          = int(gas_estimate * GAS_MARGIN)
        gas_price    = w3.eth.gas_price
        gas_price_gwei = w3.from_wei(gas_price, "gwei")
        coste_matic  = w3.from_wei(gas * gas_price, "ether")

        logger.info(
            f"[CLAIMER] Gas estimado:\n"
            f"          Gas units   : {gas_estimate}  (+{GAS_MARGIN*100-100:.0f}% margen → {gas})\n"
            f"          Gas price   : {gas_price_gwei:.2f} Gwei\n"
            f"          Coste est.  : {coste_matic:.6f} MATIC"
        )
    except Exception as e:
        logger.error(
            f"[CLAIMER] ❌ Error estimando gas: {type(e).__name__}: {e}\n"
            f"          Puede que la posición ya haya sido reclamada o el mercado no haya resuelto."
        )
        raise

    nonce = w3.eth.get_transaction_count(account.address)
    logger.debug(f"[CLAIMER] Nonce: {nonce}")

    tx = fn.build_transaction({
        "from":     account.address,
        "gas":      gas,
        "gasPrice": gas_price,
        "nonce":    nonce,
        "chainId":  CHAIN_ID,
    })

    logger.info("[CLAIMER] 📤 Firmando y enviando transacción...")
    signed  = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
    tx_hex  = tx_hash.hex()

    logger.info(
        f"[CLAIMER] ✅ Transacción enviada\n"
        f"          TX Hash     : {tx_hex}\n"
        f"          Explorer    : https://polygonscan.com/tx/{tx_hex}\n"
        f"          Esperando confirmación (timeout={CONFIRM_TIMEOUT}s)..."
    )

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=CONFIRM_TIMEOUT)
    status  = receipt.get("status", -1)

    if status != 1:
        logger.error(
            f"[CLAIMER] ❌ Transacción fallida (status={status})\n"
            f"          TX Hash  : {tx_hex}\n"
            f"          Gas used : {receipt.get('gasUsed', '—')}"
        )
        raise RuntimeError(f"Transacción fallida: {tx_hex}")

    gas_used     = receipt.get("gasUsed", 0)
    coste_real   = w3.from_wei(gas_used * gas_price, "ether")
    block_number = receipt.get("blockNumber", "—")

    logger.info(
        f"[CLAIMER] 🏆 Claim confirmado on-chain\n"
        f"          TX Hash     : {tx_hex}\n"
        f"          Block       : {block_number}\n"
        f"          Gas usado   : {gas_used} ({coste_real:.6f} MATIC)\n"
        f"          Explorer    : https://polygonscan.com/tx/{tx_hex}"
    )

    return tx_hex
