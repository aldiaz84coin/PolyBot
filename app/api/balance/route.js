/**
 * app/api/balance/route.js — v3.1
 *
 * CAMBIOS v3.1
 * ─────────────────────────────────────────────────────────────────────
 *  Bug FIX — Posiciones fantasma de mercados resueltos
 *    Polymarket data-api devuelve posiciones de mercados YA RESUELTOS
 *    (curPrice → 0 si perdiste, curPrice → 1 si ganaste pendiente de
 *    redención) junto a las activas. Esto causaba:
 *      · Posiciones activas = 1 cuando en realidad = 0
 *      · total_portfolio inflado (USDC + valor posición resuelta)
 *
 *    Fix: filtrar posiciones "verdaderamente abiertas" con
 *      curPrice > 0.01 && curPrice < 0.99
 *    Un precio en ese rango indica mercado sin resolver todavía.
 *    Posiciones fuera del rango se excluyen del conteo y del valor total.
 *
 * (v3.0 — RPCs limpios, USDC native + bridged, proxy wallet fix)
 */

export const runtime = "edge";

// ── Constantes ────────────────────────────────────────────────────────────────

const USDC_NATIVE   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_BRIDGED  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_BASE = "https://data-api.polymarket.com";

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

async function resolveProxyWallet(funder) {
  try {
    const url = `${DATA_API_BASE}/profile?address=${funder}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const proxy = data?.proxyWallet ?? data?.proxy_wallet ?? data?.proxy ?? null;
    if (proxy && proxy.startsWith("0x") && proxy.length === 42) {
      console.info(`[balance] proxyWallet resuelto: ${proxy.slice(0, 10)}…`);
      return proxy;
    }
    return funder;
  } catch (e) {
    console.warn("[balance] resolveProxyWallet falló, usando funder:", e.message);
    return funder;
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

    const list = Array.isArray(data) ? data : (data?.positions ?? data?.data ?? []);

    const allPositions = list.map(p => ({
      title:        p.title        ?? p.question ?? p.market ?? "—",
      outcome:      p.outcome      ?? (p.side === "YES" ? "YES" : "NO"),
      size:         parseFloat(p.size          ?? p.quantity   ?? 0),
      currentValue: parseFloat(p.currentValue  ?? p.cur_value  ?? p.value ?? 0),
      avgPrice:     parseFloat(p.avgPrice      ?? p.avg_price  ?? 0),
      curPrice:     parseFloat(p.curPrice      ?? p.cur_price  ?? p.price ?? 0),
    }));

    // ── FIX v3.1: filtrar solo posiciones verdaderamente abiertas ─────────
    // curPrice entre 0.01 y 0.99 → mercado sin resolver (posición activa)
    // curPrice ≤ 0.01 → mercado resuelto perdedor (tokens sin valor)
    // curPrice ≥ 0.99 → mercado resuelto ganador (pendiente de redención)
    // En ambos casos resueltos NO contamos como posición activa ni sumamos
    // al total (el USDC de redenciones ganadas llegará al balance on-chain
    // cuando se ejecute el claim).
    const positions = allPositions.filter(p =>
      p.size > 0.001 &&
      p.curPrice > 0.01 &&
      p.curPrice < 0.99
    );

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
  const paddedAddr      = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callDataNative  = "0x70a08231" + wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const callDataBridged = "0x70a08231" + paddedAddr;

  const proxyPromise = resolveProxyWallet(wallet);

  // 3. Saldo USDC (native + bridged) + POL on-chain — retry por RPCs
  let lastError   = null;
  let usdcNative  = 0;
  let usdcBridged = 0;
  let polBalance  = 0;
  let rpcUsed     = null;

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
          params:  [{ to: USDC_NATIVE,  data: callDataNative  }, "latest"],
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

      const polHex        = results.find(r => r.id === 1)?.result;
      const usdcNativeHex = results.find(r => r.id === 2)?.result;
      const usdcBridgedHex = results.find(r => r.id === 3)?.result;

      if (!polHex) throw new Error("Respuesta RPC incompleta (sin POL)");

      polBalance  = polHex        && polHex        !== "0x" ? Number(BigInt(polHex))        / 1e18 : 0;
      usdcNative  = usdcNativeHex  && usdcNativeHex  !== "0x" ? Number(BigInt(usdcNativeHex))  / 1e6  : 0;
      usdcBridged = usdcBridgedHex && usdcBridgedHex !== "0x" ? Number(BigInt(usdcBridgedHex)) / 1e6  : 0;

      rpcUsed = rpc;
      break;

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
  const usdc_total  = Math.round((usdcNative + usdcBridged) * 10000) / 10000;
  const pol_rounded = Math.round(polBalance * 1000000) / 1000000;
  const pos_value   = posResult.positions_value ?? 0;

  return Response.json({
    success:         true,
    usdc:            usdc_total,
    pol:             pol_rounded,
    wallet:          wallet.slice(0, 10) + "…",
    rpc_used:        rpcUsed,
    latency_ms:      Date.now() - t0,
    usdc_detail: {
      native:  Math.round(usdcNative  * 10000) / 10000,
      bridged: Math.round(usdcBridged * 10000) / 10000,
    },
    positions_count: posResult.positions_count,
    positions_value: posResult.positions_value,
    positions:       posResult.positions,
    positions_error: posResult.positions_error ?? null,
    // Total = solo USDC líquido + posiciones verdaderamente abiertas
    total_portfolio: posResult.ok
      ? Math.round((usdc_total + pos_value) * 10000) / 10000
      : null,
  });
}
