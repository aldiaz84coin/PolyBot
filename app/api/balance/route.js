/**
 * app/api/balance/route.js — v3.0
 *
 * CAMBIOS v3.0
 * ─────────────────────────────────────────────────────────────────────
 *  Bug 1 FIX — RPCs muertos eliminados
 *    rpc-mainnet.matic.network y rpc-mainnet.maticvigil.com estaban
 *    deprecados y consumían 5s cada uno antes de fallar, pudiendo
 *    agotar el timeout de Vercel Edge antes de llegar a los RPCs útiles.
 *    Lista reemplazada por endpoints estables y con menor latencia.
 *
 *  Bug 2 FIX — Dirección USDC correcta (USDC.e + native USDC)
 *    La versión anterior solo consultaba USDC.e (0x2791...), que es el
 *    token bridged. Polymarket migró a native USDC (0x3c499...) en 2024.
 *    Ahora se consultan AMBAS direcciones en el mismo batch RPC y se suman,
 *    lo que hace el código correcto tanto en cuentas antiguas (USDC.e)
 *    como en nuevas (native USDC) o mixtas.
 *
 *  Bug 3 FIX — fetchPositions usa proxy wallet, no funder
 *    data-api.polymarket.com indexa posiciones por proxy wallet (el contrato
 *    intermediario que ejecuta órdenes), no por el funder EOA. Se añade
 *    resolveProxyWallet() que consulta /profile?address={funder} para
 *    obtener el proxyWallet real antes de pedir posiciones.
 *
 * GET /api/balance
 * Respuesta:
 *   {
 *     success, usdc, pol, wallet, rpc_used, latency_ms,
 *     positions_count, positions_value, positions, total_portfolio,
 *     usdc_detail: { native, bridged }   ← nuevo, para diagnóstico
 *   }
 */

export const runtime = "edge";

// ── Constantes ────────────────────────────────────────────────────────────────

// Native USDC en Polygon (contrato oficial Circle, usado por Polymarket desde 2024)
const USDC_NATIVE   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
// USDC.e en Polygon (bridged desde Ethereum, token legado)
const USDC_BRIDGED  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const DATA_API_BASE = "https://data-api.polymarket.com";

// Lista limpia — solo RPCs estables y activos en 2025
const POLYGON_RPCS = [
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
  "https://polygon.llamarpc.com",
];

// ── Helper: leer wallet funder ────────────────────────────────────────────────

async function resolveWallet() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    for (const table of ["bot_config", "config"]) {
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

  return process.env.POLYMARKET_FUNDER ?? process.env.FUNDER ?? null;
}

// ── Helper: resolver proxy wallet desde funder ────────────────────────────────
//
// Polymarket usa un "proxy wallet" (contrato intermediario) por usuario.
// Las posiciones se indexan por proxy wallet, no por el funder EOA.
// Este helper consulta el perfil para obtenerlo.

