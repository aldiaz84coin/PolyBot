"use client";
/**
 * MarketInfo.jsx — v5.1
 *
 * CAMBIOS v5.1 — FIX timer y ventana activa
 * ─────────────────────────────────────────────────────────────────────
 *  PROBLEMA:
 *    Dashboard.jsx siempre pasó minsLeft, activeWindow y apiResponse como
 *    props, pero MarketInfo.jsx (v5.0) solo destructuraba { market, error }
 *    → el countdown y el indicador de ventana activa nunca se renderizaban.
 *
 *  FIX:
 *    - Añadidos minsLeft y activeWindow a la firma del componente.
 *    - Bloque de countdown: muestra MM:SS con colores de urgencia.
 *    - Indicador de ventana activa T-20/T-15/T-10/T-5 visible bajo el slug.
 *    - apiResponse aceptado (sin uso en render, evita console warning).
 *
 * CAMBIOS v5.0 (referencia):
 *   - Precios YES/NO restaurados con barra de probabilidad.
 *   - Soporte tokens como { yes:{...}, no:{...} } (normalizado en hooks.js v3.7).
 *
 * Destino: components/MarketInfo.jsx
 */

export default function MarketInfo({ market, minsLeft, activeWindow, error, apiResponse }) {
  const slug   = market?.slug ?? null;
  const tokens = market?.tokens ?? null;
  const polyUrl = slug
    ? `https://polymarket.com/event/${slug}`
    : "https://polymarket.com";

  const yesToken  = tokens?.yes ?? null;
  const noToken   = tokens?.no  ?? null;
  const yesPrice  = yesToken?.price  != null ? yesToken.price  : null;
  const noPrice   = noToken?.price   != null ? noToken.price   : null;
  const yesSource = yesToken?.price_source ?? null;
  const noSource  = noToken?.price_source  ?? null;

  // Barra de probabilidad
  const yesPct = yesPrice != null ? Math.round(yesPrice * 100) : null;
  const noPct  = noPrice  != null ? Math.round(noPrice  * 100) : null;

  // ── Countdown helpers ─────────────────────────────────────────────────
  const minsInt   = minsLeft != null ? Math.floor(minsLeft) : null;
  const secsInt   = minsLeft != null ? Math.floor((minsLeft % 1) * 60) : null;
  const countdown = minsInt != null
    ? `${String(minsInt).padStart(2, "0")}:${String(secsInt).padStart(2, "0")}`
    : null;

  // Color del countdown según urgencia
  const countdownColor = minsLeft == null
    ? "#333"
    : minsLeft < 5
      ? "var(--red)"
      : minsLeft < 15
        ? "var(--yellow)"
        : "var(--green)";

  // Ventanas: etiqueta + color
  const WINDOW_LABELS = {
    "T-20": { label: "T-20", color: "#4488ff" },
    "T-15": { label: "T-15", color: "#44aaff" },
    "T-10": { label: "T-10", color: "var(--yellow)" },
    "T-5":  { label: "T-5",  color: "var(--red)" },
  };
  const windowInfo = activeWindow ? WINDOW_LABELS[activeWindow] : null;

  const sourceTag = (src) => {
    if (!src) return null;
    const color = src === "clob" ? "#00cc66" : src === "bot" ? "#4488ff" : "#666";
    return (
      <span style={{
        fontSize: 8, letterSpacing: "0.1em", color,
        border: `1px solid ${color}44`, padding: "1px 4px",
        borderRadius: 2, marginLeft: 4,
      }}>
        {src.toUpperCase()}
      </span>
    );
  };

  // ── Sin mercado ────────────────────────────────────────────────────────
  if (!market || error) {
    return (
      <div style={{
        background: "var(--bg)", padding: "20px 24px", height: "100%",
        display: "flex", flexDirection: "column", justifyContent: "center",
      }}>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 12 }}>
          ◈ POLYMARKET — MERCADO ACTIVO
        </div>
        <div style={{ fontSize: 11, color: "#333" }}>
          {error ?? "Sin mercado detectado — bot inactivo o fuera de ventana"}
        </div>
      </div>
    );
  }

  // ── Mercado activo ─────────────────────────────────────────────────────
  return (
    <div style={{
      background: "var(--bg)", padding: "20px 24px", height: "100%",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Header */}
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
        ◈ POLYMARKET — MERCADO ACTIVO
      </div>

      {/* Slug + link */}
      <div>
        <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 4 }}>
          SLUG
        </div>
        <a
          href={polyUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11, fontWeight: 600, color: "var(--green)",
            letterSpacing: "0.03em", wordBreak: "break-all", lineHeight: 1.5,
          }}>
            {slug}
          </div>
        </a>
      </div>

      {/* ── COUNTDOWN + VENTANA ACTIVA ────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "#010108", border: "1px solid #0d0d1a",
        borderRadius: 3, padding: "8px 12px",
      }}>
        {/* Tiempo restante */}
        <div>
          <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 3 }}>
            CIERRE EN
          </div>
          <div style={{
            fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
            color: countdownColor, letterSpacing: "0.05em", lineHeight: 1,
          }}>
            {countdown ?? "—:—"}
          </div>
          {minsLeft != null && (
            <div style={{ fontSize: 9, color: "#333", marginTop: 2 }}>
              min left: {minsLeft != null ? minsLeft.toFixed(1) : "—"}
            </div>
          )}
        </div>

        {/* Ventana activa */}
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 3 }}>
            VENTANA
          </div>
          {windowInfo ? (
            <div style={{
              fontSize: 18, fontWeight: 700, color: windowInfo.color,
              fontFamily: "'JetBrains Mono', monospace",
              border: `1px solid ${windowInfo.color}44`,
              padding: "2px 10px", borderRadius: 2,
              background: `${windowInfo.color}0d`,
            }}>
              {windowInfo.label}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#2a2a3a" }}>FUERA</div>
          )}
        </div>
      </div>

      {/* ── PRECIOS YES / NO ─────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 8 }}>
          PRECIOS CLOB
        </div>

        {/* Fila YES */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 6,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: "var(--green)",
              border: "1px solid var(--green)44", padding: "1px 6px", borderRadius: 2,
            }}>
              UP / YES
            </span>
            {sourceTag(yesSource)}
          </div>
          <span style={{
            fontSize: 18, fontWeight: 700, color: "var(--green)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {yesPrice != null
              ? `${(yesPrice * 100).toFixed(1)}¢`
              : "—"}
          </span>
        </div>

        {/* Fila NO */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: "var(--red)",
              border: "1px solid var(--red)44", padding: "1px 6px", borderRadius: 2,
            }}>
              DOWN / NO
            </span>
            {sourceTag(noSource)}
          </div>
          <span style={{
            fontSize: 18, fontWeight: 700, color: "var(--red)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {noPrice != null
              ? `${(noPrice * 100).toFixed(1)}¢`
              : "—"}
          </span>
        </div>

        {/* Barra visual YES vs NO */}
        {yesPct != null && noPct != null && (
          <div style={{
            height: 4, borderRadius: 2, overflow: "hidden",
            background: "#0d0d1a", display: "flex",
          }}>
            <div style={{
              width: `${yesPct}%`, height: "100%",
              background: "var(--green)", opacity: 0.7,
              transition: "width 0.5s ease",
            }} />
            <div style={{
              width: `${noPct}%`, height: "100%",
              background: "var(--red)", opacity: 0.7,
              transition: "width 0.5s ease",
            }} />
          </div>
        )}
      </div>

      {/* Volume / Liquidity si disponibles */}
      {(market.volume != null || market.liquidity != null) && (
        <div style={{ display: "flex", gap: 20 }}>
          {market.volume != null && (
            <div>
              <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 2 }}>
                VOLUMEN
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                ${Number(market.volume).toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
          {market.liquidity != null && (
            <div>
              <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 2 }}>
                LIQUIDEZ
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                ${Number(market.liquidity).toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
