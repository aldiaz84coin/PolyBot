"use client";
/**
 * components/BalanceWidget.jsx — v4.0
 *
 * CAMBIOS v4.0 — REDISEÑO COMPLETO DE LAYOUT + FIX TOTAL
 * ─────────────────────────────────────────────────────────────────────
 *
 *  BUG FIX (raíz):
 *    - El API route (v4.0) ya devuelve posiciones correctamente
 *      categorizadas. Este widget ahora las muestra en detalle.
 *
 *  Nuevo layout:
 *    ┌─────────────────────────────────────────────────────────┐
 *    │ WALLET BALANCE                          LIVE · 14:32:01 │
 *    ├─────────────────────────────────────────────────────────┤
 *    │  TOTAL PORTFOLIO                                        │
 *    │  $1,234.5600   (+$12.34  +1.01%)                       │
 *    ├──────────────────┬──────────────────┬───────────────────┤
 *    │  USDC LÍQUIDO    │  POSICIONES      │  PENDING CLAIM    │
 *    │  $1,200.00       │  $8.00  (2)      │  $26.56  (1)      │
 *    │  bridged/native  │  abiertas        │  reclamar manual  │
 *    ├─────────────────────────────────────────────────────────┤
 *    │  [▼ ver posiciones]                                     │
 *    │  GANADORA PENDIENTE  UP / YES  26.56 tokens  ≈$26.56   │
 *    │  ABIERTA             DOWN/NO   16.00 tokens  $8.00      │
 *    ├─────────────────────────────────────────────────────────┤
 *    │  EVOLUCIÓN PORTFOLIO · 12 SNAPSHOTS   [↻ BD]           │
 *    │  [gráfico]                                              │
 *    └─────────────────────────────────────────────────────────┘
 *
 * (v3.2 — Historial Supabase con refresco periódico)
 * (v3.1 — BUG FIX portfolio congelado)
 * (v3.0 — Migración localStorage → Supabase)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_HISTORY        = 500;
const POLL_INTERVAL_MS   = 60_000;
const RETRY_ON_ERROR_MS  = 15_000;
const HISTORY_POLL_MS    = 5 * 60_000;
const SNAPSHOT_MIN_DELTA = 0.001;
const STALE_THRESHOLD_MS = 90_000;

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
    const sameDay = d.getDate() === now.getDate()
      && d.getMonth() === now.getMonth()
      && d.getFullYear() === now.getFullYear();
    return sameDay
      ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("es-ES", { month: "2-digit", day: "2-digit" });
  } catch { return ""; }
}

function mergeHistory(fromDb, inMemory) {
  const map = new Map();
  for (const p of fromDb)   map.set(p.ts, p);
  for (const p of inMemory) map.set(p.ts, p);
  return Array.from(map.values())
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-MAX_HISTORY);
}

function fmtUSD(v, decimals = 4) {
  if (v == null) return "—";
  return `$${Number(v).toFixed(decimals)}`;
}

function fmtDelta(v) {
  if (v == null) return null;
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(4)}`;
}

// ── Tooltip gráfico ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: "#0a0a14", border: "1px solid #1a1a2e",
      padding: "6px 10px", fontSize: 9, fontFamily: "inherit", color: "#ccc",
    }}>
      <div style={{ color: "#444", marginBottom: 3 }}>{label}</div>
      <div>TOTAL <span style={{ color: "#4488ff" }}>{fmtUSD(d.total)}</span></div>
      {d.usdc != null && d.usdc !== d.total && (
        <div>USDC <span style={{ color: "#888" }}>{fmtUSD(d.usdc)}</span></div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function BalanceWidget() {
  // Datos de balance
  const [usdc,           setUsdc]           = useState(null);
  const [pol,            setPol]            = useState(null);
  const [usdcDetail,     setUsdcDetail]     = useState(null);
  const [totalPortfolio, setTotalPortfolio] = useState(null);
  // Posiciones
  const [openCount,      setOpenCount]      = useState(null);
  const [openValue,      setOpenValue]      = useState(null);
  const [pendingCount,   setPendingCount]   = useState(null);
  const [pendingValue,   setPendingValue]   = useState(null);
  const [positionsOpen,   setPosOpen]       = useState([]);
  const [posPending,      setPosPending]    = useState([]);
  const [posError,        setPosError]      = useState(null);
  // UI
  const [expanded,      setExpanded]        = useState(false);
  const [loading,       setLoading]         = useState(false);
  const [histLoading,   setHistLoading]     = useState(false);
  const [error,         setError]           = useState(null);
  const [apiDiag,       setApiDiag]         = useState(null);
  const [lastFetch,     setLastFetch]       = useState(null);
  const [lastAttempt,   setLastAttempt]     = useState(null);
  const [rpcUsed,       setRpcUsed]         = useState(null);
  const [history,       setHistory]         = useState([]);

  const pollTimerRef  = useRef(null);
  const errorTimerRef = useRef(null);
  const histTimerRef  = useRef(null);
  const prevTotal     = useRef(null);

  const isStale = !lastFetch
    ? true
    : (Date.now() - new Date(lastFetch).getTime()) > STALE_THRESHOLD_MS;

  // ── Historial ─────────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const res  = await fetch(`/api/balance-history?limit=${MAX_HISTORY}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        setHistory(prev => mergeHistory(data.data, prev));
      }
    } catch (e) {
      console.warn("[BalanceWidget] No se pudo cargar historial:", e.message);
    } finally {
      setHistLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    histTimerRef.current = setInterval(loadHistory, HISTORY_POLL_MS);
    return () => clearInterval(histTimerRef.current);
  }, [loadHistory]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") loadHistory();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadHistory]);

  // ── Snapshot ──────────────────────────────────────────────────────────────

  const saveSnapshot = useCallback(async (ts, usdc, total) => {
    try {
      await fetch("/api/balance-history", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ts, usdc, total }),
      });
    } catch {}
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
        setError(errMsg);
        setApiDiag({ wallet_hint: data.wallet_hint ?? null, rpc_errors: data.rpc_errors ?? [] });
        errorTimerRef.current = setTimeout(fetchBalance, RETRY_ON_ERROR_MS);
        return;
      }

      const now      = new Date().toISOString();
      const newUsdc  = data.usdc;
      const newTotal = data.total_portfolio ?? newUsdc;

      // Balances
      setUsdc(newUsdc);
      setPol(data.pol);
      setUsdcDetail(data.usdc_detail ?? null);
      setTotalPortfolio(newTotal);
      // Posiciones
      setOpenCount(data.open_count ?? null);
      setOpenValue(data.open_value ?? null);
      setPendingCount(data.pending_claim_count ?? null);
      setPendingValue(data.pending_claim_value ?? null);
      setPosOpen(data.positions_open   ?? []);
      setPosPending(data.positions_pending ?? []);
      setPosError(data.positions_error ?? null);
      setLastFetch(now);
      setRpcUsed(data.rpc_used ?? null);

      // Snapshot
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
      setError(e.message);
      errorTimerRef.current = setTimeout(fetchBalance, RETRY_ON_ERROR_MS);
    } finally {
      setLoading(false);
    }
  }, [saveSnapshot]);

  useEffect(() => {
    fetchBalance();
    pollTimerRef.current = setInterval(fetchBalance, POLL_INTERVAL_MS);
    return () => {
      clearInterval(pollTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [fetchBalance]);

  // ── Derived chart ─────────────────────────────────────────────────────────

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
    return src.map(h => ({ label: xLabel(h.ts), total: h.total ?? h.usdc, usdc: h.usdc }));
  })();

  const vals       = chartData.map(d => d.total).filter(v => v != null);
  const minV       = vals.length ? Math.min(...vals) : 0;
  const maxV       = vals.length ? Math.max(...vals) : 1;
  const pad        = Math.max((maxV - minV) * 0.1, 0.5);
  const yMin       = Math.max(0, minV - pad);
  const yMax       = maxV + pad;
  const trendColor = deltaTotal == null ? "#4488ff" : deltaTotal >= 0 ? "#00ff88" : "#ff4466";
  const firstVal   = chartData.length > 0 ? chartData[0].total : null;

  // ── Helpers de render ─────────────────────────────────────────────────────

  const hasPending   = (pendingCount ?? 0) > 0;
  const hasOpen      = (openCount    ?? 0) > 0;
  const hasPositions = hasPending || hasOpen;

  function MetricBlock({ label, main, sub, color = "#ccc", badge, badgeColor }) {
    return (
      <div style={{ flex: 1, minWidth: 120, padding: "14px 20px" }}>
        <div style={{ fontSize: 8, color: "#444", letterSpacing: "0.15em", marginBottom: 5, display: "flex", gap: 8, alignItems: "center" }}>
          {label}
          {badge != null && badge > 0 && (
            <span style={{
              fontSize: 8, fontWeight: 700,
              background: `${badgeColor ?? "#4488ff"}22`,
              border: `1px solid ${badgeColor ?? "#4488ff"}44`,
              color: badgeColor ?? "#4488ff",
              padding: "1px 5px", borderRadius: 2,
            }}>
              ×{badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>
          {main ?? (loading ? "…" : "—")}
        </div>
        {sub && <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>{sub}</div>}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={S.root}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={S.header}>
        <span style={S.headerTitle}>WALLET BALANCE</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {lastFetch && (
            <span style={{ fontSize: 8, color: isStale ? "#ff4466" : "#444" }}>
              {isStale ? "STALE" : "LIVE"} · {fmtTime(lastFetch)}
              {rpcUsed && (
                <span style={{ color: "#222", marginLeft: 6 }}>
                  {rpcUsed.replace("https://", "").split("/")[0]}
                </span>
              )}
            </span>
          )}
          <button onClick={fetchBalance} disabled={loading} style={S.btn} title="Actualizar">
            {loading ? "…" : "↻"}
          </button>
        </div>
      </div>

      {/* ── ERROR ─────────────────────────────────────────────────────── */}
      {error && (
        <div style={S.errorBanner}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ⚠ /api/balance falló · reintentando en {RETRY_ON_ERROR_MS / 1000}s
          </div>
          <div style={{ color: "#ff446688", fontSize: 9 }}>{error}</div>
          {apiDiag?.wallet_hint && (
            <div style={{ color: "#ff446655", fontSize: 9 }}>wallet: {apiDiag.wallet_hint}</div>
          )}
          {apiDiag?.rpc_errors?.length > 0 && (
            <div style={{ color: "#ff446644", fontSize: 8 }}>
              RPCs: {apiDiag.rpc_errors.join(", ")}
            </div>
          )}
        </div>
      )}

      {/* ── TOTAL PORTFOLIO ───────────────────────────────────────────── */}
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #0d0d1a" }}>
        <div style={{ fontSize: 8, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>
          TOTAL PORTFOLIO
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div style={{
            fontSize: 34, fontWeight: 700, lineHeight: 1,
            color: deltaTotal == null ? "#ccc" : deltaTotal >= 0 ? "#00ff88" : "#ff4466",
          }}>
            {totalPortfolio != null ? fmtUSD(totalPortfolio) : (loading ? "…" : "—")}
          </div>
          {deltaTotal != null && (
            <div style={{
              fontSize: 11,
              color: deltaTotal >= 0 ? "#00ff8899" : "#ff446699",
            }}>
              {fmtDelta(deltaTotal)}
              {deltaPct != null && (
                <span style={{ marginLeft: 6 }}>
                  ({deltaTotal >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>
        {/* Desglose en una línea */}
        {(usdc != null || hasPositions) && (
          <div style={{ marginTop: 6, fontSize: 9, color: "#333", display: "flex", gap: 12, flexWrap: "wrap" }}>
            {usdc != null && (
              <span>
                USDC <span style={{ color: "#888" }}>{fmtUSD(usdc)}</span>
              </span>
            )}
            {hasOpen && (
              <span>
                +{" "}
                <span style={{ color: "#4488ff" }}>
                  posiciones abiertas {fmtUSD(openValue)}
                </span>
              </span>
            )}
            {hasPending && (
              <span>
                +{" "}
                <span style={{ color: "#ffcc00" }}>
                  pending claim {fmtUSD(pendingValue)}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── TRES COLUMNAS: USDC / POSICIONES ABIERTAS / PENDING CLAIM ─── */}
      <div style={{ display: "flex", borderBottom: "1px solid #0d0d1a" }}>

        {/* USDC */}
        <MetricBlock
          label="USDC LÍQUIDO"
          main={usdc != null ? fmtUSD(usdc) : null}
          sub={
            usdcDetail
              ? `native ${fmtUSD(usdcDetail.native, 2)} · bridged ${fmtUSD(usdcDetail.bridged, 2)}`
              : pol != null ? `POL ${pol.toFixed(4)}` : undefined
          }
          color="#ccc"
        />

        <div style={{ width: 1, background: "#0d0d1a", alignSelf: "stretch" }} />

        {/* POSICIONES ABIERTAS */}
        <MetricBlock
          label="POSICIONES ABIERTAS"
          badge={openCount}
          badgeColor="#4488ff"
          main={
            openCount == null
              ? null
              : openCount === 0
                ? <span style={{ fontSize: 16, color: "#333" }}>ninguna</span>
                : fmtUSD(openValue)
          }
          sub={
            openCount === 0
              ? "sin posiciones activas"
              : openCount > 0
                ? `${openCount} posición${openCount !== 1 ? "es" : ""} en curso`
                : posError
                  ? "⚠ error al cargar"
                  : undefined
          }
          color={openCount > 0 ? "#4488ff" : "#333"}
        />

        <div style={{ width: 1, background: "#0d0d1a", alignSelf: "stretch" }} />

        {/* PENDING CLAIM */}
        <div style={{ flex: 1, minWidth: 120, padding: "14px 20px", position: "relative" }}>
          <div style={{ fontSize: 8, color: "#444", letterSpacing: "0.15em", marginBottom: 5, display: "flex", gap: 8, alignItems: "center" }}>
            PENDING CLAIM
            {hasPending && (
              <span style={{
                fontSize: 8, fontWeight: 700,
                background: "#ffcc0022", border: "1px solid #ffcc0044",
                color: "#ffcc00", padding: "1px 5px", borderRadius: 2,
                animation: "pulse 2s infinite",
              }}>
                ×{pendingCount}
              </span>
            )}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1, color: hasPending ? "#ffcc00" : "#333" }}>
            {pendingCount == null
              ? (loading ? "…" : "—")
              : pendingCount === 0
                ? <span style={{ fontSize: 16 }}>ninguno</span>
                : fmtUSD(pendingValue)
            }
          </div>
          <div style={{ fontSize: 9, color: "#555", marginTop: 4 }}>
            {hasPending
              ? "⚠ reclamar en Polymarket"
              : pendingCount === 0
                ? "sin ganancias pendientes"
                : undefined
            }
          </div>
          {hasPending && (
            <a
              href="https://polymarket.com/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block", marginTop: 6,
                fontSize: 8, color: "#ffcc0088",
                textDecoration: "none", letterSpacing: "0.1em",
                border: "1px solid #ffcc0033", padding: "2px 7px", borderRadius: 2,
              }}
            >
              IR A PORTFOLIO ↗
            </a>
          )}
        </div>
      </div>

      {/* ── TABLA DE POSICIONES EXPANDIBLE ───────────────────────────── */}
      {hasPositions && (
        <>
          <div style={{
            padding: "8px 20px",
            borderBottom: "1px solid #0d0d1a",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <button
              onClick={() => setExpanded(e => !e)}
              style={S.btn}
            >
              {expanded ? "▲ ocultar posiciones" : "▼ ver posiciones"}
            </button>
            {posError && (
              <span style={{ fontSize: 9, color: "#ff446688" }}>⚠ {posError.slice(0, 60)}</span>
            )}
          </div>

          {expanded && (
            <div style={{ borderBottom: "1px solid #0d0d1a" }}>

              {/* PENDING CLAIM */}
              {posPending.length > 0 && (
                <div>
                  <div style={{
                    padding: "8px 20px 4px",
                    fontSize: 8, color: "#ffcc00",
                    letterSpacing: "0.15em",
                    background: "#0a0800",
                  }}>
                    GANADORAS PENDIENTES DE CLAIM — reclamar manualmente en Polymarket
                  </div>
                  {posPending.map((p, i) => (
                    <PositionRow key={i} pos={p} type="pending" />
                  ))}
                </div>
              )}

              {/* OPEN */}
              {positionsOpen.length > 0 && (
                <div>
                  <div style={{
                    padding: "8px 20px 4px",
                    fontSize: 8, color: "#4488ff",
                    letterSpacing: "0.15em",
                    background: "#000a14",
                  }}>
                    POSICIONES ABIERTAS — resultado pendiente
                  </div>
                  {positionsOpen.map((p, i) => (
                    <PositionRow key={i} pos={p} type="open" />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── GRÁFICO EVOLUCIÓN ─────────────────────────────────────────── */}
      <div style={S.chartWrap}>
        <div style={S.chartLabel}>
          EVOLUCIÓN PORTFOLIO · {histLoading ? "cargando…" : `${history.length} snapshots`}
          {hasPending && (
            <span style={{ color: "#ffcc0066", marginLeft: 8 }}>incl. pending claim</span>
          )}
          <button
            onClick={loadHistory}
            disabled={histLoading}
            style={{ ...S.btn, marginLeft: 10, fontSize: 8 }}
            title="Recargar historial"
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

// ── Fila de posición ──────────────────────────────────────────────────────────

function PositionRow({ pos, type }) {
  const isPending    = type === "pending";
  const accentColor  = isPending ? "#ffcc00" : "#4488ff";
  const isUp         = (pos.side ?? pos.outcome ?? "").toUpperCase() === "YES" ||
                       (pos.side ?? pos.outcome ?? "").toUpperCase() === "UP";
  const sideColor    = isUp ? "#00ff88" : "#ff4466";
  const sideLabel    = isUp ? "▲ UP / YES" : "▼ DOWN / NO";
  const valueEst     = isPending
    ? pos.size        // ganadora: vale ~1 USDC/token
    : pos.currentValue ?? (pos.size * pos.curPrice);

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 90px 90px 80px 80px",
      padding: "7px 20px",
      borderBottom: "1px solid #06060e",
      fontSize: 10,
      alignItems: "center",
      background: isPending ? "#0d0a00" : "transparent",
    }}>
      {/* Mercado */}
      <div style={{ color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 9 }}>
        {pos.market_slug
          ? <span>{pos.market_slug.slice(0, 40)}{pos.market_slug.length > 40 ? "…" : ""}</span>
          : <span style={{ color: "#333" }}>{pos.title?.slice(0, 40) ?? "—"}</span>
        }
      </div>
      {/* Lado */}
      <div style={{ color: sideColor, fontWeight: 700, fontSize: 9 }}>
        {sideLabel}
      </div>
      {/* Tokens */}
      <div style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>
        {pos.size?.toFixed(4) ?? "—"} tok
      </div>
      {/* Precio CLOB */}
      <div style={{ color: accentColor, fontVariantNumeric: "tabular-nums" }}>
        {pos.curPrice != null ? `${(pos.curPrice * 100).toFixed(1)}¢` : "—"}
      </div>
      {/* Valor estimado */}
      <div style={{ color: isPending ? "#ffcc00" : "#888", fontWeight: isPending ? 700 : 400, textAlign: "right" }}>
        {valueEst != null ? `≈$${Number(valueEst).toFixed(4)}` : "—"}
        {isPending && (
          <div style={{ fontSize: 7, color: "#ffcc0066", marginTop: 1 }}>CLAIM</div>
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
    background: "#010108",
  },
  headerTitle: { fontSize: 9, letterSpacing: "0.15em", color: "#333" },
  btn: {
    background: "none",
    border: "1px solid #1a1a2e",
    color: "#555",
    cursor: "pointer",
    fontSize: 9,
    padding: "3px 8px",
    borderRadius: 2,
    fontFamily: "inherit",
    letterSpacing: "0.08em",
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
