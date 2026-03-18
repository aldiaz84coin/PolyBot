/**
 * app/api/commands/route.js — v1.3
 *
 * CAMBIOS v1.3 — check_clob DIRECTO (sin bot, sin polling):
 *   check_clob ya no inserta en bot_commands ni espera al bot.
 *   Se ejecuta inline en la API route llamando a /api/market (Vercel),
 *   que ya tiene toda la lógica Gamma + CLOB midpoint.
 *   Respuesta inmediata: { ok, direct: true, status, result }.
 *   check_balance y test_order siguen pasando por el bot (necesitan wallet/L2).
 *
 * CAMBIOS v1.2:
 *   - export const dynamic = "force-dynamic" para evitar caché en GET
 *   - Logs explícitos en cada método para debug en Vercel
 *
 * POST /api/commands  { command, params }
 *   → check_clob    : { ok, direct: true, status: "done"|"error", result }  ← inmediato
 *   → check_balance : { ok: true, id }                                       ← async via bot
 *   → test_order    : { ok: true, id }                                       ← async via bot
 *
 * GET  /api/commands?id=123    → { id, command, status, result }
 * GET  /api/commands?status=X  → { commands: [...] }
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

const VALID_COMMANDS = ["check_clob", "check_balance", "test_order"];

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

    // ── check_clob: ejecución directa sin bot ──────────────────────────────
    // Gamma API y CLOB midpoint son públicos → no necesitamos al bot.
    // Llamamos a /api/market (que ya tiene toda la lógica de slug + CLOB)
    // y devolvemos el resultado de inmediato, sin insertar en bot_commands.
    if (command === "check_clob") {
      const t0 = Date.now();
      try {
        const origin    = new URL(req.url).origin;
        const marketRes = await fetch(`${origin}/api/market`, {
          cache:  "no-store",
          signal: AbortSignal.timeout(8000),
        });

        if (!marketRes.ok) {
          return NextResponse.json({
            ok:     true,
            direct: true,
            status: "error",
            result: { success: false, error: `Gamma API error: HTTP ${marketRes.status}` },
          });
        }

        const marketData = await marketRes.json();

        if (!marketData.active) {
          return NextResponse.json({
            ok:     true,
            direct: true,
            status: "error",
            result: {
              success: false,
              error:   "No se encontró mercado BTC activo en Polymarket",
              debug:   marketData,
            },
          });
        }

        const m          = marketData.market;
        const latency_ms = Date.now() - t0;

        return NextResponse.json({
          ok:     true,
          direct: true,
          status: "done",
          result: {
            success:       true,
            latency_ms,
            market_slug:   m.slug,
            yes_token_id:  m.tokens?.yes?.token_id  ?? null,
            no_token_id:   m.tokens?.no?.token_id   ?? null,
            yes_price:     m.tokens?.yes?.price      ?? null,
            no_price:      m.tokens?.no?.price       ?? null,
            price_sources: m._debug?.price_sources   ?? null,
          },
        });
      } catch (e) {
        console.error("[commands POST] check_clob directo error:", e.message);
        return NextResponse.json({
          ok:     true,
          direct: true,
          status: "error",
          result: { success: false, error: e.message },
        });
      }
    }

    // ── check_balance / test_order: siguen pasando por el bot ─────────────

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

    console.log(`[commands POST] Comando '${command}' encolado → id=${data.id}`);
    return NextResponse.json({ ok: true, id: data.id });

  } catch (err) {
    console.error("[commands POST] Unexpected error:", err.message);
    return NextResponse.json(
      { ok: false, error: `Error inesperado: ${err.message}` },
      { status: 500 }
    );
  }
}

// ── GET /api/commands ─────────────────────────────────────────────────────

export async function GET(req) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase no disponible" },
        { status: 503 }
      );
    }

    const { searchParams } = new URL(req.url);
    const id     = searchParams.get("id");
    const status = searchParams.get("status");

    if (id) {
      const { data, error } = await supabase
        .from("bot_commands")
        .select("id, command, status, result, created_at, updated_at")
        .eq("id", id)
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    }

    if (status) {
      const { data, error } = await supabase
        .from("bot_commands")
        .select("id, command, status, result, created_at, updated_at")
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
      .select("id, command, status, result, created_at, updated_at")
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
    console.error("[commands GET] Unexpected error:", err.message);
    return NextResponse.json(
      { error: `Error inesperado: ${err.message}` },
      { status: 500 }
    );
  }
}
