/**
 * app/api/stats/route.js — v1.0
 * Endpoint de analítica de rendimiento del algoritmo.
 *
 * GET /api/stats
 *   ?type=overview|by_window|by_direction|by_day|by_hour|signals
 *   &simulated=true|false  (opcional — filtra por modo)
 *   &days=30               (opcional — últimos N días, default 30)
 *
 * Usa las vistas de Supabase:
 *   v_rendimiento_por_ventana
 *   v_rendimiento_por_direccion
 *   v_pnl_diario
 *   v_rendimiento_por_hora
 *
 * Si Supabase no está configurado devuelve { available: false }.
 */

import { NextResponse }       from "next/server";
import { getSupabase }        from "../../../lib/supabase";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const type      = searchParams.get("type") || "overview";
  const simOnly   = searchParams.get("simulated");   // "true" | "false" | null
  const days      = parseInt(searchParams.get("days") || "30", 10);
  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { available: false, reason: "Supabase no configurado" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    switch (type) {

      // ── Resumen global ─────────────────────────────────────────────────
      case "overview": {
        let q = sb.from("operations")
          .select("resultado, pnl_usd, stake_usd, simulado, ts_entrada")
          .neq("resultado", "PENDING")
          .gte("ts_entrada", `${sinceDate}T00:00:00Z`);

        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;

        const rows    = data || [];
        const wins    = rows.filter(r => r.resultado === "WIN").length;
        const losses  = rows.filter(r => ["LOSS","STOP"].includes(r.resultado)).length;
        const pnl     = rows.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
        const invested = rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0);
        const stops   = rows.filter(r => r.resultado === "STOP").length;

        return NextResponse.json({
          available:   true,
          type:        "overview",
          period_days: days,
          total_ops:   rows.length,
          wins,
          losses,
          stops,
          win_rate:    (wins + losses) > 0 ? +(wins / (wins + losses) * 100).toFixed(1) : null,
          pnl_usd:     +pnl.toFixed(2),
          invested_usd: +invested.toFixed(2),
          roi_pct:     invested > 0 ? +(pnl / invested * 100).toFixed(2) : null,
          ts:          Date.now(),
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Por ventana de entrada ─────────────────────────────────────────
      case "by_window": {
        let q = sb.from("v_rendimiento_por_ventana").select("*");
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;
        return NextResponse.json({
          available: true, type: "by_window", rows: data || [], ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Por dirección (UP / DOWN) ──────────────────────────────────────
      case "by_direction": {
        let q = sb.from("v_rendimiento_por_direccion").select("*");
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;
        return NextResponse.json({
          available: true, type: "by_direction", rows: data || [], ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── P&L diario ────────────────────────────────────────────────────
      case "by_day": {
        let q = sb.from("v_pnl_diario")
          .select("*")
          .gte("fecha", sinceDate)
          .order("fecha", { ascending: false });
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;
        return NextResponse.json({
          available: true, type: "by_day", rows: data || [], ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Por hora UTC del día ───────────────────────────────────────────
      case "by_hour": {
        let q = sb.from("v_rendimiento_por_hora").select("*");
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;
        return NextResponse.json({
          available: true, type: "by_hour", rows: data || [], ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Señales evaluadas (para calibración de umbrales) ──────────────
      case "signals": {
        let q = sb.from("signal_log")
          .select("ventana, direccion, distancia, umbral, accionable, simulado")
          .gte("ts", `${sinceDate}T00:00:00Z`)
          .order("ts", { ascending: false })
          .limit(1000);
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;

        // Agrupar: por ventana, avg distancia de señales accionables
        const byWindow = {};
        for (const row of (data || [])) {
          const key = row.ventana || "unknown";
          if (!byWindow[key]) {
            byWindow[key] = { count: 0, total_dist: 0, directions: { UP: 0, DOWN: 0 } };
          }
          byWindow[key].count++;
          byWindow[key].total_dist += Math.abs(row.distancia || 0);
          if (row.direccion === "UP" || row.direccion === "DOWN") {
            byWindow[key].directions[row.direccion]++;
          }
        }

        const summary = Object.entries(byWindow).map(([ventana, v]) => ({
          ventana,
          signals:    v.count,
          avg_dist:   v.count > 0 ? +(v.total_dist / v.count).toFixed(0) : null,
          up_signals: v.directions.UP,
          down_signals: v.directions.DOWN,
        }));

        return NextResponse.json({
          available: true, type: "signals",
          summary, raw_count: (data || []).length, ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Sesiones horarias ──────────────────────────────────────────────
      case "sessions": {
        let q = sb.from("market_sessions")
          .select("*")
          .gte("fecha", sinceDate)
          .order("fecha", { ascending: false })
          .limit(200);
        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;
        return NextResponse.json({
          available: true, type: "sessions", rows: data || [], ts: Date.now()
        }, { headers: { "Cache-Control": "no-store" } });
      }

      default:
        return NextResponse.json({ error: `Tipo desconocido: ${type}` }, { status: 400 });
    }
  } catch (e) {
    console.error(`[stats/GET] type=${type} error:`, e.message);
    return NextResponse.json(
      { available: false, error: e.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
