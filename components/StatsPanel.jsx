"use client";
/**
 * StatsPanel.jsx — v2.1
 *
 * CAMBIOS v2.1:
 *  - FIX CRÍTICO useBets: la API /api/bets devuelve { ok, data: [...] }
 *    pero el hook leía json.bets (siempre undefined → []).
 *    Corregido a: json.data || json.bets || []
 *  - FIX total histórico: antes leía json.count / j2.count (inexistente).
 *    Ahora se cuenta desde los arrays devueltos filtrando PENDING.
 *
 * CAMBIOS v2.0:
 *  0. HISTORIAL DE OPERACIONES (nueva sección):
 *     - Contador histórico independiente con badge total/wins/losses
 *     - Tabla per-operación: fecha, dir, ventana, BTC entrada,
 *       odds compra, odds venta, resultado, P&L
 *     - Color de P&L basado en resultado (WIN/LOSS), no en signo numérico
 *       (workaround para datos simulados con pnl_usd incorrecto)
 *     - Paginación de 20 en 20 filas
 *
 *  2. RENDIMIENTO POR VENTANA (sección corregida):
 *     - Reemplaza "ODDS MEDIA" por dos columnas: "COMPRA MEDIA" y "VENTA MEDIA"
 *       (avg_odds_entrada y avg_odds_salida desde el API actualizado)
 *     - Indicador ⚠ cuando win_rate > 50% pero P&L total es negativo
 *       (señal de inconsistencia de datos pnl_usd en modo simulado)
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

// ── Hook historial de operaciones ─────────────────────────────────────────

function useBets(simOnly) {
  const [bets,    setBets]    = useState([]);
  const [total,   setTotal]   = useState(null); // total histórico sin filtro
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Carga filtrada (para la tabla)
      const qs = new URLSearchParams({
        limit: "500",
        ...(simOnly !== "all" ? { simulated: simOnly === "sim" ? "true" : "false" } : {}),
      }).toString();
      const res = await fetch(`/api/bets?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      // ✅ FIX v2.1: API devuelve json.data, no json.bets
      const list = json.data || json.bets || [];
      setBets(list);

      // Contador total sin filtro (para el badge "HISTORIAL TOTAL")
      if (simOnly !== "all") {
        // Fetch sin filtro para contar el total real
        const r2 = await fetch("/api/bets?limit=500");
        if (r2.ok) {
          const j2  = await r2.json();
          const all = j2.data || j2.bets || [];
          setTotal(all.filter(b => b.result !== "PENDING").length);
        }
      } else {
        // Sin filtro: el total es lo que ya tenemos
        setTotal(list.filter(b => b.result !== "PENDING").length);
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

// ── Panel principal ───────────────────────────────────────────────────────

export default function StatsPanel() {
  const [simFilter, setSimFilter] = useState("all");
  const [days,      setDays]      = useState(30);
  const [betsPage,  setBetsPage]  = useState(0);

  const BETS_PER_PAGE = 20;

  const simParam   = simFilter === "all" ? {} : simFilter === "sim" ? { simulated: "true" } : { simulated: "false" };
  const daysParam  = { days: String(days) };
  const baseParams = { ...simParam, ...daysParam };

  const overview = useStats("overview",     baseParams);
  const byWindow = useStats("by_window",    simParam);
  const byDir    = useStats("by_direction", simParam);
  const byDay    = useStats("by_day",       baseParams);
  const byHour   = useStats("by_hour",      simParam);
  const signals  = useStats("signals",      { ...simParam, ...daysParam });
  const { bets, total: betsTotal, loading: betsLoading, reload: reloadBets } = useBets(simFilter);

  const dbOk = overview.data?.available !== false;

  const reloadAll = () => {
    overview.reload(); byWindow.reload(); byDir.reload();
    byDay.reload(); byHour.reload(); signals.reload(); reloadBets();
    setBetsPage(0);
  };

  // ── Paginación de la tabla de operaciones ─────────────────────────────
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
              background:   simFilter === f ? "var(--border)" : "transparent",
              border:       "1px solid",
              borderColor:  simFilter === f ? "#1a1a2a" : "#0d0d1a",
              color:        simFilter === f ? "var(--text)" : "#333",
              padding:      "3px 10px", borderRadius: 3,
              fontSize:     9, letterSpacing: "0.12em",
              cursor:       "pointer",
            }}>
              {f === "all" ? "TODOS" : f === "real" ? "REAL" : "SIM"}
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: "#0d0d1a", margin: "0 4px" }} />

          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              background:  days === d ? "var(--border)" : "transparent",
              border:      "1px solid",
              borderColor: days === d ? "#1a1a2a" : "#0d0d1a",
              color:       days === d ? "var(--text)" : "#333",
              padding:     "3px 10px", borderRadius: 3,
              fontSize:    9, letterSpacing: "0.12em",
              cursor:      "pointer",
            }}>
              {d}D
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: "#0d0d1a", margin: "0 4px" }} />

          <button onClick={reloadAll} style={{
            background: "transparent", border: "1px solid #0d0d1a",
            color: "#333", padding: "3px 10px", borderRadius: 3,
            fontSize: 9, cursor: "pointer",
          }}>
            ↺
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 1. OVERVIEW                                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>1 · OVERVIEW — ÚLTIMOS {days} DÍAS</SectionTitle>

      {overview.loading
        ? <Spinner />
        : overview.error || !overview.data?.available
        ? <Empty msg={overview.error || "Supabase no disponible"} />
        : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <KpiCard
              label="OPERACIONES"
              value={overview.data.total_ops ?? 0}
              sub={`${overview.data.wins ?? 0}W / ${overview.data.losses ?? 0}L / ${overview.data.stops ?? 0}STOP`}
            />
            <KpiCard
              label="WIN RATE"
              value={overview.data.win_rate != null ? `${overview.data.win_rate}%` : "—"}
              color={wrColor(overview.data.win_rate)}
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
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 2. HISTORIAL DE OPERACIONES                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>2 · HISTORIAL DE OPERACIONES</SectionTitle>

      {/* Counter badges independientes */}
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

      {betsLoading
        ? <Spinner />
        : closedBets.length === 0
        ? <Empty msg="Sin operaciones cerradas aún" />
        : (
          <>
            <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
              <TableRow header cells={[
                { value: "FECHA",       width: "118px" },
                { value: "DIR",         width: "52px" },
                { value: "VENTANA",     width: "58px", align: "center" },
                { value: "BTC ENTRADA", width: "100px", align: "right" },
                { value: "ODDS COMPRA", width: "90px", align: "right" },
                { value: "ODDS VENTA",  width: "90px", align: "right" },
                { value: "RESULTADO",   width: "80px", align: "center" },
                { value: "P&L",         width: "80px", align: "right" },
              ]} />
              {pageBets.map((bet, i) => {
                const isWin  = bet.result === "WIN";
                const isLoss = ["LOSS", "STOP"].includes(bet.result);
                // Color de P&L por resultado (no por signo numérico — workaround datos sim)
                const pnlC = isWin ? "var(--green)" : isLoss ? "var(--red)" : "#555";
                // Precio de salida: real_exit_odds > odds_salida > "—"
                const exitOdds = bet.real_exit_odds ?? bet.odds_salida ?? null;

                return (
                  <TableRow key={bet.id || i} highlight={i % 2 === 0} cells={[
                    { value: fmtTs(bet.ts),                   width: "118px", color: "#444" },
                    {
                      value: bet.dir === "UP" ? "▲ UP" : "▼ DOWN",
                      width: "52px",
                      color: bet.dir === "UP" ? "var(--green)" : "var(--red)",
                      bold: true,
                    },
                    { value: bet.window || "—",               width: "58px",  align: "center", color: "#4488ff" },
                    {
                      value: bet.entry
                        ? `$${Number(bet.entry).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : "—",
                      width: "100px", align: "right", color: "#888",
                    },
                    { value: fmtOdds(bet.odds),               width: "90px",  align: "right", color: "#4488ff" },
                    {
                      value: fmtOdds(exitOdds),
                      width: "90px",  align: "right",
                      color: exitOdds != null
                        ? (exitOdds > (bet.odds ?? 0) ? "var(--green)" : "var(--red)")
                        : "#333",
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
                      width: "80px", align: "right",
                      color: pnlC,
                      bold: true,
                    },
                  ]} />
                );
              })}
            </div>

            {/* Paginación */}
            {totalPages > 1 && (
              <div style={{
                display: "flex", gap: 8, alignItems: "center",
                marginTop: 10, justifyContent: "flex-end",
              }}>
                <span style={{ fontSize: 9, color: "#333" }}>
                  Página {betsPage + 1} / {totalPages} · {closedBets.length} ops.
                </span>
                <button
                  disabled={betsPage === 0}
                  onClick={() => setBetsPage(p => p - 1)}
                  style={{
                    background: "transparent", border: "1px solid #1a1a2a",
                    color: betsPage === 0 ? "#222" : "#555",
                    padding: "3px 10px", borderRadius: 3, fontSize: 9,
                    cursor: betsPage === 0 ? "default" : "pointer",
                  }}
                >
                  ← ANT
                </button>
                <button
                  disabled={betsPage >= totalPages - 1}
                  onClick={() => setBetsPage(p => p + 1)}
                  style={{
                    background: "transparent", border: "1px solid #1a1a2a",
                    color: betsPage >= totalPages - 1 ? "#222" : "#555",
                    padding: "3px 10px", borderRadius: 3, fontSize: 9,
                    cursor: betsPage >= totalPages - 1 ? "default" : "pointer",
                  }}
                >
                  SIG →
                </button>
              </div>
            )}
          </>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 3. RENDIMIENTO POR VENTANA DE ENTRADA (v2.0: compra+venta media)  */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>3 · RENDIMIENTO POR VENTANA DE ENTRADA</SectionTitle>

      {byWindow.loading
        ? <Spinner />
        : !byWindow.data?.rows?.length
        ? <Empty />
        : (
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
              // ⚠ Detecta inconsistencia: win_rate > 50% pero P&L negativo
              const pnlInconsistent = row.win_rate_pct != null && row.win_rate_pct > 50
                && row.pnl_total_usd != null && row.pnl_total_usd < 0;

              return (
                <TableRow key={i} cells={[
                  { value: row.ventana,   width: "70px",  color: "#4488ff", bold: true },
                  { value: row.total_ops, width: "45px",  align: "center" },
                  { value: row.wins,      width: "45px",  align: "center", color: "var(--green)" },
                  { value: row.losses,    width: "55px",  align: "center", color: "var(--red)" },
                  {
                    value: row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",
                    width: "78px", align: "right",
                    color: wrColor(row.win_rate_pct), bold: true,
                  },
                  {
                    value: row.pnl_total_usd != null
                      ? `${pnlInconsistent ? "⚠ " : ""}${row.pnl_total_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_total_usd).toFixed(2)}`
                      : "—",
                    width: "95px", align: "right",
                    color: pnlColor(row.pnl_total_usd),
                  },
                  {
                    value: row.pnl_medio_usd != null
                      ? `${row.pnl_medio_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_medio_usd).toFixed(2)}`
                      : "—",
                    width: "90px", align: "right",
                    color: pnlColor(row.pnl_medio_usd),
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
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 4. UP VS DOWN                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>4 · UP VS DOWN</SectionTitle>

      {byDir.loading
        ? <Spinner />
        : !byDir.data?.rows?.length
        ? <Empty />
        : (
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
                    ["Wins",     row.wins,      "var(--green)"],
                    ["Losses",   row.losses,    "var(--red)"],
                    ["Win Rate", row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—", wrColor(row.win_rate_pct)],
                    ["P&L",      row.pnl_total_usd != null
                                  ? `${row.pnl_total_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_total_usd).toFixed(2)}`
                                  : "—", pnlColor(row.pnl_total_usd)],
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
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 5. P&L DIARIO                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>5 · P&L DIARIO — ÚLTIMOS {days} DÍAS</SectionTitle>

      {byDay.loading
        ? <Spinner />
        : !byDay.data?.rows?.length
        ? <Empty />
        : <BarChart rows={byDay.data.rows} valueKey="pnl_usd" labelKey="fecha" />
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 6. WIN RATE POR HORA UTC                                          */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>6 · WIN RATE POR HORA UTC</SectionTitle>

      {byHour.loading
        ? <Spinner />
        : !byHour.data?.rows?.length
        ? <Empty />
        : (
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
                { value: row.ops,  width: "50px", align: "center" },
                { value: row.wins, width: "50px", align: "center", color: "var(--green)" },
                {
                  value: row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",
                  width: "80px", align: "right",
                  color: wrColor(row.win_rate_pct), bold: true,
                },
                {
                  value: row.pnl_usd != null
                    ? `${row.pnl_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_usd).toFixed(2)}`
                    : "—",
                  width: "90px", align: "right",
                  color: pnlColor(row.pnl_usd),
                },
              ]} />
            ))}
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 7. CALIBRACIÓN DE UMBRALES (señales accionables)                  */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>7 · SEÑALES ACCIONABLES — CALIBRACIÓN DE UMBRALES</SectionTitle>

      {signals.loading
        ? <Spinner />
        : !signals.data?.summary?.length
        ? <Empty />
        : (
          <>
            <div style={{ fontSize: 10, color: "#333", marginBottom: 12 }}>
              {signals.data.raw_count} señales analizadas en los últimos {days} días
            </div>
            <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
              <TableRow header cells={[
                { value: "VENTANA",    width: "80px" },
                { value: "SEÑALES",    width: "70px", align: "center" },
                { value: "DIST MEDIA", width: "90px", align: "right" },
                { value: "▲ UP",       width: "60px", align: "center" },
                { value: "▼ DOWN",     width: "60px", align: "center" },
              ]} />
              {signals.data.summary.map((row, i) => (
                <TableRow key={i} cells={[
                  { value: row.ventana,                              width: "80px",  color: "#4488ff", bold: true },
                  { value: row.signals,                              width: "70px",  align: "center" },
                  { value: row.avg_dist ? `$${row.avg_dist}` : "—", width: "90px",  align: "right", color: "#888" },
                  { value: row.up_signals,                           width: "60px",  align: "center", color: "var(--green)" },
                  { value: row.down_signals,                         width: "60px",  align: "center", color: "var(--red)" },
                ]} />
              ))}
            </div>
          </>
        )
      }

      <div style={{ height: 40 }} />
    </div>
  );
}
