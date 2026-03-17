/**
 * app/api/bets/route.js — v3.1
 * Historial de operaciones con persistencia Supabase.
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
    odds_salida:   row.odds_salida     ?? null,   // v3.1 — precio CLOB de salida (stop/cierre manual)
    real_exit_odds: row.real_exit_odds ?? null,   // v3.1 — precio CLOB real en resolución
    stake:         row.stake_usd,
    tokens:        row.tokens_comprados,
    retorno_est:   row.retorno_estimado_usd,
    pnl_usd:       row.pnl_usd,
    pnl_pct:       row.pnl_pct,
    result:        row.resultado,
    market_slug:   row.market_slug,
    simulated:     row.simulado,
    source:        row.source || "bot",
    // extras retrocompatibilidad
    direction:     row.direccion,
    ventana:       row.ventana,
    resultado:     row.resultado,
    simulado:      row.simulado,
  };
}

// ── Resumen P&L ───────────────────────────────────────────────────────────

function buildSummary(rows) {
  const closed  = rows.filter(b => b.result !== "PENDING");
  const pnl_usd = closed.reduce((s, b) => s + (b.pnl_usd ?? 0), 0);
  const wins    = closed.filter(b => b.result === "WIN").length;
  const losses  = closed.filter(b => ["LOSS", "STOP"].includes(b.result)).length;
  return {
    total:    closed.length,
    wins,
    losses,
    win_rate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null,
    pnl_usd:  +pnl_usd.toFixed(2),
  };
}

// ── GET — devuelve historial ──────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const date    = searchParams.get("date");
  const result  = searchParams.get("result");
  const limit   = parseInt(searchParams.get("limit") || "200", 10);
  const simOnly = searchParams.get("simulated");

  const sb = getSupabase();

  if (sb) {
    try {
      let q = sb.from("operations")
        .select("*")
        .order("ts_entrada", { ascending: false })
        .limit(limit);

      if (date) {
        q = q.gte("ts_entrada", `${date}T00:00:00Z`)
             .lte("ts_entrada", `${date}T23:59:59Z`);
      }
      if (result)              q = q.eq("resultado", result);
      if (simOnly === "true")  q = q.eq("simulado", true);
      if (simOnly === "false") q = q.eq("simulado", false);

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data || []).map(dbRowToDashboard);
      return NextResponse.json({
        bets:    rows,
        count:   rows.length,
        summary: buildSummary(rows),
        source:  "supabase",
        ts:      Date.now(),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      console.error("[bets/GET] Supabase error:", e.message);
      // fall through to memory
    }
  }

  // Fallback memoria
  const all  = [..._mem.values()].sort((a, b) => (b.ts || 0) > (a.ts || 0) ? 1 : -1);
  const rows = all.slice(0, limit);
  return NextResponse.json({
    bets:    rows,
    count:   rows.length,
    summary: buildSummary(rows),
    source:  "memory",
    ts:      Date.now(),
  }, { headers: { "Cache-Control": "no-store" } });
}

// ── POST — registra nueva apuesta ─────────────────────────────────────────

export async function POST(req) {
  try {
    const bet = await req.json();
    if (!bet?.id) return NextResponse.json({ ok: false, error: "id requerido" }, { status: 400 });

    const sb = getSupabase();

    if (sb) {
      try {
        const row = dashboardBetToDb(bet);
        const { error } = await sb.from("operations").upsert(row, { onConflict: "id" });
        if (error) throw error;
        return NextResponse.json({ ok: true, id: bet.id, source: "supabase" });
      } catch (e) {
        console.error("[bets/POST] Supabase error:", e.message);
      }
    }

    // Fallback memoria
    if (_mem.size >= _MEM_MAX) {
      const keys = [..._mem.keys()];
      keys.slice(0, Math.floor(_MEM_MAX * 0.1)).forEach(k => _mem.delete(k));
    }
    _mem.set(bet.id, bet);
    return NextResponse.json({ ok: true, id: bet.id, source: "memory" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}

// ── PATCH — actualiza resultado y P&L ────────────────────────────────────

export async function PATCH(req) {
  try {
    const { id, result, pnl_usd, pnl_pct, odds_salida, real_exit_odds } = await req.json();
    if (!id) return NextResponse.json({ ok: false, error: "id requerido" }, { status: 400 });

    const sb = getSupabase();

    if (sb) {
      try {
        const updates = {
          resultado:  result,
          updated_at: new Date().toISOString(),
          ts_cierre:  new Date().toISOString(),
        };
        if (pnl_usd        !== undefined) updates.pnl_usd        = pnl_usd;
        if (pnl_pct        !== undefined) updates.pnl_pct        = pnl_pct;
        if (odds_salida    !== undefined) updates.odds_salida    = odds_salida;
        if (real_exit_odds !== undefined) updates.real_exit_odds = real_exit_odds;

        const { error } = await sb.from("operations").update(updates).eq("id", id);
        if (error) throw error;
        return NextResponse.json({ ok: true, source: "supabase" });
      } catch (e) {
        console.error("[bets/PATCH] Supabase error:", e.message);
      }
    }

    // Fallback memoria
    if (_mem.has(id)) {
      const existing = _mem.get(id);
      _mem.set(id, {
        ...existing,
        result,
        pnl_usd:   pnl_usd    ?? existing.pnl_usd,
        pnl_pct:   pnl_pct    ?? existing.pnl_pct,
        closed_ts: Date.now(),
      });
    }
    return NextResponse.json({ ok: true, source: "memory" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}

// ── DELETE — limpia historial ─────────────────────────────────────────────

export async function DELETE(req) {
  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope");

  const sb = getSupabase();
  if (sb && scope) {
    try {
      let q = sb.from("operations");
      if (scope === "simulated") {
        await q.delete().eq("simulado", true);
      } else if (scope === "all") {
        return NextResponse.json({
          ok: false,
          error: "Borrado total no permitido vía API. Usa el dashboard de Supabase.",
        }, { status: 403 });
      }
      return NextResponse.json({ ok: true, scope, source: "supabase" });
    } catch (e) {
      console.error("[bets/DELETE] Supabase error:", e.message);
    }
  }

  _mem.clear();
  return NextResponse.json({ ok: true, cleared: true, source: "memory" });
}
