/**
 * app/api/commands/route.js — v1.1
 * Canal de comandos dashboard → bot.
 *
 * POST /api/commands  { command, params }   → { ok, id }
 * GET  /api/commands?id=123                 → { id, command, status, result, ... }
 * GET  /api/commands?status=pending         → { commands: [...] }
 *
 * CAMBIOS v1.1:
 *   - Añadido try/catch externo explícito que garantiza JSON incluso si
 *     req.json() falla (body malformado / content-type incorrecto).
 *   - Supabase null → 503 JSON en ambos métodos (ya existía, reforzado).
 *   - Logs de error más descriptivos para Railway/Vercel.
 *
 * Comandos soportados:
 *   check_clob      → bot prueba conectividad CLOB y devuelve latencia + token_id
 *   check_balance   → bot consulta saldo USDC en cartera
 *   test_order      → bot ejecuta una orden real de prueba
 *                     params: { direction: 'UP'|'DOWN', stake: 1.0 }
 */

import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

const VALID_COMMANDS = ["check_clob", "check_balance", "test_order"];

// ── POST /api/commands ────────────────────────────────────────────────────

export async function POST(req) {
  // Outer try: garantiza que NUNCA se devuelve HTML aunque falle req.json()
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

    // Validaciones específicas por comando
    if (command === "test_order") {
      if (!["UP", "DOWN"].includes(params?.direction)) {
        return NextResponse.json(
          { ok: false, error: "test_order requiere params.direction = 'UP' | 'DOWN'" },
          { status: 400 }
        );
      }
      const stake = parseFloat(params?.stake);
      if (isNaN(stake) || stake < 0.5 || stake > 10) {
        return NextResponse.json(
          { ok: false, error: "test_order requiere params.stake entre 0.50 y 10.00 USDC" },
          { status: 400 }
        );
      }
    }

    // Verificar Supabase disponible
    const sb = getSupabase();
    if (!sb) {
      console.error("[commands/POST] Supabase no disponible — SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes");
      return NextResponse.json(
        {
          ok: false,
          error: "Supabase no configurado — añade SUPABASE_URL y SUPABASE_SERVICE_KEY en Vercel → Settings → Environment Variables y redespliega",
        },
        { status: 503 }
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await sb
      .from("bot_commands")
      .insert({ command, params, status: "pending", created_at: now, updated_at: now })
      .select("id")
      .single();

    if (error) throw error;

    return NextResponse.json(
      { ok: true, id: data.id, command, status: "pending" },
      { headers: { "Cache-Control": "no-store" } }
    );

  } catch (e) {
    console.error("[commands/POST] Error inesperado:", e?.message ?? e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Error interno del servidor" },
      { status: 500 }
    );
  }
}

// ── GET /api/commands ─────────────────────────────────────────────────────

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id     = searchParams.get("id");
    const status = searchParams.get("status");

    const sb = getSupabase();
    if (!sb) {
      console.error("[commands/GET] Supabase no disponible");
      return NextResponse.json(
        { ok: false, error: "Supabase no configurado" },
        { status: 503 }
      );
    }

    if (id) {
      const { data, error } = await sb
        .from("bot_commands")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    }

    if (status) {
      const { data, error } = await sb
        .from("bot_commands")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return NextResponse.json(
        { commands: data || [] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Sin filtros → últimos 10 comandos
    const { data, error } = await sb
      .from("bot_commands")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return NextResponse.json(
      { commands: data || [] },
      { headers: { "Cache-Control": "no-store" } }
    );

  } catch (e) {
    console.error("[commands/GET] Error:", e?.message ?? e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Error interno del servidor" },
      { status: 500 }
    );
  }
}
