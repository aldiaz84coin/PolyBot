/**
 * app/api/stats-algorithm/route.js — v1.0
 *
 * Endpoint dedicado a la comparativa Estándar vs Optimizado.
 * Agrupa operaciones por algorithm_version y devuelve métricas completas.
 *
 * GET /api/stats-algorithm
 *   ?simulated=true|false   (opcional)
 *   ?days=30                (opcional, default 90 para tener más historia)
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

function calcMetrics(ops) {
  const wins     = ops.filter(r => r.resultado === "WIN").length;
  const losses   = ops.filter(r => ["LOSS", "STOP"].includes(r.resultado)).length;
  const stops    = ops.filter(r => r.resultado === "STOP").length;
  const pnl      = ops.reduce((s, r) => s + (r.pnl_usd  ?? 0), 0);
  const invested = ops.reduce((s, r) => s + (r.stake_usd ?? 0), 0);

  const entOps   = ops.filter(r => r.odds_entrada != null);
  const avgOdds  = entOps.length > 0
    ? entOps.reduce((s, r) => s + r.odds_entrada, 0) / entOps.length
    : null;

  const winRate  = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : null;

  // P&L por ventana
  const byWindow = {};
  const WINDOWS  = ["T20", "T15", "T10", "T5", "T25", "T30", "T40", "T50"];
  for (const op of ops) {
    const w = op.ventana || "?";
    if (!byWindow[w]) byWindow[w] = { wins: 0, losses: 0, pnl: 0, ops: 0 };
    byWindow[w].ops++;
    byWindow[w].pnl += op.pnl_usd ?? 0;
    if (op.resultado === "WIN")                              byWindow[w].wins++;
    if (["LOSS", "STOP"].includes(op.resultado))             byWindow[w].losses++;
  }

  const windowRows = WINDOWS
    .filter(w => byWindow[w])
    .map(w => ({
      ventana:      w,
      ops:          byWindow[w].ops,
      wins:         byWindow[w].wins,
      losses:       byWindow[w].losses,
      pnl:          +byWindow[w].pnl.toFixed(2),
      win_rate_pct: (byWindow[w].wins + byWindow[w].losses) > 0
        ? +((byWindow[w].wins / (byWindow[w].wins + byWindow[w].losses)) * 100).toFixed(1)
        : null,
    }));

  return {
    total_ops:    ops.length,
    wins,
    losses,
    stops,
    win_rate_pct: winRate != null ? +winRate.toFixed(1) : null,
    pnl_usd:      +pnl.toFixed(2),
    pnl_medio:    ops.length > 0 ? +(pnl / ops.length).toFixed(2) : null,
    invested_usd: +invested.toFixed(2),
    roi_pct:      invested > 0 ? +(pnl / invested * 100).toFixed(2) : null,
    avg_odds:     avgOdds != null ? +avgOdds.toFixed(4) : null,
    by_window:    windowRows,
  };
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const simOnly   = searchParams.get("simulated");
  const days      = parseInt(searchParams.get("days") || "90", 10);
  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { available: false, reason: "Supabase no configurado" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    let q = sb
      .from("operations")
      .select("resultado, pnl_usd, stake_usd, odds_entrada, ventana, simulado, algorithm_version, ts_entrada")
      .neq("resultado", "PENDING")
      .gte("ts_entrada", `${sinceDate}T00:00:00Z`);

    if (simOnly === "true")  q = q.eq("simulado", true);
    if (simOnly === "false") q = q.eq("simulado", false);

    const { data, error } = await q;
    if (error) throw error;

    const rows = data || [];

    // Separar por versión de algoritmo
    // Las ops sin algorithm_version se tratan como 'standard' (pre-feature)
    const standardOps  = rows.filter(r => !r.algorithm_version || r.algorithm_version === "standard");
    const optimizedOps = rows.filter(r => r.algorithm_version === "optimized");

    const standard  = calcMetrics(standardOps);
    const optimized = calcMetrics(optimizedOps);

    // Ventanas presentes en cualquiera de los dos
    const allWindows = [...new Set([
      ...standard.by_window.map(r => r.ventana),
      ...optimized.by_window.map(r => r.ventana),
    ])];

    // Comparativa por ventana: unificar
    const windowComparison = allWindows.map(w => ({
      ventana:           w,
      standard_pnl:      standard.by_window.find(r => r.ventana === w)?.pnl  ?? null,
      standard_wr:       standard.by_window.find(r => r.ventana === w)?.win_rate_pct ?? null,
      standard_ops:      standard.by_window.find(r => r.ventana === w)?.ops  ?? 0,
      optimized_pnl:     optimized.by_window.find(r => r.ventana === w)?.pnl ?? null,
      optimized_wr:      optimized.by_window.find(r => r.ventana === w)?.win_rate_pct ?? null,
      optimized_ops:     optimized.by_window.find(r => r.ventana === w)?.ops ?? 0,
    }));

    return NextResponse.json({
      available:          true,
      period_days:        days,
      total_ops:          rows.length,
      standard,
      optimized,
      window_comparison:  windowComparison,
      ts:                 Date.now(),
    }, { headers: { "Cache-Control": "no-store" } });

  } catch (e) {
    console.error("[stats-algorithm/GET] Error:", e.message);
    return NextResponse.json(
      { available: false, error: e.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
