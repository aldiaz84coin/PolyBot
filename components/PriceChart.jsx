"use client";

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
      {d.target && <div style={{ color: "#ffcc00cc" }}>T: ${d.target?.toFixed(2)}</div>}
    </div>
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

  // ── Dominio Y: incluir siempre el target si existe ───────────────────────
  const prices = data.map(d => d.price).filter(Boolean);
  const allValues = target ? [...prices, target] : prices;
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const padding = Math.max((rawMax - rawMin) * 0.15, 80); // al menos $80 de margen
  const min = Math.floor(rawMin - padding);
  const max = Math.ceil(rawMax + padding);

  // Etiquetas del eje X: ~6 labels distribuidas
  const step = Math.max(1, Math.floor(data.length / 6));

  return (
    <div style={{ height: 140, padding: "12px 0 4px 0" }}>
      <div style={{
        fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em",
        padding: "0 16px", marginBottom: 4,
      }}>
        BTC PRECIO — ÚLTIMOS {data.length * 5}s
        {target && (
          <span style={{ marginLeft: 12, color: "#ffcc0088" }}>
            ── TARGET ${target.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={110}>
        <AreaChart data={data} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#00ff88" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#00ff88" stopOpacity={0}    />
            </linearGradient>
          </defs>

          <XAxis
            dataKey="ts"
            tickFormatter={(v, i) => (i % step === 0 ? v : "")}
            tick={{ fill: "#333", fontSize: 8, fontFamily: "var(--font)" }}
            axisLine={false} tickLine={false}
          />
          <YAxis
            domain={[min, max]}
            tick={{ fill: "#333", fontSize: 8, fontFamily: "var(--font)" }}
            axisLine={false} tickLine={false} width={60}
            tickFormatter={v => `$${v.toLocaleString()}`}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* ── Línea TARGET ───────────────────────────────────────────── */}
          {target && (
            <ReferenceLine
              y={target}
              stroke="#ffcc00"
              strokeOpacity={0.65}
              strokeDasharray="5 3"
              strokeWidth={1.5}
              label={{
                value: `TARGET $${Math.round(target).toLocaleString()}`,
                position: "insideTopRight",
                fill: "#ffcc00bb",
                fontSize: 9,
                fontFamily: "var(--font)",
                dy: -4,
              }}
              ifOverflow="visible"
            />
          )}

          <Area
            type="monotone"
            dataKey="price"
            stroke="#00ff88"
            strokeWidth={1.5}
            fill="url(#priceGrad)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
