"use client";
/**
 * MarketInfo.jsx — v4.0
 *
 * CAMBIOS v4.0 — SIMPLIFICADO
 *   - Muestra solo el SLUG activo (fuente: bot-state) + link a Polymarket.
 *   - Eliminados: tokens YES/NO, ventana timeline, condition_id, volumen,
 *     liquidez, debug badge, slugs probados.
 *   - Si no hay mercado: mensaje simple sin diagnóstico técnico.
 */

export default function MarketInfo({ market, error }) {
  const slug = market?.slug ?? null;
  const polyUrl = slug
    ? `https://polymarket.com/event/${slug}`
    : "https://polymarket.com";

  // ── Sin mercado ──────────────────────────────────────────────────────────
  if (!market || error) {
    return (
      <div style={{
        background: "var(--bg)",
        padding: "20px 24px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
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

  // ── Mercado activo ───────────────────────────────────────────────────────
  return (
    <div style={{
      background: "var(--bg)",
      padding: "20px 24px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      {/* Header */}
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
        ◈ POLYMARKET — MERCADO ACTIVO
      </div>

      {/* Slug */}
      <div>
        <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.12em", marginBottom: 6 }}>
          SLUG
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--green)",
          letterSpacing: "0.04em",
          wordBreak: "break-all",
          lineHeight: 1.5,
        }}>
          {slug}
        </div>
      </div>

      {/* Link a Polymarket */}
      <div>
        <a
          href={polyUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: "#4488ff",
            textDecoration: "none",
            letterSpacing: "0.1em",
            border: "1px solid rgba(68,136,255,0.25)",
            padding: "5px 12px",
            borderRadius: 3,
            background: "rgba(68,136,255,0.05)",
            transition: "background 0.15s",
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