async function resolveProxyWallet(funder) {
  try {
    const url = `${DATA_API_BASE}/profile?address=${funder}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // El campo puede llamarse proxyWallet, proxy_wallet o proxy
    const proxy = data?.proxyWallet ?? data?.proxy_wallet ?? data?.proxy ?? null;
    if (proxy && proxy.startsWith("0x") && proxy.length === 42) {
      console.info(`[balance] proxyWallet resuelto: ${proxy.slice(0, 10)}…`);
      return proxy;
    }
    // Si el perfil no tiene proxy (usuario nunca ha operado), fallback al funder
    return funder;
  } catch (e) {
    console.warn("[balance] resolveProxyWallet falló, usando funder:", e.message);
    return funder; // best-effort: si falla, intentamos con funder igual
  }
}

// ── Helper: posiciones Polymarket ─────────────────────────────────────────────

async function fetchPositions(proxyWallet) {
  try {
    const url = `${DATA_API_BASE}/positions?user=${proxyWallet}&sizeThreshold=.01&limit=100`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(7000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // data-api devuelve array directamente o envuelto
    const list = Array.isArray(data) ? data : (data?.positions ?? data?.data ?? []);

    const positions = list.map(p => ({
      title:        p.title        ?? p.question ?? p.market ?? "—",
      outcome:      p.outcome      ?? (p.side === "YES" ? "YES" : "NO"),
      size:         parseFloat(p.size          ?? p.quantity   ?? 0),
      currentValue: parseFloat(p.currentValue  ?? p.cur_value  ?? p.value ?? 0),
      avgPrice:     parseFloat(p.avgPrice      ?? p.avg_price  ?? 0),
      curPrice:     parseFloat(p.curPrice      ?? p.cur_price  ?? p.price ?? 0),
    }));

    const positions_value = positions.reduce((s, p) => s + (p.currentValue || 0), 0);

    return {
      ok:              true,
      positions_count: positions.length,
      positions_value: Math.round(positions_value * 10000) / 10000,
      positions,
    };
  } catch (e) {
    console.warn("[balance] fetchPositions falló:", e.message);
    return {
      ok:              false,
      positions_count: null,
      positions_value: null,
      positions:       [],
      positions_error: e.message,
    };
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function GET() {
  const t0 = Date.now();

  // 1. Resolver wallet funder
  const wallet = await resolveWallet();
  if (!wallet || !wallet.startsWith("0x")) {
    return Response.json(
      { success: false, error: "Wallet no configurada (funder no encontrado en Supabase ni en env)" },
      { status: 400 }
    );
  }

  // 2. Resolver proxy wallet + lanzar fetchPositions en paralelo con on-chain
  const paddedAddr   = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callDataNative  = "0x70a08231" + wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callDataBridged = "0x70a08231" + paddedAddr; // mismo encoded address

  // Lanzar proxy + positions en paralelo (no bloqueamos el RPC loop)
  const proxyPromise = resolveProxyWallet(wallet);

  // 3. Saldo USDC (native + bridged) + POL on-chain — retry por RPCs
  let lastError  = null;
  let usdcNative = 0;
  let usdcBridged = 0;
  let polBalance  = 0;
  let rpcUsed     = null;

  for (const rpc of POLYGON_RPCS) {
    try {
      // Batch: 3 llamadas en una sola request HTTP
      //   id 1 → eth_getBalance (POL)
      //   id 2 → balanceOf native USDC
      //   id 3 → balanceOf USDC.e
      const body = JSON.stringify([
        {
          jsonrpc: "2.0", id: 1,
          method:  "eth_getBalance",
          params:  [wallet, "latest"],
        },
        {
          jsonrpc: "2.0", id: 2,
          method:  "eth_call",
          params:  [{ to: USDC_NATIVE,  data: callDataNative },  "latest"],
        },
        {
          jsonrpc: "2.0", id: 3,
          method:  "eth_call",
          params:  [{ to: USDC_BRIDGED, data: callDataBridged }, "latest"],
        },
      ]);

      const res = await fetch(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal:  AbortSignal.timeout(5000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const results = await res.json();

      const polHex       = results.find(r => r.id === 1)?.result;
      const usdcNativeHex = results.find(r => r.id === 2)?.result;
      const usdcBridgedHex = results.find(r => r.id === 3)?.result;

      if (!polHex) throw new Error("Respuesta RPC incompleta (sin POL)");

      // Pueden devolver "0x" si la cuenta no tiene ese token — eso es válido ($0)
      polBalance  = polHex   && polHex   !== "0x" ? Number(BigInt(polHex))   / 1e18  : 0;
      usdcNative  = usdcNativeHex  && usdcNativeHex  !== "0x"
        ? Number(BigInt(usdcNativeHex))  / 1e6 : 0;
      usdcBridged = usdcBridgedHex && usdcBridgedHex !== "0x"
        ? Number(BigInt(usdcBridgedHex)) / 1e6 : 0;

      rpcUsed = rpc;
      break; // éxito, salir del loop

    } catch (e) {
      lastError = e.message;
      console.warn(`[balance] RPC ${rpc} falló: ${e.message}`);
    }
  }

  if (!rpcUsed) {
    return Response.json(
      { success: false, error: `Todos los RPCs de Polygon fallaron. Último: ${lastError}` },
      { status: 503 }
    );
  }

  // 4. Esperar proxy wallet y posiciones
  const proxyWallet = await proxyPromise;
  const posResult   = await fetchPositions(proxyWallet);

  // 5. Componer respuesta
  const usdc_total   = Math.round((usdcNative + usdcBridged) * 10000) / 10000;
  const pol_rounded  = Math.round(polBalance * 1000000) / 1000000;
  const pos_value    = posResult.positions_value ?? 0;

  return Response.json({
    success:         true,
    usdc:            usdc_total,
    pol:             pol_rounded,
    wallet:          wallet.slice(0, 10) + "…",
    rpc_used:        rpcUsed,
    latency_ms:      Date.now() - t0,
    // Desglose USDC para diagnóstico
    usdc_detail: {
      native:  Math.round(usdcNative  * 10000) / 10000,
      bridged: Math.round(usdcBridged * 10000) / 10000,
    },
    // Posiciones
    positions_count: posResult.positions_count,
    positions_value: posResult.positions_value,
    positions:       posResult.positions,
    positions_error: posResult.positions_error ?? null,
    // Total estimado = liquidez + valor posiciones abiertas
    total_portfolio: posResult.ok
      ? Math.round((usdc_total + pos_value) * 10000) / 10000
      : null,
  });
}
