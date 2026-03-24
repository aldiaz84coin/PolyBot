/**
 * components/ClaimPanel.jsx — v1.0
 *
 * Panel de gestión manual de claims on-chain.
 *
 * Botón 1 — CONSULTAR CLAIMS DISPONIBLES
 *   GET /api/claim → lista WIN ops + estado Gamma (resolved/pending)
 *   Muestra: mercado, dirección, tokens, stake, P&L, estado resolución.
 *
 * Botón 2 — RECLAMAR (por op)
 *   POST /api/claim → encola manual_claim en bot_commands
 *   Polling GET /api/commands?id=xxx hasta done/error
 *   Muestra tx_hash + enlace Polygonscan al completar.
 *
 * Añadir en Dashboard.jsx dentro del tab "config":
 *   import ClaimPanel from "./ClaimPanel";
 *   <ClaimPanel />
 */

"use client";
import { useState, useCallback, useRef } from "react";

// ── Estilos ──────────────────────────────────────────────────────────────────

const S = {
  root: {
    fontFamily:  "monospace",
    background:  "#010108",
    border:      "1px solid #1a1a2e",
    borderRadius: 4,
    padding:     "20px 24px",
    marginBottom: 24,
  },
  header: {
    fontSize: 9, letterSpacing: "0.2em", color: "#333",
    marginBottom: 16, display: "flex", alignItems: "center", gap: 12,
  },
  btn: (variant = "primary", disabled = false) => ({
    padding:       "6px 14px",
    fontSize:      9,
    letterSpacing: "0.12em",
    fontFamily:    "monospace",
    cursor:        disabled ? "not-allowed" : "pointer",
    border:        "1px solid",
    borderRadius:  3,
    opacity:       disabled ? 0.4 : 1,
    background:    variant === "primary"  ? "#001a0d" :
                   variant === "danger"   ? "#1a0008" :
                   variant === "success"  ? "#001a0d" : "#0d0d1a",
    borderColor:   variant === "primary"  ? "#00ff88" :
                   variant === "danger"   ? "#ff4466" :
                   variant === "success"  ? "#00ff88" : "#4488ff",
    color:         variant === "primary"  ? "#00ff88" :
                   variant === "danger"   ? "#ff4466" :
                   variant === "success"  ? "#00ff88" : "#4488ff",
  }),
  tag: (color) => ({
    display: "inline-block", fontSize: 8, letterSpacing: "0.1em",
    padding: "2px 6px", borderRadius: 2, fontFamily: "monospace",
    background: `${color}18`, border: `1px solid ${color}44`, color,
  }),
  card: {
    background: "#060612", border: "1px solid #1a1a2a",
    borderRadius: 4, padding: "12px 16px", marginTop: 10,
  },
  row: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  label: { fontSize: 8, color: "#444", letterSpacing: "0.12em" },
  value: { fontSize: 10, color: "#aaa" },
  dimLine: { fontSize: 8, color: "#333", letterSpacing: "0.08em", lineHeight: 1.8 },
  sep: { borderColor: "#1a1a2a", margin: "12px 0" },
  txBox: {
    marginTop: 8, padding: "8px 12px",
    background: "#020210", border: "1px solid #002244",
    borderRadius: 3, fontSize: 9, color: "#4488ff", lineHeight: 1.8,
  },
  errBox: {
    marginTop: 8, padding: "8px 12px",
    background: "#100008", border: "1px solid #440022",
    borderRadius: 3, fontSize: 9, color: "#ff4466", lineHeight: 1.6,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch { return iso; }
}

function fmtUSD(v) {
  if (v == null) return "—";
  const s = Math.abs(v).toFixed(2);
  return v >= 0 ? `+$${s}` : `-$${s}`;
}

function GammaStatus({ claim }) {
  if (claim.gamma_error) {
    return <span style={S.tag("#ff8800")}>⚠ GAMMA ERROR</span>;
  }
  if (claim.resolved) {
    return <span style={S.tag("#00ff88")}>✅ RESUELTO</span>;
  }
  if (claim.closed && claim.outcome) {
    return <span style={S.tag("#00cc66")}>🔒 CERRADO · outcome: {claim.outcome}</span>;
  }
  if (claim.closed) {
    return <span style={S.tag("#4488ff")}>🔒 CERRADO (resolución pendiente)</span>;
  }
  return <span style={S.tag("#888")}>⏳ PENDIENTE</span>;
}

// ── Polling helper ────────────────────────────────────────────────────────────

function usePoll() {
  const timerRef = useRef(null);

  const poll = useCallback((id, onDone, maxMs = 120_000) => {
    const start = Date.now();
    const tick  = async () => {
      if (Date.now() - start > maxMs) {
        onDone({ status: "error", result: { error: "Timeout esperando respuesta del bot" } });
        return;
      }
      try {
        const res  = await fetch(`/api/commands?id=${id}`);
        const data = await res.json();
        if (data.status === "done" || data.status === "error") {
          onDone(data);
        } else {
          timerRef.current = setTimeout(tick, 3000);
        }
      } catch (e) {
        onDone({ status: "error", result: { error: e.message } });
      }
    };
    timerRef.current = setTimeout(tick, 3000);
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { poll, cancel };
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ClaimPanel() {
  const [queryStatus,  setQueryStatus]  = useState("idle");   // idle | loading | ok | error
  const [claims,       setClaims]       = useState(null);
  const [queryError,   setQueryError]   = useState(null);
  const [claimStates,  setClaimStates]  = useState({});       // { [op_id]: { status, result } }

  const { poll } = usePoll();

  // ── Consultar claims disponibles ──────────────────────────────────────────
  const handleQuery = async () => {
    setQueryStatus("loading");
    setClaims(null);
    setQueryError(null);
    setClaimStates({});
    try {
      const res  = await fetch("/api/claim", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Error desconocido");
      setClaims(data.claims || []);
      setQueryStatus("ok");
    } catch (e) {
      setQueryError(e.message);
      setQueryStatus("error");
    }
  };

  // ── Ejecutar claim de una operación ──────────────────────────────────────
  const handleClaim = async (claim) => {
    const { op_id, condition_id, direction, market_slug, tokens, stake_usd } = claim;

    setClaimStates(prev => ({
      ...prev,
      [op_id]: { status: "loading", result: null },
    }));

    try {
      const res  = await fetch("/api/claim", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          condition_id,
          direction,
          market_slug,
          tokens,
          stake:  stake_usd,
          op_id,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Error al encolar claim");

      // Polling hasta que el bot procese
      poll(data.id, (pollData) => {
        const ok = pollData.status === "done" && pollData.result?.success;
        setClaimStates(prev => ({
          ...prev,
          [op_id]: { status: ok ? "ok" : "error", result: pollData.result },
        }));
      });
    } catch (e) {
      setClaimStates(prev => ({
        ...prev,
        [op_id]: { status: "error", result: { error: e.message } },
      }));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={S.root}>

      {/* Header */}
      <div style={S.header}>
        <span>⛓ CLAIMS ON-CHAIN</span>
        <span style={S.tag("#4488ff")}>POLYGON CTF</span>
      </div>

      {/* Botón principal */}
      <div style={{ ...S.row, marginBottom: 8 }}>
        <button
          onClick={handleQuery}
          disabled={queryStatus === "loading"}
          style={S.btn("primary", queryStatus === "loading")}
        >
          {queryStatus === "loading" ? "CONSULTANDO…" : "CONSULTAR CLAIMS DISPONIBLES"}
        </button>
        {queryStatus === "ok" && claims != null && (
          <span style={{ fontSize: 9, color: "#444" }}>
            {claims.length === 0
              ? "Sin WIN ops en los últimos 7 días"
              : `${claims.length} operación${claims.length > 1 ? "es" : ""} WIN encontrada${claims.length > 1 ? "s" : ""}`}
          </span>
        )}
      </div>

      {/* Error de consulta */}
      {queryStatus === "error" && (
        <div style={S.errBox}>✗ {queryError}</div>
      )}

      {/* Lista de claims */}
      {claims && claims.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {claims.map((claim) => {
            const cs  = claimStates[claim.op_id] || {};
            const busy = cs.status === "loading";

            return (
              <div key={claim.op_id} style={S.card}>

                {/* Fila 1: market + estado */}
                <div style={{ ...S.row, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, color: "#ddd", fontWeight: 700 }}>
                    {claim.direction === "UP" ? "🟢" : "🔴"} {claim.direction}
                  </span>
                  <span style={{ fontSize: 9, color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {claim.question || claim.market_slug}
                  </span>
                  <GammaStatus claim={claim} />
                </div>

                {/* Fila 2: datos de la op */}
                <div style={{ ...S.row, marginBottom: 10, gap: 20 }}>
                  <div>
                    <div style={S.label}>STAKE</div>
                    <div style={S.value}>${(claim.stake_usd || 0).toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={S.label}>TOKENS</div>
                    <div style={S.value}>{(claim.tokens || 0).toFixed(4)}</div>
                  </div>
                  <div>
                    <div style={S.label}>P&amp;L</div>
                    <div style={{ fontSize: 10, color: (claim.pnl_usd || 0) >= 0 ? "#00ff88" : "#ff4466" }}>
                      {fmtUSD(claim.pnl_usd)}
                    </div>
                  </div>
                  <div>
                    <div style={S.label}>ENTRADA</div>
                    <div style={S.value}>{fmtDate(claim.ts_entrada)}</div>
                  </div>
                </div>

                {/* Fila 3: condition_id + slug */}
                <div style={S.dimLine}>
                  <span style={{ color: "#222" }}>condId: </span>
                  <span style={{ color: "#333" }}>
                    {claim.condition_id
                      ? `${claim.condition_id.slice(0, 14)}…`
                      : <span style={{ color: "#ff4466" }}>NO DISPONIBLE</span>}
                  </span>
                  <span style={{ color: "#222", marginLeft: 12 }}>slug: </span>
                  <span style={{ color: "#333" }}>{claim.market_slug}</span>
                  {claim.outcome && (
                    <>
                      <span style={{ color: "#222", marginLeft: 12 }}>outcome: </span>
                      <span style={{ color: "#00ff88" }}>{claim.outcome}</span>
                    </>
                  )}
                </div>

                <hr style={S.sep} />

                {/* Botón reclamar */}
                <div style={S.row}>
                  <button
                    onClick={() => handleClaim(claim)}
                    disabled={busy || !claim.condition_id || cs.status === "ok"}
                    style={S.btn(
                      cs.status === "ok"    ? "success" :
                      cs.status === "error" ? "danger"  : "primary",
                      busy || !claim.condition_id || cs.status === "ok"
                    )}
                  >
                    {busy             ? "RECLAMANDO…" :
                     cs.status === "ok"    ? "✅ RECLAMADO" :
                     cs.status === "error" ? "↩ REINTENTAR" :
                     !claim.condition_id   ? "⚠ SIN CONDITION ID" :
                     !claim.resolved       ? "⚠ RECLAMAR (MERCADO PENDIENTE)" :
                     "RECLAMAR"}
                  </button>

                  {!claim.condition_id && (
                    <span style={{ fontSize: 8, color: "#ff4466" }}>
                      condition_id no disponible en Gamma — reclamar manualmente
                    </span>
                  )}
                  {claim.condition_id && !claim.resolved && !claim.closed && (
                    <span style={{ fontSize: 8, color: "#ff8800" }}>
                      Gamma no confirma resolución — el claim puede fallar
                    </span>
                  )}
                  {claim.condition_id && !claim.resolved && claim.closed && claim.outcome && (
                    <span style={{ fontSize: 8, color: "#aaffcc" }}>
                      Mercado cerrado con outcome conocido — se intentará con gas fijo si estimate_gas falla
                    </span>
                  )}
                </div>

                {/* Resultado del claim */}
                {cs.status === "ok" && cs.result && (
                  <div style={S.txBox}>
                    <div>✅ Claim confirmado on-chain</div>
                    {cs.result.tx_hash && (
                      <>
                        <div>TX: <span style={{ color: "#88aaff" }}>{cs.result.tx_hash.slice(0, 16)}…</span></div>
                        <div>
                          <a
                            href={`https://polygonscan.com/tx/${cs.result.tx_hash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "#4488ff" }}
                          >
                            Ver en Polygonscan ↗
                          </a>
                        </div>
                      </>
                    )}
                    {cs.result.usdc_est != null && (
                      <div>USDC recuperados: <span style={{ color: "#00ff88" }}>~${cs.result.usdc_est.toFixed(4)}</span></div>
                    )}
                    {cs.result.note && (
                      <div style={{ color: "#888" }}>{cs.result.note}</div>
                    )}
                  </div>
                )}

                {cs.status === "error" && cs.result && (
                  <div style={S.errBox}>
                    <div>✗ {cs.result.error || "Error desconocido"}</div>
                    {cs.result.gamma_resolved != null && (
                      <div style={{ color: "#888", marginTop: 4 }}>
                        Gamma resuelto: {cs.result.gamma_resolved ? "sí" : "no"}
                      </div>
                    )}
                  </div>
                )}

              </div>
            );
          })}
        </div>
      )}

      {/* Vacío tras consulta */}
      {queryStatus === "ok" && claims?.length === 0 && (
        <div style={{ ...S.dimLine, marginTop: 12, color: "#333" }}>
          No se encontraron operaciones WIN reales en los últimos 7 días.
        </div>
      )}

      {/* Info pie */}
      <div style={{ ...S.dimLine, marginTop: 20 }}>
        <span style={{ color: "#222" }}>
          Los claims se ejecutan en la cadena Polygon mediante el contrato CTF de Polymarket.
          El botón "Reclamar" envía el comando al bot (Railway) que tiene la clave privada.
          Si el mercado aún no está resuelto on-chain, el claim fallará —
          en ese caso espera 1-3h tras el cierre de la vela.
        </span>
      </div>

    </div>
  );
}
