"use client";
/**
 * components/BalanceWidget.jsx — v3.1
 *
 * CAMBIOS v3.1
 * ─────────────────────────────────────────────────────────────────────
 *  BUG FIX — Portfolio congelado ("la foto")
 *
 *  Síntoma: el gráfico mostraba el historial de Supabase (snapshot
 *  pasado) pero los valores live (USDC, posiciones, total) nunca se
 *  actualizaban.
 *
 *  Causa raíz: /api/balance devolvía { success: false, error: "..." }
 *  (wallet no resuelta o todos los RPCs fallando) → fetchBalance()
 *  hacía early return sin actualizar ningún estado live. El error se
 *  pintaba en S.errTxt de 8px, prácticamente invisible.
 *
 *  Correcciones:
 *    1. Banner de error prominente cuando /api/balance falla, con el
 *       mensaje completo y diagnóstico (wallet_hint, rpc_errors si los
 *       devuelve la API v3.2).
 *    2. Retry automático agresivo: en caso de error reintenta a los 15s
 *       en vez de esperar los 60s del intervalo normal.
 *    3. Botón ↻ siempre visible aunque loading=false y haya error.
 *    4. Indicador "LIVE" / "STALE" junto a la última hora de fetch.
 *    5. En polling normal (sin error) se mantiene POLL_INTERVAL_MS=60s.
 *
 * (v3.0 — Migración localStorage → Supabase, historial persistido)
 * (v2.0 — USDC + posiciones activas + tabla expandible + gráfico)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_HISTORY        = 500;
const POLL_INTERVAL_MS   = 60_000;
const RETRY_ON_ERROR_MS  = 15_000;   // reintento rápido si /api/balance falla
const SNAPSHOT_MIN_DELTA = 0.001;
const STALE_THRESHOLD_MS = 90_000;   // >90s sin éxito → "STALE"

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

// ── Subcomponente: tooltip del gráfico ───────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#010108", border: "1px solid #0d0d1a",
      padding: "4px 8px", fontSize: 9, fontFamily: "inherit",
    }}>
      <div style={{ color: "#444" }}>{label}</div>
      <div style={{ color: "#00ff88" }}>${payload[0]?.value?.toFixed(4)}</div>
    </div>
  );
}

// ── Subcomponente: fila de posición ──────────────────────────────────────────

function PositionRow({ pos }) {
  const pnlPct   = pos.avgPrice > 0
    ? ((pos.curPrice - pos.avgPrice) / pos.avgPrice) * 100
    : null;
  const pnlColor = pnlPct == null ? "#555" : pnlPct >= 0 ? "#00ff88" : "#ff4466";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 48px 60px 52px 52px 64px",
      gap: 6, padding: "5px 8px",
      borderBottom: "1px solid #07070f",
      fontSize: 9, alignItems: "center",
    }}>
      <div style={{ overflow: "hidden" }}>
        <div style={{
          overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", fontSize: 8, color: "#888",
          marginBottom: 2,
        }}>
          {pos.title}
        </div>
        <div style={{
          fontSize: 8, fontWeight: 700,
          color: pos.outcome === "YES" ? "#00ff88" : "#ff4466",
          letterSpacing: "0.1em",
        }}>
          {pos.outcome}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>{pos.size.toFixed(2)}</div>
      <div style={{ textAlign: "right" }}>${pos.avgPrice.toFixed(4)}</div>
      <div style={{ textAlign: "right", color: pnlColor }}>
        ${pos.curPrice.toFixed(4)}
      </div>
      <div style={{ textAlign: "right", color: pnlColor }}>
        {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : "—"}
      </div>
      <div style={{ textAlign: "right", color: "#00cc77", fontWeight: 700 }}>
        ${pos.currentValue.toFixed(4)}
      </div>
    </div>
  );
}

// ── Subcomponente: banner de error ────────────────────────────────────────────

function ErrorBanner({ error, apiDiag, onRetry, loading }) {
  if (!error) return null;
  return (
    <div style={{
      margin: "0 12px 10px",
      padding: "8px 12px",
      background: "#1a0508",
      border: "1px solid #ff446633",
      borderRadius: 3,
      fontSize: 9,
      color: "#ff6677",
      lineHeight: 1.7,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <span style={{ color: "#ff4466", fontWeight: 700, letterSpacing: "0.1em" }}>
            ✗ /api/balance FALLÓ
          </span>
          <div style={{ marginTop: 3, color: "#cc3344", wordBreak: "break-word" }}>
            {error}
          </div>
          {apiDiag?.wallet_hint && (
            <div style={{ marginTop: 2, color: "#552233" }}>
              Wallet buscada: <span style={{ color: "#884455" }}>{apiDiag.wallet_hint}</span>
            </div>
          )}
          {apiDiag?.rpc_errors?.length > 0 && (
            <div style={{ marginTop: 2, color: "#552233" }}>
              RPCs fallidos: {apiDiag.rpc_errors.join(", ")}
            </div>
          )}
          <div style={{ marginTop: 4, color: "#442233", fontSize: 8 }}>
            Reintentando en 15s… o pulsa ↻
          </div>
        </div>
        <button
          onClick={onRetry}
          disabled={loading}
          style={{
            marginLeft: 12,
            background: "none",
            border: "1px solid #ff446644",
            color: loading ? "#442233" : "#ff4466",
            fontSize: 9,
            padding: "3px 8px",
            cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            borderRadius: 2,
            flexShrink: 0,
          }}
        >
          {loading ? "…" : "↻ RETRY"}
        </button>
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
  const [histLoading,    setHistLoading]    = useState(true);
  const [error,          setError]          = useState(null);
  const [apiDiag,        setApiDiag]        = useState(null);   // diagnóstico extra de la API
  const [posError,       setPosError]       = useState(null);
  const [lastFetch,      setLastFetch]      = useState(null);   // ISO de último fetch exitoso
  const [lastAttempt,    setLastAttempt]    = useState(null);   // ISO del último intento
  const [rpcUsed,        setRpcUsed]        = useState(null);
  const [showPositions,  setShowPositions]  = useState(false);
  const [history,        setHistory]        = useState([]);

  const prevTotal    = useRef(null);
  const errorTimerRef = useRef(null);   // timer del retry rápido por error
  const pollTimerRef  = useRef(null);   // timer del poll normal

  // Stale: más de 90s desde el último fetch exitoso
  const isStale = lastFetch
    ? (Date.now() - new Date(lastFetch).getTime()) > STALE_THRESHOLD_MS
    : true;

  // ── Cargar historial desde Supabase al montar ─────────────────────────────
  useEffect(() => {
    async function loadHistory() {
      setHistLoading(true);
      try {
        const res  = await fetch(`/api/balance-history?limit=${MAX_HISTORY}`);
        const data = await res.json();
        if (data.ok && Array.isArray(data.data)) {
          setHistory(data.data);
        }
      } catch (e) {
        console.warn("[BalanceWidget] No se pudo cargar historial:", e.message);
      } finally {
        setHistLoading(false);
      }
    }
    loadHistory();
  }, []);

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

  // ── Fetch balance (definido con useCallback para poder llamarlo manualmente) ─
  const fetchBalance = useCallback(async () => {
    // Cancelar timer de retry si había uno pendiente
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
        // Guardar info de diagnóstico extra que devuelve v3.2
        setApiDiag({
          wallet_hint: data.wallet_hint ?? null,
          rpc_errors:  data.rpc_errors  ?? [],
        });
        // Programar retry rápido
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
        const next  = [...prev, point].slice(-MAX_HISTORY);
        saveSnapshot(now, newUsdc, newTotal);
        return next;
      });

      prevTotal.current = newTotal;

    } catch (e) {
      console.error("[BalanceWidget] fetchBalance exception:", e.message);
      setError(e.message);
      // Programar retry rápido
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
        </div>

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

        {/* Controles */}
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
              {isStale && <span style={{ color: "#ff4466", marginLeft: 3 }}>STALE</span>}
              {!isStale && <span style={{ color: "#00ff88", marginLeft: 3 }}>LIVE</span>}
              {rpcUsed && (
                <span style={{ marginLeft: 4 }}>
                  · {rpcUsed.replace("https://", "").split("/")[0].split(".").slice(0, 2).join(".")}
                </span>
              )}
            </div>
          )}
          <div style={{ ...S.meta, color: "#1a1a2a" }}>
            {history.length}pt · supabase
          </div>
        </div>
      </div>

      {/* ══════════════════ BANNER DE ERROR (prominente) ═══════════════ */}
      <ErrorBanner
        error={error}
        apiDiag={apiDiag}
        onRetry={fetchBalance}
        loading={loading}
      />

      {/* ══════════════════ TABLA POSICIONES (expandible) ══════════════ */}
      {showPositions && positions.length > 0 && (
        <div style={S.posTable}>
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
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 48px 60px 52px 52px 64px",
            gap: 6, padding: "5px 8px",
            borderTop: "1px solid #0d0d1a",
            fontSize: 9, color: "#555",
          }}>
            <div style={{ color: "#444", letterSpacing: "0.1em" }}>TOTAL</div>
            <div /><div /><div /><div />
            <div style={{ textAlign: "right", color: "#00cc77", fontWeight: 700 }}>
              ${(posValue ?? 0).toFixed(4)}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ GRÁFICO EVOLUCIÓN ══════════════════════════ */}
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
        </div>

        {histLoading ? (
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
  midValue: {
    fontSize: 18, fontWeight: 700, lineHeight: 1, marginBottom: 4,
  },
  delta: (positive) => ({
    fontSize: 9, marginTop: 4,
    color: positive ? "#00ff88" : "#ff4466",
    letterSpacing: "0.05em",
  }),
  sub: {
    fontSize: 8, color: "#555", marginTop: 3,
  },
  controls: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
    flexShrink: 0,
    minWidth: 60,
  },
  btn: (disabled) => ({
    background: "none",
    border: "1px solid #0d0d1a",
    color: disabled ? "#222" : "#444",
    fontSize: 9,
    padding: "2px 6px",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.1em",
    borderRadius: 2,
  }),
  meta: {
    fontSize: 7, color: "#2a2a3a", letterSpacing: "0.05em",
  },
  posTable: {
    borderTop: "1px solid #0d0d1a",
  },
  chartWrap: {
    borderTop: "1px solid #07070f",
    padding: "8px 8px 8px 0",
  },
  chartLabel: {
    fontSize: 7, color: "#2a2a3a", letterSpacing: "0.12em",
    paddingLeft: 12, marginBottom: 4,
  },
  noData: {
    fontSize: 8, color: "#2a2a3a", textAlign: "center",
    padding: "16px 0", letterSpacing: "0.1em",
  },
};
