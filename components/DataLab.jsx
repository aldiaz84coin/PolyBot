// components/DataLab.jsx
// DataLab — Pestaña de análisis histórico de precios de tokens y velas BTC
// v2.1 — FIX ventanas horarias en gráfico de tokens (ReferenceArea geométrico)

"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  BarChart, Bar, ResponsiveContainer, ReferenceLine, ReferenceArea, Cell,
} from "recharts";

// ── Colores y estilos ──────────────────────────────────────────────────────────
const C = {
  green:  "#00ff88",
  red:    "#ff3355",
  yellow: "#ffcc00",
  blue:   "#4488ff",
  purple: "#aa66ff",
  dim:    "#888",
  border: "#0d0d1a",
  bg:     "#010108",
  card:   "#02020e",
};

const VENTANA_COLORS = {
  T20: "#4488ff",
  T15: "#ffcc00",
  T10: "#ff8800",
  T5:  "#ff3355",
};

const VENTANA_ORDER = ["T20", "T15", "T10", "T5"];

// Definición de ventanas: minutos antes del CIERRE de la vela
const WINDOWS_DEF = [
  { key: "T-20", min: 17, max: 22, color: "#4488ff" },
  { key: "T-15", min: 12, max: 17, color: "#ffcc00" },
  { key: "T-10", min: 7,  max: 12, color: "#ff8800" },
  { key: "T-5",  min: 2,  max: 7,  color: "#ff3355" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtTime  = (ts) => ts ? new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const fmtDate  = (ts) => ts ? new Date(ts).toLocaleDateString("es-ES") : "—";
const fmtOdds  = (v)  => v != null ? `${(v * 100).toFixed(1)}%` : "—";
const fmtUSD   = (v)  => v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
const fmtBTC   = (v)  => v != null ? `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} BTC` : "—";

/**
 * Dado cualquier ts_ms dentro de una hora, calcula los x1/x2 (ms)
 * de cada ventana de esa hora.
 * La vela cierra al inicio de la hora siguiente (HH+1:00:00 UTC).
 */
function getWindowBandsForHour(ts_ms) {
  const d = new Date(ts_ms);
  const closeMs = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0)
  ).getTime();

  return WINDOWS_DEF.map((w) => ({
    ...w,
    x1: closeMs - w.max * 60_000,
    x2: closeMs - w.min * 60_000,
  }));
}

/**
 * Devuelve bandas para todas las horas presentes en chartData.
 */
function getAllWindowBands(chartData) {
  if (!chartData.length) return [];
  const seenHours = new Set();
  chartData.forEach(({ ts_ms }) => {
    const d = new Date(ts_ms);
    seenHours.add(
      `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`
    );
  });
  const bands = [];
  seenHours.forEach((key) => {
    const [year, month, day, hour] = key.split("-").map(Number);
    const sampleTs = new Date(Date.UTC(year, month, day, hour, 30, 0)).getTime();
    bands.push(...getWindowBandsForHour(sampleTs));
  });
  return bands;
}

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize: 9, letterSpacing: "0.2em", color: C.dim,
      borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub, color = C.dim }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      padding: "12px 16px", borderRadius: 4, minWidth: 110,
    }}>
      <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.15em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Tooltip personalizado para el gráfico de tokens ──────────────────────────

function TokenTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const yes = payload.find(p => p.dataKey === "yes_price");
  const no  = payload.find(p => p.dataKey === "no_price");
  const btc = payload.find(p => p.dataKey === "btc_price");
  return (
    <div style={{
      background: "#050510", border: `1px solid ${C.border}`,
      padding: "8px 12px", fontSize: 10, fontFamily: "monospace",
    }}>
      <div style={{ color: C.dim, marginBottom: 4 }}>{label}</div>
      {yes && <div style={{ color: C.green }}>YES {fmtOdds(yes.value)}</div>}
      {no  && <div style={{ color: C.red   }}>NO  {fmtOdds(no.value)}</div>}
      {btc && <div style={{ color: C.yellow, marginTop: 4 }}>BTC {fmtUSD(btc.value)}</div>}
    </div>
  );
}

// ── Selector de fecha ─────────────────────────────────────────────────────────

function DateSelector({ dates, selected, onChange }) {
  return (
    <select
      value={selected}
      onChange={e => onChange(e.target.value)}
      style={{
        background: C.card, border: `1px solid ${C.border}`,
        color: "#ccc", fontSize: 10, padding: "4px 8px",
        fontFamily: "inherit", cursor: "pointer",
      }}
    >
      {dates.map(d => (
        <option key={d} value={d}>{d}</option>
      ))}
    </select>
  );
}

// ── Selector de hora ──────────────────────────────────────────────────────────

function HourSelector({ selected, onChange }) {
  return (
    <select
      value={selected}
      onChange={e => onChange(e.target.value)}
      style={{
        background: C.card, border: `1px solid ${C.border}`,
        color: "#ccc", fontSize: 10, padding: "4px 8px",
        fontFamily: "inherit", cursor: "pointer",
      }}
    >
      <option value="">Todas las horas</option>
      {Array.from({ length: 24 }, (_, i) => (
        <option key={i} value={i}>{String(i).padStart(2, "0")}:00 UTC</option>
      ))}
    </select>
  );
}

