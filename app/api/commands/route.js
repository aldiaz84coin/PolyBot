// app/api/commands/route.js
// POST — encola un bot_command en Supabase
// GET  — consulta el estado de un comando por id

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

// ── POST /api/commands ────────────────────────────────────────────────────────

export async function POST(req) {
  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 }); }

  const { command, params = {} } = body;
  if (!command) {
    return NextResponse.json({ ok: false, error: "command requerido" }, { status: 400 });
  }

  const sb = getSupabase();
  if (!sb) return NextResponse.json({ ok: false, error: "Supabase no disponible" }, { status: 503 });

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("bot_commands")
    .insert({ command, params, status: "pending", created_at: now, updated_at: now })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  console.log(`[commands POST] encolado: ${command} → id=${data.id}`);
  return NextResponse.json({ ok: true, id: data.id, command, status: "pending" });
}

// ── GET /api/commands?id=xxx ──────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ ok: false, error: "id requerido" }, { status: 400 });
  }

  const sb = getSupabase();
  if (!sb) return NextResponse.json({ ok: false, error: "Supabase no disponible" }, { status: 503 });

  const { data, error } = await sb
    .from("bot_commands")
    .select("id, command, status, result, created_at, updated_at")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: "Comando no encontrado" }, { status: 404 });
  }

  return NextResponse.json({
    ok:     true,
    id:     data.id,
    command: data.command,
    status: data.status,
    result: data.result,
    created_at: data.created_at,
    updated_at: data.updated_at,
  });
}
