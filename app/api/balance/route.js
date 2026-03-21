/**
 * app/api/balance/route.js — v1.0
 *
 * GET /api/balance
 * Consulta el saldo USDC y POL de la wallet de Polymarket
 * directamente via JSON-RPC a nodos públicos de Polygon.
 * No requiere bot activo.
 *
 * Respuesta:
 *   { success, usdc, pol, wallet, rpc_used, latency_ms }
 *   { success: false, error }
 */

export const runtime = "edge";

// ── Constantes ───────────────────────────────────────────────────────────────

const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const POLYGON_RPCS = [
  "https://polygon-rpc.com",
  "https://rpc-mainnet.matic.network",
  "https://rpc-mainnet.maticvigil.com",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET() {
  const t0 = Date.now();

  // 1. Leer wallet desde Supabase (tabla config, key = "funder")
  //    Usamos la misma URL/KEY que el resto de API routes del proyecto.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let wallet = null;

  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/config?key=eq.funder&select=value&limit=1`,
        {
          headers: {
            apikey:        supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          signal: AbortSignal.timeout(4000),
        }
      );
      if (res.ok) {
        const rows = await res.json();
        if (rows?.[0]?.value) wallet = rows[0].value.trim();
      }
    } catch (e) {
      console.warn("[balance] Supabase lookup falló:", e.message);
    }
  }

  // Fallback: variable de entorno directa
  if (!wallet) wallet = process.env.POLYMARKET_FUNDER ?? process.env.FUNDER ?? null;

  if (!wallet || !wallet.startsWith("0x")) {
    return Response.json(
      { success: false, error: "Wallet no configurada (funder no encontrado en Supabase ni en env)" },
      { status: 400 }
    );
  }

  // 2. Codificar llamada balanceOf(address)
  //    selector keccak256("balanceOf(address)") = 0x70a08231
  const paddedAddr = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callData   = "0x70a08231" + paddedAddr;

  // 3. Intentar cada RPC hasta el primero que responda
  let lastError = null;

  for (const rpc of POLYGON_RPCS) {
    try {
      const body = JSON.stringify([
        {
          jsonrpc: "2.0", id: 1,
          method:  "eth_getBalance",
          params:  [wallet, "latest"],
        },
        {
          jsonrpc: "2.0", id: 2,
          method:  "eth_call",
          params:  [{ to: USDC_POLYGON, data: callData }, "latest"],
        },
      ]);

      const res = await fetch(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const results = await res.json();

      const polHex  = results.find(r => r.id === 1)?.result;
      const usdcHex = results.find(r => r.id === 2)?.result;

      if (!polHex || !usdcHex)           throw new Error("Respuesta RPC incompleta");
      if (polHex === "0x" || usdcHex === "0x") throw new Error("RPC devolvió 0x");

      const pol  = Number(BigInt(polHex))  / 1e18;
      const usdc = Number(BigInt(usdcHex)) / 1e6;

      return Response.json({
        success:    true,
        usdc:       Math.round(usdc * 10000) / 10000,
        pol:        Math.round(pol  * 1000000) / 1000000,
        wallet:     wallet.slice(0, 10) + "…",
        rpc_used:   rpc,
        latency_ms: Date.now() - t0,
      });

    } catch (e) {
      lastError = e.message;
      console.warn(`[balance] RPC ${rpc} falló: ${e.message}`);
    }
  }

  return Response.json(
    { success: false, error: `Todos los RPCs de Polygon fallaron. Último error: ${lastError}` },
    { status: 503 }
  );
}
