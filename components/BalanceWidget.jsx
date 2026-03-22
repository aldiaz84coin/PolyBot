"use client";
/**
 * components/BalanceWidget.jsx — v3.2
 *
 * CAMBIOS v3.2
 * ─────────────────────────────────────────────────────────────────────
 *  BUG FIX — Historial Supabase congelado en el snapshot de mount
 *
 *  Síntoma: las métricas live (USDC, posiciones, total) se actualizaban
 *  correctamente cada 60s, pero el gráfico "EVOLUCIÓN PORTFOLIO" quedaba
 *  estancado en los datos que Supabase tenía al cargar la página.
 *  Si entre tanto entraban nuevos snapshots en balance_history (desde
 *  esta u otra sesión), el gráfico no los reflejaba.
 *
 *  Causa raíz: loadHistory() sólo se llamaba dentro de un useEffect con
 *  dependencias vacías — es decir, una única vez al montar el componente.
 *  No había ningún mecanismo de refresco posterior.
 *
 *  Correcciones:
 *    1. loadHistory() migrada a useCallback para poder reutilizarla.
 *    2. Intervalo HISTORY_POLL_MS (5 min) que recarga el historial
 *       completo desde Supabase en segundo plano.
 *    3. Listener visibilitychange: al volver a la pestaña se fuerza un
 *       loadHistory() inmediato (evita mostrar un gráfico rancio tras
 *       dejar el tab en segundo plano).
 *    4. Merge inteligente: los puntos del historial Supabase se fusionan
 *       con cualquier punto generado en la sesión actual, de forma que
 *       nunca se pierden datos recientes en memoria.
 *
 * (v3.1 — BUG FIX portfolio congelado: error /api/balance invisible)
 * (v3.0 — Migración localStorage → Supabase, historial persistido)
 * (v2.0 — USDC + posiciones activas + tabla expandible + gráfico)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_HISTORY        = 500;
const POLL_INTERVAL_MS   = 60_000;       // refresco live balance
const RETRY_ON_ERROR_MS  = 15_000;       // reintento rápido si /api/balance falla
const HISTORY_POLL_MS    = 5 * 60_000;   // v3.2: refresco periódico historial Supabase
const SNAPSHOT_MIN_DELTA = 0.001;
const STALE_THRESHOLD_MS = 90_000;       // >90s sin éxito → "STALE"

// ── Utilidades ────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function xLabel(iso) {
  try {
    const d   = new Date(iso);
    const now = new Date();
    const sameDay = d.getDate()     === now.getDate()
      && d.getMonth()    === now.getMonth()
      && d.getFullYear() === now.getFullYear();
    return sameDay
      ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("es-ES", { month: "2-digit", day: "2-digit" });
  } catch { return ""; }
}

// v3.2: merge historial Supabase con puntos en memoria (evita duplicados por ts)
function mergeHistory(fromDb, inMemory) {
  const map = new Map();
  for (const p of fromDb)      map.set(p.ts, p);
  for (const p of inMemory)    map.set(p.ts, p);   // memoria gana en caso de colisión
  return Array.from(map.values())
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-MAX_HISTORY);
}

// ── Tooltip personalizado ─────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: "#0a0a14", border: "1px solid #1a1a2e",
      padding: "6px 10px", fontSize: 9, fontFamily: "inherit", color: "#ccc",
    }}>
      <div style={{ color: "#444", marginBottom: 3 }}>{label}</div>
      <div>TOTAL <span style={{ color: "#0066ff" }}>${(d.total ?? 0).toFixed(4)}</span></div>
      {d.usdc != null && d.usdc !== d.total && (
        <div>USDC <span style={{ color: "#888" }}>${d.usdc.toFixed(4)}</span></div>
      )}
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
  const [posError,       setPosError]       = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [histLoading,    setHistLoading]    = useState(false);
  const [error,          setError]          = useState(null);
  const [apiDiag,        setApiDiag]        = useState(null);
  const [lastFetch,      setLastFetch]      = useState(null);
  const [lastAttempt,    setLastAttempt]    = useState(null);
  const [rpcUsed,        setRpcUsed]        = useState(null);
  const [history,        setHistory]        = useState([]);
  const [expanded,       setExpanded]       = useState(false);

  const pollTimerRef    = useRef(null);
  const errorTimerRef   = useRef(null);
  const histTimerRef    = useRef(null);   // v3.2: timer refresco historial
  const prevTotal       = useRef(null);

  const isStale = !lastFetch
    ? true
    : (Date.now() - new Date(lastFetch).getTime()) > STALE_THRESHOLD_MS;

  // ── v3.2: loadHistory como useCallback para reutilizarla ─────────────────
  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const res  = await fetch(`/api/balance-history?limit=${MAX_HISTORY}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        // Merge con lo que ya tenemos en memoria (no perder puntos recientes)
        setHistory(prev => mergeHistory(data.data, prev));
      }
    } catch (e) {
      console.warn("[BalanceWidget] No se pudo cargar historial:", e.message);
    } finally {
      setHistLoading(false);
    }
  }, []);

  // ── Cargar historial al montar ────────────────────────────────────────────
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // ── v3.2: Refresco periódico del historial (cada 5 min) ──────────────────
  useEffect(() => {
    histTimerRef.current = setInterval(loadHistory, HISTORY_POLL_MS);
    return () => clearInterval(histTimerRef.current);
  }, [loadHistory]);

  // ── v3.2: Refresco al volver a primer plano (visibilitychange) ───────────
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        console.log("[BalanceWidget] Tab visible → recargando historial");
        loadHistory();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadHistory]);

  // ── Guardar snapshot en Supabase ──────────────────────────────────────────
  const saveSnapshot = useCallback(async (ts, usdc, total) => {
    try {
      await fetch("/api/balance-history", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ts, usdc, total }),
      });
    } catch (e) {
      console.warn("[BalanceWidget] Error guardando snapshot:", e.message);
    }
  }, []);

  // ── Fetch balance ─────────────────────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }

    setLoading(true);
    setError(null);
    setApiDiag(null);
    setLastAttempt(new Date().toISOString());

    try {
      const res  = await fetch("/api/balance");
      const data = await res.json();

      if (!data.success) {
        const errMsg = data.error ?? "Error desconocido";
        console.error("[BalanceWidget] /api/balance →", errMsg, data);
        setError(errMsg);
        setApiDiag({
          wallet_hint: data.wallet_hint ?? null,
          rpc_errors:  data.rpc_errors  ?? [],
        });
        errorTimerRef.current = setTimeout(fetchBalance, RETRY_ON_ERROR_MS);
        return;
      }

      const now      = new Date().toISOString();
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

      // ── Snapshot: solo si el total cambió significativamente ─────────────
      setHistory(prev => {
        const last    = prev[prev.length - 1];
        const changed = !last ||
          Math.abs((last.total ?? last.usdc ?? 0) - newTotal) >= SNAPSHOT_MIN_DELTA;

        if (!changed) return prev;

        const point = { ts: now, usdc: newUsdc, total: newTotal };
        const next  = mergeHistory(prev, [point]);
        saveSnapshot(now, newUsdc, newTotal);
        return next;
      });

      prevTotal.current = newTotal;

    } catch (e) {
      console.error("[BalanceWidget] fetchBalance exception:", e.message);
      setError(e.message);
      errorTimerRef.current = setTimeout(fetchBalance, RETRY_ON_ERROR_MS);
    } finally {
      setLoading(false);
    }
  }, [saveSnapshot]);

  // ── Polling normal ────────────────────────────────────────────────────────
  useEffect(() => {
    fetchBalance();
    pollTimerRef.current = setInterval(fetchBalance, POLL_INTERVAL_MS);
    return () => {
      clearInterval(pollTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [fetchBalance]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const firstTotal = history.length > 1 ? (history[0].total ?? history[0].usdc) : null;
  const deltaTotal = totalPortfolio != null && firstTotal != null
    ? totalPortfolio - firstTotal : null;
  const deltaPct   = deltaTotal != null && firstTotal > 0
    ? (deltaTotal / firstTotal) * 100 : null;

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

  const vals       = chartData.map(d => d.total).filter(v => v != null);
  const minV       = vals.length ? Math.min(...vals) : 0;
  const maxV       = vals.length ? Math.max(...vals) : 1;
  const pad        = Math.max((maxV - minV) * 0.1, 0.5);
  const yMin       = Math.max(0, minV - pad);
  const yMax       = maxV + pad;
  const trendColor = deltaTotal == null ? "#0066ff" : deltaTotal >= 0 ? "#00ff88" : "#ff4466";
  const firstVal   = chartData.length > 0 ? chartData[0].total : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={S.header}>
        <span style={S.headerTitle}>WALLET BALANCE</span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastFetch && (
            <span style={{ fontSize: 8, color: isStale ? "#ff4466" : "#444" }}>
              {isStale ? "STALE" : "LIVE"} · {fmtTime(lastFetch)}
              {rpcUsed && <span style={{ color: "#222", marginLeft: 6 }}>{rpcUsed}</span>}
            </span>
          )}
          <button
            onClick={fetchBalance}
            disabled={loading}
            style={S.refreshBtn}
            title="Actualizar balance"
          >
            {loading ? "…" : "↻"}
          </button>
        </span>
      </div>

      {/* ── ERROR BANNER ──────────────────────────────────────────────── */}
      {error && (
        <div style={S.errorBanner}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ⚠ /api/balance falló · reintentando en {RETRY_ON_ERROR_MS / 1000}s
          </div>
          <div style={{ color: "#ff446688", fontSize: 9 }}>{error}</div>
          {apiDiag?.wallet_hint && (
            <div style={{ color: "#ff446655", fontSize: 9, marginTop: 2 }}>
              wallet: {apiDiag.wallet_hint}
            </div>
          )}
          {apiDiag?.rpc_errors?.length > 0 && (
            <div style={{ color: "#ff446644", fontSize: 8, marginTop: 2 }}>
              RPCs fallidos: {apiDiag.rpc_errors.join(", ")}
            </div>
          )}
          {lastAttempt && (
            <div style={{ color: "#333", fontSize: 8, marginTop: 4 }}>
              último intento: {fmtTime(lastAttempt)}
            </div>
          )}
        </div>
      )}

      {/* ── MÉTRICAS ──────────────────────────────────────────────────── */}
      <div style={S.metricsRow}>

        {/* TOTAL */}
        <div style={S.metricBlock}>
          <div style={S.label}>TOTAL PORTFOLIO</div>
          <div style={S.bigValue(deltaTotal)}>
            {totalPortfolio != null ? `$${totalPortfolio.toFixed(4)}` : (loading ? "…" : "—")}
          </div>
          {deltaPct != null && (
            <div style={{ fontSize: 10, color: deltaTotal >= 0 ? "#00ff88" : "#ff4466", marginTop: 4 }}>
              {deltaTotal >= 0 ? "+" : ""}{deltaTotal.toFixed(4)} ({deltaPct.toFixed(2)}%)
            </div>
          )}
        </div>

        <div style={S.divider} />

        {/* USDC LÍQUIDO */}
        <div style={S.metricBlock}>
          <div style={S.label}>USDC LÍQUIDO</div>
          <div style={S.bigValue(null)}>
            {usdc != null ? `$${usdc.toFixed(4)}` : (loading ? "…" : "—")}
          </div>
          {pol != null && (
            <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>
              POL {pol.toFixed(4)}
            </div>
          )}
        </div>

        <div style={S.divider} />

        {/* POSICIONES */}
        <div style={{ flex: 1 }}>
          <div style={S.label}>
            POSICIONES
            {posCount != null && posCount > 0 && (
              <button
                onClick={() => setExpanded(e => !e)}
                style={S.expandBtn}
              >
                {expanded ? "▲ ocultar" : "▼ ver"}
              </button>
            )}
          </div>
          <div style={S.bigValue(posValue > 0 ? true : null)}>
            {posValue != null ? `$${posValue.toFixed(4)}` : (loading ? "…" : "—")}
          </div>
          {posCount != null && (
            <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>
              {posCount} posición{posCount !== 1 ? "es" : ""}
              {posError && <span style={{ color: "#ff446688", marginLeft: 8 }}>⚠ parcial</span>}
            </div>
          )}
        </div>

      </div>

      {/* ── TABLA POSICIONES EXPANDIBLE ───────────────────────────────── */}
      {expanded && positions.length > 0 && (
        <div style={S.posTable}>
          <div style={S.posRow(true)}>
            <span>MERCADO</span>
            <span>LADO</span>
            <span>TOKENS</span>
            <span>PRECIO</span>
            <span>VALOR</span>
          </div>
          {positions.map((p, i) => (
            <div key={i} style={S.posRow(false)}>
              <span style={{ color: "#888", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.market_slug ?? p.condition_id?.slice(0, 12) ?? "—"}
              </span>
              <span style={{ color: p.side === "YES" ? "#00ff88" : "#ff4466" }}>
                {p.side ?? "—"}
              </span>
              <span>{p.size != null ? p.size.toFixed(4) : "—"}</span>
              <span>{p.price != null ? p.price.toFixed(4) : "—"}</span>
              <span style={{ color: "#0066ff" }}>
                {p.value != null ? `$${p.value.toFixed(4)}` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── GRÁFICO EVOLUCIÓN ─────────────────────────────────────────── */}
      <div style={S.chartWrap}>
        <div style={S.chartLabel}>
          EVOLUCIÓN PORTFOLIO · {histLoading ? "cargando…" : `${history.length} SNAPSHOTS`}
          {posCount != null && posCount > 0 && (
            <span style={{ color: "#333", marginLeft: 8 }}>(USDC + posiciones)</span>
          )}
          {error && history.length > 0 && (
            <span style={{ color: "#ff446688", marginLeft: 8 }}>
              ⚠ mostrando último snapshot — datos live no disponibles
            </span>
          )}
          {/* v3.2: botón de recarga manual del historial */}
          <button
            onClick={loadHistory}
            disabled={histLoading}
            style={{ ...S.refreshBtn, marginLeft: 10, fontSize: 8 }}
            title="Recargar historial desde Supabase"
          >
            {histLoading ? "…" : "↻ BD"}
          </button>
        </div>

        {histLoading && history.length === 0 ? (
          <div style={S.noData}>Cargando historial desde Supabase…</div>
        ) : chartData.length < 2 ? (
          <div style={S.noData}>
            Acumulando datos…{" "}
            {chartData.length === 1 && (
              <span style={{ color: "#333" }}>(primer snapshot, esperando el siguiente)</span>
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
                dataKey="total"
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
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 20px",
    borderBottom: "1px solid #0d0d1a",
  },
  headerTitle: {
    fontSize: 9,
    letterSpacing: "0.15em",
    color: "#333",
  },
  refreshBtn: {
    background: "none",
    border: "1px solid #1a1a2e",
    color: "#444",
    cursor: "pointer",
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 2,
    fontFamily: "inherit",
  },
  errorBanner: {
    background: "#1a0008",
    border: "1px solid #ff446622",
    margin: "12px 20px",
    padding: "10px 14px",
    borderRadius: 3,
    fontSize: 10,
    color: "#ff4466",
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
    color: positive == null ? "#ccc" : positive ? "#00ff88" : "#ff4466",
  }),
  expandBtn: {
    background: "none",
    border: "none",
    color: "#333",
    cursor: "pointer",
    fontSize: 8,
    marginLeft: 8,
    fontFamily: "inherit",
    padding: 0,
  },
  posTable: {
    margin: "0 20px 12px",
    border: "1px solid #0d0d1a",
    borderRadius: 3,
    overflow: "hidden",
    fontSize: 9,
  },
  posRow: (header) => ({
    display: "grid",
    gridTemplateColumns: "2fr 0.5fr 1fr 1fr 1fr",
    gap: 8,
    padding: "5px 10px",
    background: header ? "#050510" : "transparent",
    borderBottom: "1px solid #0d0d1a",
    color: header ? "#333" : "#888",
    letterSpacing: header ? "0.1em" : 0,
    fontSize: header ? 7 : 9,
  }),
  chartWrap: {
    borderTop: "1px solid #0d0d1a",
    padding: "10px 20px 14px",
  },
  chartLabel: {
    fontSize: 7,
    letterSpacing: "0.15em",
    color: "#333",
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
  },
  noData: {
    fontSize: 9,
    color: "#222",
    textAlign: "center",
    padding: "20px 0",
  },
};
