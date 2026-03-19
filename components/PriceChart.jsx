"use client";
/**
 * PriceChart.jsx — v2.1
 *
 * FIX v2.1
 *   - Añadida <ReferenceLine y={target}> para dibujar la línea horizontal
 *     del target en la gráfica. Antes se importaba ReferenceLine pero nunca
 *     se renderizaba dentro del <AreaChart>.
 *   - Label flotante del target visible en el extremo derecho de la línea.
 *   - Tooltip mejorado: muestra precio + target si existe.
 *
 * Destino: components/PriceChart.jsx
 */

import {
  AreaChart, Area, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: "#0a0a18", border: "1px solid #1a1a2e",
      padding: "6px 12px", fontSize: 11, fontFamily: "var(--font)",
    }}>
      <div style={{ color: "#aaa" }}>{d.ts}</div>
      <div style={{ color: "var(--green)" }}>${d.price?.toFixed(2)}</div>
      {d.target && <div style={{ color: "#ffcc00" }}>TARGET: ${d.target?.toFixed(2)}</div>}
    </div>
  );
}

// Label personalizado para la ReferenceLine del target
function TargetLabel({ viewBox, value }) {
  if (!viewBox) return null;
  const { x, y, width } = viewBox;
  return (
    <text
      x={x + width - 4}
      y={y - 4}
      fill="#ffcc0099"
      fontSize={9}
      textAnchor="end"
      fontFamily="'JetBrains Mono', monospace"
    >
      TARGET {value}
    </text>
  );
}

export default function PriceChart({ data, target }) {
  if (!data || data.length < 2) {
    return (
      <div style={{
        height: 140, display: "flex", alignItems: "center",
        justifyContent: "center", color: "#1a1a2e", fontSize: 11,
      }}>
        Acumulando datos de precio...
      </div>
    );
  }

  // ── Dominio Y: incluir siempre el target si existe ─────────────────────
  const prices    = data.map(d => d.price).filter(Boolean);
  const allValues = target ? [...prices, target] : prices;
  const rawMin    = Math.min(...allValues);
  const rawMax    = Math.max(...allValues);
  const padding   = Math.max((rawMax - rawMin) * 0.15, 80); // al menos $80
  const domMin    = Math.floor(rawMin - padding);
  const domMax    = Math.ceil(rawMax  + padding);

  // Etiquetas del eje X: ~6 labels distribuidas
  const step = Math.max(1, Math.floor(data.length / 6));

  const targetLabel = target
    ? `$${target.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : null;

  return (
    <div style={{ height: 140, padding: "12px 0 4px 0" }}>
      {/* Header con info del target */}
      <div style={{
        fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em",
        padding: "0 16px", marginBottom: 4,
        display: "flex", gap: 16, alignItems: "center",
      }}>
        <span>BTC PRECIO — ÚLTIMOS {data.length * 5}s</span>
        {target && (
          <span style={{ color: "#ffcc0099" }}>
            ── TARGET {targetLabel}
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={110}>
        <AreaChart data={data} margin={{ top: 8, right: 60, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#00ff88" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#00ff88" stopOpacity={0}    />
            </linearGradient>
          </defs>

          <XAxis
            dataKey="ts"
            tickFormatter={(v, i) => (i % step === 0 ? v : "")}
            tick={{ fontSize: 8, fill: "#1a1a2e" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[domMin, domMax]}
            tick={{ fontSize: 8, fill: "#1a1a2e" }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip content={<CustomTooltip />} />

          <Area
            type="monotone"
            dataKey="price"
            stroke="var(--green)"
            strokeWidth={1.5}
            fill="url(#priceGrad)"
            dot={false}
            activeDot={{ r: 3, fill: "var(--green)" }}
            isAnimationActive={false}
          />

          {/* ── LÍNEA DE TARGET ────────────────────────────────────────── */}
          {target && (
            <ReferenceLine
              y={target}
              stroke="#ffcc00"
              strokeDasharray="5 3"
              strokeOpacity={0.75}
              strokeWidth={1}
              label={<TargetLabel value={targetLabel} />}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
