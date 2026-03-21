// components/DataLab.jsx
// DataLab — Pestaña de análisis histórico de precios de tokens y velas BTC
// v1.0 — Series temporales, heatmap de volumen, odds por ventana

"use client";
import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  BarChart, Bar, ResponsiveContainer, ReferenceLine, Cell,
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtTime  = (ts) => ts ? new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const fmtDate  = (ts) => ts ? new Date(ts).toLocaleDateString("es-ES") : "—";
const fmtOdds  = (v)  => v != null ? `${(v * 100).toFixed(1)}%` : "—";
const fmtUSD   = (v)  => v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
const fmtBTC   = (v)  => v != null ? `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} BTC` : "—";

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

function TokenPriceChart({ data, loading }) {
  if (loading) return <div style={{ color: C.dim, fontSize: 10, padding: 20 }}>Cargando datos…</div>;
  if (!data.length) return <div style={{ color: "#333", fontSize: 10, padding: 20 }}>Sin datos para el filtro seleccionado.</div>;

  // Agregar ventanas al dataset y formatear tiempo para el eje X
  const chartData = data.map(row => ({
    ...row,
    time: fmtTime(row.ts),
    yes_price: row.yes_price ? parseFloat(row.yes_price) : null,
    no_price:  row.no_price  ? parseFloat(row.no_price)  : null,
    btc_price: row.btc_price ? parseFloat(row.btc_price) : null,
  }));

  // Encontrar cambios de ventana para añadir líneas de referencia
  const windowChanges = [];
  let prevVentana = null;
  chartData.forEach((row, i) => {
    if (row.ventana && row.ventana !== prevVentana) {
      windowChanges.push({ index: i, ventana: row.ventana, time: row.time });
      prevVentana = row.ventana;
    }
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#0a0a18" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 8, fill: "#444" }}
          interval="preserveStartEnd"
          tickLine={false}
        />
        <YAxis
          domain={[0, 1]}
          tickFormatter={v => `${(v * 100).toFixed(0)}%`}
          tick={{ fontSize: 8, fill: "#444" }}
          width={36}
          tickLine={false}
        />
        <Tooltip content={<TokenTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 9, color: C.dim }}
          iconType="circle"
          iconSize={6}
        />
        {/* Líneas de referencia por cambio de ventana */}
        {windowChanges.map(({ time, ventana }) => (
          <ReferenceLine
            key={`${time}-${ventana}`}
            x={time}
            stroke={VENTANA_COLORS[ventana] || "#333"}
            strokeDasharray="4 4"
            strokeWidth={1}
            label={{
              value: ventana,
              position: "top",
              fontSize: 8,
              fill: VENTANA_COLORS[ventana] || "#333",
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
            .filter(r => !r.simulado) // mostrar solo real por defecto
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

// ── Componente principal DataLab ──────────────────────────────────────────────

export default function DataLab() {
  // Estado de filtros
  const [selectedDate, setSelectedDate]   = useState("");
  const [selectedHour, setSelectedHour]   = useState("");
  const [availableDates, setAvailableDates] = useState([]);

  // Datos
  const [tokenPrices,  setTokenPrices]  = useState([]);
  const [candleData,   setCandleData]   = useState([]);
  const [windowStats,  setWindowStats]  = useState([]);
  const [hoursHeatmap, setHoursHeatmap] = useState([]);

  // Loading
  const [loadingTokens,  setLoadingTokens]  = useState(false);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [loadingWindow,  setLoadingWindow]  = useState(false);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);

  // ── Cargar fechas disponibles ──────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/datalab?type=available_dates")
      .then(r => r.json())
      .then(({ dates }) => {
        if (dates?.length) {
          setAvailableDates(dates);
          setSelectedDate(dates[0]); // fecha más reciente por defecto
        }
      })
      .catch(console.error);
  }, []);

  // ── Cargar stats de ventanas y heatmap (una sola vez) ─────────────────────
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

  // ── Cargar precios de tokens al cambiar filtros ────────────────────────────
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

  // ── Estadísticas rápidas del día seleccionado ──────────────────────────────
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

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "monospace", color: "#ccc", minHeight: "100vh" }}>

      {/* ── HEADER ────────────────────────────────────────────────────────── */}
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

      {/* ── STAT CARDS ────────────────────────────────────────────────────── */}
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

      {/* ── GRID PRINCIPAL ────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>

        {/* Gráfico: evolución de precio de tokens */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <SectionTitle>EVOLUCIÓN PRECIO TOKENS YES / NO · {selectedDate}{selectedHour !== "" ? ` · ${String(selectedHour).padStart(2, "0")}:00 UTC` : ""}</SectionTitle>
          <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
            Las líneas verticales marcadas indican el inicio de cada ventana de entrada.
            {tokenPrices.length > 0 && (
              <span style={{ color: "#555", marginLeft: 8 }}>
                {tokenPrices.length} puntos · throttle 30s
              </span>
            )}
          </div>
          <TokenPriceChart data={tokenPrices} loading={loadingTokens} />
        </div>

        {/* Fila de 2 columnas: odds por ventana + heatmap */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${C.border}` }}>

          {/* Odds por ventana */}
          <div style={{ padding: "20px 24px", borderRight: `1px solid ${C.border}` }}>
            <SectionTitle>ODDS MEDIAS POR VENTANA DE ENTRADA</SectionTitle>
            <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
              Estadísticas históricas de precio YES/NO en cada ventana. Base para calibrar umbrales.
            </div>
            <WindowOddsTable data={windowStats} loading={loadingWindow} />
          </div>

          {/* Heatmap de volumen por hora */}
          <div style={{ padding: "20px 24px" }}>
            <SectionTitle>VOLUMEN MEDIO BTC POR HORA UTC</SectionTitle>
            <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
              Intensidad de color = mayor volumen relativo. Útil para identificar horas de alta liquidez.
            </div>
            <VolumeHeatmap data={hoursHeatmap} loading={loadingHeatmap} />

            {/* Tabla de rango y volumen */}
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

        {/* Historial de velas */}
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
