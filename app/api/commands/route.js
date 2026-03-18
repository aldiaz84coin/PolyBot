/**
 * app/api/commands/route.js — v1.2
 *
 * CAMBIOS v1.2:
 *   - export const dynamic = "force-dynamic" para evitar caché en GET
 *   - Logs explícitos en cada método para debug en Vercel
 *
 * POST /api/commands  { command, params }   → { ok, id }
 * GET  /api/commands?id=123                 → { id, command, status, result }
 * GET  /api/commands?status=pending         → { commands: [...] }
 */

import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

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

    const { data, error } = await supabase
      .from("bot_commands")
      .insert({
        command,
        params,
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
      return NextResponse.json(data);
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
      return NextResponse.json({ commands: data });
    }

    return NextResponse.json(
      { error: "Parámetro requerido: ?id=X o ?status=Y" },
      { status: 400 }
    );

  } catch (err) {
    console.error("[commands GET] Unexpected error:", err.message);
    return NextResponse.json(
      { error: `Error inesperado: ${err.message}` },
      { status: 500 }
    );
  }
}
