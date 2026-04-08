"use client";
/**
 * StatsPanel.jsx — v3.0
 *
 * CAMBIOS v3.0:
 *  7. COMPARATIVA ESTÁNDAR vs OPTIMIZADO (nueva sección):
 *     - Cards lado a lado: ops, wins, losses, win_rate, P&L total, P&L medio, ROI
 *     - Tabla de comparativa por ventana: P&L y win_rate de cada versión
 *     - Indicador visual de qué versión gana en cada métrica
 *     - Fuente: /api/stats-algorithm (endpoint dedicado)
 *     - Nota informativa cuando optimized tiene 0 ops (nuevo)
 *
 * CAMBIOS v2.0:
 *  0. HISTORIAL DE OPERACIONES: tabla paginada con odds compra/venta
 *  2. RENDIMIENTO POR VENTANA v2.0: COMPRA MEDIA + VENTA MEDIA
 *     Indicador ⚠ cuando win_rate > 50% pero P&L negativo
 */

import { useState, useEffect, useCallback } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────

const fmtUSD   = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtPct   = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtOdds  = (v) => v == null ? "—" : v.toFixed(4);
const pnlColor = (v) => v == null ? "#555" : v >= 0 ? "var(--green)" : "var(--red)";
const wrColor  = (v) => v == null ? "#555" : v >= 55 ? "var(--green)" : v >= 45 ? "var(--yellow)" : "var(--red)";

function resultColor(r) {
  if (r === "WIN")  return "var(--green)";
  if (r === "LOSS") return "var(--red)";
  if (r === "STOP") return "var(--yellow)";
  return "#555";
}

function fmtTs(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", {
      month:  "2-digit", day:    "2-digit",
      hour:   "2-digit", minute: "2-digit",
    }).replace(",", "");
  } catch { return iso.slice(0, 16).replace("T", " "); }
}

// ── Sub-componentes ───────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize: 9, color: "#444", letterSpacing: "0.18em",
      borderBottom: "1px solid #0d0d1a", paddingBottom: 8,
      marginBottom: 16, marginTop: 24,
    }}>
      {children}
    </div>
  );
}

function KpiCard({ label, value, color = "var(--text)", sub }) {
  return (
    <div style={{
      background: "#02020c", border: "1px solid #0d0d1a",
      borderRadius: 3, padding: "12px 16px", minWidth: 110,
    }}>
      <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function TableRow({ cells, header = false, highlight = false }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: cells.map(c => c.width || "1fr").join(" "),
      padding: header ? "6px 12px" : "8px 12px",
      borderBottom: "1px solid #07070f",
      background: highlight ? "#04040e" : "transparent",
      alignItems: "center",
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          fontSize: header ? 8 : 11,
          color: header ? "#333" : (c.color || "#777"),
          letterSpacing: header ? "0.14em" : 0,
          fontWeight: c.bold ? 700 : 400,
          textAlign: c.align || "left",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {c.value}
        </div>
      ))}
    </div>
  );
}

