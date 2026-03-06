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
          const isActive = activeWindow?.key === w.key;
          const isPast   = minsLeft < w.min;

          // Progreso dentro de la ventana activa: 0% al entrar, 100% al salir
          const windowPct = isActive
            ? Math.min(100, Math.max(0, ((w.max - minsLeft) / (w.max - w.min)) * 100))
            : 0;

          // Segundos restantes dentro de la ventana activa
          const secsInWindow = isActive ? Math.max(0, (minsLeft - w.min) * 60) : 0;
          const wMM = String(Math.floor(secsInWindow / 60)).padStart(2, "0");
          const wSS = String(Math.floor(secsInWindow % 60)).padStart(2, "0");

          return (
            <div key={w.key} style={{
              flex: 1,
              borderRadius: 3, textAlign: "center",
              background: isActive  ? `${w.color}1a`
                        : isPast    ? "rgba(255,255,255,0.02)"
                        : "rgba(255,255,255,0.04)",
              border: `1px solid ${isActive ? w.color + "55" : "#111122"}`,
              transition: "all 0.3s",
              overflow: "hidden",
              position: "relative",
            }}>
              {/* Relleno de progreso interno (aparece solo en ventana activa) */}
              {isActive && (
                <div style={{
                  position: "absolute",
                  left: 0, top: 0, bottom: 0,
                  width: `${windowPct}%`,
                  background: `${w.color}1a`,
                  transition: "width 1s linear",
                  pointerEvents: "none",
                }} />
              )}

              <div style={{ padding: "6px 4px", position: "relative", zIndex: 1 }}>
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
                  <>
                    <div style={{ fontSize: 8, color: w.color, marginTop: 2, animation: "blink 1.2s infinite" }}>
                      ● ACTIVA
                    </div>
                    {/* Cuenta atrás dentro de la ventana */}
                    <div style={{
                      fontSize: 10, fontWeight: 700, color: w.color,
                      marginTop: 3, fontVariantNumeric: "tabular-nums",
                      letterSpacing: "0.04em",
                    }}>
                      {wMM}:{wSS}
                    </div>
                  </>
                )}
              </div>

              {/* Barra de progreso inferior de la ventana activa */}
              {isActive && (
                <div style={{
                  height: 3,
                  background: "#0a0a14",
                  position: "relative",
                }}>
                  <div style={{
                    position: "absolute",
                    left: 0, top: 0, bottom: 0,
                    width: `${windowPct}%`,
                    background: w.color,
                    boxShadow: `0 0 6px ${w.color}`,
                    transition: "width 1s linear",
                  }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Sección de diagnóstico compacta, siempre visible */
function DebugBadge({ debug }) {
  if (!debug) return null;
  return (
    <div style={{
      marginTop: 8, padding: "7px 10px",
      background: "#03030c", border: "1px solid #111",
      borderRadius: 3, fontSize: 9, color: "#333", lineHeight: 1.9,
    }}>
      <div style={{ color: "#2a3a4a", letterSpacing: "0.1em", marginBottom: 3 }}>◎ DIAGNÓSTICO SLUG</div>
      <div>
        <span style={{ color: "#444" }}>DST: </span>
        <span style={{ color: "#555" }}>{debug.dst_active ? "EDT (UTC‑4)" : "EST (UTC‑5)"}</span>
        <span style={{ color: "#2a2a3a", margin: "0 6px" }}>|</span>
        <span style={{ color: "#444" }}>UTC now: </span>
        <span style={{ color: "#555" }}>{debug.now_utc?.slice(11, 19)}</span>
      </div>
      {(debug.slugs_all || debug.slugs_tried)?.map((s, i) => (
        <div key={s} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{
            color: s === debug.found_slug ? "var(--green)" : "#2a2a3a",
            fontSize: 8,
          }}>
            {s === debug.found_slug ? "✓" : "·"}
          </span>
          <span style={{ color: s === debug.found_slug ? "#3a5a4a" : "#2a2a3a" }}>{s}</span>
        </div>
      ))}
    </div>
  );
}

export default function MarketInfo({ market, minsLeft, activeWindow, error, apiResponse }) {

  // Estado: error explícito
  if (error) {
    return (
      <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 10 }}>◈ POLYMARKET — MERCADO ACTIVO</div>
        <div style={{ padding: "12px 16px", background: "rgba(255,68,102,0.05)", border: "1px solid rgba(255,68,102,0.2)", borderRadius: 3 }}>
          <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>⚠ {error}</div>
          <div style={{ fontSize: 10, color: "#555", lineHeight: 1.9, marginBottom: 8 }}>
            <span style={{ color: "#444" }}>Posibles causas:</span><br />
            · El slug generado no coincide con el de Polymarket para esta hora<br />
            · El mercado aún no ha sido creado para esta ventana horaria<br />
            · La Gamma API de Polymarket no responde temporalmente
          </div>
          {apiResponse?.slugs_tried && (
            <div style={{ fontSize: 9, lineHeight: 2, color: "#2a2a3a", marginBottom: 6 }}>
              <div style={{ color: "#444", marginBottom: 2 }}>SLUGS PROBADOS:</div>
              {apiResponse.slugs_tried.map(s => (
                <div key={s} style={{ color: "#333", paddingLeft: 8 }}>· {s}</div>
              ))}
            </div>
          )}
          {apiResponse?.errors?.length > 0 && (
            <div style={{ fontSize: 9, lineHeight: 1.8, color: "#2a2a3a", marginBottom: 6 }}>
              <div style={{ color: "#444", marginBottom: 2 }}>ERRORES:</div>
              {apiResponse.errors.map((e, i) => (
                <div key={i} style={{ color: "#333", paddingLeft: 8 }}>· {e.slug?.slice(-20)} → {e.error}</div>
              ))}
            </div>
          )}
          {apiResponse?.dst_active !== undefined && (
            <div style={{ fontSize: 9, color: "#333", marginBottom: 6 }}>
              DST activo: <span style={{ color: "#444" }}>{apiResponse.dst_active
                ? "Sí — EDT (UTC‑4)" : "No — EST (UTC‑5)"}</span>
              <span style={{ margin: "0 6px", color: "#222" }}>|</span>
              UTC: <span style={{ color: "#444" }}>{apiResponse.now_utc?.slice(11,19)}</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href="/api/market/debug" target="_blank" rel="noopener noreferrer"
              style={{
                display: "inline-block", fontSize: 10, color: "var(--blue)",
                border: "1px solid rgba(68,136,255,0.3)", padding: "3px 10px",
                borderRadius: 2, textDecoration: "none",
              }}>
              Ver diagnóstico completo ↗
            </a>
            <a href="/api/market" target="_blank" rel="noopener noreferrer"
              style={{
                display: "inline-block", fontSize: 10, color: "#555",
                border: "1px solid #1a1a2e", padding: "3px 10px",
                borderRadius: 2, textDecoration: "none",
              }}>
              Ver respuesta API ↗
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Estado: cargando
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

  // ── Tiempo restante en vivo ───────────────────────────────────────────────
  const totalSecs   = Math.max(0, minsLeft * 60);
  const mm          = String(Math.floor(totalSecs / 60)).padStart(2, "0");
  const ss          = String(Math.floor(totalSecs % 60)).padStart(2, "0");
  const minsDisplay = `${mm}:${ss}`;
  const timeColor   = minsLeft < 5 ? "var(--red)" : minsLeft < 15 ? "var(--yellow)" : "var(--green)";

  const closeTime = market.end_date_iso
    ? new Date(market.end_date_iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;
  const closeDate = market.end_date_iso
    ? new Date(market.end_date_iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })
    : null;

  return (
    <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>◈ POLYMARKET — MERCADO ACTIVO</span>
          <span style={{
            fontSize: 9, color: "var(--green)", border: "1px solid rgba(0,255,136,0.3)",
            padding: "1px 6px", borderRadius: 2, animation: "pulse 2s infinite",
          }}>LIVE</span>
        </div>
        {market.url && (
          <a href={market.url} target="_blank" rel="noopener noreferrer"
            style={{
              fontSize: 10, color: "var(--blue)", textDecoration: "none",
              letterSpacing: "0.08em", border: "1px solid rgba(68,136,255,0.3)",
              padding: "2px 8px", borderRadius: 2,
            }}>
            VER EN POLYMARKET ↗
          </a>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Left: detalles del mercado */}
        <div>
          <div style={{
            fontSize: 12, color: "#c8c8d8", lineHeight: 1.5,
            padding: "8px 12px", background: "rgba(255,255,255,0.03)",
            border: "1px solid #111122", borderRadius: 3, marginBottom: 12,
          }}>
            {market.question || "—"}
          </div>

          <Row label="CIERRE" value={closeTime ? `${closeDate}  ${closeTime} UTC` : "—"} valueColor="#ffcc00" />
          <Row
            label="TIEMPO RESTANTE"
            value={
              <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 14, fontWeight: 700, color: timeColor }}>
                {minsDisplay}
              </span>
            }
            valueColor={timeColor}
          />
          <Row label="CONDITION ID"
            value={market.condition_id ? market.condition_id.slice(0, 18) + "..." : "—"}
            valueColor="#555"
          />
          {market.volume != null && (
            <Row label="VOLUMEN" value={`$${Number(market.volume).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} valueColor="#aaa" />
          )}
          {market.liquidity != null && (
            <Row label="LIQUIDEZ" value={`$${Number(market.liquidity).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} valueColor="#aaa" />
          )}
          <Row label="SLUG" value={market.slug || "—"} valueColor="#333" />

          {/* Badge de diagnóstico del slug encontrado */}
          {market._debug && <DebugBadge debug={market._debug} />}
        </div>

        {/* Right: tokens + ventanas */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.12em", marginBottom: 8 }}>
              PRECIOS DE TOKENS (1 = certeza)
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <TokenBadge label="▲ YES (UP)"  price={market.tokens?.yes?.price} color="var(--green)" />
              <TokenBadge label="▼ NO (DOWN)" price={market.tokens?.no?.price}  color="var(--red)"   />
            </div>
          </div>

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
