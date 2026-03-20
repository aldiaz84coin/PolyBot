/**
 * app/api/comparativa/route.js — v1.0
 *
 * Endpoint servidor para la vista comparativa de estrategias.
 * Agrega datos de operations (direccional) y arb_operations (arbitraje).
 *
 * GET /api/comparativa?mode=all
 *   mode: "all" | "sim" | "real"
 *
 * → {
 *     dirStats:  { total_ops, wins, losses, tasa_exito_pct, pnl_total_usd, ... },
 *     arbStats:  { ... },
 *     dailyDir:  [{ label, value }],  // últimos 14 días
 *     dailyArb:  [{ label, value }],
 *   }
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

function buildStats(ops, { winResults, lossResults, stakeKey }) {
  const wins   = ops.filter(o => winResults.includes(o.resultado)).length;
  const losses = ops.filter(o => lossResults.includes(o.resultado)).length;
  const pnl    = ops.reduce((s, o) => s + (parseFloat(o.pnl_usd) || 0), 0);
  const inv    = ops.reduce((s, o) => s + (parseFloat(o[stakeKey]) || 0), 0);
  return {
    total_ops:           ops.length,
    wins,
    losses,
    tasa_exito_pct:      ops.length > 0 ? (wins / ops.length * 100) : 0,
    pnl_total_usd:       pnl,
    pnl_medio_usd:       ops.length > 0 ? pnl / ops.length : 0,
    invertido_total_usd: inv,
    roi_pct:             inv > 0 ? (pnl / inv * 100) : 0,
  };
}

function buildDaily(ops, pnlKey) {
  const map = {};
  for (const o of ops) {
    const day = (o.ts_entrada || "").slice(0, 10);
    if (!day) continue;
    map[day] = (map[day] || 0) + (parseFloat(o[pnlKey]) || 0);
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14)
    .map(([date, value]) => ({ label: date.slice(5), value }));
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "all";

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { dirStats: null, arbStats: null, dailyDir: [], dailyArb: [], error: "Supabase no configurado" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // ── Estrategia Direccional ──────────────────────────────────────────
    let dirQ = sb
      .from("operations")
      .select("resultado, pnl_usd, stake_usd, ts_entrada")
      .neq("resultado", "PENDING");
    if (mode === "sim")  dirQ = dirQ.eq("simulado", true);
    if (mode === "real") dirQ = dirQ.eq("simulado", false);
    const { data: dirOps, error: dirErr } = await dirQ;
    if (dirErr) throw dirErr;

    // ── Estrategia ARB ─────────────────────────────────────────────────
    let arbQ = sb
      .from("arb_operations")
      .select("resultado, pnl_usd, stake_total_usd, ts_entrada")
      .neq("resultado", "PENDING");
    if (mode === "sim")  arbQ = arbQ.eq("simulado", true);
    if (mode === "real") arbQ = arbQ.eq("simulado", false);
    const { data: arbOps, error: arbErr } = await arbQ;
    if (arbErr) throw arbErr;

    const dOps = dirOps || [];
    const aOps = arbOps || [];

    return NextResponse.json(
      {
        dirStats: buildStats(dOps, { winResults: ["WIN"], lossResults: ["LOSS","STOP"], stakeKey: "stake_usd" }),
        arbStats: buildStats(aOps, { winResults: ["BALANCED"], lossResults: ["PHASE3_EXIT","PARTIAL"], stakeKey: "stake_total_usd" }),
        dailyDir: buildDaily(dOps, "pnl_usd"),
        dailyArb: buildDaily(aOps, "pnl_usd"),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[comparativa/GET] Error:", e.message);
    return NextResponse.json(
      { dirStats: null, arbStats: null, dailyDir: [], dailyArb: [], error: e.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
