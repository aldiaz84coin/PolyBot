/**
 * app/api/balance/route.js — v2.0
 *
 * CAMBIOS v2.0
 * ─────────────────────────────────────────────────────────────────────
 *  Añade posiciones activas de Polymarket vía Data API pública:
 *    GET https://data-api.polymarket.com/positions?user={wallet}&sizeThreshold=.01
 *
 *  Nuevos campos en la respuesta:
 *    positions_count   : número de posiciones abiertas
 *    positions_value   : valor total de mercado (sum currentValue)
 *    positions         : array de { title, outcome, size, currentValue, avgPrice, curPrice }
 *    total_portfolio   : usdc + positions_value  (saldo total estimado en Polymarket)
 *
 *  La llamada a posiciones es best-effort: si falla, devuelve
 *  positions_count=null y sigue retornando USDC/POL normalmente.
 *
 * GET /api/balance
 * Respuesta:
 *   {
 *     success, usdc, pol, wallet, rpc_used, latency_ms,
 *     positions_count, positions_value, positions, total_portfolio
 *   }
 */

export const runtime = "edge";

// ── Constantes ────────────────────────────────────────────────────────────────

const USDC_POLYGON   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_BASE  = "https://data-api.polymarket.com";

const POLYGON_RPCS = [
  "https://polygon-rpc.com",
  "https://rpc-mainnet.matic.network",
  "https://rpc-mainnet.maticvigil.com",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

// ── Helper: leer wallet ───────────────────────────────────────────────────────

async function resolveWallet() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    // Intentar tabla config (key = "funder")
    for (const table of ["config", "bot_config"]) {
      const keyField = table === "bot_config" ? "funder_address" : "funder";
      try {
        const res = await fetch(
          `${supabaseUrl}/rest/v1/${table}?key=eq.${keyField}&select=value&limit=1`,
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
          if (rows?.[0]?.value) return rows[0].value.trim();
        }
      } catch (e) {
        console.warn(`[balance] Supabase ${table} falló:`, e.message);
      }
    }
  }

  // Fallback: variable de entorno directa
  return process.env.POLYMARKET_FUNDER ?? process.env.FUNDER ?? null;
}

// ── Helper: posiciones Polymarket ─────────────────────────────────────────────

async function fetchPositions(wallet) {
  try {
    const url = `${DATA_API_BASE}/positions?user=${wallet}&sizeThreshold=.01&limit=100`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // data-api devuelve un array directamente
    const list = Array.isArray(data) ? data : (data?.positions ?? data?.data ?? []);

    // Normalizar cada posición al subconjunto de campos que necesitamos
    const positions = list.map(p => ({
      title:        p.title        ?? p.market ?? "—",
      outcome:      p.outcome      ?? (p.side === "YES" ? "YES" : "NO"),
      size:         parseFloat(p.size          ?? p.quantity   ?? 0),
      currentValue: parseFloat(p.currentValue  ?? p.cur_value  ?? p.value ?? 0),
      avgPrice:     parseFloat(p.avgPrice      ?? p.avg_price  ?? 0),
      curPrice:     parseFloat(p.curPrice      ?? p.cur_price  ?? p.price ?? 0),
    }));

    const positions_value = positions.reduce((s, p) => s + (p.currentValue || 0), 0);

    return {
      ok:               true,
      positions_count:  positions.length,
      positions_value:  Math.round(positions_value * 10000) / 10000,
      positions,
    };
  } catch (e) {
    console.warn("[balance] fetchPositions falló:", e.message);
    return {
      ok:               false,
      positions_count:  null,
      positions_value:  null,
      positions:        [],
      positions_error:  e.message,
    };
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function GET() {
  const t0 = Date.now();

  // 1. Resolver wallet
  const wallet = await resolveWallet();

  if (!wallet || !wallet.startsWith("0x")) {
    return Response.json(
      { success: false, error: "Wallet no configurada (funder no encontrado en Supabase ni en env)" },
      { status: 400 }
    );
  }

  // 2. Lanzar en paralelo: saldo on-chain + posiciones Polymarket
  const paddedAddr = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callData   = "0x70a08231" + paddedAddr;

  const [posResult] = await Promise.all([
    fetchPositions(wallet),
    // El saldo on-chain lo hacemos abajo de forma secuencial con retry RPCs
    Promise.resolve(null),
  ]);

  // 3. Saldo USDC + POL on-chain (retry por RPCs)
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

      if (!polHex || !usdcHex)               throw new Error("Respuesta RPC incompleta");
      if (polHex === "0x" || usdcHex === "0x") throw new Error("RPC devolvió 0x");

      const pol  = Number(BigInt(polHex))  / 1e18;
      const usdc = Number(BigInt(usdcHex)) / 1e6;

      const usdc_rounded = Math.round(usdc * 10000) / 10000;
      const pos_value    = posResult.positions_value ?? 0;

      return Response.json({
        success:          true,
        usdc:             usdc_rounded,
        pol:              Math.round(pol * 1000000) / 1000000,
        wallet:           wallet.slice(0, 10) + "…",
        rpc_used:         rpc,
        latency_ms:       Date.now() - t0,
        // Posiciones
        positions_count:  posResult.positions_count,
        positions_value:  posResult.positions_value,
        positions:        posResult.positions,
        positions_error:  posResult.positions_error ?? null,
        // Total estimado = liquidez + valor posiciones
        total_portfolio:  posResult.ok
          ? Math.round((usdc_rounded + pos_value) * 10000) / 10000
          : null,
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
