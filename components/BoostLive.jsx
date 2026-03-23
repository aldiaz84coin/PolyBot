"use client";
/**
 * components/BoostLive.jsx — v1.0
 * Panel en tiempo real de lecturas BoostPower del Algoritmo A (Crypto Detector v4).
 * Se ubica junto a la señal en el dashboard para correlacionar tendencia con decisión.
 * Hace polling a /api/boost cada 30s.
 */
import { useState, useEffect, useCallback } from "react";

const POLL_MS = 30_000;

const WINDOW_COLORS = {
  "T-20":          "#4488ff",
  "T-15":          "#aa44ff",
  "T-10":          "#ff8800",
  "T-5":           "#ff4466",
  "MITAD HORA":    "#4488ff",
  "NUEVO MERCADO": "#00ff88",
};

function boostColor(v) {
  if (v == null) return "#2a2a3a";
  if (v >= 0.6)  return "#00ff88";
  if (v >= 0.4)  return "#88ff44";
  if (v >= 0.25) return "#ffcc00";
  if (v >= 0.1)  return "#ff8800";
  return "#ff4466";
}

function boostLabel(v) {
  if (v == null)  return "—";
  if (v >= 0.6)   return "INVERTIBLE";
  if (v >= 0.35)  return "APAL.";
  return "RUIDOSO";
}

function fmtTs(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("es-ES", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch { return "—"; }
}

// ── Fila de una lectura ───────────────────────────────────────────────────────

function BoostRow({ label, value, ts, slug, isWindow }) {
  const color    = boostColor(value);
  const pct      = value != null ? Math.min(Math.max(value, 0), 1) * 100 : 0;
  const wColor   = WINDOW_COLORS[label] || "#4488ff";
  const hasValue = value != null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "90px 1fr 52px 64px",
      alignItems: "center",
      gap: 8,
      padding: "5px 0",
      borderBottom: "1px solid #06060f",
    }}>
      {/* Etiqueta */}
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
        color: isWindow ? wColor : "#888",
      }}>
        {label}
      </span>

      {/* Barra + valor */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{
          height: 4, background: "#08080f", borderRadius: 2, overflow: "hidden",
        }}>
          <div style={{
            width: `${pct}%`, height: "100%",
            background: hasValue ? color : "transparent",
            borderRadius: 2, transition: "width 0.5s ease",
          }} />
        </div>
        {slug && (
          <span style={{ fontSize: 7, color: "#2a2a3a", letterSpacing: "0.08em" }}>
            {slug.split("-").slice(-3).join("-")}
          </span>
        )}
      </div>

      {/* Valor numérico */}
      <span style={{
        fontSize: 12, fontWeight: 700, color: hasValue ? color : "#2a2a3a",
        textAlign: "right", fontVariantNumeric: "tabular-nums",
      }}>
        {hasValue ? value.toFixed(3) : "—"}
      </span>

      {/* Timestamp */}
      <span style={{
        fontSize: 8, color: "#2a2a3a", textAlign: "right",
        letterSpacing: "0.06em",
      }}>
        {fmtTs(ts)}
      </span>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function BoostLive() {
  const [readings, setReadings] = useState([]);
  const [lastPoll, setLastPoll] = useState(null);
  const [error,    setError]    = useState(false);

  const fetchBoost = useCallback(async () => {
    try {
      const res  = await fetch("/api/boost");
      if (!res.ok) { setError(true); return; }
      const data = await res.json();
      if (data.ok && Array.isArray(data.readings)) {
        setReadings(data.readings);
        setLastPoll(new Date());
        setError(false);
      }
    } catch { setError(true); }
  }, []);

  useEffect(() => {
    fetchBoost();
    const id = setInterval(fetchBoost, POLL_MS);
    return () => clearInterval(id);
  }, [fetchBoost]);

  const WINDOW_KEYS = new Set(["T-20", "T-15", "T-10", "T-5"]);

  // Separar en: contextuales (nuevo mercado + mitad hora) y de ventana
  const contextReadings = readings.filter(r => !WINDOW_KEYS.has(r.label));
  const windowReadings  = readings.filter(r =>  WINDOW_KEYS.has(r.label));

  // Último valor de ventana con dato (el más reciente)
  const latestWindow = [...windowReadings].reverse().find(r => r.value != null);

  return (
    <div style={{
      padding: "14px 16px",
      background: "#03030c",
      height: "100%",
      boxSizing: "border-box",
    }}>

      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
          BOOST POWER · TENDENCIA BTC
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {latestWindow && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: boostColor(latestWindow.value),
              letterSpacing: "0.08em",
            }}>
              {boostLabel(latestWindow.value)}
            </span>
          )}
          {error && (
            <span style={{ fontSize: 8, color: "#ff4466" }}>SIN DATOS</span>
          )}
          {lastPoll && !error && (
            <span style={{ fontSize: 8, color: "#2a2a3a" }}>
              ↻ {fmtTs(lastPoll.toISOString())}
            </span>
          )}
        </div>
      </div>

      {readings.length === 0 ? (
        <div style={{ fontSize: 9, color: "#2a2a3a", paddingTop: 8 }}>
          {error
            ? "Error conectando con /api/boost — configura BOOST_POWER_URL en Railway"
            : "Esperando lecturas del bot…"}
        </div>
      ) : (
        <>
          {/* Lecturas contextuales */}
          {contextReadings.map(r => (
            <BoostRow
              key={r.key}
              label={r.label}
              value={r.value}
              ts={r.ts}
              slug={r.slug}
              isWindow={false}
            />
          ))}

          {/* Separador */}
          {contextReadings.length > 0 && windowReadings.length > 0 && (
            <div style={{ height: 6 }} />
          )}

          {/* Lecturas de ventana */}
          {windowReadings.map(r => (
            <BoostRow
              key={r.key}
              label={r.label}
              value={r.value}
              ts={r.ts}
              isWindow={true}
            />
          ))}

          {/* Leyenda compacta */}
          <div style={{
            display: "flex", gap: 12, marginTop: 10,
            fontSize: 7, color: "#2a2a3a", letterSpacing: "0.08em",
          }}>
            {[
              { label: "INVERTIBLE ≥0.60", color: "#00ff88" },
              { label: "APAL. 0.35–0.59",  color: "#ffcc00" },
              { label: "RUIDOSO <0.35",     color: "#ff4466" },
            ].map(({ label, color }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
