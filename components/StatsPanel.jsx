"use client";
/**
 * StatsPanel.jsx — v1.0
 * Panel de analítica de rendimiento del algoritmo.
 * Lee desde /api/stats que a su vez consulta las vistas de Supabase.
 *
 * Secciones:
 *  1. Overview global (ops, wins, P&L, ROI)
 *  2. Rendimiento por ventana T-20/15/10/5
 *  3. Rendimiento UP vs DOWN
 *  4. P&L diario (últimos 30 días)
 *  5. Win rate por hora UTC
 *  6. Señales accionables (calibración de umbrales)
 */

import { useState, useEffect, useCallback } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────

const fmtUSD  = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtPct  = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const pnlColor = (v) => v == null ? "#555" : v >= 0 ? "var(--green)" : "var(--red)";
const wrColor  = (v) => v == null ? "#555" : v >= 55 ? "var(--green)" : v >= 45 ? "var(--yellow)" : "var(--red)";

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
      <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.15em", marginBottom: 6 }}>
        {label}
      </div>
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
        }}>
          {c.value}
        </div>
      ))}
    </div>
  );
}

function BarChart({ rows, valueKey, labelKey, color = "#0066ff", maxW = 200 }) {
  if (!rows || rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map(r => Math.abs(r[valueKey] ?? 0)), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((row, i) => {
        const val  = row[valueKey] ?? 0;
        const pct  = Math.abs(val) / max;
        const col  = val >= 0 ? "var(--green)" : "var(--red)";
        return (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 60, fontSize: 9, color: "#555", textAlign: "right" }}>
              {row[labelKey]}
            </div>
            <div style={{
              width: Math.max(pct * maxW, 2), height: 12,
              background: color !== "dynamic" ? color : col,
              borderRadius: 1, flexShrink: 0,
            }} />
            <div style={{ fontSize: 10, color: col, minWidth: 60 }}>
              {typeof val === "number" && val % 1 !== 0
                ? `${val >= 0 ? "+" : ""}$${Math.abs(val).toFixed(2)}`
                : `${val >= 0 ? "+" : ""}${val}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ color: "#333", fontSize: 10, padding: "20px 0" }}>
      Cargando datos...
    </div>
  );
}

function Empty({ msg = "Sin datos suficientes aún" }) {
  return (
    <div style={{
      fontSize: 10, color: "#2a2a3a",
      padding: "20px 0", letterSpacing: "0.1em",
    }}>
      {msg}
    </div>
  );
}

function DbBadge({ available }) {
  return (
    <span style={{
      fontSize: 8, letterSpacing: "0.12em",
      padding: "2px 8px", borderRadius: 2,
      background: available ? "rgba(0,255,136,0.06)" : "rgba(255,68,102,0.08)",
      border: `1px solid ${available ? "rgba(0,255,136,0.2)" : "rgba(255,68,102,0.2)"}`,
      color: available ? "var(--green)" : "var(--red)",
    }}>
      {available ? "● SUPABASE OK" : "● SUPABASE OFF"}
    </span>
  );
}

// ── Hook de carga ─────────────────────────────────────────────────────────

function useStats(type, params = {}) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ type, ...params }).toString();
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

// ── Panel principal ───────────────────────────────────────────────────────

export default function StatsPanel() {
  const [simFilter, setSimFilter] = useState("all");  // all | sim | real
  const [days,      setDays]      = useState(30);

  const simParam = simFilter === "all"  ? {}
                 : simFilter === "sim"  ? { simulated: "true" }
                 :                       { simulated: "false" };

  const daysParam  = { days: String(days) };
  const baseParams = { ...simParam, ...daysParam };

  const overview  = useStats("overview",      baseParams);
  const byWindow  = useStats("by_window",     simParam);
  const byDir     = useStats("by_direction",  simParam);
  const byDay     = useStats("by_day",        baseParams);
  const byHour    = useStats("by_hour",       simParam);
  const signals   = useStats("signals",       { ...simParam, ...daysParam });

  const dbOk = overview.data?.available !== false;

  const reloadAll = () => {
    overview.reload(); byWindow.reload(); byDir.reload();
    byDay.reload(); byHour.reload(); signals.reload();
  };

  return (
    <div style={{ padding: "20px 24px", fontFamily: "var(--font-mono)", color: "var(--text)" }}>

      {/* ── Header de controles ───────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 8, flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#333", letterSpacing: "0.18em" }}>
            ANALÍTICA DE RENDIMIENTO
          </span>
          <DbBadge available={dbOk} />
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {/* Filtro sim/real */}
          {["all", "real", "sim"].map(f => (
            <button key={f} onClick={() => setSimFilter(f)} style={{
              background: simFilter === f ? "var(--border)" : "transparent",
              border: "1px solid",
              borderColor: simFilter === f ? "var(--border)" : "#1a1a2a",
              color: simFilter === f ? "var(--text)" : "#444",
              padding: "3px 10px", borderRadius: 3,
              fontSize: 9, letterSpacing: "0.12em", cursor: "pointer",
            }}>
              {f === "all" ? "TODO" : f === "sim" ? "SIMULADO" : "REAL"}
            </button>
          ))}

          {/* Periodo */}
          <span style={{ color: "#2a2a3a", fontSize: 9, marginLeft: 6 }}>PERIODO:</span>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              background: days === d ? "var(--border)" : "transparent",
              border: "1px solid",
              borderColor: days === d ? "var(--border)" : "#1a1a2a",
              color: days === d ? "var(--text)" : "#444",
              padding: "3px 8px", borderRadius: 3,
              fontSize: 9, letterSpacing: "0.10em", cursor: "pointer",
            }}>
              {d}D
            </button>
          ))}

          <button onClick={reloadAll} style={{
            background: "transparent", border: "1px solid #1a1a2a",
            color: "#444", padding: "3px 10px", borderRadius: 3,
            fontSize: 9, cursor: "pointer", letterSpacing: "0.12em",
          }}>
            ↺ ACTUALIZAR
          </button>
        </div>
      </div>

      {/* ── Sin BD ────────────────────────────────────────────────────────── */}
      {!dbOk && !overview.loading && (
        <div style={{
          margin: "24px 0", padding: "16px 20px",
          background: "rgba(255,68,102,0.05)", border: "1px solid rgba(255,68,102,0.2)",
          borderRadius: 3, fontSize: 11, color: "#884444", lineHeight: 1.8,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--red)" }}>
            ⚠ Supabase no está configurado
          </div>
          Añade <code style={{ color: "var(--yellow)" }}>SUPABASE_URL</code> y{" "}
          <code style={{ color: "var(--yellow)" }}>SUPABASE_SERVICE_KEY</code>{" "}
          como variables de entorno en Vercel y Railway, luego ejecuta{" "}
          <code style={{ color: "#4488ff" }}>supabase_schema.sql</code> en tu proyecto Supabase.
          Consulta <code>SETUP_SUPABASE.md</code> para la guía completa.
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 1. OVERVIEW GLOBAL                                                */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>1 · RESUMEN GLOBAL — ÚLTIMOS {days} DÍAS</SectionTitle>

      {overview.loading
        ? <Spinner />
        : overview.data?.available === false
        ? <Empty msg={overview.data?.reason || "No disponible"} />
        : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <KpiCard
              label="TOTAL OPS"
              value={overview.data.total_ops ?? "—"}
              color="var(--text)"
            />
            <KpiCard
              label="WIN RATE"
              value={overview.data.win_rate != null ? `${overview.data.win_rate}%` : "—"}
              color={wrColor(overview.data.win_rate)}
              sub={`${overview.data.wins ?? 0}W / ${overview.data.losses ?? 0}L / ${overview.data.stops ?? 0}STOP`}
            />
            <KpiCard
              label="P&L NETO"
              value={overview.data.pnl_usd != null ? `${overview.data.pnl_usd >= 0 ? "+" : ""}$${Math.abs(overview.data.pnl_usd).toFixed(2)}` : "—"}
              color={pnlColor(overview.data.pnl_usd)}
              sub={`Invertido $${(overview.data.invested_usd ?? 0).toFixed(2)}`}
            />
            <KpiCard
              label="ROI"
              value={overview.data.roi_pct != null ? `${overview.data.roi_pct >= 0 ? "+" : ""}${overview.data.roi_pct.toFixed(1)}%` : "—"}
              color={pnlColor(overview.data.roi_pct)}
            />
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 2. POR VENTANA                                                    */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>2 · RENDIMIENTO POR VENTANA DE ENTRADA</SectionTitle>

      {byWindow.loading
        ? <Spinner />
        : !byWindow.data?.rows?.length
        ? <Empty />
        : (
          <div style={{ border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
            <TableRow header cells={[
              { value: "VENTANA",  width: "70px" },
              { value: "OPS",      width: "50px", align: "center" },
              { value: "WINS",     width: "50px", align: "center" },
              { value: "LOSSES",   width: "60px", align: "center" },
              { value: "WIN RATE", width: "80px", align: "right" },
              { value: "P&L TOTAL",width: "100px", align: "right" },
              { value: "P&L MEDIO",width: "100px", align: "right" },
              { value: "ODDS MEDIA",width: "90px", align: "right" },
            ]} />
            {byWindow.data.rows.map((row, i) => (
              <TableRow key={i} cells={[
                { value: row.ventana,         width: "70px", color: "#4488ff", bold: true },
                { value: row.total_ops,       width: "50px", align: "center" },
                { value: row.wins,            width: "50px", align: "center", color: "var(--green)" },
                { value: row.losses,          width: "60px", align: "center", color: "var(--red)" },
                {
                  value: row.win_rate_pct != null ? `${row.win_rate_pct}%` : "—",
                  width: "80px", align: "right",
                  color: wrColor(row.win_rate_pct),
                  bold: true,
                },
                {
                  value: row.pnl_total_usd != null
                    ? `${row.pnl_total_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_total_usd).toFixed(2)}`
                    : "—",
                  width: "100px", align: "right",
                  color: pnlColor(row.pnl_total_usd),
                },
                {
                  value: row.pnl_medio_usd != null
                    ? `${row.pnl_medio_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_medio_usd).toFixed(2)}`
                    : "—",
                  width: "100px", align: "right",
                  color: pnlColor(row.pnl_medio_usd),
                },
                {
                  value: row.odds_media != null ? row.odds_media.toFixed(3) : "—",
                  width: "90px", align: "right",
                },
              ]} />
            ))}
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 3. UP vs DOWN                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>3 · UP VS DOWN</SectionTitle>

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
                                  : "—",
                                  pnlColor(row.pnl_total_usd)],
                  ].map(([k, v, c = "#666"]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "#333" }}>{k}</span>
                      <span style={{ color: c, fontWeight: 700 }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 4. P&L DIARIO                                                     */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>4 · P&L DIARIO — ÚLTIMOS {days} DÍAS</SectionTitle>

      {byDay.loading
        ? <Spinner />
        : !byDay.data?.rows?.length
        ? <Empty />
        : (
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            {/* Tabla */}
            <div style={{ flex: "1 1 320px", border: "1px solid #0d0d1a", borderRadius: 3, overflow: "hidden" }}>
              <TableRow header cells={[
                { value: "FECHA",     width: "100px" },
                { value: "OPS",       width: "40px", align: "center" },
                { value: "W/L",       width: "60px", align: "center" },
                { value: "P&L",       width: "90px", align: "right" },
                { value: "INVERTIDO", width: "90px", align: "right" },
              ]} />
              {byDay.data.rows.slice(0, 20).map((row, i) => (
                <TableRow key={i} highlight={i % 2 === 0} cells={[
                  { value: row.fecha,         width: "100px", color: "#666" },
                  { value: row.ops,           width: "40px",  align: "center" },
                  { value: `${row.wins}W/${row.losses}L`, width: "60px", align: "center",
                    color: row.wins > row.losses ? "var(--green)" : row.losses > row.wins ? "var(--red)" : "#555" },
                  {
                    value: row.pnl_usd != null
                      ? `${row.pnl_usd >= 0 ? "+" : ""}$${Math.abs(row.pnl_usd).toFixed(2)}`
                      : "—",
                    width: "90px", align: "right",
                    color: pnlColor(row.pnl_usd), bold: true,
                  },
                  {
                    value: row.invertido_usd != null ? `$${row.invertido_usd.toFixed(2)}` : "—",
                    width: "90px", align: "right",
                  },
                ]} />
              ))}
            </div>

            {/* Gráfico de barras P&L diario */}
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.12em", marginBottom: 12 }}>
                P&L POR DÍA
              </div>
              <BarChart
                rows={byDay.data.rows.slice(0, 14).reverse()}
                valueKey="pnl_usd"
                labelKey="fecha"
                color="dynamic"
              />
            </div>
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 5. POR HORA UTC                                                   */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>5 · WIN RATE POR HORA UTC DEL DÍA</SectionTitle>

      {byHour.loading
        ? <Spinner />
        : !byHour.data?.rows?.length
        ? <Empty />
        : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "flex", gap: 4, minWidth: 600 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const row = byHour.data.rows.find(r => r.hour_utc === h);
                const wr  = row?.win_rate_pct ?? null;
                const ops = row?.ops ?? 0;
                const pnl = row?.pnl_usd ?? 0;
                const col = !row ? "#111"
                          : wr >= 60 ? "var(--green)"
                          : wr >= 50 ? "#336633"
                          : wr >= 40 ? "#553300"
                          : "var(--red)";
                return (
                  <div key={h} style={{
                    flex: 1, textAlign: "center",
                    background: "#02020a",
                    border: `1px solid ${row ? col + "44" : "#0a0a14"}`,
                    borderRadius: 2, padding: "6px 2px",
                  }}>
                    <div style={{ fontSize: 8, color: "#333", marginBottom: 4 }}>
                      {String(h).padStart(2, "0")}h
                    </div>
                    {row ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: col }}>
                          {wr != null ? `${wr}%` : "—"}
                        </div>
                        <div style={{ fontSize: 8, color: "#333", marginTop: 2 }}>
                          {ops} ops
                        </div>
                        <div style={{ fontSize: 8, color: pnlColor(pnl), marginTop: 1 }}>
                          {pnl >= 0 ? "+" : ""}${Math.abs(pnl).toFixed(0)}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 9, color: "#1a1a2a" }}>—</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 8, color: "#2a2a3a", marginTop: 6, letterSpacing: "0.1em" }}>
              CADA CELDA = UNA HORA UTC · COLOR = WIN RATE
            </div>
          </div>
        )
      }

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* 6. SEÑALES (calibración de umbrales)                             */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <SectionTitle>6 · SEÑALES ACCIONABLES — CALIBRACIÓN DE UMBRALES</SectionTitle>

      {signals.loading
        ? <Spinner />
        : !signals.data?.summary?.length
        ? <Empty />
        : (
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {signals.data.summary.map((row, i) => (
              <div key={i} style={{
                background: "#02020c", border: "1px solid #0d0d1a",
                borderRadius: 3, padding: "12px 16px", minWidth: 140,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#4488ff", marginBottom: 8 }}>
                  {row.ventana}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10 }}>
                  {[
                    ["Señales",    row.signals],
                    ["Dist media", row.avg_dist != null ? `$${row.avg_dist}` : "—", "#888"],
                    ["▲ UP",       row.up_signals,   "var(--green)"],
                    ["▼ DOWN",     row.down_signals, "var(--red)"],
                  ].map(([k, v, c = "#666"]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "#333" }}>{k}</span>
                      <span style={{ color: c, fontWeight: 700 }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{
              fontSize: 9, color: "#2a2a3a", alignSelf: "flex-end",
              maxWidth: 260, lineHeight: 1.7, letterSpacing: "0.08em",
            }}>
              Señales con dist. media muy alta sugieren umbral demasiado bajo (muchas entradas).
              Dist. media muy baja sugiere umbral muy conservador (pocas entradas).
            </div>
          </div>
        )
      }

      {/* Spacer final */}
      <div style={{ height: 48 }} />
    </div>
  );
}
