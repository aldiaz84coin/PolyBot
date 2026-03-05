"use client";

import { WINDOWS } from "../lib/constants";

function Row({ label, value, valueColor = "#aaa", mono = true }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "flex-start",
      padding: "5px 0", borderBottom: "1px solid #0a0a14",
    }}>
      <span style={{ color: "#444", fontSize: 10, letterSpacing: "0.1em", flexShrink: 0, marginRight: 12 }}>
        {label}
      </span>
      <span style={{
        color: valueColor, fontSize: 11,
        fontFamily: mono ? "var(--font)" : "inherit",
        textAlign: "right", wordBreak: "break-all",
      }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function TokenBadge({ label, price, color }) {
  const impliedPct = price != null ? (price * 100).toFixed(1) + "%" : "—";
  return (
    <div style={{
      flex: 1, padding: "10px 12px",
      background: `${color}0d`,
      border: `1px solid ${color}33`,
      borderRadius: 3, textAlign: "center",
    }}>
      <div style={{ fontSize: 9, color: "#555", letterSpacing: "0.12em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>
        {price != null ? `$${price.toFixed(3)}` : "—"}
      </div>
      <div style={{ fontSize: 9, color: "#555", marginTop: 3 }}>
        prob. implícita {impliedPct}
      </div>
    </div>
  );
}

function WindowTimeline({ minsLeft, activeWindow }) {
  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {WINDOWS.map(w => {
          const isActive  = activeWindow?.key === w.key;
          const isPast    = minsLeft < w.min;
          const isFuture  = minsLeft > w.max;
          return (
            <div key={w.key} style={{
              flex: 1, padding: "6px 4px", borderRadius: 3, textAlign: "center",
              background: isActive  ? `${w.color}1a`
                        : isPast    ? "rgba(255,255,255,0.02)"
                        : "rgba(255,255,255,0.04)",
              border: `1px solid ${isActive ? w.color + "55" : "#111122"}`,
              transition: "all 0.3s",
            }}>
              <div style={{
                fontSize: 11, fontWeight: isActive ? 700 : 400,
                color: isActive ? w.color : isPast ? "#222" : "#555",
              }}>
                {w.label}
              </div>
              <div style={{ fontSize: 8, color: isActive ? w.color + "99" : "#2a2a3a", marginTop: 2 }}>
                {w.min}–{w.max}m
              </div>
              {isActive && (
                <div style={{ fontSize: 8, color: w.color, marginTop: 2, animation: "blink 1.2s infinite" }}>
                  ● ACTIVA
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MarketInfo({ market, minsLeft, activeWindow, error }) {
  if (error) {
    return (
      <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>◈ POLYMARKET — MERCADO ACTIVO</div>
        <div style={{ fontSize: 11, color: "var(--red)", padding: "8px 12px", background: "rgba(255,68,102,0.06)", border: "1px solid rgba(255,68,102,0.2)", borderRadius: 3 }}>
          ⚠ {error}
        </div>
      </div>
    );
  }

  if (!market) {
    return (
      <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>◈ POLYMARKET — MERCADO ACTIVO</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#333", fontSize: 11 }}>
          <span style={{ animation: "blink 1s infinite" }}>●</span> Buscando mercado activo...
        </div>
      </div>
    );
  }

  const closeTime = market.end_date_iso
    ? new Date(market.end_date_iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;

  const closeDate = market.end_date_iso
    ? new Date(market.end_date_iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })
    : null;

  const minsDisplay = market.mins_to_close != null
    ? `${Math.floor(market.mins_to_close)}m ${Math.round((market.mins_to_close % 1) * 60)}s`
    : "—";

  return (
    <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>◈ POLYMARKET — MERCADO ACTIVO</span>
          <span style={{
            fontSize: 9, color: "var(--green)", border: "1px solid rgba(0,255,136,0.3)",
            padding: "1px 6px", borderRadius: 2, animation: "pulse 2s infinite",
          }}>
            LIVE
          </span>
        </div>
        {market.url && (
          <a
            href={market.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 10, color: "var(--blue)",
              textDecoration: "none", letterSpacing: "0.08em",
              border: "1px solid rgba(68,136,255,0.3)", padding: "2px 8px", borderRadius: 2,
            }}
          >
            VER EN POLYMARKET ↗
          </a>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Left: market details */}
        <div>
          {/* Question */}
          <div style={{
            fontSize: 12, color: "#c8c8d8", lineHeight: 1.5,
            padding: "8px 12px", background: "rgba(255,255,255,0.03)",
            border: "1px solid #111122", borderRadius: 3, marginBottom: 12,
          }}>
            {market.question || "—"}
          </div>

          <Row label="CIERRE"       value={closeTime ? `${closeDate}  ${closeTime} UTC` : "—"} valueColor="#ffcc00" />
          <Row label="TIEMPO RESTANTE" value={minsDisplay} valueColor={
            minsLeft < 5 ? "var(--red)" : minsLeft < 15 ? "var(--yellow)" : "var(--green)"
          } />
          <Row label="CONDITION ID"
            value={market.condition_id ? market.condition_id.slice(0, 18) + "..." : "—"}
            valueColor="#555"
          />
          {market.volume != null && (
            <Row label="VOLUMEN"     value={`$${Number(market.volume).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} valueColor="#aaa" />
          )}
          {market.liquidity != null && (
            <Row label="LIQUIDEZ"    value={`$${Number(market.liquidity).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} valueColor="#aaa" />
          )}
          <Row label="SLUG" value={market.slug || "—"} valueColor="#333" />
        </div>

        {/* Right: tokens + window timeline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Token prices */}
          <div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.12em", marginBottom: 8 }}>
              PRECIOS DE TOKENS (1 = certeza)
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <TokenBadge
                label="▲ YES (UP)"
                price={market.tokens?.yes?.price}
                color="var(--green)"
              />
              <TokenBadge
                label="▼ NO (DOWN)"
                price={market.tokens?.no?.price}
                color="var(--red)"
              />
            </div>
          </div>

          {/* Window timeline */}
          <div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.12em", marginBottom: 8 }}>
              VENTANAS DE ENTRADA
            </div>
            <WindowTimeline minsLeft={minsLeft} activeWindow={activeWindow} />
          </div>

        </div>
      </div>
    </div>
  );
}
