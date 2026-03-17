/**
 * app/api/config/route.js — v1.0
 * Gestión de configuración compartida bot ↔ dashboard.
 *
 * GET  /api/config?key=trading_mode    → { key, value, updated_at }
 * GET  /api/config                     → { configs: [{key,value,updated_at},...] }
 * POST /api/config  { key, value }     → { ok, key, value }
 */

import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// ── Fallback en memoria si Supabase no está disponible ────────────────────
const _mem = new Map([["trading_mode", "simulate"]]);

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  const sb = getSupabase();
  if (sb) {
    try {
      if (key) {
        const { data, error } = await sb
          .from("bot_config")
          .select("key, value, updated_at")
          .eq("key", key)
          .single();
        if (error && error.code !== "PGRST116") throw error;  // 116 = not found
        if (data) return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
        // Key no existe → devolver null con fallback
        return NextResponse.json(
          { key, value: _mem.get(key) ?? null, updated_at: null, source: "default" },
          { headers: { "Cache-Control": "no-store" } }
        );
      } else {
        const { data, error } = await sb
          .from("bot_config")
          .select("key, value, updated_at")
          .order("key");
        if (error) throw error;
        return NextResponse.json(
          { configs: data || [], source: "supabase" },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
    } catch (e) {
      console.error("[config/GET] Supabase error:", e.message);
    }
  }

  // Fallback memoria
  if (key) {
    return NextResponse.json(
      { key, value: _mem.get(key) ?? null, updated_at: null, source: "memory" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const configs = [..._mem.entries()].map(([k, v]) => ({ key: k, value: v, updated_at: null }));
  return NextResponse.json({ configs, source: "memory" }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req) {
  try {
    const { key, value } = await req.json();
    if (!key || value === undefined) {
      return NextResponse.json({ ok: false, error: "key y value son requeridos" }, { status: 400 });
    }

    // Actualizar memoria de fallback
    _mem.set(key, String(value));

    const sb = getSupabase();
    if (sb) {
      try {
        const now = new Date().toISOString();
        const { error } = await sb.from("bot_config").upsert(
          { key, value: String(value), updated_at: now },
          { onConflict: "key" }
        );
        if (error) throw error;
        return NextResponse.json({ ok: true, key, value, source: "supabase" });
      } catch (e) {
        console.error("[config/POST] Supabase error:", e.message);
      }
    }

    return NextResponse.json({ ok: true, key, value, source: "memory" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}
