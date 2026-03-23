"use client";
/**
 * components/BoostLive.jsx — v1.1
 *
 * CAMBIOS v1.1:
 *   - Muestra valor LIVE directo del Crypto Detector (via /api/boost)
 *     en la parte superior, siempre visible aunque el bot no haya
 *     escrito en bot_config aún.
 *   - Lecturas del bot por ventana (T-20/15/10/5) debajo, cuando existen.
 *   - Polling cada 30s.
 */
import { useState, useEffect, useCallback } from "react";

const POLL_MS = 30_000;

const WINDOW_COLORS = {
  "T-20":          "#4488ff",
  "T-15":          "#aa44ff",
  "T-10":          "#ff8800",
  "T-5":           "#ff4466",
  "MITAD HORA":    "#5588cc",
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
  if (v >= 0.35)  return "APALANCADO";
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

function BoostRow({ label, value, ts, slug, isWindow }) {
  const color  = boostColor(value);
  const pct    = value != null ? Math.min(Math.max(value, 0), 1) * 100 : 0;
  const wColor = WINDOW_COLORS[label] || "#4488ff";
  const hasVal = value != null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "80px 1fr 52px 58px",
      alignItems: "center",
      gap: 6,
      padding: "4px 0",
      borderBottom: "1px solid #06060f",
    }}>
      <span style={{
        fontSize: 8, fontWeight: 700, letterSpacing: "0.12em",
        color: isWindow ? wColor : "#666",
      }}>
        {label}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ height: 3, background: "#08080f", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            width: `${pct}%`, height: "100%",
            background: hasVal ? color : "transparent",
            borderRadius: 2, transition: "width 0.5s ease",
          }} />
        </div>
        {slug && (
          <span style={{ fontSize: 6, color: "#2a2a3a" }}>
            {slug.split("-").slice(-3).join("-")}
          </span>
        )}
      </div>
      <span style={{
        fontSize: 11, fontWeight: 700,
        color: hasVal ? color : "#2a2a3a",
        textAlign: "right", fontVariantNumeric: "tabular-nums",
      }}>
        {hasVal ? value.toFixed(3) : "—"}
      </span>
      <span style={{ fontSize: 7, color: "#2a2a3a", textAlign: "right" }}>
        {fmtTs(ts)}
      </span>
    </div>
  );
}

export default function BoostLive() {
  const [data,     setData]     = useState(null);
  const [lastPoll, setLastPoll] = useState(null);
  const [error,    setError]    = useState(false);

  const fetchBoost = useCallback(async () => {
    try {
      const res = await fetch("/api/boost");
      if (!res.ok) { setError(true); return; }
      const json = await res.json();
      if (json.ok) {
        setData(json);
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

  const live     = data?.live     ?? null;
  const readings = data?.readings ?? [];

  const WINDOW_KEYS    = new Set(["T-20", "T-15", "T-10", "T-5"]);
  const contextReads   = readings.filter(r => !WINDOW_KEYS.has(r.label));
  const windowReads    = readings.filter(r =>  WINDOW_KEYS.has(r.label));
  const hasAnyBotData  = readings.some(r => r.value != null);

  const bpColor = boostColor(live?.value);

  return (
    <div style={{
      padding: "14px 16px",
      background: "#03030c",
      height: "100%",
      boxSizing: "border-box",
    }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
          BOOST POWER · TENDENCIA BTC
        </div>
        {lastPoll && !error && (
          <span style={{ fontSize: 7, color: "#2a2a3a" }}>
            ↻ {fmtTs(lastPoll.toISOString())}
          </span>
        )}
        {error && (
          <span style={{ fontSize: 7, color: "#ff4466" }}>ERROR</span>
        )}
      </div>

      {/* ── Valor LIVE grande ──────────────────────────────────────────── */}
      {live ? (
        <div style={{
          background: "#05050f",
          border: `1px solid ${bpColor}22`,
          borderRadius: 3,
          padding: "10px 12px",
          marginBottom: 10,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{
              fontSize: 32, fontWeight: 700, lineHeight: 1,
              color: bpColor, fontVariantNumeric: "tabular-nums",
            }}>
              {live.value.toFixed(3)}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{
                fontSize: 10, fontWeight: 700,
                color: bpColor, letterSpacing: "0.10em",
              }}>
                {boostLabel(live.value)}
              </span>
              <span style={{ fontSize: 8, color: "#333", letterSpacing: "0.08em" }}>
                {live.pct?.toFixed(1)}% · {live.mode?.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Barra grande */}
          <div style={{
            height: 4, background: "#08080f", borderRadius: 2,
            overflow: "hidden", marginTop: 8,
          }}>
            <div style={{
              width: `${Math.min(Math.max(live.value, 0), 1) * 100}%`,
              height: "100%", background: bpColor, borderRadius: 2,
              transition: "width 0.6s ease",
            }} />
          </div>

          {/* Métricas de mercado */}
          <div style={{
            display: "flex", gap: 14, marginTop: 8,
            fontSize: 8, color: "#444", letterSpacing: "0.08em",
          }}>
            {live.price != null && (
              <span>BTC <span style={{ color: "#888" }}>
                ${live.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span></span>
            )}
            {live.change24h != null && (
              <span>24h <span style={{
                color: live.change24h >= 0 ? "var(--green, #00ff88)" : "var(--red, #ff4466)",
                fontWeight: 700,
              }}>
                {live.change24h >= 0 ? "+" : ""}{live.change24h.toFixed(2)}%
              </span></span>
            )}
            {live.predictedChange != null && (
              <span>pred <span style={{
                color: live.predictedChange >= 0 ? "var(--green, #00ff88)" : "var(--red, #ff4466)",
                fontWeight: 700,
              }}>
                {live.predictedChange >= 0 ? "+" : ""}{live.predictedChange.toFixed(2)}%
              </span></span>
            )}
            <span style={{ marginLeft: "auto", color: "#2a2a3a" }}>
              {live.cached ? "caché" : "fresh"} · {fmtTs(live.ts)}
            </span>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize: 9, color: "#2a2a3a", padding: "10px 0",
          marginBottom: 8,
        }}>
          {error
            ? "Sin conexión — añade BOOST_POWER_URL en Vercel"
            : "Cargando…"}
        </div>
      )}

      {/* ── Lecturas del bot por momento ───────────────────────────────── */}
      {hasAnyBotData ? (
        <>
          <div style={{
            fontSize: 8, color: "#333", letterSpacing: "0.12em",
            marginBottom: 4,
          }}>
            LECTURAS DEL BOT
          </div>
          {contextReads.map(r => (
            <BoostRow key={r.key} label={r.label} value={r.value}
              ts={r.ts} slug={r.slug} isWindow={false} />
          ))}
          {contextReads.length > 0 && windowReads.length > 0 && (
            <div style={{ height: 4 }} />
          )}
          {windowReads.map(r => (
            <BoostRow key={r.key} label={r.label} value={r.value}
              ts={r.ts} isWindow={true} />
          ))}
        </>
      ) : (
        <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.10em" }}>
          LECTURAS DEL BOT · esperando primera ventana…
        </div>
      )}

      {/* ── Leyenda ────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", gap: 10, marginTop: 10,
        fontSize: 7, color: "#2a2a3a",
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
    </div>
  );
}
