"use client";
/**
 * MarketInfo.jsx — v5.0
 *
 * FIX v5.0 — PRECIOS YES/NO RESTAURADOS
 *   - v4.0 eliminó por completo el bloque de tokens YES/NO. Restaurado.
 *   - Muestra: precio YES (UP) y precio NO (DOWN) con fuente (CLOB/gamma/bot).
 *   - Barra visual de probabilidad YES vs NO.
 *   - El objeto market.tokens llega con forma:
 *       { yes: { price, token_id, price_source }, no: { ... } }
 *     tanto desde bot-state como desde /api/market.
 *   - Si alguno de los precios no está disponible muestra "—".
 *   - Mantiene SLUG + link a Polymarket de v4.0.
 *
 * Destino: components/MarketInfo.jsx
 */

export default function MarketInfo({ market, error }) {
  const slug   = market?.slug ?? null;
  const tokens = market?.tokens ?? null;
  const polyUrl = slug
    ? `https://polymarket.com/event/${slug}`
    : "https://polymarket.com";

  const yesToken = tokens?.yes ?? null;
  const noToken  = tokens?.no  ?? null;
  const yesPrice = yesToken?.price  != null ? yesToken.price  : null;
  const noPrice  = noToken?.price   != null ? noToken.price   : null;
  const yesSource = yesToken?.price_source ?? null;
  const noSource  = noToken?.price_source  ?? null;

  // Barra de probabilidad
  const yesPct = yesPrice != null ? Math.round(yesPrice * 100) : null;
  const noPct  = noPrice  != null ? Math.round(noPrice  * 100) : null;

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

      {/* Slug */}
      <div>
        <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 4 }}>
          SLUG
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, fontWeight: 600, color: "var(--green)",
          letterSpacing: "0.03em", wordBreak: "break-all", lineHeight: 1.5,
        }}>
          {slug}
        </div>
      </div>

      {/* Precios YES / NO */}
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

        {/* Barra de probabilidad */}
        {yesPct != null && noPct != null && (
          <div>
            <div style={{
              height: 6, borderRadius: 3, overflow: "hidden",
              background: "#0a0a14", display: "flex",
            }}>
              <div style={{
                width: `${yesPct}%`, background: "var(--green)",
                opacity: 0.7, transition: "width 0.4s ease",
              }} />
              <div style={{
                width: `${noPct}%`, background: "var(--red)",
                opacity: 0.7, transition: "width 0.4s ease",
              }} />
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between",
              fontSize: 9, color: "#333", marginTop: 3,
            }}>
              <span style={{ color: "#00ff8866" }}>UP {yesPct}%</span>
              <span style={{ color: "#ff444466" }}>DOWN {noPct}%</span>
            </div>
          </div>
        )}
      </div>

      {/* Link a Polymarket */}
      <div style={{ marginTop: "auto" }}>
        <a
          href={polyUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 10, color: "#4488ff", textDecoration: "none",
            letterSpacing: "0.1em", border: "1px solid rgba(68,136,255,0.25)",
            padding: "5px 12px", borderRadius: 3,
            background: "rgba(68,136,255,0.05)",
          }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(68,136,255,0.12)"}
          onMouseLeave={e => e.currentTarget.style.background = "rgba(68,136,255,0.05)"}
        >
          <span>↗</span>
          <span>Ver en Polymarket</span>
        </a>
      </div>
    </div>
  );
}
