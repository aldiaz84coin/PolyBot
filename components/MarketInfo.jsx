"use client";
/**
 * MarketInfo.jsx — v5.2
 *
 * CAMBIOS v5.2 — FIX CRÍTICO: activeWindow es objeto, no string
 * ─────────────────────────────────────────────────────────────────────
 *  BUG: `getActiveWindow()` en constants.js devuelve un objeto
 *       { key, label, color, ... } pero este componente hacía:
 *         const windowInfo = WINDOW_LABELS[activeWindow]
 *       → `WINDOW_LABELS[{...}]` es siempre `undefined` porque las claves
 *         del dict son strings ("T-20", "T-15", ...).
 *       Resultado: el indicador de ventana NUNCA se mostraba.
 *
 *  FIX: `WINDOW_LABELS[activeWindow?.key]` para acceder por la clave string.
 *       Además se usa directamente `activeWindow.color` del objeto para no
 *       duplicar el mapa de colores.
 *
 * CAMBIOS v5.1 (referencia):
 *   - Añadidos minsLeft y activeWindow a la firma del componente.
 *   - Bloque de countdown: MM:SS con colores de urgencia.
 *
 * CAMBIOS v5.0 (referencia):
 *   - Precios YES/NO restaurados con barra de probabilidad.
 *   - Soporte tokens como { yes:{...}, no:{...} } (normalizado en hooks.js).
 *
 * Destino: components/MarketInfo.jsx
 */

export default function MarketInfo({ market, minsLeft, activeWindow, error, apiResponse }) {
  const slug   = market?.slug   ?? null;
  const tokens = market?.tokens ?? null;

  const yesToken  = tokens?.yes ?? null;
  const noToken   = tokens?.no  ?? null;
  const yesPrice  = yesToken?.price  != null ? yesToken.price  : null;
  const noPrice   = noToken?.price   != null ? noToken.price   : null;
  const yesSource = yesToken?.price_source ?? null;
  const noSource  = noToken?.price_source  ?? null;

  const polyUrl = slug
    ? `https://polymarket.com/event/${slug}`
    : "https://polymarket.com";

  // Barra de probabilidad
  const yesPct = yesPrice != null ? Math.round(yesPrice * 100) : null;
  const noPct  = noPrice  != null ? Math.round(noPrice  * 100) : null;

  // Countdown
  const minsInt   = minsLeft != null ? Math.floor(minsLeft) : null;
  const secsInt   = minsLeft != null ? Math.floor((minsLeft % 1) * 60) : null;
  const countdown = minsInt != null
    ? `${String(minsInt).padStart(2, "0")}:${String(secsInt).padStart(2, "0")}`
    : null;

  const countdownColor = minsLeft == null ? "#333"
    : minsLeft < 5  ? "var(--red)"
    : minsLeft < 15 ? "var(--yellow)"
    : "var(--green)";

  // FIX v5.2: activeWindow es un objeto → usar activeWindow.key para el lookup
  // y activeWindow.color / activeWindow.label directamente del objeto.
  const windowInfo = activeWindow ?? null;

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
          {error ?? "Buscando mercado BTC…"}
        </div>
        {apiResponse?.slugs_tried?.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 9, color: "#222" }}>
            Slugs intentados: {apiResponse.slugs_tried.slice(0, 3).map(s => s.slug).join(", ")}
          </div>
        )}
      </div>
    );
  }

  // ── Con mercado ────────────────────────────────────────────────────────
  return (
    <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
      {/* Header: slug + countdown */}
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 10 }}>
        ◈ POLYMARKET — MERCADO ACTIVO
      </div>

      {/* Slug como enlace */}
      <a
        href={polyUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 9, color: "#4488ff", letterSpacing: "0.06em",
          textDecoration: "none", display: "block", marginBottom: 12,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {slug ?? "—"}
      </a>

      {/* Countdown + Ventana activa */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        {/* Timer */}
        <div>
          <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 3 }}>
            CIERRE EN
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: countdownColor, fontVariantNumeric: "tabular-nums" }}>
            {countdown ?? "—:—"}
          </div>
          {minsLeft != null && (
            <div style={{ fontSize: 9, color: "#333", marginTop: 2 }}>
              {minsLeft.toFixed(1)} min
            </div>
          )}
        </div>

        {/* Ventana activa — FIX v5.2: usa windowInfo.key, .label, .color */}
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 8, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 3 }}>
            VENTANA
          </div>
          {windowInfo ? (
            <div style={{
              fontSize: 18, fontWeight: 700, color: windowInfo.color,
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

      {/* Precios YES / NO */}
      <div>
        <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 8 }}>
          PRECIOS CLOB
        </div>

        {/* Fila YES / UP */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: "var(--green)",
              border: "1px solid var(--green)44", padding: "1px 6px", borderRadius: 2,
            }}>
              UP / YES
            </span>
            {sourceTag(yesSource)}
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>
            {yesPrice != null ? `${(yesPrice * 100).toFixed(1)}¢` : "—"}
          </span>
        </div>

        {/* Fila NO / DOWN */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: "var(--red)",
              border: "1px solid var(--red)44", padding: "1px 6px", borderRadius: 2,
            }}>
              DOWN / NO
            </span>
            {sourceTag(noSource)}
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: "var(--red)" }}>
            {noPrice != null ? `${(noPrice * 100).toFixed(1)}¢` : "—"}
          </span>
        </div>

        {/* Barra de probabilidad */}
        {yesPct != null && noPct != null && (
          <div style={{ height: 4, borderRadius: 2, overflow: "hidden", background: "#0a0a18", display: "flex" }}>
            <div style={{ width: `${yesPct}%`, background: "var(--green)", transition: "width 0.5s" }} />
            <div style={{ width: `${noPct}%`,  background: "var(--red)",   transition: "width 0.5s" }} />
          </div>
        )}

        {/* Si no hay tokens */}
        {yesPrice == null && noPrice == null && (
          <div style={{ fontSize: 9, color: "#222", marginTop: 4 }}>
            Sin datos CLOB — verifica tokens en bot-state
          </div>
        )}
      </div>
    </div>
  );
}
