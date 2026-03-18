// app/api/events/route.js — v1.0
//
// Devuelve los últimos N eventos del bot combinando:
//   - signal_log  → señales accionables (type="signal")
//   - operations  → operaciones abiertas/cerradas (type="operation")
//
// Ordenados por timestamp descendente.
//
// GET /api/events?limit=30&simulated=true|false
// → { events: [...], total: N, ts: timestamp }

import { createClient } from "@supabase/supabase-js";
import { NextResponse }  from "next/server";

export const runtime    = "nodejs";
export const revalidate = 0;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const limit    = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "30", 10)));
  const simOnly  = searchParams.get("simulated");  // "true" | "false" | null

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { events: [], total: 0, error: "Supabase no disponible", ts: Date.now() },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // ── Señales accionables ───────────────────────────────────────────────
    let sigQ = sb
      .from("signal_log")
      .select("ts, ventana, direccion, distancia, umbral, market_slug, simulado")
      .eq("accionable", true)
      .order("ts", { ascending: false })
      .limit(limit);

    if (simOnly === "true")  sigQ = sigQ.eq("simulado", true);
    if (simOnly === "false") sigQ = sigQ.eq("simulado", false);

    // ── Operaciones (todas menos PENDING) ────────────────────────────────
    let opQ = sb
      .from("operations")
      .select("ts_entrada, ts_cierre, direccion, ventana, resultado, pnl_usd, stake_usd, odds_entrada, simulado")
      .neq("resultado", "PENDING")
      .order("ts_entrada", { ascending: false })
      .limit(limit);

    if (simOnly === "true")  opQ = opQ.eq("simulado", true);
    if (simOnly === "false") opQ = opQ.eq("simulado", false);

    const [sigRes, opRes] = await Promise.allSettled([sigQ, opQ]);

    const signals = (sigRes.status === "fulfilled" && !sigRes.value.error)
      ? (sigRes.value.data ?? []).map(r => ({
          type:       "signal",
          ts:         r.ts,
          ventana:    r.ventana,
          direccion:  r.direccion,
          distancia:  r.distancia,
          umbral:     r.umbral,
          simulado:   r.simulado,
        }))
      : [];

    const operations = (opRes.status === "fulfilled" && !opRes.value.error)
      ? (opRes.value.data ?? []).map(r => ({
          type:       "operation",
          ts:         r.ts_cierre ?? r.ts_entrada,
          ventana:    r.ventana,
          direccion:  r.direccion,
          resultado:  r.resultado,
          pnl_usd:    r.pnl_usd,
          stake_usd:  r.stake_usd,
          odds:       r.odds_entrada,
          simulado:   r.simulado,
        }))
      : [];

    // ── Combinar, ordenar y limitar ───────────────────────────────────────
    const combined = [...signals, ...operations]
      .filter(e => e.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, limit);

    return NextResponse.json(
      { events: combined, total: combined.length, ts: Date.now() },
      { headers: { "Cache-Control": "no-store" } }
    );

  } catch (err) {
    console.error("[events/GET] Error:", err.message);
    return NextResponse.json(
      { events: [], total: 0, error: err.message, ts: Date.now() },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
