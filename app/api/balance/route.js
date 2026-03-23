/**
 * app/api/balance/route.js — v4.0
 *
 * CAMBIOS v4.0 — FIX CRÍTICO: posiciones categorizadas (abiertas vs pending claim)
 * ─────────────────────────────────────────────────────────────────────────────────
 *  BUG RAÍZ: el filtro anterior excluía posiciones con curPrice >= 0.99,
 *  que son exactamente las posiciones GANADORAS pendientes de claim.
 *  Resultado: positions_value = 0 → total_portfolio = usdc siempre.
 *
 *  Correcciones v4.0:
 *    1. fetchPositions() ya NO excluye posiciones de alto precio.
 *    2. Categorización explícita:
 *         pending_claim : curPrice >= 0.85  → ganadora, esperando redención
 *         open          : 0.01 < curPrice < 0.85 → abierta e incierta
 *         (curPrice < 0.01 → perdedora sin valor residual, ignorada)
 *    3. Valor de pending_claim = size * 1.0 (se cobra completo al reclamar)
 *    4. API devuelve campos extra:
 *         open_count, open_value, pending_claim_count, pending_claim_value
 *         positions_open[], positions_pending[]
 *    5. total_portfolio = usdc + open_value + pending_claim_value
 *
 * (v3.3 — FIX cacheo Vercel con force-dynamic)
 * (v3.2 — Diagnóstico mejorado wallet_hint + rpc_errors)
 * (v3.1 — Bug FIX posiciones fantasma de mercados resueltos)
 * (v3.0 — RPCs limpios, USDC native + bridged, proxy wallet fix)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Constantes ────────────────────────────────────────────────────────────────

const USDC_NATIVE   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_BRIDGED  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_BASE = "https://data-api.polymarket.com";

const NO_CACHE = { "Cache-Control": "no-store, no-cache" };

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
//
// v4.0: Categorización en dos grupos:
//   pending_claim : curPrice >= 0.85 → ya ganada, pendiente de redención on-chain
//   open          : 0.01 < curPrice < 0.85 → abierta, resultado incierto
//
// NOTA: el filtro anterior (curPrice < 0.99) excluía silenciosamente
// todas las posiciones ganadoras, haciendo que total_portfolio = USDC.

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

    const allPositions = list
      .filter(p => p != null)
      .map(p => {
        const size     = parseFloat(p.size     ?? p.quantity  ?? 0);
        const curPrice = parseFloat(p.curPrice ?? p.cur_price ?? p.price ?? 0);
        const avgPrice = parseFloat(p.avgPrice ?? p.avg_price ?? 0);
        // Valor actual: de la API si existe, si no estimado
        const currentValue =
          parseFloat(p.currentValue ?? p.cur_value ?? p.value ?? 0) ||
          Math.round(size * curPrice * 10000) / 10000;

        return {
          title:       p.title ?? p.question ?? p.market ?? "—",
          outcome:     p.outcome ?? p.side ?? "—",
          side:        p.side ?? p.outcome ?? "—",
          market_slug: p.market_slug ?? p.conditionId ?? p.condition_id ?? null,
          size,
          currentValue,
          avgPrice,
          curPrice,
        };
      });

    // Excluir solo tamaño cero (no filtrar por precio)
    const valid = allPositions.filter(p => p.size > 0.001);

    // Categorizar por precio del token
    // pending_claim: precio >= 0.85 → ganadora esperando redención
    // open:          0.01 < precio < 0.85 → incierta
    // (precio < 0.01 → perdedora, sin valor útil — ignorar)
    const pending_claim = valid.filter(p => p.curPrice >= 0.85);
    const open          = valid.filter(p => p.curPrice > 0.01 && p.curPrice < 0.85);

    // Valor de pending_claim = nº de tokens (cobran ~1 USDC/token al reclamar)
    const pending_value = pending_claim.reduce((s, p) => s + p.size, 0);
    const open_value    = open.reduce((s, p) => s + (p.currentValue || p.size * p.curPrice || 0), 0);

    const positions_value = Math.round((open_value + pending_value) * 10000) / 10000;
    const positions_count = open.length + pending_claim.length;

    return {
      ok:                  true,
      positions_count,
      positions_value,
      open_count:          open.length,
      open_value:          Math.round(open_value  * 10000) / 10000,
      pending_claim_count: pending_claim.length,
      pending_claim_value: Math.round(pending_value * 10000) / 10000,
      positions:           [...pending_claim, ...open], // pending_claim primero
      positions_open:      open,
      positions_pending:   pending_claim,
    };
  } catch (e) {
    console.warn("[balance] fetchPositions falló:", e.message);
    return {
      ok:                  false,
      positions_count:     null,
      positions_value:     null,
      open_count:          null,
      open_value:          null,
      pending_claim_count: null,
      pending_claim_value: null,
      positions:           [],
      positions_open:      [],
      positions_pending:   [],
      positions_error:     e.message,
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
    }, { status: 400, headers: NO_CACHE });
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
    }, { status: 503, headers: NO_CACHE });
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
    // Posiciones
    positions_count:      posResult.positions_count,
    positions_value:      posResult.positions_value,
    open_count:           posResult.open_count,
    open_value:           posResult.open_value,
    pending_claim_count:  posResult.pending_claim_count,
    pending_claim_value:  posResult.pending_claim_value,
    positions:            posResult.positions,
    positions_open:       posResult.positions_open,
    positions_pending:    posResult.positions_pending,
    positions_error:      posResult.positions_error ?? null,
    // Portfolio total: USDC líquido + valor posiciones abiertas + valor pending claim
    total_portfolio: posResult.ok
      ? Math.round((usdc_total + pos_value) * 10000) / 10000
      : usdc_total,
  }, { headers: NO_CACHE });
}
