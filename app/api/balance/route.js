/**
 * app/api/balance/route.js — v3.3
 *
 * CAMBIOS v3.3
 * ─────────────────────────────────────────────────────────────────────
 *  BUG FIX CRÍTICO — Vercel cacheaba la respuesta edge
 *
 *  Síntoma: el widget actualizaba (fetchBalance cada 60s), las entradas
 *  llegaban a Supabase balance_history, pero el valor nunca cambiaba.
 *  Siempre era el mismo snapshot antiguo.
 *
 *  Causa raíz: el route tenía `export const runtime = "edge"` pero NO
 *  `export const dynamic = "force-dynamic"`. Vercel interpreta las rutas
 *  edge sin ese flag como candidatas a cacheo en la CDN. El primer hit
 *  generaba la respuesta real; todos los siguientes la devolvían cacheada,
 *  ignorando los RPCs de Polygon y la API de Polymarket.
 *
 *  Correcciones:
 *    1. `export const dynamic = "force-dynamic"` — deshabilita el cacheo
 *       de Vercel para esta ruta; cada request ejecuta el handler real.
 *    2. `Cache-Control: no-store, no-cache` en TODAS las respuestas
 *       (éxito, error 400, error 503) — segunda línea de defensa.
 *    3. Migrado de runtime "edge" a "nodejs" para mayor compatibilidad
 *       con AbortSignal.timeout() y BigInt en todos los entornos.
 *
 * (v3.2 — Diagnóstico mejorado wallet_hint + rpc_errors)
 * (v3.1 — Bug FIX posiciones fantasma de mercados resueltos)
 * (v3.0 — RPCs limpios, USDC native + bridged, proxy wallet fix)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";   // ← FIX: desactiva cacheo Vercel

// ── Constantes ────────────────────────────────────────────────────────────────

const USDC_NATIVE   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_BRIDGED  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_BASE = "https://data-api.polymarket.com";

const NO_CACHE = { "Cache-Control": "no-store, no-cache" };   // ← FIX: cabecera en todas las respuestas

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
    const attempts = [
      { table: "bot_config", keyField: "funder_address" },
      { table: "bot_config", keyField: "funder"         },
      { table: "config",     keyField: "funder"         },
      { table: "config",     keyField: "funder_address" },
    ];

    for (const { table, keyField } of attempts) {
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
          if (rows?.[0]?.value) {
            const wallet = rows[0].value.trim();
            console.info(`[balance] wallet resuelta desde Supabase (${table}.${keyField}): ${wallet.slice(0, 10)}…`);
            return wallet;
          }
        }
      } catch (e) {
        console.warn(`[balance] Supabase ${table}.${keyField} falló:`, e.message);
      }
    }
  }

  const envWallet = process.env.POLYMARKET_FUNDER ?? process.env.FUNDER ?? null;
  if (envWallet) {
    console.info(`[balance] wallet resuelta desde env: ${envWallet.slice(0, 10)}…`);
  } else {
    console.error("[balance] wallet NO encontrada — configura POLYMARKET_FUNDER en Vercel");
  }
  return envWallet;
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

    // Filtrar solo posiciones verdaderamente abiertas (v3.1)
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
    return Response.json({
      success:     false,
      error:       "Wallet no configurada. Añade POLYMARKET_FUNDER en Vercel o bot_config.funder_address en Supabase.",
      wallet_hint: wallet ? wallet.slice(0, 10) + "…" : "NULL",
      rpc_errors:  [],
    }, { status: 400, headers: NO_CACHE });   // ← FIX: no-store
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
  const rpcErrors = [];

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

      const polHex         = results.find(r => r.id === 1)?.result;
      const usdcNativeHex  = results.find(r => r.id === 2)?.result;
      const usdcBridgedHex = results.find(r => r.id === 3)?.result;

      if (!polHex) throw new Error("Respuesta RPC incompleta (sin POL)");

      polBalance  = polHex         && polHex         !== "0x" ? Number(BigInt(polHex))         / 1e18 : 0;
      usdcNative  = usdcNativeHex  && usdcNativeHex  !== "0x" ? Number(BigInt(usdcNativeHex))  / 1e6  : 0;
      usdcBridged = usdcBridgedHex && usdcBridgedHex !== "0x" ? Number(BigInt(usdcBridgedHex)) / 1e6  : 0;

      rpcUsed = rpc;
      break;

    } catch (e) {
      lastError = e.message;
      const rpcShort = rpc.replace("https://", "").split("/")[0];
      rpcErrors.push(`${rpcShort}: ${e.message.slice(0, 60)}`);
      console.warn(`[balance] RPC ${rpc} falló: ${e.message}`);
    }
  }

  if (!rpcUsed) {
    return Response.json({
      success:     false,
      error:       `Todos los RPCs de Polygon fallaron. Último: ${lastError}`,
      wallet_hint: wallet.slice(0, 10) + "…",
      rpc_errors:  rpcErrors,
    }, { status: 503, headers: NO_CACHE });   // ← FIX: no-store
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
    total_portfolio: posResult.ok
      ? Math.round((usdc_total + pos_value) * 10000) / 10000
      : null,
  }, { headers: NO_CACHE });   // ← FIX: no-store en la respuesta de éxito
}