// ── Gráfico: evolución de precio de tokens en el tiempo ──────────────────────
// v2.1 — Ventanas calculadas geométricamente con ReferenceArea + ReferenceLine

function TokenPriceChart({ data, loading }) {
  if (loading) return <div style={{ color: C.dim, fontSize: 10, padding: 20 }}>Cargando datos…</div>;
  if (!data.length) return <div style={{ color: "#333", fontSize: 10, padding: 20 }}>Sin datos para el filtro seleccionado.</div>;

  const chartData = data.map(row => ({
    ...row,
    ts_ms:     new Date(row.ts).getTime(),
    yes_price: row.yes_price != null ? parseFloat(row.yes_price) : null,
    no_price:  row.no_price  != null ? parseFloat(row.no_price)  : null,
    btc_price: row.btc_price != null ? parseFloat(row.btc_price) : null,
  }));

  const domain = [chartData[0].ts_ms, chartData[chartData.length - 1].ts_ms];
  const windowBands = getAllWindowBands(chartData);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#0a0a18" />

        <XAxis
          dataKey="ts_ms"
          type="number"
          scale="time"
          domain={domain}
          tickFormatter={(v) => {
            const d = new Date(v);
            return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
          }}
          tick={{ fontSize: 8, fill: "#444" }}
          tickCount={8}
          tickLine={false}
        />

        <YAxis
          domain={[0, 1]}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          tick={{ fontSize: 8, fill: "#444" }}
          width={36}
          tickLine={false}
        />

        <Tooltip
          content={<TokenTooltip />}
          labelFormatter={(v) => {
            const d = new Date(v);
            return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")} UTC`;
          }}
        />

        <Legend
          wrapperStyle={{ fontSize: 9, color: C.dim }}
          iconType="circle"
          iconSize={6}
        />

        {/* Bandas semitransparentes por ventana */}
        {windowBands.map(({ key, x1, x2, color }, i) => (
          <ReferenceArea
            key={`band-${i}-${key}`}
            x1={x1}
            x2={x2}
            fill={color}
            fillOpacity={0.07}
            stroke={color}
            strokeOpacity={0.25}
            strokeWidth={1}
            ifOverflow="visible"
          />
        ))}

        {/* Línea de inicio de ventana con label */}
        {windowBands.map(({ key, x1, color }, i) => (
          <ReferenceLine
            key={`line-${i}-${key}`}
            x={x1}
            stroke={color}
            strokeDasharray="5 3"
            strokeWidth={1.5}
            strokeOpacity={0.9}
            label={{
              value: key,
              position: "insideTopRight",
              fontSize: 8,
              fill: color,
              fontWeight: 700,
            }}
          />
        ))}

        <Line
          type="monotone"
          dataKey="yes_price"
          name="YES (UP)"
          stroke={C.green}
          dot={false}
          strokeWidth={1.5}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="no_price"
          name="NO (DOWN)"
          stroke={C.red}
          dot={false}
          strokeWidth={1.5}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Gráfico: heatmap de volumen por hora ─────────────────────────────────────

function VolumeHeatmap({ data, loading }) {
  if (loading) return <div style={{ color: C.dim, fontSize: 10, padding: 20 }}>Cargando…</div>;
  if (!data.length) return <div style={{ color: "#333", fontSize: 10, padding: 20 }}>Sin datos de velas.</div>;

  const maxVol = Math.max(...data.map(d => parseFloat(d.avg_volume_btc || 0)));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#0a0a18" />
        <XAxis
          dataKey="hour_utc"
          tickFormatter={h => `${String(h).padStart(2, "0")}h`}
          tick={{ fontSize: 8, fill: "#444" }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={v => `${v.toFixed(0)}`}
          tick={{ fontSize: 8, fill: "#444" }}
          width={40}
          tickLine={false}
          label={{ value: "BTC", angle: -90, position: "insideLeft", fontSize: 8, fill: "#333" }}
        />
        <Tooltip
          formatter={(v, name) => [
            name === "avg_volume_btc" ? `${Number(v).toFixed(1)} BTC` : fmtUSD(v),
            name === "avg_volume_btc" ? "Vol. medio" : "Vol. USDT",
          ]}
          contentStyle={{ background: "#050510", border: `1px solid ${C.border}`, fontSize: 10 }}
        />
        <Bar dataKey="avg_volume_btc" name="avg_volume_btc" maxBarSize={20}>
          {data.map((entry, i) => {
            const intensity = maxVol > 0 ? parseFloat(entry.avg_volume_btc || 0) / maxVol : 0;
            const r = Math.round(0   + intensity * 68);
            const g = Math.round(136 + intensity * 119);
            const b = Math.round(255 - intensity * 200);
            return <Cell key={i} fill={`rgb(${r},${g},${b})`} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Tabla: odds por ventana ───────────────────────────────────────────────────

function WindowOddsTable({ data, loading }) {
  if (loading) return <div style={{ color: C.dim, fontSize: 10, padding: 20 }}>Cargando…</div>;
  if (!data.length) return <div style={{ color: "#333", fontSize: 10, padding: 20 }}>Sin datos de ventanas.</div>;

  const cols = [
    { key: "ventana",       label: "VENTANA",       fmt: v => v },
    { key: "muestras",      label: "MUESTRAS",      fmt: v => Number(v).toLocaleString() },
    { key: "avg_yes_price", label: "YES MEDIO",     fmt: v => fmtOdds(v) },
    { key: "avg_no_price",  label: "NO MEDIO",      fmt: v => fmtOdds(v) },
    { key: "min_yes_price", label: "YES MIN",       fmt: v => fmtOdds(v) },
    { key: "max_yes_price", label: "YES MAX",       fmt: v => fmtOdds(v) },
    { key: "std_yes_price", label: "YES STD",       fmt: v => v != null ? (parseFloat(v) * 100).toFixed(2) + "%" : "—" },
  ];

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                textAlign: "left", padding: "6px 12px",
                color: "#444", fontSize: 8, letterSpacing: "0.12em",
                borderBottom: `1px solid ${C.border}`,
              }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data
            .filter(r => !r.simulado)
            .sort((a, b) => VENTANA_ORDER.indexOf(a.ventana) - VENTANA_ORDER.indexOf(b.ventana))
            .map((row, i) => (
              <tr key={i} style={{ borderBottom: `1px solid #05050f` }}>
                {cols.map(c => (
                  <td key={c.key} style={{
                    padding: "6px 12px",
                    color: c.key === "ventana"
                      ? VENTANA_COLORS[row.ventana] || C.dim
                      : "#ccc",
                    fontWeight: c.key === "ventana" ? 700 : 400,
                  }}>
                    {c.fmt(row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tabla: historial de velas ─────────────────────────────────────────────────

function CandleTable({ data, loading }) {
  if (loading) return <div style={{ color: C.dim, fontSize: 10, padding: 20 }}>Cargando…</div>;
  if (!data.length) return <div style={{ color: "#333", fontSize: 10, padding: 20 }}>Sin datos de velas.</div>;

  return (
    <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
        <thead style={{ position: "sticky", top: 0, background: C.bg }}>
          <tr>
            {["FECHA", "HORA UTC", "OPEN", "HIGH", "LOW", "CLOSE", "VOL BTC", "VOL USDT", "TRADES", "RANGO"].map(h => (
              <th key={h} style={{
                textAlign: "left", padding: "6px 10px",
                color: "#444", fontSize: 8, letterSpacing: "0.12em",
                borderBottom: `1px solid ${C.border}`,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const range = row.high_price && row.low_price
              ? (parseFloat(row.high_price) - parseFloat(row.low_price)).toFixed(0)
              : "—";
            const isGreen = row.close_price && row.open_price
              && parseFloat(row.close_price) >= parseFloat(row.open_price);
            return (
              <tr key={i} style={{ borderBottom: `1px solid #05050f` }}>
                <td style={{ padding: "5px 10px", color: "#888" }}>{row.fecha}</td>
                <td style={{ padding: "5px 10px", color: C.dim }}>{String(row.hour_utc).padStart(2, "0")}:00</td>
                <td style={{ padding: "5px 10px", color: C.yellow, fontWeight: 600 }}>${Number(row.open_price).toLocaleString()}</td>
                <td style={{ padding: "5px 10px", color: C.green }}>{row.high_price ? `$${Number(row.high_price).toLocaleString()}` : "—"}</td>
                <td style={{ padding: "5px 10px", color: C.red   }}>{row.low_price  ? `$${Number(row.low_price).toLocaleString()}`  : "—"}</td>
                <td style={{ padding: "5px 10px", color: isGreen ? C.green : C.red }}>
                  {row.close_price ? `$${Number(row.close_price).toLocaleString()}` : "—"}
                </td>
                <td style={{ padding: "5px 10px", color: "#ccc" }}>{row.volume_btc ? Number(row.volume_btc).toFixed(1) : "—"}</td>
                <td style={{ padding: "5px 10px", color: "#888" }}>{row.volume_usdt ? `$${Number(row.volume_usdt / 1e6).toFixed(1)}M` : "—"}</td>
                <td style={{ padding: "5px 10px", color: "#666" }}>{row.trades_count ? Number(row.trades_count).toLocaleString() : "—"}</td>
                <td style={{ padding: "5px 10px", color: "#888" }}>{range !== "—" ? `$${range}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ◈ AI ANÁLISIS — Módulo 1: Diagnóstico Inteligente
// ─────────────────────────────────────────────────────────────────────────────

const LS_AI_KEY    = "polybot_ai_analysis_v1";
const AI_CACHE_TTL = 5 * 60 * 1000;

const ESTADO_META = {
  ÓPTIMO:     { color: "#00ff88", emoji: "◆" },
  BUENO:      { color: "#00ff88", emoji: "●" },
  NEUTRO:     { color: "#ffcc00", emoji: "◐" },
  PRECAUCIÓN: { color: "#ff8800", emoji: "▲" },
  CRÍTICO:    { color: "#ff3355", emoji: "✕" },
};

const TENDENCIA_META = {
  MEJORANDO:    { color: "#00ff88", icon: "↑" },
  ESTABLE:      { color: "#ffcc00", icon: "→" },
  DETERIORANDO: { color: "#ff3355", icon: "↓" },
};

const ALERTA_COLOR = { ALTA: "#ff3355", MEDIA: "#ff8800", BAJA: "#ffcc00" };
const OPO_COLOR    = { ALTO: "#00ff88", MEDIO: "#4488ff", BAJO: "#666" };

function saveAICache(data, key) {
  try {
    const store = JSON.parse(localStorage.getItem(LS_AI_KEY) || "{}");
    store[key] = { data, ts: Date.now() };
    localStorage.setItem(LS_AI_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
}

function loadAICache(key) {
  try {
    const store = JSON.parse(localStorage.getItem(LS_AI_KEY) || "{}");
    const entry = store[key];
    if (entry && (Date.now() - entry.ts) < AI_CACHE_TTL) return entry.data;
  } catch { /* ignore */ }
  return null;
}

function AIBadge({ text, color, small }) {
  return (
    <span style={{
      display: "inline-block",
      background: `${color}18`, border: `1px solid ${color}44`,
      color, fontSize: small ? 8 : 9, padding: small ? "1px 5px" : "2px 7px",
      borderRadius: 3, letterSpacing: "0.1em", fontWeight: 700,
    }}>{text}</span>
  );
}

function AIScoreDial({ score }) {
  if (score == null) return null;
  const color = score >= 75 ? "#00ff88" : score >= 50 ? "#ffcc00" : score >= 30 ? "#ff8800" : "#ff3355";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%",
        border: `3px solid ${color}`, boxShadow: `0 0 12px ${color}44`,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: `${color}08`,
      }}>
        <span style={{ fontSize: 16, fontWeight: 900, color, lineHeight: 1 }}>{score}</span>
      </div>
      <span style={{ fontSize: 7, color: "#555", letterSpacing: "0.15em" }}>SCORE</span>
    </div>
  );
}

function AIMiniCard({ label, value, sub, color = "#ccc" }) {
  return (
    <div style={{
      background: "#02020e", border: "1px solid #0d0d1a",
      padding: "9px 13px", borderRadius: 4, flex: 1, minWidth: 85,
    }}>
      <div style={{ fontSize: 8, color: "#555", letterSpacing: "0.15em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 8, color: "#333", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function AIVentanaTag({ v }) {
  const colors = { T20: "#4488ff", T15: "#ffcc00", T10: "#ff8800", T5: "#ff3355" };
  const c = colors[v] ?? "#aaa";
  return (
    <span style={{
      display: "inline-block",
      background: `${c}20`, border: `1px solid ${c}55`,
      color: c, fontSize: 9, padding: "2px 6px",
      borderRadius: 3, fontWeight: 700, letterSpacing: "0.1em",
    }}>{v}</span>
  );
}

function AIHorasGrid({ optimas = [], evitar = [] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 3 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const isOpt = optimas.includes(h);
        const isEv  = evitar.includes(h);
        return (
          <div key={h} style={{
            background: isOpt ? "#00ff8818" : isEv ? "#ff335518" : "#02020e",
            border: `1px solid ${isOpt ? "#00ff8844" : isEv ? "#ff335530" : "#0d0d1a"}`,
            borderRadius: 3, padding: "4px 2px", textAlign: "center",
          }}>
            <div style={{ fontSize: 8, color: isOpt ? "#00ff88" : isEv ? "#ff3355" : "#333", fontWeight: isOpt || isEv ? 700 : 400 }}>
              {String(h).padStart(2, "0")}h
            </div>
            {isOpt && <div style={{ fontSize: 6, color: "#00ff88" }}>▲</div>}
            {isEv  && <div style={{ fontSize: 6, color: "#ff3355" }}>▼</div>}
          </div>
        );
      })}
    </div>
  );
}

function AIAnalysis() {
  const [simFilter, setSimFilter] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [result,    setResult]    = useState(null);
  const [activeTab, setActiveTab] = useState("diagnostico");

  useEffect(() => {
    const cached = loadAICache(simFilter ?? "all");
    if (cached) setResult(cached);
    else setResult(null);
  }, [simFilter]);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = simFilter != null
        ? `/api/ai-analysis?simulated=${simFilter}`
        : `/api/ai-analysis`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      saveAICache(data, simFilter ?? "all");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [simFilter]);

  const { analysis, meta } = result ?? {};
  const estadoMeta = ESTADO_META[analysis?.estado] ?? ESTADO_META.NEUTRO;
  const tendMeta   = TENDENCIA_META[analysis?.tendencia?.direccion] ?? TENDENCIA_META.ESTABLE;

  const AI_TABS = [
    { key: "diagnostico",     label: "DIAGNÓSTICO"    },
    { key: "recomendaciones", label: "ACCIONES"       },
    { key: "horas",           label: "MAPA DE HORAS"  },
  ];

  return (
    <div style={{ background: "#010108", borderBottom: "1px solid #0d0d1a" }}>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 24px", borderBottom: "1px solid #0d0d1a", background: "#00050d",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, letterSpacing: "0.25em", color: "#aa66ff", fontWeight: 700 }}>
            ◈ AI DIAGNÓSTICO
          </span>
          {analysis && !loading && (
            <span style={{
              fontSize: 8, color: estadoMeta.color, letterSpacing: "0.12em",
              background: `${estadoMeta.color}15`, border: `1px solid ${estadoMeta.color}44`,
              padding: "2px 7px", borderRadius: 3, fontWeight: 700,
            }}>
              {estadoMeta.emoji} {analysis.estado}
            </span>
          )}
          {meta && (
            <span style={{ fontSize: 8, color: "#2a2a3a" }}>
              {new Date(meta.generated_at).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          {[
            { val: null,    label: "TODOS" },
            { val: "true",  label: "SIM"   },
            { val: "false", label: "REAL"  },
          ].map(({ val, label }) => (
            <button key={label} onClick={() => setSimFilter(val)} style={{
              background: simFilter === val ? "#aa66ff22" : "none",
              border: `1px solid ${simFilter === val ? "#aa66ff" : "#1a1a2e"}`,
              color: simFilter === val ? "#aa66ff" : "#444",
              fontSize: 8, padding: "3px 8px", cursor: "pointer",
              fontFamily: "inherit", letterSpacing: "0.1em", borderRadius: 3,
            }}>{label}</button>
          ))}
          <button
            onClick={runAnalysis}
            disabled={loading}
            style={{
              background: loading ? "#0d0d1a" : "#aa66ff22",
              border: `1px solid ${loading ? "#222" : "#aa66ff"}`,
              color: loading ? "#444" : "#aa66ff",
              fontSize: 9, padding: "4px 14px",
              cursor: loading ? "default" : "pointer",
              fontFamily: "inherit", letterSpacing: "0.15em", fontWeight: 700,
              borderRadius: 3,
            }}
          >
            {loading ? "ANALIZANDO…" : analysis ? "↻ REANALIZAR" : "◈ ANALIZAR AHORA"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 24px", background: "#ff335508", borderBottom: "1px solid #ff335522" }}>
          <span style={{ fontSize: 9, color: "#ff3355" }}>✕ {error}</span>
        </div>
      )}

      {loading && (
        <div style={{ padding: "28px 24px", textAlign: "center", borderBottom: "1px solid #0d0d1a" }}>
          <style>{`@keyframes ai-spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{
            display: "inline-block", width: 22, height: 22, borderRadius: "50%",
            border: "2px solid #aa66ff33", borderTop: "2px solid #aa66ff",
            animation: "ai-spin 0.8s linear infinite", marginBottom: 10,
          }} />
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em" }}>Consultando datos y generando diagnóstico…</div>
        </div>
      )}

      {!loading && !analysis && !error && (
        <div style={{ padding: "22px 24px", textAlign: "center", borderBottom: "1px solid #0d0d1a" }}>
          <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.15em", marginBottom: 6 }}>SIN ANÁLISIS GENERADO</div>
          <div style={{ fontSize: 9, color: "#1a1a2a" }}>Pulsa "ANALIZAR AHORA" para que la IA diagnostique el rendimiento de tu estrategia</div>
        </div>
      )}

      {!loading && analysis && (
        <>
          <div style={{
            display: "flex", gap: 10, padding: "12px 24px", flexWrap: "wrap",
            borderBottom: "1px solid #0d0d1a", alignItems: "center",
          }}>
            <AIScoreDial score={analysis.score} />
            <AIMiniCard label="OPS"       value={meta?.totalOps ?? "—"}           color="#ccc" sub={meta?.mode} />
            <AIMiniCard label="P&L"       value={meta?.totalPnl != null ? `$${meta.totalPnl.toFixed(2)}` : "—"}
                        color={meta?.totalPnl >= 0 ? "#00ff88" : "#ff3355"} />
            <AIMiniCard label="WIN RATE"  value={meta?.globalWR != null ? `${meta.globalWR}%` : "—"}
                        sub={`${meta?.totalWins ?? 0}W / ${meta?.totalLoss ?? 0}L`}
                        color={parseFloat(meta?.globalWR) >= 55 ? "#00ff88" : parseFloat(meta?.globalWR) >= 45 ? "#ffcc00" : "#ff3355"} />
            <AIMiniCard label="TENDENCIA" value={`${tendMeta.icon} ${analysis.tendencia?.direccion ?? "—"}`}
                        color={tendMeta.color} sub={analysis.tendencia?.analisis?.slice(0, 40) + "…"} />
            {analysis.edge && (
              <AIMiniCard label="EDGE" value={analysis.edge.tiene_edge ? "✓ SÍ" : "✕ NO"}
                          color={analysis.edge.tiene_edge ? "#00ff88" : "#ff3355"}
                          sub={analysis.edge.explicacion?.slice(0, 45) + "…"} />
            )}
          </div>

          <div style={{
            padding: "12px 24px", borderBottom: "1px solid #0d0d1a",
            background: `${estadoMeta.color}06`,
          }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>DIAGNÓSTICO EJECUTIVO</div>
            <p style={{
              fontSize: 11, color: "#bbb", lineHeight: 1.7, margin: 0,
              borderLeft: `3px solid ${estadoMeta.color}`, paddingLeft: 12,
            }}>
              {analysis.resumen}
            </p>
            {analysis.proximos_pasos && (
              <div style={{
                marginTop: 10, padding: "6px 12px",
                background: "#aa66ff10", border: "1px solid #aa66ff33",
                borderRadius: 3, display: "inline-flex", gap: 8, alignItems: "center",
              }}>
                <span style={{ fontSize: 8, color: "#aa66ff", letterSpacing: "0.12em" }}>PRÓXIMO PASO</span>
                <span style={{ fontSize: 10, color: "#888" }}>{analysis.proximos_pasos}</span>
              </div>
            )}
          </div>

          <div style={{ display: "flex", borderBottom: "1px solid #0d0d1a", background: "#00040c", paddingLeft: 24 }}>
            {AI_TABS.map(({ key, label }) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "7px 16px", fontSize: 8, letterSpacing: "0.15em",
                color: activeTab === key ? "#aa66ff" : "#333",
                borderBottom: activeTab === key ? "2px solid #aa66ff" : "2px solid transparent",
                fontFamily: "inherit",
              }}>{label}</button>
            ))}
          </div>

          {activeTab === "diagnostico" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #0d0d1a" }}>
              <div style={{ padding: "16px 24px", borderRight: "1px solid #0d0d1a" }}>
                <SectionTitle>RENDIMIENTO POR VENTANA</SectionTitle>
                {analysis.ventanas && (
                  <>
                    <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 8, color: "#444", marginBottom: 4 }}>MEJOR</div>
                        <AIVentanaTag v={analysis.ventanas.mejor} />
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: "#444", marginBottom: 4 }}>PEOR</div>
                        <AIVentanaTag v={analysis.ventanas.peor} />
                      </div>
                      {analysis.ventanas.ranking?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 8, color: "#444", marginBottom: 4 }}>RANKING</div>
                          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                            {analysis.ventanas.ranking.map((v, i) => (
                              <span key={v} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                {i > 0 && <span style={{ color: "#333", fontSize: 8 }}>›</span>}
                                <AIVentanaTag v={v} />
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: "#555", lineHeight: 1.6, margin: 0 }}>
                      {analysis.ventanas.analisis}
                    </p>
                  </>
                )}
              </div>
              <div style={{ padding: "16px 24px" }}>
                <SectionTitle>SESGO DIRECCIONAL</SectionTitle>
                {analysis.direccion && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <AIBadge
                        text={analysis.direccion.sesgo}
                        color={analysis.direccion.sesgo === "UP" ? "#00ff88" : analysis.direccion.sesgo === "DOWN" ? "#ff3355" : "#ffcc00"}
                      />
                      {analysis.direccion.confianza && (
                        <AIBadge text={`CONFIANZA ${analysis.direccion.confianza}`} color="#555" small />
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: "#555", lineHeight: 1.6, margin: 0 }}>
                      {analysis.direccion.analisis}
                    </p>
                  </div>
                )}
                <SectionTitle>ALERTAS ACTIVAS</SectionTitle>
                {!analysis.alertas?.length
                  ? <span style={{ fontSize: 9, color: "#2a2a3a" }}>Sin alertas activas</span>
                  : analysis.alertas.map((a, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "flex-start", gap: 8,
                      padding: "6px 10px", marginBottom: 5,
                      background: `${ALERTA_COLOR[a.nivel] ?? "#666"}08`,
                      border: `1px solid ${ALERTA_COLOR[a.nivel] ?? "#666"}22`,
                      borderRadius: 3,
                    }}>
                      <AIBadge text={a.nivel} color={ALERTA_COLOR[a.nivel] ?? "#666"} small />
                      <span style={{ fontSize: 10, color: "#666", lineHeight: 1.5 }}>{a.mensaje}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          )}

          {activeTab === "recomendaciones" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #0d0d1a" }}>
              <div style={{ padding: "16px 24px", borderRight: "1px solid #0d0d1a" }}>
                <SectionTitle>RECOMENDACIONES PRIORITARIAS</SectionTitle>
                {analysis.recomendaciones?.sort((a, b) => (a.prioridad ?? 99) - (b.prioridad ?? 99)).map((r, i) => (
                  <div key={i} style={{
                    padding: "10px 14px", marginBottom: 8,
                    background: "#030316", border: "1px solid #0d0d1a",
                    borderLeft: `3px solid ${i === 0 ? "#00ff88" : i === 1 ? "#ffcc00" : "#333"}`,
                    borderRadius: "0 4px 4px 0",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 8, color: "#444" }}>#{r.prioridad ?? i + 1}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#ccc", letterSpacing: "0.05em" }}>{r.accion}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#555", lineHeight: 1.6 }}>{r.detalle}</div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "16px 24px" }}>
                <SectionTitle>OPORTUNIDADES DETECTADAS</SectionTitle>
                {!analysis.oportunidades?.length
                  ? <span style={{ fontSize: 9, color: "#2a2a3a" }}>Sin oportunidades destacadas</span>
                  : analysis.oportunidades.map((o, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "flex-start", gap: 8,
                      padding: "6px 10px", marginBottom: 5,
                      background: `${OPO_COLOR[o.impacto] ?? "#666"}08`,
                      border: `1px solid ${OPO_COLOR[o.impacto] ?? "#666"}22`,
                      borderRadius: 3,
                    }}>
                      <AIBadge text={o.impacto} color={OPO_COLOR[o.impacto] ?? "#666"} small />
                      <span style={{ fontSize: 10, color: "#666", lineHeight: 1.5 }}>{o.mensaje}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          )}

          {activeTab === "horas" && (
            <div style={{ padding: "16px 24px", borderBottom: "1px solid #0d0d1a" }}>
              <SectionTitle>MAPA DE RENDIMIENTO POR HORA UTC</SectionTitle>
              <div style={{ marginBottom: 10, display: "flex", gap: 16 }}>
                <span style={{ fontSize: 9, color: "#444" }}>
                  ▲ <span style={{ color: "#00ff88" }}>Horas óptimas</span>
                  {analysis.horas_optimas?.length ? ` · ${analysis.horas_optimas.join(", ")}h UTC` : ""}
                </span>
                <span style={{ fontSize: 9, color: "#444" }}>
                  ▼ <span style={{ color: "#ff3355" }}>Horas a evitar</span>
                  {analysis.horas_evitar?.length ? ` · ${analysis.horas_evitar.join(", ")}h UTC` : ""}
                </span>
              </div>
              <AIHorasGrid optimas={analysis.horas_optimas ?? []} evitar={analysis.horas_evitar ?? []} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Componente principal DataLab ──────────────────────────────────────────────

export default function DataLab() {
  const [selectedDate, setSelectedDate]     = useState("");
  const [selectedHour, setSelectedHour]     = useState("");
  const [availableDates, setAvailableDates] = useState([]);

  const [tokenPrices,  setTokenPrices]  = useState([]);
  const [candleData,   setCandleData]   = useState([]);
  const [windowStats,  setWindowStats]  = useState([]);
  const [hoursHeatmap, setHoursHeatmap] = useState([]);

  const [loadingTokens,  setLoadingTokens]  = useState(false);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [loadingWindow,  setLoadingWindow]  = useState(false);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);

  useEffect(() => {
    fetch("/api/datalab?type=available_dates")
      .then(r => r.json())
      .then(({ dates }) => {
        if (dates?.length) {
          setAvailableDates(dates);
          setSelectedDate(dates[0]);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    setLoadingWindow(true);
    fetch("/api/datalab?type=window_stats")
      .then(r => r.json())
      .then(({ data }) => setWindowStats(data || []))
      .catch(console.error)
      .finally(() => setLoadingWindow(false));

    setLoadingHeatmap(true);
    fetch("/api/datalab?type=hours_heatmap")
      .then(r => r.json())
      .then(({ data }) => setHoursHeatmap(data || []))
      .catch(console.error)
      .finally(() => setLoadingHeatmap(false));

    setLoadingCandles(true);
    fetch("/api/datalab?type=candle_data&limit=168")
      .then(r => r.json())
      .then(({ data }) => setCandleData(data || []))
      .catch(console.error)
      .finally(() => setLoadingCandles(false));
  }, []);

  const loadTokenPrices = useCallback(() => {
    if (!selectedDate) return;
    setLoadingTokens(true);

    let url = `/api/datalab?type=token_prices&fecha=${selectedDate}&limit=2000`;
    if (selectedHour !== "") url += `&hour=${selectedHour}`;

    fetch(url)
      .then(r => r.json())
      .then(({ data }) => setTokenPrices(data || []))
      .catch(console.error)
      .finally(() => setLoadingTokens(false));
  }, [selectedDate, selectedHour]);

  useEffect(() => { loadTokenPrices(); }, [loadTokenPrices]);

  const dayStats = (() => {
    if (!tokenPrices.length) return null;
    const yes = tokenPrices.filter(r => r.yes_price != null).map(r => parseFloat(r.yes_price));
    const no  = tokenPrices.filter(r => r.no_price  != null).map(r => parseFloat(r.no_price));
    const inWindow = tokenPrices.filter(r => r.ventana).length;
    return {
      muestras:   tokenPrices.length,
      enVentana:  inWindow,
      yesMin:     Math.min(...yes),
      yesMax:     Math.max(...yes),
      yesMean:    yes.reduce((a, b) => a + b, 0) / yes.length,
      noMin:      Math.min(...no),
      noMax:      Math.max(...no),
    };
  })();

  return (
    <div style={{ fontFamily: "monospace", color: "#ccc", minHeight: "100vh" }}>

      <AIAnalysis />

      <div style={{
        padding: "16px 24px",
        borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 9, color: C.dim, letterSpacing: "0.2em" }}>DATA LAB</span>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#333" }}>FECHA</span>
          <DateSelector
            dates={availableDates}
            selected={selectedDate}
            onChange={setSelectedDate}
          />

          <span style={{ fontSize: 9, color: "#333" }}>HORA UTC</span>
          <HourSelector selected={selectedHour} onChange={setSelectedHour} />

          <button
            onClick={loadTokenPrices}
            style={{
              background: "none", border: `1px solid ${C.border}`,
              color: C.green, fontSize: 9, padding: "4px 12px",
              cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em",
            }}
          >
            ↻ REFRESCAR
          </button>
        </div>
      </div>

      {dayStats && (
        <div style={{
          display: "flex", gap: 12, padding: "16px 24px", flexWrap: "wrap",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <StatCard label="MUESTRAS"   value={dayStats.muestras.toLocaleString()} color={C.dim} />
          <StatCard label="EN VENTANA" value={dayStats.enVentana.toLocaleString()} color={C.yellow} />
          <StatCard label="YES MIN"    value={fmtOdds(dayStats.yesMin)} color={C.green} />
          <StatCard label="YES MAX"    value={fmtOdds(dayStats.yesMax)} color={C.green} />
          <StatCard label="YES MEDIO"  value={fmtOdds(dayStats.yesMean)} color={C.green} sub="(día seleccionado)" />
          <StatCard label="NO MIN"     value={fmtOdds(dayStats.noMin)} color={C.red} />
          <StatCard label="NO MAX"     value={fmtOdds(dayStats.noMax)} color={C.red} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>

        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <SectionTitle>EVOLUCIÓN PRECIO TOKENS YES / NO · {selectedDate}{selectedHour !== "" ? ` · ${String(selectedHour).padStart(2, "0")}:00 UTC` : ""}</SectionTitle>
          <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
            Las bandas coloreadas y líneas verticales indican inicio/fin de cada ventana de entrada (T-20, T-15, T-10, T-5).
            {tokenPrices.length > 0 && (
              <span style={{ color: "#555", marginLeft: 8 }}>
                {tokenPrices.length} puntos · throttle 30s
              </span>
            )}
          </div>
          {/* Leyenda de ventanas */}
          <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            {WINDOWS_DEF.map(w => (
              <div key={w.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{
                  width: 12, height: 12, borderRadius: 2,
                  background: `${w.color}20`, border: `1px solid ${w.color}66`,
                }} />
                <span style={{ fontSize: 8, color: w.color, fontWeight: 700 }}>{w.key}</span>
                <span style={{ fontSize: 8, color: "#333" }}>
                  ({w.min}–{w.max} min antes del cierre)
                </span>
              </div>
            ))}
          </div>
          <TokenPriceChart data={tokenPrices} loading={loadingTokens} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${C.border}` }}>

          <div style={{ padding: "20px 24px", borderRight: `1px solid ${C.border}` }}>
            <SectionTitle>ODDS MEDIAS POR VENTANA DE ENTRADA</SectionTitle>
            <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
              Estadísticas históricas de precio YES/NO en cada ventana. Base para calibrar umbrales.
            </div>
            <WindowOddsTable data={windowStats} loading={loadingWindow} />
          </div>

          <div style={{ padding: "20px 24px" }}>
            <SectionTitle>VOLUMEN MEDIO BTC POR HORA UTC</SectionTitle>
            <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
              Intensidad de color = mayor volumen relativo. Útil para identificar horas de alta liquidez.
            </div>
            <VolumeHeatmap data={hoursHeatmap} loading={loadingHeatmap} />

            {!loadingHeatmap && hoursHeatmap.length > 0 && (
              <div style={{ marginTop: 16, overflowX: "auto", maxHeight: 200, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                  <thead>
                    <tr>
                      {["HORA", "VELAS", "VOL BTC", "VOL USDT", "TRADES", "RANGO $", "RANGO %"].map(h => (
                        <th key={h} style={{ textAlign: "left", padding: "4px 8px", color: "#333", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {hoursHeatmap.map((row, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid #05050f" }}>
                        <td style={{ padding: "4px 8px", color: C.blue }}>{String(row.hour_utc).padStart(2, "0")}h</td>
                        <td style={{ padding: "4px 8px", color: "#666" }}>{row.velas}</td>
                        <td style={{ padding: "4px 8px", color: "#ccc" }}>{Number(row.avg_volume_btc).toFixed(1)}</td>
                        <td style={{ padding: "4px 8px", color: "#888" }}>${Number(row.avg_volume_usdt / 1e6).toFixed(1)}M</td>
                        <td style={{ padding: "4px 8px", color: "#666" }}>{Number(row.avg_trades).toLocaleString()}</td>
                        <td style={{ padding: "4px 8px", color: C.yellow }}>${Number(row.avg_range_usd).toFixed(0)}</td>
                        <td style={{ padding: "4px 8px", color: "#888" }}>{Number(row.avg_range_pct).toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "20px 24px" }}>
          <SectionTitle>HISTORIAL VELAS 1H BTC · ÚLTIMAS 7 DÍAS</SectionTitle>
          <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
            Datos completos de Binance: open/high/low/close, volumen BTC y USDT, número de trades.
          </div>
          <CandleTable data={candleData} loading={loadingCandles} />
        </div>

      </div>
    </div>
  );
}
