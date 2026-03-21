"use client";
/**
 * components/BalanceWidget.jsx — v1.0
 *
 * Muestra:
 *  - Saldo USDC actual de la cuenta de Polymarket
 *  - Saldo POL (gas)
 *  - Gráfico de área con la evolución del saldo USDC en el tiempo
 *
 * Fuente de datos: GET /api/balance  (consulta Polygon RPC directamente)
 * Persistencia   : localStorage["polymarket_balance_history_v1"]
 *                  Array de { ts: ISO string, usdc: number }
 *                  Máx. 500 puntos; se guarda un snapshot cada vez que
 *                  el saldo cambia ≥ $0.001 o cada SNAPSHOT_INTERVAL ms.
 *
 * Polling: cada 60s en background; se puede forzar con el botón "↻".
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Constantes ────────────────────────────────────────────────────────────────

const LS_KEY             = "polymarket_balance_history_v1";
const MAX_HISTORY        = 500;
const POLL_INTERVAL_MS   = 60_000;   // poll cada 60s
const SNAPSHOT_MIN_DELTA = 0.001;    // sólo guardar si cambia ≥ $0.001

// ── Utilidades ────────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {}
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" });
  } catch {
    return "";
  }
}

// Para el eje X del gráfico: muestra hora si es hoy, fecha si es otro día
function xLabel(iso) {
  try {
    const d   = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getDate()     === now.getDate()     &&
      d.getMonth()    === now.getMonth()    &&
      d.getFullYear() === now.getFullYear();
    return sameDay
      ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : `${fmtDate(iso)} ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    return "";
  }
}

// Tooltip personalizado
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const usdc = payload[0]?.value;
  return (
    <div style={{
      background: "#05050f", border: "1px solid #1a1a2e",
      padding: "6px 10px", fontSize: 9, color: "#aaa",
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ color: "#555", marginBottom: 2 }}>{label}</div>
      <div style={{ color: "#00ff88", fontWeight: 700 }}>
        ${usdc != null ? usdc.toFixed(4) : "—"} USDC
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
    padding: "14px 18px",
    fontFamily: "'JetBrains Mono', monospace",
    color: "#ccc",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    marginBottom: 12,
  },
  label: {
    fontSize: 9, letterSpacing: "0.15em", color: "#444", marginBottom: 4,
  },
  value: (positive) => ({
    fontSize: 28, fontWeight: 700, lineHeight: 1,
    color: positive == null ? "#ccc" : positive ? "var(--green, #00ff88)" : "var(--red, #ff4466)",
    letterSpacing: "-0.02em",
  }),
  delta: (positive) => ({
    fontSize: 10, marginTop: 3,
    color: positive ? "var(--green, #00ff88)" : positive === false ? "var(--red, #ff4466)" : "#555",
  }),
  sub: {
    fontSize: 10, color: "#444", marginTop: 6,
  },
  refreshBtn: (loading) => ({
    background: "none", border: "1px solid #1a1a2a",
    color: loading ? "#333" : "#555", fontSize: 9, padding: "3px 8px",
    cursor: loading ? "default" : "pointer", fontFamily: "inherit",
    borderRadius: 2, letterSpacing: "0.1em",
    transition: "color 0.2s",
  }),
  meta: {
    fontSize: 8, color: "#2a2a3a", marginTop: 2, textAlign: "right",
  },
  error: {
    fontSize: 9, color: "var(--red, #ff4466)", marginTop: 4,
  },
  chartWrap: {
    marginTop: 14,
    borderTop: "1px solid #0a0a14",
    paddingTop: 10,
  },
  chartLabel: {
    fontSize: 8, color: "#333", letterSpacing: "0.12em", marginBottom: 6,
  },
  noData: {
    fontSize: 9, color: "#2a2a3a", textAlign: "center",
    padding: "20px 0",
  },
};

// ── Componente principal ──────────────────────────────────────────────────────

export default function BalanceWidget() {
  const [usdc,      setUsdc]      = useState(null);
  const [pol,       setPol]       = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [lastFetch, setLastFetch] = useState(null);   // ISO string
  const [rpcUsed,   setRpcUsed]   = useState(null);

  // Historial para el gráfico
  const [history, setHistory] = useState([]);

  // Carga inicial del historial desde localStorage
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  // Referencia al saldo anterior para calcular el delta
  const prevUsdc = useRef(null);

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

      const newUsdc = data.usdc;
      const newPol  = data.pol;
      const now     = new Date().toISOString();

      setUsdc(newUsdc);
      setPol(newPol);
      setLastFetch(now);
      setRpcUsed(data.rpc_used ?? null);

      // Guardar snapshot si el saldo cambió o es el primer punto
      setHistory(prev => {
        const last = prev[prev.length - 1];
        const changed = !last || Math.abs((last.usdc ?? 0) - newUsdc) >= SNAPSHOT_MIN_DELTA;
        if (!changed) return prev;                // sin cambio → no duplicar
        const next = [...prev, { ts: now, usdc: newUsdc }].slice(-MAX_HISTORY);
        saveHistory(next);
        return next;
      });

      prevUsdc.current = newUsdc;

    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll automático
  useEffect(() => {
    fetchBalance();
    const id = setInterval(fetchBalance, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchBalance]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const firstUsdc = history.length > 1 ? history[0].usdc : null;
  const deltaUsdc = (usdc != null && firstUsdc != null) ? usdc - firstUsdc : null;
  const deltaPct  = (deltaUsdc != null && firstUsdc > 0) ? (deltaUsdc / firstUsdc) * 100 : null;

  // Decimar el historial para la gráfica (máx. 100 puntos visibles)
  const chartData = (() => {
    if (history.length === 0) return [];
    if (history.length <= 100) return history.map(h => ({ ...h, label: xLabel(h.ts) }));
    const step = Math.ceil(history.length / 100);
    return history
      .filter((_, i) => i % step === 0 || i === history.length - 1)
      .map(h => ({ ...h, label: xLabel(h.ts) }));
  })();

  // Rango Y del gráfico con padding visual
  const minUsdc = chartData.length ? Math.min(...chartData.map(d => d.usdc)) : 0;
  const maxUsdc = chartData.length ? Math.max(...chartData.map(d => d.usdc)) : 1;
  const pad     = Math.max((maxUsdc - minUsdc) * 0.1, 0.5);
  const yMin    = Math.max(0, minUsdc - pad);
  const yMax    = maxUsdc + pad;

  // Color del área según tendencia
  const trendColor = deltaUsdc == null
    ? "#0066ff"
    : deltaUsdc >= 0 ? "#00ff88" : "#ff4466";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      {/* ── Header: saldo actual + botón refresh ── */}
      <div style={S.header}>
        <div>
          <div style={S.label}>LIQUIDEZ CUENTA</div>
          <div style={S.value(usdc == null ? null : deltaUsdc == null ? null : deltaUsdc >= 0)}>
            {usdc != null ? `$${usdc.toFixed(2)}` : (loading ? "…" : "—")}
          </div>

          {/* Delta respecto al inicio del historial */}
          {deltaUsdc != null && (
            <div style={S.delta(deltaUsdc >= 0)}>
              {deltaUsdc >= 0 ? "▲" : "▼"}{" "}
              {deltaUsdc >= 0 ? "+" : ""}{deltaUsdc.toFixed(4)} USDC
              {deltaPct != null && (
                <span style={{ color: "#555", marginLeft: 6 }}>
                  ({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}

          {/* POL para gas */}
          {pol != null && (
            <div style={S.sub}>
              <span style={{ color: "#333" }}>POL</span>{" "}
              <span style={{ color: "#555" }}>{pol.toFixed(4)}</span>
            </div>
          )}

          {/* Error */}
          {error && <div style={S.error}>✗ {error}</div>}
        </div>

        {/* Controles */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button
            onClick={fetchBalance}
            disabled={loading}
            style={S.refreshBtn(loading)}
          >
            {loading ? "…" : "↻ ACTUALIZAR"}
          </button>

          {/* Limpiar historial */}
          {history.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm("¿Borrar historial de saldo?")) {
                  localStorage.removeItem(LS_KEY);
                  setHistory([]);
                }
              }}
              style={{ ...S.refreshBtn(false), fontSize: 7, color: "#2a2a3a", borderColor: "#0d0d1a" }}
            >
              LIMPIAR
            </button>
          )}

          {/* Meta */}
          {lastFetch && (
            <div style={S.meta}>
              actualizado {fmtTime(lastFetch)}
              {rpcUsed && (
                <span style={{ marginLeft: 4 }}>
                  · {rpcUsed.replace("https://", "").split("/")[0].split(".").slice(0, 2).join(".")}
                </span>
              )}
            </div>
          )}
          <div style={{ ...S.meta, color: "#1a1a2a" }}>
            {history.length} puntos · poll 60s
          </div>
        </div>
      </div>

      {/* ── Gráfico de evolución ── */}
      <div style={S.chartWrap}>
        <div style={S.chartLabel}>EVOLUCIÓN USDC · {history.length} SNAPSHOTS</div>

        {chartData.length < 2 ? (
          <div style={S.noData}>
            Acumulando datos…{" "}
            {chartData.length === 1 && (
              <span style={{ color: "#333" }}>
                (primer snapshot registrado, esperando el siguiente)
              </span>
            )}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={110}>
            <AreaChart
              data={chartData}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="balGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="10%"  stopColor={trendColor} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={trendColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <XAxis
                dataKey="label"
                tick={{ fontSize: 7, fill: "#333", fontFamily: "inherit" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 7, fill: "#333", fontFamily: "inherit" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `$${v.toFixed(1)}`}
                width={46}
              />
              <Tooltip content={<CustomTooltip />} />

              {/* Línea de referencia: primer valor del historial */}
              {firstUsdc != null && (
                <ReferenceLine
                  y={firstUsdc}
                  stroke="#1a1a2e"
                  strokeDasharray="3 3"
                />
              )}

              <Area
                type="monotone"
                dataKey="usdc"
                stroke={trendColor}
                strokeWidth={1.5}
                fill="url(#balGradient)"
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
