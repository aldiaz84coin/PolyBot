/**
 * app/api/commands/route.js — v1.5
 *
 * CAMBIOS v1.5 — check_balance INLINE (sin bot, sin Railway)
 *   - check_balance ya NO pasa por el bot. Ejecuta inline desde Vercel igual
 *     que check_clob, usando llamadas JSON-RPC directas a Polygon.
 *   - El bot publica "funder_address" en bot_config al arrancar (monitor.py v10.8).
 *     Vercel la lee de Supabase y consulta el balance directamente on-chain.
 *   - Eliminada la dependencia de web3.py en Railway para esta operación.
 *   - Eliminado el timeout de 35s que antes afectaba a check_balance.
 *   - Usa AbortSignal.timeout(5000) por RPC con fallback a 3 endpoints.
 *
 * CAMBIOS v1.4 (referencia):
 *   - check_clob ejecuta inline desde Vercel (sin bot).
 *   - runCheckClobInline importa fetchActiveMarket() directamente.
 *
 * POST /api/commands  { command, params }
 *   check_clob    → { ok, direct: true, status, result }   (inline Vercel)
 *   check_balance → { ok, direct: true, status, result }   (inline Vercel)
 *   test_order    → { ok, id }                             (requiere bot)
 *
 * GET /api/commands?id=123         → { id, command, status, result }
 * GET /api/commands?status=pending → { commands: [...] }
 */

import { NextResponse }      from "next/server";
import { getSupabase }       from "../../../lib/supabase";
import { fetchActiveMarket } from "../../../lib/market-fetch";

export const dynamic = "force-dynamic";

const VALID_COMMANDS = ["check_clob", "check_balance", "test_order"];

