/**
 * app/api/bets/route.js — v3.2
 * Historial de operaciones con persistencia Supabase.
 *
 * CAMBIOS v3.2:
 *   - dbRowToDashboard expone boost_t20, boost_t15, boost_t10, boost_t5
 *     (BoostPower del Algoritmo A capturado en cada ventana temporal).
 *     Permite correlacionar señal de tendencia BTC con resultados de ops.
 *
 * CAMBIOS v3.1:
 *   - dbRowToDashboard expone odds_salida y real_exit_odds para la nueva
 *     tabla de historial en StatsPanel (precio de entrada/salida CLOB).
 */

import { NextResponse }  from "next/server";
import { getSupabase, isConfigured } from "../../../lib/supabase";

// ── Fallback in-memory (si Supabase no está disponible) ──────────────────
const _mem = new Map();
const _MEM_MAX = 500;

// ── Helpers de mapeo ─────────────────────────────────────────────────────

function dashboardBetToDb(bet) {
  return {
    id:                   bet.id,
    ts_entrada:           bet.ts || bet.ts_entrada || new Date().toISOString(),
    ts_cierre:            bet.ts_cierre || null,
    direccion:            bet.dir     || bet.direccion || bet.direction || "",
    ventana:              bet.window  || bet.ventana   || "",
    entry_price:          bet.entry   || bet.entry_price || null,
    target_price:         bet.target  || bet.target_price || null,
    distancia:            bet.dist    || bet.distancia    || null,
    umbral:               bet.umbral  || null,
    odds_entrada:         bet.odds    || bet.odds_entrada  || null,
    stake_usd:            bet.stake   || bet.stake_usd     || null,
    tokens_comprados:     bet.tokens  || bet.tokens_comprados || null,
    retorno_estimado_usd: bet.retorno_est || bet.retorno_estimado_usd || null,
    pnl_usd:              bet.pnl_usd ?? null,
    pnl_pct:              bet.pnl_pct ?? null,
    resultado:            bet.result  || bet.resultado || "PENDING",
    market_slug:          bet.market_slug || null,
    simulado:             bet.simulated   ?? false,
    source:               "dashboard",
    updated_at:           new Date().toISOString(),
  };
}

function dbRowToDashboard(row) {
  return {
    id:            row.id,
    ts:            row.ts_entrada,
    ts_cierre:     row.ts_cierre,
    dir:           row.direccion,
    window:        row.ventana,
    entry:         row.entry_price,
    target:        row.target_price,
    dist:          row.distancia,
    umbral:        row.umbral,
    odds:          row.odds_entrada,
    odds_salida:   row.odds_salida     ?? null,
    real_exit_odds: row.real_exit_odds ?? null,
    stake:         row.stake_usd,
    tokens:        row.tokens_comprados,
    retorno_est:   row.retorno_estimado_usd,
    pnl_usd:       row.pnl_usd,
    pnl:           row.pnl_pct,
    result:        row.resultado,
    market_slug:   row.market_slug,
    simulated:     row.simulado,
    source:        row.source,
    // ── v3.2: BoostPower por ventana (Crypto Detector v4) ───────────
    boost_t20:     row.boost_t20 ?? null,
    boost_t15:     row.boost_t15 ?? null,
    boost_t10:     row.boost_t10 ?? null,
    boost_t5:      row.boost_t5  ?? null,
  };
}

// ── GET — listar operaciones ──────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const limit     = parseInt(searchParams.get("limit")     || "200", 10);
  const simulado  = searchParams.get("simulated");
  const resultado = searchParams.get("result");

  if (!isConfigured()) {
    const rows = [..._mem.values()]
      .sort((a, b) => new Date(b.ts_entrada) - new Date(a.ts_entrada))
      .slice(0, limit)
      .map(dbRowToDashboard);
    return NextResponse.json({ ok: true, data: rows, source: "memory" });
  }

  try {
    const supabase = getSupabase();
    let q = supabase
      .from("operations")
      .select("*")
      .order("ts_entrada", { ascending: false })
      .limit(limit);

    if (simulado === "true")  q = q.eq("simulado", true);
    if (simulado === "false") q = q.eq("simulado", false);
    if (resultado)            q = q.eq("resultado", resultado.toUpperCase());

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      data: (data || []).map(dbRowToDashboard),
      source: "supabase",
    });
  } catch (err) {
    console.error("[bets/GET]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ── POST — registrar / actualizar operación ───────────────────────────────

export async function POST(req) {
  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 }); }

  const row = dashboardBetToDb(body);

  if (!isConfigured()) {
    if (_mem.size >= _MEM_MAX) {
      const oldest = [..._mem.keys()].slice(0, 50);
      oldest.forEach(k => _mem.delete(k));
    }
    _mem.set(row.id, row);
    return NextResponse.json({ ok: true, source: "memory" });
  }

  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("operations")
      .upsert(row, { onConflict: "id" });
    if (error) throw error;
    return NextResponse.json({ ok: true, source: "supabase" });
  } catch (err) {
    console.error("[bets/POST]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ── DELETE — limpiar todas las operaciones ────────────────────────────────

export async function DELETE() {
  if (!isConfigured()) {
    _mem.clear();
    return NextResponse.json({ ok: true, source: "memory" });
  }
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("operations")
      .delete()
      .neq("id", "____never____");   // workaround: Supabase requiere condición
    if (error) throw error;
    return NextResponse.json({ ok: true, source: "supabase" });
  } catch (err) {
    console.error("[bets/DELETE]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
