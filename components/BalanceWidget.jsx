"use client";
/**
 * components/BalanceWidget.jsx — v2.0
 *
 * CAMBIOS v2.0
 * ─────────────────────────────────────────────────────────────────────
 *  Nuevos bloques visuales:
 *    · TOTAL PORTFOLIO  = USDC líquido + valor posiciones activas
 *    · POSICIONES       = número de tokens abiertos + valor total
 *    · Tabla expandible con detalle de cada posición (título, outcome,
 *      tokens, precio medio, precio actual, valor)
 *
 *  El gráfico de área ahora traza "total_portfolio" si hay posiciones,
 *  o "usdc" si no hay posiciones (retrocompatible con historial anterior).
 *
 * (v1.0 — USDC + POL + gráfico evolución)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Constantes ────────────────────────────────────────────────────────────────

const LS_KEY             = "polymarket_balance_history_v2";   // v2: incluye total_portfolio
const MAX_HISTORY        = 500;
const POLL_INTERVAL_MS   = 60_000;
const SNAPSHOT_MIN_DELTA = 0.001;

// ── Utilidades ────────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveHistory(h) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); } catch {}
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function xLabel(iso) {
  try {
    const d   = new Date(iso);
    const now = new Date();
    const sameDay = d.getDate() === now.getDate()
      && d.getMonth()    === now.getMonth()
      && d.getFullYear() === now.getFullYear();
    return sameDay
      ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : `${d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
  } catch { return ""; }
}

// ── Tooltip del gráfico ───────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const total = payload.find(p => p.dataKey === "total")?.value;
  const usdc  = payload.find(p => p.dataKey === "usdc")?.value;
  return (
    <div style={{
      background: "#05050f", border: "1px solid #1a1a2e",
      padding: "7px 11px", fontSize: 9, color: "#aaa",
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ color: "#444", marginBottom: 3 }}>{label}</div>
      {total != null && (
        <div style={{ color: "#00ff88", fontWeight: 700 }}>
          Total ${total.toFixed(4)}
        </div>
      )}
      {usdc != null && total != null && (
        <div style={{ color: "#555" }}>Líquido ${usdc.toFixed(4)}</div>
      )}
      {usdc != null && total == null && (
        <div style={{ color: "#00ff88", fontWeight: 700 }}>
          USDC ${usdc.toFixed(4)}
        </div>
      )}
    </div>
  );
}

// ── Fila de posición ──────────────────────────────────────────────────────────

function PositionRow({ pos }) {
  const pnlPct = pos.avgPrice > 0
    ? ((pos.curPrice - pos.avgPrice) / pos.avgPrice) * 100
    : null;
  const pnlColor = pnlPct == null ? "#555" : pnlPct >= 0 ? "#00ff88" : "#ff4466";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 48px 60px 52px 52px 64px",
      gap: 6,
      padding: "5px 8px",
      borderBottom: "1px solid #07070f",
      fontSize: 9,
      color: "#777",
      alignItems: "center",
    }}>
      {/* Título + outcome */}
      <div style={{ overflow: "hidden" }}>
        <div style={{
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          color: "#aaa", fontSize: 9,
        }}>
          {pos.title}
        </div>
        <div style={{
          fontSize: 8, marginTop: 1,
          color: pos.outcome === "YES" ? "#00ff88" : "#ff4466",
          letterSpacing: "0.1em",
        }}>
          {pos.outcome}
        </div>
      </div>
      {/* Tokens */}
      <div style={{ textAlign: "right" }}>{pos.size.toFixed(2)}</div>
      {/* Precio medio */}
      <div style={{ textAlign: "right" }}>${pos.avgPrice.toFixed(4)}</div>
      {/* Precio actual */}
      <div style={{ textAlign: "right", color: pnlColor }}>
        ${pos.curPrice.toFixed(4)}
      </div>
      {/* % cambio */}
      <div style={{ textAlign: "right", color: pnlColor }}>
        {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : "—"}
      </div>
      {/* Valor actual */}
      <div style={{ textAlign: "right", color: "#00cc77", fontWeight: 700 }}>
        ${pos.currentValue.toFixed(4)}
      </div>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function BalanceWidget() {
  const [usdc,           setUsdc]           = useState(null);
  const [pol,            setPol]            = useState(null);
  const [posCount,       setPosCount]       = useState(null);
  const [posValue,       setPosValue]       = useState(null);
  const [positions,      setPositions]      = useState([]);
  const [totalPortfolio, setTotalPortfolio] = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState(null);
  const [posError,       setPosError]       = useState(null);
  const [lastFetch,      setLastFetch]      = useState(null);
  const [rpcUsed,        setRpcUsed]        = useState(null);
  const [showPositions,  setShowPositions]  = useState(false);
  const [history,        setHistory]        = useState([]);

  useEffect(() => { setHistory(loadHistory()); }, []);

  const prevTotal = useRef(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/balance");
      const data = await res.json();

      if (!data.success) {
        setError(data.error ?? "Error desconocido");
        return;
      }

      const now   = new Date().toISOString();
      const newUsdc  = data.usdc;
      const newTotal = data.total_portfolio ?? newUsdc;

      setUsdc(newUsdc);
      setPol(data.pol);
      setPosCount(data.positions_count ?? null);
      setPosValue(data.positions_value ?? null);
      setPositions(data.positions      ?? []);
      setTotalPortfolio(newTotal);
      setPosError(data.positions_error ?? null);
      setLastFetch(now);
      setRpcUsed(data.rpc_used ?? null);

      // Guardar snapshot si cambió
      setHistory(prev => {
        const last    = prev[prev.length - 1];
        const changed = !last || Math.abs((last.total ?? last.usdc ?? 0) - newTotal) >= SNAPSHOT_MIN_DELTA;
        if (!changed) return prev;
        const point = { ts: now, usdc: newUsdc, total: newTotal };
        const next  = [...prev, point].slice(-MAX_HISTORY);
        saveHistory(next);
        return next;
      });

      prevTotal.current = newTotal;
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
    const id = setInterval(fetchBalance, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchBalance]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const firstTotal  = history.length > 1 ? (history[0].total ?? history[0].usdc) : null;
  const deltaTotal  = totalPortfolio != null && firstTotal != null
    ? totalPortfolio - firstTotal : null;
  const deltaPct    = deltaTotal != null && firstTotal > 0
    ? (deltaTotal / firstTotal) * 100 : null;

  // Gráfico: trazar total si existe, sino usdc
  const chartData = (() => {
    if (!history.length) return [];
    const src = history.length <= 100
      ? history
      : history.filter((_, i) => i % Math.ceil(history.length / 100) === 0 || i === history.length - 1);
    return src.map(h => ({
      label: xLabel(h.ts),
      total: h.total ?? h.usdc,
      usdc:  h.usdc,
    }));
  })();

  const chartKey    = "total";
  const vals        = chartData.map(d => d[chartKey]).filter(v => v != null);
  const minV        = vals.length ? Math.min(...vals) : 0;
  const maxV        = vals.length ? Math.max(...vals) : 1;
  const pad         = Math.max((maxV - minV) * 0.1, 0.5);
  const yMin        = Math.max(0, minV - pad);
  const yMax        = maxV + pad;
  const trendColor  = deltaTotal == null ? "#0066ff" : deltaTotal >= 0 ? "#00ff88" : "#ff4466";
  const firstVal    = chartData.length > 0 ? chartData[0][chartKey] : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      {/* ══════════════════ FILA SUPERIOR: 3 métricas ══════════════════ */}
      <div style={S.metricsRow}>

        {/* ── TOTAL PORTFOLIO ── */}
        <div style={S.metricBlock}>
          <div style={S.label}>TOTAL PORTFOLIO</div>
          <div style={S.bigValue(deltaTotal == null ? null : deltaTotal >= 0)}>
            {totalPortfolio != null ? `$${totalPortfolio.toFixed(2)}` : (loading ? "…" : "—")}
          </div>
          {deltaTotal != null && (
            <div style={S.delta(deltaTotal >= 0)}>
              {deltaTotal >= 0 ? "▲" : "▼"}{" "}
              {deltaTotal >= 0 ? "+" : ""}{deltaTotal.toFixed(4)}
              {deltaPct != null && (
                <span style={{ color: "#555", marginLeft: 5 }}>
                  ({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>

        {/* Divisor */}
        <div style={S.divider} />

        {/* ── LIQUIDEZ USDC ── */}
        <div style={S.metricBlock}>
          <div style={S.label}>LIQUIDEZ USDC</div>
          <div style={{ ...S.midValue, color: "#ccc" }}>
            {usdc != null ? `$${usdc.toFixed(2)}` : (loading ? "…" : "—")}
          </div>
          {pol != null && (
            <div style={S.sub}>
              <span style={{ color: "#333" }}>POL gas</span>{" "}
              <span style={{ color: "#555" }}>{pol.toFixed(4)}</span>
            </div>
          )}
          {error && <div style={S.errTxt}>✗ {error}</div>}
        </div>

        {/* Divisor */}
        <div style={S.divider} />

        {/* ── POSICIONES ACTIVAS ── */}
        <div style={S.metricBlock}>
          <div style={S.label}>POSICIONES ACTIVAS</div>
          <div style={{ ...S.midValue, color: posCount ? "#4488ff" : "#555" }}>
            {posCount != null ? posCount : (loading ? "…" : "—")}
            {posCount != null && (
              <span style={{ fontSize: 12, color: "#555", marginLeft: 5, fontWeight: 400 }}>
                tokens
              </span>
            )}
          </div>
          {posValue != null && (
            <div style={S.sub}>
              valor{" "}
              <span style={{ color: "#00cc77", fontWeight: 700 }}>
                ${posValue.toFixed(2)}
              </span>
            </div>
          )}
          {posError && (
            <div style={{ ...S.sub, color: "#ff4466" }}>
              ⚠ {posError.slice(0, 40)}
            </div>
          )}
        </div>

        {/* Controles alineados a la derecha */}
        <div style={S.controls}>
          <button onClick={fetchBalance} disabled={loading} style={S.btn(loading)}>
            {loading ? "…" : "↻"}
          </button>
          {positions.length > 0 && (
            <button
              onClick={() => setShowPositions(v => !v)}
              style={{ ...S.btn(false), color: showPositions ? "#4488ff" : "#444" }}
            >
              {showPositions ? "▲ OCULTAR" : "▼ DETALLE"}
            </button>
          )}
          {lastFetch && (
            <div style={S.meta}>
              {fmtTime(lastFetch)}
              {rpcUsed && (
                <span style={{ marginLeft: 4 }}>
                  · {rpcUsed.replace("https://", "").split("/")[0].split(".").slice(0, 2).join(".")}
                </span>
              )}
            </div>
          )}
          <div style={{ ...S.meta, color: "#1a1a2a" }}>
            {history.length}pt · 60s
          </div>
        </div>
      </div>

      {/* ══════════════════ TABLA POSICIONES (expandible) ══════════════ */}
      {showPositions && positions.length > 0 && (
        <div style={S.posTable}>
          {/* Cabecera */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 48px 60px 52px 52px 64px",
            gap: 6, padding: "4px 8px",
            borderBottom: "1px solid #0d0d1a",
            fontSize: 8, color: "#333", letterSpacing: "0.12em",
          }}>
            <div>MERCADO</div>
            <div style={{ textAlign: "right" }}>TOKENS</div>
            <div style={{ textAlign: "right" }}>PRECIO MED</div>
            <div style={{ textAlign: "right" }}>PRECIO ACT</div>
            <div style={{ textAlign: "right" }}>CAMBIO</div>
            <div style={{ textAlign: "right" }}>VALOR</div>
          </div>
          {positions.map((pos, i) => (
            <PositionRow key={i} pos={pos} />
          ))}
          {/* Totales */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 48px 60px 52px 52px 64px",
            gap: 6, padding: "5px 8px",
            borderTop: "1px solid #0d0d1a",
            fontSize: 9, color: "#555",
          }}>
            <div style={{ color: "#444", letterSpacing: "0.1em" }}>TOTAL</div>
            <div />
            <div />
            <div />
            <div />
            <div style={{ textAlign: "right", color: "#00cc77", fontWeight: 700 }}>
              ${(posValue ?? 0).toFixed(4)}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ GRÁFICO EVOLUCIÓN ══════════════════════════ */}
      <div style={S.chartWrap}>
        <div style={S.chartLabel}>
          EVOLUCIÓN PORTFOLIO · {history.length} SNAPSHOTS
          {posCount != null && posCount > 0 && (
            <span style={{ color: "#333", marginLeft: 8 }}>
              (USDC + posiciones)
            </span>
          )}
        </div>

        {chartData.length < 2 ? (
          <div style={S.noData}>
            Acumulando datos…{" "}
            {chartData.length === 1 && (
              <span style={{ color: "#333" }}>
                (primer snapshot, esperando el siguiente)
              </span>
            )}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={110}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="portGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="10%"  stopColor={trendColor} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={trendColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 7, fill: "#333", fontFamily: "inherit" }}
                tickLine={false} axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 7, fill: "#333", fontFamily: "inherit" }}
                tickLine={false} axisLine={false}
                tickFormatter={v => `$${v.toFixed(1)}`}
                width={46}
              />
              <Tooltip content={<ChartTooltip />} />
              {firstVal != null && (
                <ReferenceLine y={firstVal} stroke="#1a1a2e" strokeDasharray="3 3" />
              )}
              <Area
                type="monotone"
                dataKey={chartKey}
                stroke={trendColor}
                strokeWidth={1.5}
                fill="url(#portGradient)"
                dot={false}
                activeDot={{ r: 3, fill: trendColor, stroke: "none" }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Estilos ───────────────────────────────────────────────────────────────────

const S = {
  root: {
    background: "#010108",
    border: "1px solid #0d0d1a",
    borderRadius: 4,
    fontFamily: "'JetBrains Mono', monospace",
    color: "#ccc",
    overflow: "hidden",
  },
  metricsRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 0,
    padding: "16px 20px",
  },
  metricBlock: {
    flex: 1,
    paddingRight: 20,
  },
  divider: {
    width: 1,
    alignSelf: "stretch",
    background: "#0d0d1a",
    marginRight: 20,
    flexShrink: 0,
  },
  label: {
    fontSize: 8, letterSpacing: "0.15em", color: "#444", marginBottom: 5,
  },
  bigValue: (positive) => ({
    fontSize: 28, fontWeight: 700, lineHeight: 1,
    color: positive == null ? "#ccc" : positive ? "var(--green, #00ff88)" : "var(--red, #ff4466)",
    letterSpacing: "-0.02em",
  }),
  midValue: {
    fontSize: 20, fontWeight: 700, lineHeight: 1,
    letterSpacing: "-0.02em",
  },
  delta: (positive) => ({
    fontSize: 10, marginTop: 4,
    color: positive ? "var(--green, #00ff88)" : "var(--red, #ff4466)",
  }),
  sub: {
    fontSize: 9, color: "#444", marginTop: 4,
  },
  errTxt: {
    fontSize: 9, color: "var(--red, #ff4466)", marginTop: 4,
  },
  controls: {
    display: "flex", flexDirection: "column", alignItems: "flex-end",
    gap: 5, flexShrink: 0, marginLeft: "auto",
  },
  btn: (loading) => ({
    background: "none", border: "1px solid #1a1a2a",
    color: loading ? "#333" : "#555",
    fontSize: 8, padding: "3px 8px",
    cursor: loading ? "default" : "pointer",
    fontFamily: "inherit", borderRadius: 2, letterSpacing: "0.1em",
  }),
  meta: {
    fontSize: 7, color: "#2a2a3a", textAlign: "right",
  },
  posTable: {
    borderTop: "1px solid #0a0a14",
    background: "#010108",
  },
  chartWrap: {
    borderTop: "1px solid #0a0a14",
    padding: "10px 20px 14px",
  },
  chartLabel: {
    fontSize: 8, color: "#333", letterSpacing: "0.12em", marginBottom: 6,
  },
  noData: {
    fontSize: 9, color: "#2a2a3a", textAlign: "center", padding: "20px 0",
  },
};
