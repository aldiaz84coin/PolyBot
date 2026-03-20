/**
 * ArbHistorial.jsx — Historial de operaciones de arbitraje
 *
 * Muestra la tabla de arb_operations con:
 *  - Par cost (precio de entrada de ambas patas)
 *  - Ganancia garantizada vs PnL real
 *  - Estado: BALANCED | PHASE3_EXIT | PARTIAL | PENDING
 *  - Filtros: simulado / real, resultado
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

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtUSD(v) {
  if (v == null || isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(4)}`;
}

function fmtOdds(v) {
  if (v == null) return "—";
  return `${parseFloat(v).toFixed(4)}`;
}

const RESULTADO_STYLE = {
  BALANCED:    { color: "#00ff88", label: "✅ BALANCED"    },
  PHASE3_EXIT: { color: "#ff8800", label: "⚠ FASE 3 EXIT" },
  PARTIAL:     { color: "#ff4466", label: "❌ PARTIAL"     },
  PENDING:     { color: "#4488ff", label: "⏳ PENDING"     },
};

const S = {
  container: { padding: "0 0 32px" },
  toolbar: {
    display: "flex", gap: 10, padding: "12px 20px",
    borderBottom: "1px solid #0a0a1e",
    background: "#02020a", alignItems: "center", flexWrap: "wrap",
  },
  filterBtn: (active) => ({
    background: "none",
    border: `1px solid ${active ? "#00ff88" : "#1a1a2e"}`,
    color: active ? "#00ff88" : "#444",
    fontSize: 8, letterSpacing: "0.12em",
    padding: "3px 8px", cursor: "pointer",
    borderRadius: 2, fontFamily: "inherit",
  }),
  statsBar: {
    display: "flex", gap: 28, padding: "10px 20px",
    borderBottom: "1px solid #0a0a1e", background: "#010108",
    flexWrap: "wrap",
  },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statLabel: { fontSize: 8, color: "#333", letterSpacing: "0.12em" },
  statValue: (color) => ({ fontSize: 13, fontWeight: 700, color: color || "#888" }),
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    fontSize: 8, color: "#333", letterSpacing: "0.14em",
    padding: "7px 12px", borderBottom: "1px solid #0a0a1e",
    textAlign: "left", whiteSpace: "nowrap",
    background: "#02020a", position: "sticky", top: 0,
  },
  td: {
    fontSize: 10, color: "#777",
    padding: "7px 12px", borderBottom: "1px solid #050510",
    whiteSpace: "nowrap",
  },
  empty: { fontSize: 10, color: "#2a2a3a", padding: "24px 20px" },
};

function StatBox({ label, value, color }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statValue(color)}>{value}</div>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────

export default function ArbHistorial() {
  const [ops,         setOps]         = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [filterMode,  setFilterMode]  = useState("all"); // "all" | "sim" | "real"
  const [filterRes,   setFilterRes]   = useState("all"); // "all" | "BALANCED" | "PHASE3_EXIT" | "PARTIAL"
  const [stats,       setStats]       = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let q = supabase
        .from("arb_operations")
        .select("*")
        .order("ts_entrada", { ascending: false })
        .limit(300);

      if (filterMode === "sim")  q = q.eq("simulado", true);
      if (filterMode === "real") q = q.eq("simulado", false);
      if (filterRes  !== "all")  q = q.eq("resultado", filterRes);

      const { data, error } = await q;
      if (error) throw error;
      setOps(data || []);

      // Calcular estadísticas locales
      const closed = (data || []).filter(o => o.resultado !== "PENDING");
      const pnl    = closed.reduce((s, o) => s + (parseFloat(o.pnl_usd) || 0), 0);
      const bal    = closed.filter(o => o.resultado === "BALANCED").length;
      const inv    = closed.reduce((s, o) => s + (parseFloat(o.stake_total_usd) || 0), 0);
      setStats({ total: closed.length, balanced: bal, pnl, invested: inv });

    } catch (e) {
      console.error("[ArbHistorial]", e);
    } finally {
      setLoading(false);
    }
  }, [filterMode, filterRes]);

  useEffect(() => { load(); }, [load]);

  const balancedRate = stats && stats.total > 0
    ? Math.round((stats.balanced / stats.total) * 100)
    : null;

  const roi = stats && stats.invested > 0
    ? ((stats.pnl / stats.invested) * 100).toFixed(2)
    : null;

  return (
    <div style={S.container}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={S.toolbar}>
        <span style={{ fontSize: 9, color: "#444", letterSpacing: "0.1em", marginRight: 4 }}>
          MODO:
        </span>
        {[["all", "TODOS"], ["sim", "SIMULADO"], ["real", "REAL"]].map(([v, l]) => (
          <button key={v} onClick={() => setFilterMode(v)}
            style={S.filterBtn(filterMode === v)}>{l}</button>
        ))}

        <span style={{ fontSize: 9, color: "#333", margin: "0 4px" }}>|</span>
        <span style={{ fontSize: 9, color: "#444", letterSpacing: "0.1em", marginRight: 4 }}>
          RESULTADO:
        </span>
        {[["all", "TODOS"], ["BALANCED", "BALANCED"], ["PHASE3_EXIT", "FASE 3"], ["PARTIAL", "PARTIAL"]].map(([v, l]) => (
          <button key={v} onClick={() => setFilterRes(v)}
            style={S.filterBtn(filterRes === v)}>{l}</button>
        ))}

        <button onClick={load} disabled={loading}
          style={{ ...S.filterBtn(false), marginLeft: "auto", color: "#4488ff", borderColor: "#1a2a4a" }}>
          {loading ? "…" : "↺ RECARGAR"}
        </button>
      </div>

      {/* ── Stats bar ────────────────────────────────────────────────────── */}
      {stats && (
        <div style={S.statsBar}>
          <StatBox label="OPERACIONES"  value={stats.total}                             color="#888"    />
          <StatBox label="BALANCED"     value={stats.balanced}                          color="#00ff88" />
          <StatBox label="TASA ÉXITO"   value={balancedRate != null ? `${balancedRate}%` : "—"} color={balancedRate >= 70 ? "#00ff88" : "#ff8800"} />
          <StatBox label="PnL TOTAL"    value={fmtUSD(stats.pnl)}                       color={stats.pnl >= 0 ? "#00ff88" : "#ff4466"} />
          <StatBox label="ROI"          value={roi != null ? `${roi}%` : "—"}           color={parseFloat(roi) >= 0 ? "#00ff88" : "#ff4466"} />
          <StatBox label="INVERTIDO"    value={`$${stats.invested.toFixed(2)}`}         color="#555"    />
        </div>
      )}

      {/* ── Tabla ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={S.empty}>cargando…</div>
      ) : ops.length === 0 ? (
        <div style={S.empty}>
          Sin operaciones ARB registradas.
          {filterMode !== "all" || filterRes !== "all"
            ? " Prueba a quitar filtros."
            : " El bot ARB debe estar activo para registrar operaciones."
          }
        </div>
      ) : (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                {[
                  "FECHA", "SLUG", "FASE", "UP ENTRY", "DOWN ENTRY",
                  "PAR COST", "GANANCIA GAR.", "PnL REAL", "RESULTADO", "MODO",
                ].map(h => <th key={h} style={S.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {ops.map(op => {
                const res = RESULTADO_STYLE[op.resultado] || { color: "#555", label: op.resultado };
                const pnl = parseFloat(op.pnl_usd);
                const gar = parseFloat(op.ganancia_garantizada);
                return (
                  <tr key={op.id}>
                    <td style={S.td}>{fmtDate(op.ts_entrada)}</td>
                    <td style={{ ...S.td, fontSize: 8, color: "#4488ff", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {op.market_slug || "—"}
                    </td>
                    <td style={{ ...S.td, fontSize: 8, color: "#666" }}>
                      {op.fase_entrada || "—"}
                    </td>
                    <td style={S.td}>{fmtOdds(op.up_entry_odds)}</td>
                    <td style={S.td}>{fmtOdds(op.down_entry_odds)}</td>
                    <td style={{
                      ...S.td, fontWeight: 700,
                      color: parseFloat(op.pair_cost) < 1.0 ? "#00ff88" : "#ff4466",
                    }}>
                      {fmtOdds(op.pair_cost)}
                    </td>
                    <td style={{ ...S.td, color: gar > 0 ? "#00ff88" : "#555" }}>
                      {gar > 0 ? `+$${gar.toFixed(4)}` : "—"}
                    </td>
                    <td style={{ ...S.td, color: pnl >= 0 ? "#00ff88" : "#ff4466", fontWeight: 700 }}>
                      {isNaN(pnl) ? "—" : fmtUSD(pnl)}
                    </td>
                    <td style={{ ...S.td, color: res.color, fontWeight: 600 }}>
                      {res.label}
                    </td>
                    <td style={{ ...S.td, fontSize: 8 }}>
                      <span style={{
                        padding: "2px 6px", borderRadius: 2,
                        background: op.simulado ? "rgba(68,136,255,0.1)" : "rgba(255,68,102,0.1)",
                        color: op.simulado ? "#4488ff" : "#ff4466",
                        border: `1px solid ${op.simulado ? "rgba(68,136,255,0.3)" : "rgba(255,68,102,0.3)"}`,
                      }}>
                        {op.simulado ? "SIM" : "REAL"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
