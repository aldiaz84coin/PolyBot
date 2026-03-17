/**
 * app/api/commands/route.js — v1.0
 * Canal de comandos dashboard → bot.
 *
 * POST /api/commands  { command, params }   → { ok, id }
 * GET  /api/commands?id=123                 → { id, command, status, result, ... }
 * GET  /api/commands?status=pending         → { commands: [...] }
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

export async function POST(req) {
  try {
    const { command, params = {} } = await req.json();

    if (!VALID_COMMANDS.includes(command)) {
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

    const sb = getSupabase();
    if (!sb) {
      return NextResponse.json(
        { ok: false, error: "Supabase no configurado — no se puede enviar comandos al bot" },
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

    return NextResponse.json({ ok: true, id: data.id, command, status: "pending" });
  } catch (e) {
    console.error("[commands/POST] Error:", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id     = searchParams.get("id");
  const status = searchParams.get("status");

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { ok: false, error: "Supabase no configurado" },
      { status: 503 }
    );
  }

  try {
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
    console.error("[commands/GET] Error:", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
