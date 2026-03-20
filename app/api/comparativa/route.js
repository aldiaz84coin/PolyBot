/**
 * app/api/arb-ops/route.js — v1.0
 *
 * Endpoint servidor para operaciones de arbitraje.
 * Lee arb_operations desde Supabase con filtros opcionales.
 *
 * GET /api/arb-ops?mode=all&resultado=all&limit=300
 *   mode:      "all" | "sim" | "real"
 *   resultado: "all" | "BALANCED" | "PHASE3_EXIT" | "PARTIAL" | "PENDING"
 *   limit:     número (default 300)
 *
 * → { ops: [...], stats: { total, balanced, pnl, invested } }
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode      = searchParams.get("mode")      ?? "all";
  const resultado = searchParams.get("resultado")  ?? "all";
  const limit     = Math.min(parseInt(searchParams.get("limit") ?? "300", 10), 500);

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { ops: [], stats: null, error: "Supabase no configurado" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    let q = sb
      .from("arb_operations")
      .select("*")
      .order("ts_entrada", { ascending: false })
      .limit(limit);

    if (mode === "sim")  q = q.eq("simulado", true);
    if (mode === "real") q = q.eq("simulado", false);
    if (resultado !== "all") q = q.eq("resultado", resultado);

    const { data, error } = await q;
    if (error) throw error;

    const ops    = data || [];
    const closed = ops.filter(o => o.resultado !== "PENDING");
    const pnl    = closed.reduce((s, o) => s + (parseFloat(o.pnl_usd) || 0), 0);
    const bal    = closed.filter(o => o.resultado === "BALANCED").length;
    const inv    = closed.reduce((s, o) => s + (parseFloat(o.stake_total_usd) || 0), 0);

    return NextResponse.json(
      {
        ops,
        stats: { total: closed.length, balanced: bal, pnl, invested: inv },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[arb-ops/GET] Error:", e.message);
    return NextResponse.json(
      { ops: [], stats: null, error: e.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
