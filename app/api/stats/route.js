/**
 * app/api/stats/route.js — v1.1
 * Endpoint de analítica de rendimiento del algoritmo.
 *
 * GET /api/stats
 *   ?type=overview|by_window|by_direction|by_day|by_hour|signals
 *   &simulated=true|false  (opcional)
 *   &days=30               (opcional, default 30)
 *
 * CAMBIOS v1.1:
 *   - by_window: migrado de vista v_rendimiento_por_ventana a query directo
 *     sobre `operations`, añadiendo avg_odds_entrada Y avg_odds_salida
 *     (usa real_exit_odds con fallback a odds_salida).
 *     Esto permite mostrar precio medio de compra y venta por ventana.
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const type      = searchParams.get("type") || "overview";
  const simOnly   = searchParams.get("simulated");
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

        const rows     = data || [];
        const wins     = rows.filter(r => r.resultado === "WIN").length;
        const losses   = rows.filter(r => ["LOSS", "STOP"].includes(r.resultado)).length;
        const stops    = rows.filter(r => r.resultado === "STOP").length;
        const pnl      = rows.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
        const invested = rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0);

        return NextResponse.json({
          available:    true,
          type:         "overview",
          period_days:  days,
          total_ops:    rows.length,
          wins, losses, stops,
          win_rate:     (wins + losses) > 0 ? +(wins / (wins + losses) * 100).toFixed(1) : null,
          pnl_usd:      +pnl.toFixed(2),
          invested_usd: +invested.toFixed(2),
          roi_pct:      invested > 0 ? +(pnl / invested * 100).toFixed(2) : null,
          ts:           Date.now(),
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Por ventana de entrada ─────────────────────────────────────────
      // v1.1: query directo sobre operations para obtener avg_odds_entrada
      //       y avg_odds_salida (real_exit_odds → odds_salida) por ventana.
      case "by_window": {
        let q = sb.from("operations")
          .select("ventana, resultado, pnl_usd, stake_usd, simulado, odds_entrada, odds_salida, real_exit_odds")
          .neq("resultado", "PENDING")
          .gte("ts_entrada", `${sinceDate}T00:00:00Z`);

        if (simOnly === "true")  q = q.eq("simulado", true);
        if (simOnly === "false") q = q.eq("simulado", false);

        const { data, error } = await q;
        if (error) throw error;

        // Agrupar por ventana en JS
        const groups = {};
        for (const row of (data || [])) {
          const key = row.ventana || "?";
          if (!groups[key]) groups[key] = [];
          groups[key].push(row);
        }

        const WINDOW_ORDER = { T20: 0, T15: 1, T10: 2, T5: 3 };

        const rows = Object.entries(groups).map(([ventana, ops]) => {
          const wins   = ops.filter(r => r.resultado === "WIN").length;
          const losses = ops.filter(r => ["LOSS", "STOP"].includes(r.resultado)).length;
          const stops  = ops.filter(r => r.resultado === "STOP").length;

          const pnlTotal = ops.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
          const pnlMedio = ops.length > 0 ? pnlTotal / ops.length : 0;

          // Precio medio de compra (odds_entrada)
          const entOps    = ops.filter(r => r.odds_entrada != null);
          const avgEntrada = entOps.length > 0
            ? entOps.reduce((s, r) => s + r.odds_entrada, 0) / entOps.length
            : null;

          // Precio medio de venta — usa real_exit_odds si existe, si no odds_salida
          const salOps    = ops.filter(r => (r.real_exit_odds ?? r.odds_salida) != null);
          const avgSalida = salOps.length > 0
            ? salOps.reduce((s, r) => s + (r.real_exit_odds ?? r.odds_salida), 0) / salOps.length
            : null;

          return {
            ventana,
            total_ops:        ops.length,
            wins, losses, stops,
            win_rate_pct:     (wins + losses) > 0
              ? +((wins / (wins + losses)) * 100).toFixed(1)
              : null,
            pnl_total_usd:    +pnlTotal.toFixed(2),
            pnl_medio_usd:    +pnlMedio.toFixed(2),
            avg_odds_entrada: avgEntrada != null ? +avgEntrada.toFixed(4) : null,
            avg_odds_salida:  avgSalida  != null ? +avgSalida.toFixed(4)  : null,
          };
        });

        rows.sort((a, b) =>
          (WINDOW_ORDER[a.ventana] ?? 99) - (WINDOW_ORDER[b.ventana] ?? 99)
        );

        return NextResponse.json({
          available: true, type: "by_window", rows, ts: Date.now(),
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
          available: true, type: "by_direction", rows: data || [], ts: Date.now(),
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
          available: true, type: "by_day", rows: data || [], ts: Date.now(),
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
          available: true, type: "by_hour", rows: data || [], ts: Date.now(),
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // ── Señales evaluadas ──────────────────────────────────────────────
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

        const byWindow = {};
        for (const row of (data || [])) {
          const key = row.ventana || "unknown";
          if (!byWindow[key]) byWindow[key] = { count: 0, total_dist: 0, directions: { UP: 0, DOWN: 0 } };
          byWindow[key].count++;
          byWindow[key].total_dist += Math.abs(row.distancia || 0);
          if (row.direccion === "UP" || row.direccion === "DOWN") {
            byWindow[key].directions[row.direccion]++;
          }
        }

        const summary = Object.entries(byWindow).map(([ventana, v]) => ({
          ventana,
          signals:      v.count,
          avg_dist:     v.count > 0 ? +(v.total_dist / v.count).toFixed(0) : null,
          up_signals:   v.directions.UP,
          down_signals: v.directions.DOWN,
        }));

        return NextResponse.json({
          available: true, type: "signals",
          summary, raw_count: (data || []).length, ts: Date.now(),
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
          available: true, type: "sessions", rows: data || [], ts: Date.now(),
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
