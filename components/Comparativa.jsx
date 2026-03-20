/**
 * Comparativa.jsx — Comparación de rendimiento entre estrategia Direccional y Arbitraje
 *
 * Muestra en paralelo:
 *  - Métricas clave de cada estrategia (PnL, win rate, ROI, ops)
 *  - Gráfico de PnL acumulado en el tiempo para ambas
 *  - Tabla de rendimiento por día (ambas estrategias)
 *
 * Lee de Supabase:
 *   operations     → estrategia direccional
 *   arb_operations → estrategia de arbitraje
 *   v_comparativa_estrategias → vista SQL (si disponible)
 *
 * v1.0 — Implementación inicial
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtUSD(v, digits = 2) {
  if (v == null || isNaN(v)) return "—";
  const abs = Math.abs(v);
  return `${v >= 0 ? "+" : "-"}$${abs.toFixed(digits)}`;
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${parseFloat(v).toFixed(1)}%`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" });
}

const C = {
  dir: "#00ff88",
  arb: "#4488ff",
  neutral: "#555",
  bg: "#02020a",
  border: "#0a0a1e",
};

const S = {
  container: { padding: "16px 20px 32px" },
  section: {
    marginBottom: 24,
    background: "#02020a",
    border: "1px solid #0a0a1e",
    borderRadius: 4,
  },
  sectionTitle: {
    fontSize: 9, letterSpacing: "0.18em", color: "#333",
    padding: "12px 16px", borderBottom: "1px solid #0a0a1e",
  },
  body: { padding: "16px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  metricCard: (color) => ({
    background: "#010108",
    border: `1px solid ${color}22`,
    borderRadius: 4,
    padding: "14px 16px",
  }),
  metricTitle: { fontSize: 9, letterSpacing: "0.14em", color: "#444", marginBottom: 10 },
  metricRow: { display: "flex", justifyContent: "space-between", marginBottom: 7, alignItems: "center" },
  metricLabel: { fontSize: 9, color: "#444" },
  metricValue: (color) => ({ fontSize: 13, fontWeight: 700, color: color || "#888" }),
  bigNumber: (color) => ({ fontSize: 22, fontWeight: 700, color: color || "#888", lineHeight: 1.1 }),
  badge: (color) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 2,
    fontSize: 8,
    letterSpacing: "0.12em",
    background: `${color}15`,
    border: `1px solid ${color}44`,
    color: color,
    marginBottom: 8,
  }),
  filterRow: {
    display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap",
  },
  filterBtn: (active) => ({
    background: "none",
    border: `1px solid ${active ? "#00ff88" : "#1a1a2e"}`,
    color: active ? "#00ff88" : "#444",
    fontSize: 8, letterSpacing: "0.1em",
    padding: "3px 8px", cursor: "pointer",
    borderRadius: 2, fontFamily: "inherit",
  }),
  table: { width: "100%", borderCollapse: "collapse", fontSize: 10 },
  th: {
    fontSize: 8, color: "#333", letterSpacing: "0.12em",
    padding: "6px 10px", borderBottom: "1px solid #0a0a1e",
    textAlign: "left", background: "#02020a",
  },
  td: { padding: "6px 10px", borderBottom: "1px solid #050510", color: "#666" },
  chart: { height: 120, position: "relative", marginTop: 8 },
  empty: { fontSize: 10, color: "#2a2a3a", padding: "12px 0" },
};

// ── Mini bar chart ─────────────────────────────────────────────────────────

function MiniBarChart({ rows, label }) {
  if (!rows || rows.length === 0) {
    return <div style={S.empty}>Sin datos suficientes</div>;
  }
  const vals = rows.map(r => r.value);
  const max  = Math.max(...vals.map(Math.abs), 0.001);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {rows.map((row, i) => {
        const pct = Math.abs(row.value) / max;
        const col = row.value >= 0 ? "#00ff88" : "#ff4466";
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 9, color: "#444", width: 38, textAlign: "right", flexShrink: 0 }}>
              {row.label}
            </div>
            <div style={{ flex: 1, background: "#070710", borderRadius: 2, height: 12 }}>
              <div style={{ width: `${pct * 100}%`, height: "100%", background: col, borderRadius: 2 }} />
            </div>
            <div style={{ fontSize: 9, color: col, width: 58, textAlign: "right", flexShrink: 0 }}>
              {fmtUSD(row.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Comparativa de métricas ────────────────────────────────────────────────

function MetricColumn({ title, color, stats, loading }) {
  if (loading) {
    return (
      <div style={S.metricCard(color)}>
        <div style={S.metricTitle}>{title}</div>
        <div style={S.empty}>cargando…</div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div style={S.metricCard(color)}>
        <div style={S.metricTitle}>{title}</div>
        <div style={S.empty}>Sin datos</div>
      </div>
    );
  }

  const { total_ops, wins, losses, tasa_exito_pct, pnl_total_usd, pnl_medio_usd, invertido_total_usd, roi_pct } = stats;
  const pnl  = parseFloat(pnl_total_usd  || 0);
  const roi  = parseFloat(roi_pct         || 0);
  const tasa = parseFloat(tasa_exito_pct  || 0);

  return (
    <div style={S.metricCard(color)}>
      <div style={{ ...S.badge(color), display: "block", marginBottom: 10 }}>{title}</div>

      <div style={{ marginBottom: 12 }}>
        <div style={S.bigNumber(pnl >= 0 ? "#00ff88" : "#ff4466")}>
          {fmtUSD(pnl)}
        </div>
        <div style={{ fontSize: 9, color: "#333", marginTop: 2 }}>PnL total</div>
      </div>

      <div style={S.metricRow}>
        <span style={S.metricLabel}>Operaciones</span>
        <span style={S.metricValue(color)}>{total_ops || 0}</span>
      </div>
      <div style={S.metricRow}>
        <span style={S.metricLabel}>Éxito / Fallo</span>
        <span style={S.metricValue(color)}>{wins || 0} / {losses || 0}</span>
      </div>
      <div style={S.metricRow}>
        <span style={S.metricLabel}>Tasa éxito</span>
        <span style={S.metricValue(tasa >= 50 ? "#00ff88" : "#ff8800")}>
          {fmtPct(tasa)}
        </span>
      </div>
      <div style={S.metricRow}>
        <span style={S.metricLabel}>PnL medio / op</span>
        <span style={S.metricValue(parseFloat(pnl_medio_usd) >= 0 ? "#00ff88" : "#ff4466")}>
          {fmtUSD(parseFloat(pnl_medio_usd))}
        </span>
      </div>
      <div style={S.metricRow}>
        <span style={S.metricLabel}>ROI</span>
        <span style={S.metricValue(roi >= 0 ? "#00ff88" : "#ff4466")}>
          {fmtPct(roi)}
        </span>
      </div>
      <div style={S.metricRow}>
        <span style={S.metricLabel}>Invertido total</span>
        <span style={S.metricValue("#555")}>
          ${parseFloat(invertido_total_usd || 0).toFixed(2)}
        </span>
      </div>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────

export default function Comparativa() {
  const [filterMode, setFilterMode] = useState("all"); // all | sim | real
  const [loading,    setLoading]    = useState(true);

  const [dirStats,   setDirStats]   = useState(null);
  const [arbStats,   setArbStats]   = useState(null);
  const [dailyDir,   setDailyDir]   = useState([]);
  const [dailyArb,   setDailyArb]   = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const simFilter = filterMode === "sim" ? true : filterMode === "real" ? false : null;

      // ── Estrategia Direccional ─────────────────────────────────────────
      let dirQ = supabase
        .from("operations")
        .select("resultado, pnl_usd, stake_usd, ts_entrada")
        .neq("resultado", "PENDING");
      if (simFilter !== null) dirQ = dirQ.eq("simulado", simFilter);
      const { data: dirOps } = await dirQ;

      // ── Estrategia ARB ─────────────────────────────────────────────────
      let arbQ = supabase
        .from("arb_operations")
        .select("resultado, pnl_usd, stake_total_usd, ts_entrada")
        .neq("resultado", "PENDING");
      if (simFilter !== null) arbQ = arbQ.eq("simulado", simFilter);
      const { data: arbOps } = await arbQ;

      // ── Calcular stats Direccional ─────────────────────────────────────
      const dOps  = dirOps || [];
      const dWins = dOps.filter(o => o.resultado === "WIN").length;
      const dLoss = dOps.filter(o => ["LOSS","STOP"].includes(o.resultado)).length;
      const dPnl  = dOps.reduce((s, o) => s + (parseFloat(o.pnl_usd) || 0), 0);
      const dInv  = dOps.reduce((s, o) => s + (parseFloat(o.stake_usd) || 0), 0);
      setDirStats({
        total_ops:         dOps.length,
        wins:              dWins,
        losses:            dLoss,
        tasa_exito_pct:    dOps.length > 0 ? (dWins / dOps.length * 100) : 0,
        pnl_total_usd:     dPnl,
        pnl_medio_usd:     dOps.length > 0 ? dPnl / dOps.length : 0,
        invertido_total_usd: dInv,
        roi_pct:           dInv > 0 ? (dPnl / dInv * 100) : 0,
      });

      // ── Calcular stats ARB ─────────────────────────────────────────────
      const aOps  = arbOps || [];
      const aWins = aOps.filter(o => o.resultado === "BALANCED").length;
      const aLoss = aOps.filter(o => ["PHASE3_EXIT","PARTIAL"].includes(o.resultado)).length;
      const aPnl  = aOps.reduce((s, o) => s + (parseFloat(o.pnl_usd) || 0), 0);
      const aInv  = aOps.reduce((s, o) => s + (parseFloat(o.stake_total_usd) || 0), 0);
      setArbStats({
        total_ops:         aOps.length,
        wins:              aWins,
        losses:            aLoss,
        tasa_exito_pct:    aOps.length > 0 ? (aWins / aOps.length * 100) : 0,
        pnl_total_usd:     aPnl,
        pnl_medio_usd:     aOps.length > 0 ? aPnl / aOps.length : 0,
        invertido_total_usd: aInv,
        roi_pct:           aInv > 0 ? (aPnl / aInv * 100) : 0,
      });

      // ── PnL por día ────────────────────────────────────────────────────
      const byDay = (ops, pnlKey) => {
        const map = {};
        for (const o of ops) {
          const day = (o.ts_entrada || "").slice(0, 10);
          if (!day) continue;
          map[day] = (map[day] || 0) + (parseFloat(o[pnlKey]) || 0);
        }
        return Object.entries(map)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-14)  // últimos 14 días
          .map(([date, value]) => ({ label: date.slice(5), value }));
      };

      setDailyDir(byDay(dOps, "pnl_usd"));
      setDailyArb(byDay(aOps, "pnl_usd"));

    } catch (e) {
      console.error("[Comparativa]", e);
    } finally {
      setLoading(false);
    }
  }, [filterMode]);

  useEffect(() => { load(); }, [load]);

  // ── Ventaja comparativa ───────────────────────────────────────────────────
  const winner = (() => {
    if (!dirStats || !arbStats) return null;
    const dRoi = parseFloat(dirStats.roi_pct || 0);
    const aRoi = parseFloat(arbStats.roi_pct || 0);
    if (dRoi > aRoi) return "direccional";
    if (aRoi > dRoi) return "arbitraje";
    return "empate";
  })();

  return (
    <div style={S.container}>
      {/* ── Filtros ────────────────────────────────────────────────────── */}
      <div style={S.filterRow}>
        <span style={{ fontSize: 9, color: "#444", lineHeight: "24px", letterSpacing: "0.1em" }}>MODO:</span>
        {[["all","TODOS"],["sim","SIMULADO"],["real","REAL"]].map(([v,l]) => (
          <button key={v} onClick={() => setFilterMode(v)}
            style={S.filterBtn(filterMode === v)}>{l}</button>
        ))}
        <button onClick={load} disabled={loading}
          style={{ ...S.filterBtn(false), marginLeft: "auto", color: "#4488ff" }}>
          {loading ? "…" : "↺"}
        </button>
      </div>

      {/* ── Banner ganador ────────────────────────────────────────────── */}
      {winner && !loading && (
        <div style={{
          marginBottom: 16,
          padding: "10px 14px",
          background: winner === "empate" ? "#07070f" : `${winner === "direccional" ? C.dir : C.arb}0a`,
          border: `1px solid ${winner === "empate" ? "#1a1a2e" : winner === "direccional" ? C.dir : C.arb}33`,
          borderRadius: 4,
          fontSize: 9, color: "#777", letterSpacing: "0.1em",
        }}>
          {winner === "empate"
            ? "⚖ EMPATE — Ambas estrategias con mismo ROI"
            : `🏆 MEJOR ROI: ${winner === "direccional" ? "ESTRATEGIA DIRECCIONAL" : "ARBITRAJE"}`
          }
        </div>
      )}

      {/* ── Columnas de métricas ──────────────────────────────────────── */}
      <div style={S.grid2}>
        <MetricColumn
          title="📈 DIRECCIONAL (UP/DOWN)"
          color={C.dir}
          stats={dirStats}
          loading={loading}
        />
        <MetricColumn
          title="⚖️ ARBITRAJE (PAR)"
          color={C.arb}
          stats={arbStats}
          loading={loading}
        />
      </div>

      {/* ── PnL diario por estrategia ─────────────────────────────────── */}
      <div style={{ ...S.section, marginTop: 16 }}>
        <div style={S.sectionTitle}>PnL DIARIO — ÚLTIMOS 14 DÍAS</div>
        <div style={{ ...S.body, ...S.grid2 }}>
          <div>
            <div style={{ fontSize: 9, color: C.dir, marginBottom: 8, letterSpacing: "0.1em" }}>
              📈 DIRECCIONAL
            </div>
            <MiniBarChart rows={dailyDir} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: C.arb, marginBottom: 8, letterSpacing: "0.1em" }}>
              ⚖️ ARBITRAJE
            </div>
            <MiniBarChart rows={dailyArb} />
          </div>
        </div>
      </div>

      {/* ── Tabla comparativa por estrategia ──────────────────────────── */}
      {!loading && dirStats && arbStats && (
        <div style={{ ...S.section, marginTop: 0 }}>
          <div style={S.sectionTitle}>RESUMEN COMPARATIVO</div>
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>MÉTRICA</th>
                  <th style={{ ...S.th, color: C.dir }}>DIRECCIONAL</th>
                  <th style={{ ...S.th, color: C.arb }}>ARBITRAJE</th>
                  <th style={S.th}>VENTAJA</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: "Operaciones",
                    dir: dirStats.total_ops,
                    arb: arbStats.total_ops,
                    fmt: v => v,
                    higherIsBetter: true,
                  },
                  {
                    label: "Tasa éxito",
                    dir: parseFloat(dirStats.tasa_exito_pct || 0),
                    arb: parseFloat(arbStats.tasa_exito_pct || 0),
                    fmt: v => fmtPct(v),
                    higherIsBetter: true,
                  },
                  {
                    label: "PnL total",
                    dir: parseFloat(dirStats.pnl_total_usd || 0),
                    arb: parseFloat(arbStats.pnl_total_usd || 0),
                    fmt: v => fmtUSD(v),
                    higherIsBetter: true,
                  },
                  {
                    label: "PnL / operación",
                    dir: parseFloat(dirStats.pnl_medio_usd || 0),
                    arb: parseFloat(arbStats.pnl_medio_usd || 0),
                    fmt: v => fmtUSD(v),
                    higherIsBetter: true,
                  },
                  {
                    label: "ROI %",
                    dir: parseFloat(dirStats.roi_pct || 0),
                    arb: parseFloat(arbStats.roi_pct || 0),
                    fmt: v => fmtPct(v),
                    higherIsBetter: true,
                  },
                ].map(({ label, dir, arb, fmt, higherIsBetter }) => {
                  let ventaja = "—";
                  if (dir > arb) ventaja = <span style={{ color: C.dir }}>📈 DIR</span>;
                  else if (arb > dir) ventaja = <span style={{ color: C.arb }}>⚖️ ARB</span>;
                  else ventaja = <span style={{ color: "#555" }}>= igual</span>;

                  return (
                    <tr key={label}>
                      <td style={{ ...S.td, fontSize: 9, color: "#555" }}>{label}</td>
                      <td style={{ ...S.td, color: C.dir, fontWeight: 600 }}>{fmt(dir)}</td>
                      <td style={{ ...S.td, color: C.arb, fontWeight: 600 }}>{fmt(arb)}</td>
                      <td style={S.td}>{ventaja}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