// Dirección USDC en Polygon
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// RPCs de Polygon a intentar en orden
const POLYGON_RPCS = [
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

// ── check_clob inline ──────────────────────────────────────────────────────

async function runCheckClobInline() {
  const t0 = Date.now();
  try {
    const mData = await fetchActiveMarket();

    if (!mData.active || !mData.market) {
      return {
        success:     false,
        error:       mData.error || "Mercado BTC no encontrado en Gamma",
        latency_ms:  Date.now() - t0,
        slugs_tried: mData.slugs_tried ?? [],
      };
    }

    const m = mData.market;
    return {
      success:     true,
      market_slug: m.slug,
      yes_price:   m.tokens?.yes?.price        ?? null,
      no_price:    m.tokens?.no?.price         ?? null,
      yes_source:  m.tokens?.yes?.price_source ?? null,
      no_source:   m.tokens?.no?.price_source  ?? null,
      latency_ms:  Date.now() - t0,
    };
  } catch (e) {
    return {
      success:    false,
      error:      e.message || "Error desconocido en check_clob",
      latency_ms: Date.now() - t0,
    };
  }
}

// ── check_balance inline — Polygon JSON-RPC directo desde Vercel ──────────
//
// No depende del bot. Solo necesita la funder address publicada en bot_config.
// Usa llamadas JSON-RPC puras (sin web3) → compatible con cualquier entorno.

async function runCheckBalanceInline(supabase) {
  const t0 = Date.now();
  try {
    // 1. Leer funder_address desde bot_config (publicada por monitor.py al arrancar)
    const { data: cfgRow } = await supabase
      .from("bot_config")
      .select("value")
      .eq("key", "funder_address")
      .maybeSingle();

    if (!cfgRow?.value) {
      return {
        success:    false,
        error:      "funder_address no encontrada en bot_config. El bot debe haber arrancado al menos una vez con v10.8+.",
        latency_ms: Date.now() - t0,
      };
    }

    const wallet = cfgRow.value.trim();

    // 2. Codificar llamada balanceOf(address) para USDC
    //    Selector keccak256("balanceOf(address)")[0:4] = 0x70a08231
    const paddedAddr = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
    const callData   = "0x70a08231" + paddedAddr;

    let lastError = null;

    // 3. Intentar cada RPC hasta el primero que responda
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
          signal: AbortSignal.timeout(5000), // 5s por RPC
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} de ${rpc}`);

        const results = await res.json();

        const polHex  = results.find(r => r.id === 1)?.result;
        const usdcHex = results.find(r => r.id === 2)?.result;

        if (!polHex || !usdcHex) throw new Error("Respuesta RPC incompleta");
        if (polHex === "0x" || usdcHex === "0x") throw new Error("RPC devolvió 0x — posible nodo caído");

        const polWei  = BigInt(polHex);
        const usdcRaw = BigInt(usdcHex);

        const pol  = Number(polWei)  / 1e18;
        const usdc = Number(usdcRaw) / 1e6;

        return {
          success:      true,
          // nombres que lee ModeSelector.jsx
          usdc:         Math.round(usdc * 10000) / 10000,
          pol:          Math.round(pol  * 1000000) / 1000000,
          // aliases back-compat
          usdc_balance: Math.round(usdc * 10000) / 10000,
          pol_balance:  Math.round(pol  * 1000000) / 1000000,
          // diagnóstico
          wallet:       wallet.slice(0, 10) + "…",
          rpc_used:     rpc,
          latency_ms:   Date.now() - t0,
        };

      } catch (e) {
        lastError = e.message;
        console.warn(`[balance] RPC ${rpc} falló: ${e.message}`);
        continue;
      }
    }

    return {
      success:    false,
      error:      `Todos los RPCs de Polygon fallaron. Último error: ${lastError}`,
      latency_ms: Date.now() - t0,
    };

  } catch (e) {
    return {
      success:    false,
      error:      e.message || "Error desconocido en check_balance",
      latency_ms: Date.now() - t0,
    };
  }
}

// ── POST /api/commands ────────────────────────────────────────────────────

export async function POST(req) {
  try {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return NextResponse.json(
        { ok: false, error: "Body inválido — se esperaba JSON con { command, params }" },
        { status: 400 }
      );
    }

    const { command, params = {} } = body;

    if (!command || !VALID_COMMANDS.includes(command)) {
      return NextResponse.json(
        { ok: false, error: `Comando inválido. Válidos: ${VALID_COMMANDS.join(", ")}` },
        { status: 400 }
      );
    }

    // ── check_clob: inline desde Vercel ─────────────────────────────────
    if (command === "check_clob") {
      console.log("[commands POST] check_clob → inline v1.5");
      const result = await runCheckClobInline();
      return NextResponse.json({
        ok:     true,
        direct: true,
        status: result.success ? "done" : "error",
        result,
      });
    }

    // ── check_balance: inline desde Vercel via Polygon RPC ───────────────
    if (command === "check_balance") {
      console.log("[commands POST] check_balance → inline v1.5 (Polygon JSON-RPC)");
      const supabase = getSupabase();
      if (!supabase) {
        return NextResponse.json(
          { ok: false, error: "Supabase no disponible — no se puede leer funder_address" },
          { status: 503 }
        );
      }
      const result = await runCheckBalanceInline(supabase);
      console.log("[commands POST] check_balance result:", JSON.stringify(result));
      return NextResponse.json({
        ok:     true,
        direct: true,
        status: result.success ? "done" : "error",
        result,
      });
    }

    // ── test_order: sigue requiriendo el bot (necesita L2 auth) ─────────
    if (command === "test_order") {
      const { direction, stake } = params;
      if (!["UP", "DOWN"].includes(direction)) {
        return NextResponse.json(
          { ok: false, error: "direction debe ser 'UP' o 'DOWN'" },
          { status: 400 }
        );
      }
      if (typeof stake !== "number" || stake < 0.5 || stake > 10) {
        return NextResponse.json(
          { ok: false, error: "stake debe estar entre 0.50 y 10.00 USDC" },
          { status: 400 }
        );
      }
    }

    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Supabase no disponible — verifica variables de entorno" },
        { status: 503 }
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("bot_commands")
      .insert({
        command,
        params,
        status:     "pending",
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[commands POST] Supabase insert error:", error.message);
      return NextResponse.json(
        { ok: false, error: `Error al encolar comando: ${error.message}` },
        { status: 500 }
      );
    }

    console.log(`[commands POST] ${command} encolado → id=${data.id}`);
    return NextResponse.json({ ok: true, id: data.id, command, status: "pending" });

  } catch (err) {
    console.error("[commands POST] Error inesperado:", err.message);
    return NextResponse.json(
      { ok: false, error: `Error inesperado: ${err.message}` },
      { status: 500 }
    );
  }
}

// ── GET /api/commands ─────────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id     = searchParams.get("id");
  const status = searchParams.get("status");

  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase no disponible" },
      { status: 503 }
    );
  }

  try {
    if (id) {
      const { data, error } = await supabase
        .from("bot_commands")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      return NextResponse.json(data, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (status) {
      const { data, error } = await supabase
        .from("bot_commands")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json(
        { commands: data || [] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Sin filtros → últimos 10 comandos
    const { data, error } = await supabase
      .from("bot_commands")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(
      { commands: data || [] },
      { headers: { "Cache-Control": "no-store" } }
    );

  } catch (err) {
    console.error("[commands GET] Error:", err.message);
    return NextResponse.json(
      { ok: false, error: `Error inesperado: ${err.message}` },
      { status: 500 }
    );
  }
}
