/**
 * app/api/config/route.js — v1.1
 *
 * Endpoint de configuración compartida bot ↔ dashboard.
 * Lee y escribe en la tabla bot_config de Supabase.
 *
 * El bot lee trading_mode cada 60s via db.get_config("trading_mode").
 * El dashboard escribe aquí → el bot lo recoge en el siguiente ciclo.
 *
 * GET  /api/config?key=trading_mode   → { key, value, updated_at }
 * POST /api/config  { key, value }    → { ok, key, value }
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

// Claves permitidas (whitelist de seguridad)
const ALLOWED_KEYS = new Set([
  "trading_mode",
  "stake_usdc",
  "bot_simulate_active",
  "bot_started_at",
  "funder_address",
  "mode_changed_by",
  "mode_changed_at",
]);

// ── GET /api/config?key=xxx ───────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json(
      { ok: false, error: "Parámetro 'key' requerido" },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb) {
    // Sin Supabase: devolver defaults útiles en vez de error
    const defaults = { trading_mode: "simulate", stake_usdc: "10" };
    return NextResponse.json(
      { key, value: defaults[key] ?? null, source: "default" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const { data, error } = await sb
      .from("bot_config")
      .select("key, value, updated_at")
      .eq("key", key)
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json(
      {
        key,
        value:      data?.value      ?? null,
        updated_at: data?.updated_at ?? null,
        source:     data ? "supabase" : "not_found",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[config/GET] Error:", e.message);
    return NextResponse.json(
      { ok: false, error: e.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// ── POST /api/config  { key, value } ─────────────────────────────────────────

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (_) {
    return NextResponse.json(
      { ok: false, error: "Body JSON inválido" },
      { status: 400 }
    );
  }

  const { key, value } = body;

  if (!key || value === undefined) {
    return NextResponse.json(
      { ok: false, error: "Se requieren 'key' y 'value'" },
      { status: 400 }
    );
  }

  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json(
      { ok: false, error: `Clave no permitida: ${key}` },
      { status: 403 }
    );
  }

  // Validación específica para trading_mode
  if (key === "trading_mode" && !["simulate", "real"].includes(value)) {
    return NextResponse.json(
      { ok: false, error: "trading_mode debe ser 'simulate' o 'real'" },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { ok: false, error: "Supabase no configurado — añade SUPABASE_URL y SUPABASE_SERVICE_KEY en Vercel" },
      { status: 503 }
    );
  }

  try {
    const now = new Date().toISOString();

    const { error } = await sb
      .from("bot_config")
      .upsert(
        { key, value: String(value), updated_at: now },
        { onConflict: "key" }
      );

    if (error) throw error;

    // Si es un cambio de modo, registrar también quién lo cambió y cuándo
    if (key === "trading_mode") {
      await sb.from("bot_config").upsert([
        { key: "mode_changed_by",  value: "dashboard",  updated_at: now },
        { key: "mode_changed_at",  value: now,          updated_at: now },
      ], { onConflict: "key" });

      console.log(`[config/POST] trading_mode → ${value}`);
    }

    return NextResponse.json(
      { ok: true, key, value, updated_at: now },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[config/POST] Error:", e.message);
    return NextResponse.json(
      { ok: false, error: e.message },
      { status: 500 }
    );
  }
}
