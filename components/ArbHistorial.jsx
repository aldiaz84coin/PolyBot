/**
 * ArbHistorial.jsx — v1.1
 *
 * v1.1 — MIGRACIÓN: eliminado createClient de @supabase/supabase-js.
 *         Ahora usa /api/arb-ops (GET) con query params para filtros.
 *         Corrige error "supabaseUrl is required" en build de Vercel.
 *
 * v1.0 — Implementación inicial
 */

"use client";

import { useState, useEffect, useCallback } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Componente principal ──────────────────────────────────────────────────────

export default function ArbHistorial() {
  const [ops,        setOps]        = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [filterMode, setFilterMode] = useState("all"); // "all" | "sim" | "real"
  const [filterRes,  setFilterRes]  = useState("all"); // "all" | "BALANCED" | "PHASE3_EXIT" | "PARTIAL"
  const [stats,      setStats]      = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        mode:      filterMode,
        resultado: filterRes,
        limit:     "300",
      });
      const res  = await fetch(`/api/arb-ops?${params}`, { cache: "no-store" });
      const data = await res.json();
      setOps(data.ops   ?? []);
      setStats(data.stats ?? null);
    } catch (e) {
      console.error("[ArbHistorial]", e);
    } finally {
      setLoading(false);
    }
  }, [filterMode, filterRes]);

  useEffect(() => { load(); }, [load]);

  const balancedRate = stats && stats.total > 0
    ? ((stats.balanced / stats.total) * 100).toFixed(0)
    : null;

  return (
    <div style={S.container}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={S.toolbar}>
        <span style={{ fontSize: 9, color: "#333", letterSpacing: "0.1em" }}>MODO:</span>
        {[["all","TODOS"],["sim","SIMULADO"],["real","REAL"]].map(([v,l]) => (
          <button key={v} onClick={() => setFilterMode(v)}
            style={S.filterBtn(filterMode === v)}>{l}</button>
        ))}
        <span style={{ fontSize: 9, color: "#333", letterSpacing: "0.1em", marginLeft: 8 }}>RESULTADO:</span>
        {[["all","TODOS"],["BALANCED","✅ BAL"],["PHASE3_EXIT","⚠ F3"],["PARTIAL","❌ PAR"],["PENDING","⏳ PEN"]].map(([v,l]) => (
          <button key={v} onClick={() => setFilterRes(v)}
            style={S.filterBtn(filterRes === v)}>{l}</button>
        ))}
        <button onClick={load} disabled={loading}
          style={{ ...S.filterBtn(false), marginLeft: "auto", color: "#4488ff" }}>
          {loading ? "…" : "↺"}
        </button>
      </div>

      {/* ── Stats bar ───────────────────────────────────────────────────── */}
      {stats && (
        <div style={S.statsBar}>
          <StatBox label="OPS CERRADAS"  value={stats.total}   color="#888" />
          <StatBox label="BALANCED"      value={stats.balanced} color="#00ff88" />
          <StatBox
            label="TASA ÉXITO"
            value={balancedRate != null ? `${balancedRate}%` : "—"}
            color={balancedRate != null && parseInt(balancedRate) >= 60 ? "#00ff88" : "#ff8800"}
          />
          <StatBox
            label="PnL TOTAL"
            value={fmtUSD(stats.pnl)}
            color={stats.pnl >= 0 ? "#00ff88" : "#ff4466"}
          />
          <StatBox
            label="INVERTIDO"
            value={`$${(stats.invested || 0).toFixed(2)}`}
            color="#555"
          />
        </div>
      )}

      {/* ── Tabla ───────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={S.empty}>cargando…</div>
      ) : ops.length === 0 ? (
        <div style={S.empty}>Sin operaciones ARB registradas con los filtros seleccionados.</div>
      ) : (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                {["FECHA","MERCADO","FASE","PAR COST","UP ODDS","DN ODDS","GANANCIA","PnL","RESULTADO","SIM"].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ops.map(op => {
                const rs = RESULTADO_STYLE[op.resultado] ?? { color: "#555", label: op.resultado };
                return (
                  <tr key={op.id}>
                    <td style={S.td}>{fmtDate(op.ts_entrada)}</td>
                    <td style={{ ...S.td, color: "#4488ff", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {op.market_slug?.split("-").slice(-3).join("-") ?? "—"}
                    </td>
                    <td style={{ ...S.td, color: "#888" }}>{op.fase_entrada ?? "—"}</td>
                    <td style={{ ...S.td, color: op.pair_cost < 1 ? "#00ff88" : "#ff4466" }}>
                      {fmtOdds(op.pair_cost)}
                    </td>
                    <td style={S.td}>{fmtOdds(op.up_entry_odds)}</td>
                    <td style={S.td}>{fmtOdds(op.down_entry_odds)}</td>
                    <td style={{ ...S.td, color: "#00ff88" }}>{fmtUSD(op.ganancia_garantizada)}</td>
                    <td style={{ ...S.td, color: op.pnl_usd >= 0 ? "#00ff88" : "#ff4466" }}>
                      {op.resultado === "PENDING" ? "—" : fmtUSD(op.pnl_usd)}
                    </td>
                    <td style={{ ...S.td, color: rs.color, fontWeight: 700 }}>{rs.label}</td>
                    <td style={{ ...S.td, color: op.simulado ? "#4488ff" : "#ff4466" }}>
                      {op.simulado ? "SIM" : "REAL"}
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