function BarChart({ rows, valueKey, labelKey, color = "#0066ff" }) {
  if (!rows || rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map(r => Math.abs(r[valueKey] ?? 0)), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((row, i) => {
        const val = row[valueKey] ?? 0;
        const pct = Math.abs(val) / max;
        const col = val >= 0 ? "var(--green)" : "var(--red)";
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 10, color: "#555", width: 40, textAlign: "right", flexShrink: 0 }}>
              {row[labelKey]}
            </div>
            <div style={{ flex: 1, background: "#07070f", borderRadius: 2, height: 14, overflow: "hidden" }}>
              <div style={{ width: `${pct * 100}%`, height: "100%", background: col, borderRadius: 2 }} />
            </div>
            <div style={{ fontSize: 10, color: col, width: 64, textAlign: "right", flexShrink: 0 }}>
              {fmtUSD(val)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Spinner() {
  return <div style={{ fontSize: 10, color: "#333", padding: "8px 0" }}>cargando…</div>;
}

function Empty({ msg = "Sin datos suficientes" }) {
  return <div style={{ fontSize: 10, color: "#2a2a3a", padding: "8px 0" }}>{msg}</div>;
}

function DbBadge({ available }) {
  return (
    <span style={{
      fontSize: 8, letterSpacing: "0.12em", padding: "2px 7px", borderRadius: 2,
      background: available ? "rgba(0,255,136,0.06)" : "rgba(255,68,102,0.08)",
      border: `1px solid ${available ? "rgba(0,255,136,0.2)" : "rgba(255,68,102,0.2)"}`,
      color: available ? "var(--green)" : "var(--red)",
    }}>
      {available ? "● SUPABASE OK" : "● SUPABASE OFF"}
    </span>
  );
}

// ── Hook genérico de stats ────────────────────────────────────────────────

function useStats(type, params = {}) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs  = new URLSearchParams({ type, ...params }).toString();
      const res = await fetch(`/api/stats?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [type, JSON.stringify(params)]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

// ── Hook comparativa algoritmos ───────────────────────────────────────────

function useAlgoComparison(params = {}) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs  = new URLSearchParams(params).toString();
      const res = await fetch(`/api/stats-algorithm?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(params)]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

// ── Hook historial de operaciones ─────────────────────────────────────────

function useBets(simOnly) {
  const [bets,    setBets]    = useState([]);
  const [total,   setTotal]   = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs  = new URLSearchParams({
        limit: "500",
        ...(simOnly !== "all" ? { simulated: simOnly === "sim" ? "true" : "false" } : {}),
      }).toString();
      const res = await fetch(`/api/bets?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setBets(json.bets || []);

      if (simOnly !== "all") {
        const r2 = await fetch("/api/bets?limit=1");
        if (r2.ok) {
          const j2 = await r2.json();
          setTotal(j2.count ?? null);
        }
      } else {
        setTotal(json.summary?.total ?? json.count ?? null);
      }
    } catch {
      setBets([]);
    } finally {
      setLoading(false);
    }
  }, [simOnly]);

  useEffect(() => { load(); }, [load]);
  return { bets, total, loading, reload: load };
}

// ── AlgoCard: tarjeta resumen de una versión de algoritmo ─────────────────

function AlgoCard({ label, data, color, icon, isNew = false }) {
  const noData = !data || data.total_ops === 0;
  return (
    <div style={{
      flex: 1, minWidth: 260,
      background: noData ? "#02020a" : `${color}08`,
      border: `1px solid ${noData ? "#1a1a2e" : `${color}33`}`,
      borderRadius: 4,
      padding: "16px 20px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ color, fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 11, color, letterSpacing: "0.12em", fontWeight: 700 }}>{label}</span>
        {isNew && (
          <span style={{
            fontSize: 8, padding: "1px 6px", borderRadius: 2,
            background: `${color}18`, border: `1px solid ${color}44`, color,
            marginLeft: "auto", letterSpacing: "0.1em",
          }}>
            NUEVO
          </span>
        )}
      </div>

      {noData ? (
        <div style={{ fontSize: 10, color: "#2a2a3a", lineHeight: 1.8 }}>
          Sin operaciones aún con esta versión.
          {isNew && (
            <span style={{ color: "#334433", display: "block", marginTop: 4 }}>
              Actívalo en Config → Versión de Algoritmo.
            </span>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
          {[
            ["OPS",      data.total_ops,                                                          "#888"],
            ["WINS",     data.wins,                                                               "var(--green)"],
            ["LOSSES",   data.losses + (data.stops || 0),                                         "var(--red)"],
            ["WIN RATE", data.win_rate_pct != null ? `${data.win_rate_pct}%` : "—",              wrColor(data.win_rate_pct)],
            ["P&L TOTAL", fmtUSD(data.pnl_usd),                                                  pnlColor(data.pnl_usd)],
            ["P&L/OP",   data.pnl_medio != null ? fmtUSD(data.pnl_medio) : "—",                  pnlColor(data.pnl_medio)],
            ["ROI",      data.roi_pct != null ? fmtPct(data.roi_pct) : "—",                      pnlColor(data.roi_pct)],
            ["ODDS MED.", data.avg_odds != null ? data.avg_odds.toFixed(4) : "—",                 "#4488ff"],
          ].map(([lbl, val, col]) => (
            <div key={lbl}>
              <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.12em", marginBottom: 2 }}>{lbl}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: col }}>{val}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel principal ───────────────────────────────────────────────────────

export default function StatsPanel() {
  const [simFilter, setSimFilter] = useState("all");
  const [days,      setDays]      = useState(30);
  const [betsPage,  setBetsPage]  = useState(0);

  const BETS_PER_PAGE = 20;

  const simParam   = simFilter === "all" ? {} : simFilter === "sim" ? { simulated: "true" } : { simulated: "false" };
  const daysParam  = { days: String(days) };
  const baseParams = { ...simParam, ...daysParam };

  const overview  = useStats("overview",     baseParams);
  const byWindow  = useStats("by_window",    simParam);
  const byDir     = useStats("by_direction", simParam);
  const byDay     = useStats("by_day",       baseParams);
  const byHour    = useStats("by_hour",      simParam);
  const signals   = useStats("signals",      { ...simParam, ...daysParam });
  const algoComp  = useAlgoComparison({ ...simParam, days: "90" });
  const { bets, total: betsTotal, loading: betsLoading, reload: reloadBets } = useBets(simFilter);

  const dbOk = overview.data?.available !== false;

  const reloadAll = () => {
    overview.reload(); byWindow.reload(); byDir.reload();
    byDay.reload(); byHour.reload(); signals.reload();
    algoComp.reload(); reloadBets();
    setBetsPage(0);
  };

  const closedBets = bets.filter(b => b.result !== "PENDING");
  const totalPages = Math.ceil(closedBets.length / BETS_PER_PAGE);
  const pageBets   = closedBets.slice(betsPage * BETS_PER_PAGE, (betsPage + 1) * BETS_PER_PAGE);

  const betsWins   = closedBets.filter(b => b.result === "WIN").length;
  const betsLosses = closedBets.filter(b => ["LOSS", "STOP"].includes(b.result)).length;
  const betsPnl    = closedBets.reduce((s, b) => s + (b.pnl_usd ?? 0), 0);

  return (
    <div style={{ padding: "20px 24px", fontFamily: "var(--font-mono)", color: "var(--text)" }}>

      {/* ── Header de controles ─────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 8, flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#333", letterSpacing: "0.18em" }}>ANALÍTICA DE RENDIMIENTO</span>
          <DbBadge available={dbOk} />
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {["all", "real", "sim"].map(f => (
            <button key={f} onClick={() => { setSimFilter(f); setBetsPage(0); }} style={{
              background:  simFilter === f ? "var(--border)" : "transparent",
              border:      "1px solid",
              borderColor: simFilter === f ? "#4488ff" : "#1a1a2e",
              color:       simFilter === f ? "#4488ff" : "#333",
              fontSize: 9, letterSpacing: "0.12em",
              padding: "4px 10px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit",
            }}>
              {f === "all" ? "TODO" : f === "real" ? "REAL" : "SIMULADO"}
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: "#1a1a2e" }} />

          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              background:  days === d ? "var(--border)" : "transparent",
              border:      "1px solid",
              borderColor: days === d ? "#aa66ff" : "#1a1a2e",
              color:       days === d ? "#aa66ff" : "#333",
              fontSize: 9, letterSpacing: "0.1em",
              padding: "4px 10px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit",
            }}>
              {d}D
            </button>
          ))}

          <button onClick={reloadAll} style={{
            background: "transparent", border: "1px solid #1a1a2e",
            color: "#333", fontSize: 9, padding: "4px 10px",
            borderRadius: 3, cursor: "pointer", fontFamily: "inherit",
          }}>
            ↺
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 1. OVERVIEW KPIs                                                  */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>1 · RESUMEN GLOBAL — ÚLTIMOS {days} DÍAS</SectionTitle>

      {overview.loading ? <Spinner /> : !overview.data?.available ? (
        <Empty msg={overview.data?.reason ?? "Supabase no disponible"} />
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <KpiCard
            label="TOTAL OPS"
            value={overview.data.total_ops}
            color="var(--text)"
            sub={`Período: ${days} días`}
          />
          <KpiCard
            label="WIN RATE"
            value={overview.data.win_rate != null ? `${overview.data.win_rate}%` : "—"}
            color={wrColor(overview.data.win_rate)}
          />
          <KpiCard
            label="WINS / LOSSES"
            value={`${overview.data.wins}W`}
            color="var(--green)"
            sub={`${overview.data.losses}L / ${overview.data.stops ?? 0}STOP`}
          />
          <KpiCard
            label="P&L NETO"
            value={overview.data.pnl_usd != null
              ? `${overview.data.pnl_usd >= 0 ? "+" : ""}$${Math.abs(overview.data.pnl_usd).toFixed(2)}`
              : "—"}
            color={pnlColor(overview.data.pnl_usd)}
            sub={`Invertido $${(overview.data.invested_usd ?? 0).toFixed(2)}`}
          />
          <KpiCard
            label="ROI"
            value={overview.data.roi_pct != null
              ? `${overview.data.roi_pct >= 0 ? "+" : ""}${overview.data.roi_pct.toFixed(1)}%`
              : "—"}
            color={pnlColor(overview.data.roi_pct)}
          />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 2. HISTORIAL DE OPERACIONES                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>2 · HISTORIAL DE OPERACIONES</SectionTitle>

      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{
          background: "#02020c", border: "1px solid #0d0d1a",
          borderRadius: 3, padding: "8px 14px", display: "flex", gap: 16, alignItems: "center",
        }}>
          <div>
            <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 4 }}>
              HISTORIAL TOTAL{betsTotal != null && simFilter !== "all" ? " (sin filtro)" : ""}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>
              {betsLoading ? "…" : (betsTotal ?? closedBets.length)}
            </div>
          </div>
          <div style={{ width: 1, height: 32, background: "#0d0d1a" }} />
          <div>
            <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 4 }}>WINS</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>{betsWins}</div>
          </div>
          <div style={{ width: 1, height: 32, background: "#0d0d1a" }} />
          <div>
            <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 4 }}>LOSSES</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>{betsLosses}</div>
          </div>
          <div style={{ width: 1, height: 32, background: "#0d0d1a" }} />
          <div>
            <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 4 }}>P&L ACUM.</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: pnlColor(betsPnl) }}>
              {betsPnl >= 0 ? "+" : ""}{betsPnl.toFixed(2)}$
            </div>
          </div>
        </div>
        {simFilter !== "all" && (
          <div style={{ fontSize: 9, color: "#2a2a3a" }}>
            Mostrando {closedBets.length} ops. · filtro: {simFilter === "sim" ? "SIMULADO" : "REAL"}
          </div>
        )}
      </div>

      {betsLoading ? <Spinner /> : closedBets.length === 0 ? (
        <Empty msg="Sin operaciones cerradas aún" />
      ) : (
        <>
          <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
            <TableRow header cells={[
              { value: "FECHA",       width: "118px" },
              { value: "DIR",         width: "52px" },
              { value: "VENTANA",     width: "58px",  align: "center" },
              { value: "BTC ENTRADA", width: "100px", align: "right" },
              { value: "ODDS COMPRA", width: "90px",  align: "right" },
              { value: "ODDS VENTA",  width: "90px",  align: "right" },
              { value: "RESULTADO",   width: "80px",  align: "center" },
              { value: "P&L",         width: "80px",  align: "right" },
            ]} />
            {pageBets.map((bet, i) => {
              const isWin  = bet.result === "WIN";
              const isLoss = ["LOSS", "STOP"].includes(bet.result);
              const pnlC   = isWin ? "var(--green)" : isLoss ? "var(--red)" : "#555";
              const exitOdds = bet.real_exit_odds ?? bet.odds_salida ?? null;

              return (
                <TableRow key={bet.id || i} highlight={i % 2 === 0} cells={[
                  { value: fmtTs(bet.ts),  width: "118px", color: "#444" },
                  {
                    value: bet.dir === "UP" ? "▲ UP" : "▼ DOWN",
                    width: "52px",
                    color: bet.dir === "UP" ? "var(--green)" : "var(--red)",
                    bold: true,
                  },
                  { value: bet.window || "—",  width: "58px",  align: "center", color: "#4488ff" },
                  {
                    value: bet.entry
                      ? `$${Number(bet.entry).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                      : "—",
                    width: "100px", align: "right", color: "#888",
                  },
                  { value: fmtOdds(bet.odds),    width: "90px", align: "right", color: "#4488ff" },
                  {
                    value: fmtOdds(exitOdds),
                    width: "90px", align: "right",
                    color: exitOdds != null ? (exitOdds > (bet.odds ?? 0) ? "var(--green)" : "var(--red)") : "#333",
                  },
                  {
                    value: bet.result || "—",
                    width: "80px", align: "center",
                    color: resultColor(bet.result), bold: true,
                  },
                  {
                    value: bet.pnl_usd != null
                      ? `${bet.pnl_usd >= 0 ? "+" : ""}$${Math.abs(bet.pnl_usd).toFixed(2)}`
                      : "—",
                    width: "80px", align: "right", color: pnlC, bold: true,
                  },
                ]} />
              );
            })}
          </div>

          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, justifyContent: "flex-end" }}>
              <span style={{ fontSize: 9, color: "#333" }}>
                Página {betsPage + 1} / {totalPages} · {closedBets.length} ops.
              </span>
              <button disabled={betsPage === 0} onClick={() => setBetsPage(p => p - 1)} style={{
                background: "transparent", border: "1px solid #1a1a2a",
                color: betsPage === 0 ? "#222" : "#555",
                padding: "3px 10px", borderRadius: 3, fontSize: 9,
                cursor: betsPage === 0 ? "default" : "pointer", fontFamily: "inherit",
              }}>← ANT</button>
              <button disabled={betsPage >= totalPages - 1} onClick={() => setBetsPage(p => p + 1)} style={{
                background: "transparent", border: "1px solid #1a1a2a",
                color: betsPage >= totalPages - 1 ? "#222" : "#555",
                padding: "3px 10px", borderRadius: 3, fontSize: 9,
                cursor: betsPage >= totalPages - 1 ? "default" : "pointer", fontFamily: "inherit",
              }}>SIG →</button>
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 3. RENDIMIENTO POR VENTANA                                        */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>3 · RENDIMIENTO POR VENTANA DE ENTRADA</SectionTitle>

      {byWindow.loading ? <Spinner /> : !byWindow.data?.rows?.length ? <Empty /> : (
        <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
          <TableRow header cells={[
            { value: "VENTANA",      width: "70px" },
            { value: "OPS",          width: "45px", align: "center" },
            { value: "WINS",         width: "45px", align: "center" },
            { value: "LOSSES",       width: "55px", align: "center" },
            { value: "WIN RATE",     width: "78px", align: "right" },
            { value: "P&L TOTAL",    width: "95px", align: "right" },
            { value: "P&L MEDIO",    width: "90px", align: "right" },
            { value: "COMPRA MEDIA", width: "95px", align: "right" },
            { value: "VENTA MEDIA",  width: "90px", align: "right" },
          ]} />
          {byWindow.data.rows.map((row, i) => {
            const pnlInconsistent = row.win_rate_pct != null && row.win_rate_pct > 50
              && row.pnl_total_usd != null && row.pnl_total_usd < 0;
            return (
              <TableRow key={i} cells={[
                { value: row.ventana,    width: "70px",  color: "#4488ff", bold: true },
                { value: row.total_ops,  width: "45px",  align: "center" },
                { value: row.wins,       width: "45px",  align: "center", color: "var(--green)" },
                { value: row.losses,     width: "55px",  align: "center", color: "var(--red)" },
                {
                  value: row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",
                  width: "78px", align: "right", color: wrColor(row.win_rate_pct), bold: true,
                },
                {
                  value: row.pnl_total_usd != null
                    ? `${pnlInconsistent ? "⚠ " : ""}${row.pnl_total_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_total_usd).toFixed(2)}`
                    : "—",
                  width: "95px", align: "right", color: pnlColor(row.pnl_total_usd),
                },
                {
                  value: row.pnl_medio_usd != null
                    ? `${row.pnl_medio_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_medio_usd).toFixed(2)}`
                    : "—",
                  width: "90px", align: "right", color: pnlColor(row.pnl_medio_usd),
                },
                {
                  value: row.avg_odds_entrada != null ? row.avg_odds_entrada.toFixed(4) : "—",
                  width: "95px", align: "right", color: "#4488ff",
                },
                {
                  value: row.avg_odds_salida != null ? row.avg_odds_salida.toFixed(4) : "—",
                  width: "90px", align: "right",
                  color: row.avg_odds_salida != null && row.avg_odds_entrada != null
                    ? (row.avg_odds_salida > row.avg_odds_entrada ? "var(--green)" : "var(--red)")
                    : "#444",
                },
              ]} />
            );
          })}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 4. UP VS DOWN                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>4 · UP VS DOWN</SectionTitle>

      {byDir.loading ? <Spinner /> : !byDir.data?.rows?.length ? <Empty /> : (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          {byDir.data.rows.map((row, i) => (
            <div key={i} style={{
              background: "#02020c", border: "1px solid #0d0d1a",
              borderRadius: 3, padding: "14px 20px", minWidth: 160,
            }}>
              <div style={{
                fontSize: 16, fontWeight: 700, marginBottom: 10,
                color: row.direccion === "UP" ? "var(--green)" : "var(--red)",
              }}>
                {row.direccion === "UP" ? "▲ UP" : "▼ DOWN"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10 }}>
                {[
                  ["Ops",      row.total_ops],
                  ["Wins",     row.wins,                                                    "var(--green)"],
                  ["Losses",   row.losses,                                                  "var(--red)"],
                  ["Win Rate", row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",    wrColor(row.win_rate_pct)],
                  ["P&L",      row.pnl_total_usd != null
                    ? `${row.pnl_total_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_total_usd).toFixed(2)}`
                    : "—",                                                                  pnlColor(row.pnl_total_usd)],
                ].map(([label, val, c]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <span style={{ color: "#333" }}>{label}</span>
                    <span style={{ color: c || "#777", fontWeight: 600 }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 5. P&L DIARIO                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>5 · P&L DIARIO — ÚLTIMOS {days} DÍAS</SectionTitle>

      {byDay.loading ? <Spinner /> : !byDay.data?.rows?.length ? <Empty /> : (
        <BarChart rows={byDay.data.rows} valueKey="pnl_usd" labelKey="fecha" />
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 6. WIN RATE POR HORA UTC                                          */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>6 · WIN RATE POR HORA UTC</SectionTitle>

      {byHour.loading ? <Spinner /> : !byHour.data?.rows?.length ? <Empty /> : (
        <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
          <TableRow header cells={[
            { value: "HORA UTC", width: "80px" },
            { value: "OPS",      width: "50px", align: "center" },
            { value: "WINS",     width: "50px", align: "center" },
            { value: "WIN RATE", width: "80px", align: "right" },
            { value: "P&L",      width: "90px", align: "right" },
          ]} />
          {byHour.data.rows.map((row, i) => (
            <TableRow key={i} cells={[
              { value: `${String(row.hour_utc).padStart(2, "0")}:00`, width: "80px", color: "#888" },
              { value: row.ops,   width: "50px", align: "center" },
              { value: row.wins,  width: "50px", align: "center", color: "var(--green)" },
              {
                value: row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",
                width: "80px", align: "right", color: wrColor(row.win_rate_pct), bold: true,
              },
              {
                value: row.pnl_usd != null
                  ? `${row.pnl_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_usd).toFixed(2)}`
                  : "—",
                width: "90px", align: "right", color: pnlColor(row.pnl_usd),
              },
            ]} />
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 7. COMPARATIVA ESTÁNDAR vs OPTIMIZADO  (v3.0)                    */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>7 · COMPARATIVA ESTÁNDAR vs OPTIMIZADO — ÚLTIMOS 90 DÍAS</SectionTitle>

      {algoComp.loading ? <Spinner /> : !algoComp.data?.available ? (
        <Empty msg={algoComp.data?.reason ?? "Sin datos"} />
      ) : (
        <>
          {/* ── Cards resumen lado a lado ─────────────────────────────── */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
            <AlgoCard
              label="ESTÁNDAR"
              data={algoComp.data.standard}
              color="#4488ff"
              icon="◈"
            />
            <AlgoCard
              label="OPTIMIZADO"
              data={algoComp.data.optimized}
              color="#00ff88"
              icon="⬡"
              isNew={algoComp.data.optimized?.total_ops === 0}
            />
          </div>

          {/* ── Diferencial global ───────────────────────────────────── */}
          {algoComp.data.standard?.total_ops > 0 && algoComp.data.optimized?.total_ops > 0 && (() => {
            const s = algoComp.data.standard;
            const o = algoComp.data.optimized;
            const pnlDiff = (o.pnl_usd  ?? 0) - (s.pnl_usd  ?? 0);
            const wrDiff  = (o.win_rate_pct ?? 0) - (s.win_rate_pct ?? 0);
            const roiDiff = (o.roi_pct ?? 0) - (s.roi_pct ?? 0);
            return (
              <div style={{
                marginBottom: 20,
                padding: "12px 16px",
                background: pnlDiff >= 0 ? "#020e06" : "#0e0206",
                border: `1px solid ${pnlDiff >= 0 ? "#003322" : "#330011"}`,
                borderRadius: 3,
                fontSize: 10, lineHeight: 1.8,
              }}>
                <div style={{
                  fontSize: 8, letterSpacing: "0.14em",
                  color: pnlDiff >= 0 ? "#00cc66" : "#cc0033",
                  marginBottom: 6,
                }}>
                  {pnlDiff >= 0 ? "⬡ OPTIMIZADO SUPERA AL ESTÁNDAR" : "◈ ESTÁNDAR SUPERA AL OPTIMIZADO"}
                </div>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                  {[
                    ["ΔP&L",      fmtUSD(pnlDiff), pnlColor(pnlDiff)],
                    ["ΔWIN RATE", `${wrDiff >= 0 ? "+" : ""}${wrDiff.toFixed(1)}%`, wrDiff >= 0 ? "var(--green)" : "var(--red)"],
                    ["ΔROI",      `${roiDiff >= 0 ? "+" : ""}${roiDiff.toFixed(1)}%`, pnlColor(roiDiff)],
                  ].map(([lbl, val, col]) => (
                    <div key={lbl}>
                      <span style={{ color: "#444", marginRight: 8 }}>{lbl}</span>
                      <span style={{ color: col, fontWeight: 700 }}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* ── Tabla comparativa por ventana ────────────────────────── */}
          {algoComp.data.window_comparison?.length > 0 && (
            <>
              <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.12em", marginBottom: 10 }}>
                P&L Y WIN RATE POR VENTANA
              </div>
              <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
                <TableRow header cells={[
                  { value: "VENTANA",          width: "70px" },
                  { value: "◈ OPS STD",         width: "80px",  align: "center" },
                  { value: "◈ WR STD",          width: "80px",  align: "right" },
                  { value: "◈ P&L STD",         width: "95px",  align: "right" },
                  { value: "⬡ OPS OPT",         width: "80px",  align: "center" },
                  { value: "⬡ WR OPT",          width: "80px",  align: "right" },
                  { value: "⬡ P&L OPT",         width: "95px",  align: "right" },
                  { value: "Δ P&L",             width: "90px",  align: "right" },
                ]} />
                {algoComp.data.window_comparison.map((row, i) => {
                  const diff = (row.optimized_pnl ?? 0) - (row.standard_pnl ?? 0);
                  const optBetter = row.optimized_pnl != null && row.standard_pnl != null
                    ? row.optimized_pnl > row.standard_pnl : null;
                  return (
                    <TableRow key={i} highlight={i % 2 === 0} cells={[
                      { value: row.ventana,                                                      width: "70px",  color: "#888",          bold: true },
                      { value: row.standard_ops || 0,                                            width: "80px",  align: "center" },
                      {
                        value: row.standard_wr != null ? `${row.standard_wr}%` : "—",
                        width: "80px", align: "right", color: wrColor(row.standard_wr),
                      },
                      {
                        value: row.standard_pnl != null ? fmtUSD(row.standard_pnl) : "—",
                        width: "95px", align: "right", color: pnlColor(row.standard_pnl),
                      },
                      { value: row.optimized_ops || 0,                                           width: "80px",  align: "center" },
                      {
                        value: row.optimized_wr != null ? `${row.optimized_wr}%` : "—",
                        width: "80px", align: "right", color: wrColor(row.optimized_wr),
                      },
                      {
                        value: row.optimized_pnl != null ? fmtUSD(row.optimized_pnl) : "—",
                        width: "95px", align: "right", color: pnlColor(row.optimized_pnl),
                      },
                      {
                        value: row.optimized_pnl != null && row.standard_pnl != null
                          ? fmtUSD(diff) : "—",
                        width: "90px", align: "right",
                        color: optBetter === true ? "var(--green)" : optBetter === false ? "var(--red)" : "#444",
                        bold: true,
                      },
                    ]} />
                  );
                })}
              </div>

              {/* Nota informativa */}
              <div style={{
                marginTop: 10, fontSize: 9, color: "#2a3a2a", lineHeight: 1.7,
              }}>
                ◈ Standard incluye ops sin <span style={{ color: "#334" }}>algorithm_version</span> (anteriores a v11.5).
                El filtro de simulado/real de arriba no afecta esta sección (siempre 90 días).
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}
