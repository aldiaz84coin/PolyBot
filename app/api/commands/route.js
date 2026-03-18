/**
 * app/api/commands/route.js — v1.4
 *
 * CAMBIOS v1.4 — FIX CRÍTICO: HTTP 401 en check_clob
 *   - runCheckClobInline ya NO hace fetch HTTP a ${origin}/api/market.
 *     Ese fetch server-to-server era bloqueado por Vercel con 401.
 *   - Ahora importa fetchActiveMarket() desde lib/market-fetch.js y la
 *     llama directamente, sin pasar por la capa HTTP.
 *   - Eliminado parámetro requestUrl (ya no es necesario).
 *
 * CAMBIOS v1.3 (referencia):
 *   - check_clob ejecuta INLINE desde Vercel (sin bot, sin Supabase).
 *   - check_balance y test_order siguen usando Supabase + polling.
 *
 * POST /api/commands  { command, params }
 *   check_clob    → { ok, direct: true, status, result }   (sin bot)
 *   check_balance → { ok, id }                             (requiere bot)
 *   test_order    → { ok, id }                             (requiere bot)
 *
 * GET /api/commands?id=123         → { id, command, status, result }
 * GET /api/commands?status=pending → { commands: [...] }
 */

import { NextResponse }       from "next/server";
import { getSupabase }        from "../../../lib/supabase";
import { fetchActiveMarket }  from "../../../lib/market-fetch";

export const dynamic = "force-dynamic";

const VALID_COMMANDS = ["check_clob", "check_balance", "test_order"];

// ── check_clob inline — sin llamada HTTP interna ──────────────────────────
// Llama fetchActiveMarket() directamente (Gamma + CLOB) sin hacer fetch
// a ${origin}/api/market, evitando el 401 de Vercel en llamadas internas.

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

    // ── check_clob: ejecución inline, sin bot, sin Supabase ──────────────
    if (command === "check_clob") {
      console.log("[commands POST] check_clob → ejecutando inline (v1.4, sin HTTP interno)");
      const result = await runCheckClobInline();
      console.log("[commands POST] check_clob result:", JSON.stringify(result));
      return NextResponse.json({
        ok:     true,
        direct: true,
        status: result.success ? "done" : "error",
        result,
      });
    }

    // ── check_balance / test_order: requieren el bot (wallet/L2 auth) ────
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
