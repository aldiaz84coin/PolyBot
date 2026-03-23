"use client";
/**
 * components/BetsTable.jsx — v4.0
 *
 * CAMBIOS v4.0 — BoostPower correlation display
 *   - DetailRow muestra sección "BOOST POWER · Crypto Detector v4" con
 *     las 4 lecturas capturadas (T-20, T-15, T-10, T-5) como barras
 *     visuales + valor numérico. Si no hay dato → "—".
 *   - Los datos vienen del campo boost_t20 / boost_t15 / boost_t10 /
 *     boost_t5 de cada operación (guardados por el bot en Supabase).
 *
 * (v3.x — sin cambios en la lógica de P&L ni de columnas)
 */
import { useState } from "react";
import { fmtUSD, fmtPct } from "../lib/constants";

const COLS = [
  { label: "ID",       width: 65  },
  { label: "HORA",     width: 72  },
  { label: "DIR",      width: 50  },
  { label: "VENTANA",  width: 65  },
  { label: "TARGET",   width: 88  },
  { label: "ENTRY",    width: 88  },
  { label: "DIST $",   width: 65  },
  { label: "STAKE",    width: 68  },
  { label: "RETORNO",  width: 78  },
  { label: "RESULT",   width: 68  },
  { label: "P&L $",    width: 78  },
];

const TOTAL_W = COLS.reduce((s, c) => s + c.width, 0);

// BoostPower: color ramp  0.0 → 0.5 → 1.0  (rojo → amarillo → verde)
function boostColor(v) {
  if (v == null) return "#333";
  if (v >= 0.6)  return "#00ff88";   // fuerte alcista
  if (v >= 0.4)  return "#88ff44";
  if (v >= 0.25) return "#ffcc00";   // neutro
  if (v >= 0.1)  return "#ff8800";
  return "#ff4466";                   // bajista / débil
}

// Etiqueta de clasificación implícita por rango
function boostLabel(v) {
  if (v == null)  return "—";
  if (v >= 0.6)   return "INVERTIBLE";
  if (v >= 0.35)  return "APALANCADO";
  return "RUIDOSO";
}

function ResultBadge({ result }) {
  const map = {
    WIN:     { color: "#00ff88", label: "WIN"  },
    LOSS:    { color: "#ff4466", label: "LOSS" },
    STOP:    { color: "#ff8800", label: "STOP" },
    PENDING: { color: "#ffcc00", label: "PEND" },
  };
  const { color, label } = map[result] || { color: "#555", label: result || "—" };
  return (
    <span style={{
      color, fontSize: 10, fontWeight: 700,
      border: `1px solid ${color}44`, padding: "1px 6px", borderRadius: 2,
    }}>
      {label}
    </span>
  );
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("es-ES", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch { return "—"; }
}

function calcPnlUsd(bet) {
  if (!bet) return null;
  if (bet.pnl_usd != null) return +bet.pnl_usd;
  if (bet.pnl == null) return null;
  const stake = bet.stake ?? 0;
  const odds  = bet.odds  ?? 0.5;
  if (bet.result === "WIN")  return +(stake / odds - stake).toFixed(2);
  if (bet.result === "LOSS") return -stake;
  if (bet.result === "STOP") return +(stake * bet.pnl / 100).toFixed(2);
  return null;
}

function calcRetorno(bet) {
  const stake = bet?.stake ?? 0;
  if (!stake) return null;
  const isClosed = bet?.result && bet.result !== "PENDING";
  if (isClosed) {
    const pnl = calcPnlUsd(bet);
    return pnl != null ? stake + pnl : null;
  }
  const odds = bet?.odds ?? 0.5;
  return odds > 0 ? stake / odds : null;
}

// ── BoostBar — barra visual de un solo valor ─────────────────────────────

function BoostBar({ windowKey, value, windowColor }) {
  const pct    = value != null ? Math.min(Math.max(value, 0), 1) * 100 : 0;
  const color  = boostColor(value);
  const label  = boostLabel(value);
  const hasVal = value != null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 100, flex: 1 }}>
      {/* Header: ventana + valor */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{
          fontSize: 8, letterSpacing: "0.14em", color: windowColor,
          fontWeight: 700,
        }}>
          {windowKey}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: hasVal ? color : "#333" }}>
          {hasVal ? value.toFixed(3) : "—"}
        </span>
      </div>
      {/* Barra */}
      <div style={{
        height: 3, background: "#0a0a18", borderRadius: 2, overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: hasVal ? color : "transparent",
          borderRadius: 2,
          transition: "width 0.4s ease",
        }} />
      </div>
      {/* Clasificación */}
      <div style={{ fontSize: 8, color: hasVal ? color : "#2a2a3a", letterSpacing: "0.10em" }}>
        {hasVal ? label : "SIN DATO"}
      </div>
    </div>
  );
}

// ── DetailRow — fila expandida con todos los datos + boost ───────────────

function DetailRow({ bet }) {
  const pnlUsd      = calcPnlUsd(bet);
  const odds        = bet?.odds ?? 0.5;
  const prob        = (odds * 100).toFixed(1);
  const isClosed    = bet?.result && bet.result !== "PENDING";
  const retornoEst  = odds > 0 ? bet.stake / odds : null;
  const retornoReal = isClosed && pnlUsd != null ? bet.stake + pnlUsd : null;

  const WINDOW_COLORS = {
    "T-20": "#4488ff",
    "T-15": "#aa44ff",
    "T-10": "#ff8800",
    "T-5":  "#ff4466",
  };

  const boostWindows = [
    { key: "T-20", val: bet.boost_t20, color: WINDOW_COLORS["T-20"] },
    { key: "T-15", val: bet.boost_t15, color: WINDOW_COLORS["T-15"] },
    { key: "T-10", val: bet.boost_t10, color: WINDOW_COLORS["T-10"] },
    { key: "T-5",  val: bet.boost_t5,  color: WINDOW_COLORS["T-5"]  },
  ];

  const hasAnyBoost = boostWindows.some(w => w.val != null);

  // Boost en la ventana de entrada (la más relevante para correlación)
  const entryWindowKey = bet.window;   // "T-20" | "T-15" | "T-10" | "T-5"
  const entryBoost     = boostWindows.find(w => w.key === entryWindowKey)?.val ?? null;

  return (
    <div style={{
      background: "#04040e",
      borderTop: "1px solid #0a0a1a",
      borderBottom: "1px solid #0a0a1a",
      fontSize: 10,
      minWidth: TOTAL_W,
    }}>

      {/* ── Datos de la operación ────────────────────────────────────────── */}
      <div style={{
        padding: "10px 20px",
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "10px 24px",
      }}>
        {[
          ["Mercado slug",      bet.market_slug || "—"],
          ["Odds de entrada",   `${odds.toFixed(3)}  (${prob}% prob)`],
          ["Stake invertido",   fmtUSD(bet.stake)],
          ["Retorno estimado",  retornoEst ? fmtUSD(retornoEst) : "—"],
          ...(isClosed ? [
            ["Retorno real",    retornoReal != null ? fmtUSD(retornoReal) : "—"],
          ] : []),
          ["Umbral $",          bet.umbral ? `$${bet.umbral}` : "—"],
          ["Distancia $",       bet.dist ? `$${Math.abs(+bet.dist).toFixed(0)}` : "—"],
          ["P&L USD",           pnlUsd != null ? fmtUSD(pnlUsd) : "—"],
          ["P&L %",             bet.pnl != null ? fmtPct(bet.pnl) : "—"],
          ["Timestamp",         bet.ts ? new Date(bet.ts).toLocaleString("es-ES") : "—"],
          ["Simulado",          bet.simulated ? "Sí" : "No"],
          ...(entryBoost != null ? [
            ["BP ventana entrada", `${entryBoost.toFixed(3)} · ${boostLabel(entryBoost)}`],
          ] : []),
        ].map(([k, v]) => (
          <div key={k}>
            <span style={{ color: "#333", display: "block", marginBottom: 2, letterSpacing: "0.10em" }}>
              {k.toUpperCase()}
            </span>
            <span style={{ color: "#888" }}>{v}</span>
          </div>
        ))}
      </div>

      {/* ── Sección BoostPower ────────────────────────────────────────────── */}
      <div style={{
        borderTop: "1px solid #08080f",
        padding: "12px 20px",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 10,
        }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.16em", fontWeight: 700 }}>
            BOOST POWER · CRYPTO DETECTOR v4
          </div>
          {hasAnyBoost ? (
            <div style={{
              fontSize: 8, color: "#2a2a3a", letterSpacing: "0.10em",
            }}>
              Algoritmo A · solo datos on-chain y de mercado CoinGecko
            </div>
          ) : (
            <div style={{ fontSize: 8, color: "#222", letterSpacing: "0.10em" }}>
              Sin datos — BOOST_POWER_URL no configurada o ventanas no capturadas
            </div>
          )}
        </div>

        {/* Barras de las 4 ventanas */}
        <div style={{
          display: "flex", gap: 20,
          padding: "10px 0",
        }}>
          {boostWindows.map(w => (
            <BoostBar
              key={w.key}
              windowKey={w.key}
              value={w.val}
              windowColor={w.color}
            />
          ))}
        </div>

        {/* Leyenda de rangos */}
        <div style={{
          display: "flex", gap: 16, marginTop: 8,
          fontSize: 8, color: "#2a2a3a", letterSpacing: "0.08em",
        }}>
          {[
            { label: "INVERTIBLE",  range: "≥ 0.60", color: "#00ff88" },
            { label: "APALANCADO",  range: "0.35 – 0.59", color: "#ffcc00" },
            { label: "RUIDOSO",     range: "< 0.35", color: "#ff4466" },
          ].map(({ label, range, color }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
              <span style={{ color: "#333" }}>{label}</span>
              <span style={{ color: "#2a2a3a" }}>· {range}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── StatCell ─────────────────────────────────────────────────────────────

function StatCell({ label, value, color = "#888", size = 14 }) {
  return (
    <div>
      <div style={{ color: "#333", marginBottom: 3, fontSize: 9, letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ color, fontWeight: 700, fontSize: size }}>{value}</div>
    </div>
  );
}

// ── BetsTable ─────────────────────────────────────────────────────────────

export default function BetsTable({ bets: rawBets = [] }) {
  const bets = Array.isArray(rawBets) ? rawBets : [];
  const [expanded, setExpanded] = useState(null);
  const toggle = (id) => setExpanded(prev => prev === id ? null : id);

  const today = new Date().toISOString().slice(0, 10);

  const allClosed   = bets.filter(b => b?.result && b.result !== "PENDING");
  const allWins     = allClosed.filter(b => b.result === "WIN").length;
  const allLosses   = allClosed.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const allWinRate  = (allWins + allLosses) > 0 ? Math.round(allWins / (allWins + allLosses) * 100) : null;
  const allInvested = bets.reduce((s, b) => s + (b?.stake ?? 0), 0);
  const allPnl      = allClosed.reduce((s, b) => { const p = calcPnlUsd(b); return s + (p != null ? p : 0); }, 0);
  const allPending  = bets.filter(b => !b?.result || b.result === "PENDING").length;

  const todayB      = bets.filter(b => b?.ts?.startsWith(today));
  const todayC      = todayB.filter(b => b?.result && b.result !== "PENDING");
  const todayWins   = todayC.filter(b => b.result === "WIN").length;
  const todayLosses = todayC.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const todayWR     = (todayWins + todayLosses) > 0 ? Math.round(todayWins / (todayWins + todayLosses) * 100) : null;
  const todayIn     = todayB.reduce((s, b) => s + (b?.stake ?? 0), 0);
  const todayPnl    = todayC.reduce((s, b) => { const p = calcPnlUsd(b); return s + (p != null ? p : 0); }, 0);

  return (
    <div style={{ fontFamily: "inherit" }}>

      {/* ── Stats globales ─────────────────────────────────────────────── */}
      {allClosed.length > 0 && (
        <div style={{
          display: "flex", gap: 28, padding: "12px 20px",
          borderBottom: "1px solid #0d0d1a", background: "#02020a",
          fontSize: 10, letterSpacing: "0.12em", alignItems: "center",
          flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.16em", marginRight: 4 }}>TOTAL</div>
          <StatCell
            label="INVERTIDO"
            value={fmtUSD(allInvested)}
            color="#666" size={16}
          />
          <StatCell
            label="P&L NETO"
            value={`${allPnl >= 0 ? "+" : ""}${fmtUSD(allPnl)}`}
            color={allPnl >= 0 ? "#00cc66" : "#cc3344"} size={16}
          />
          <div style={{ width: 1, background: "#111", alignSelf: "stretch" }} />
          <StatCell label="WINS"     value={allWins}   color="#00ff88" size={16} />
          <StatCell label="LOSSES"   value={allLosses} color="#ff4466" size={16} />
          <StatCell
            label="WIN RATE"
            value={allWinRate != null ? `${allWinRate}%` : "—"}
            color={allWinRate == null ? "#555" : allWinRate >= 50 ? "#00ff88" : "#ff4466"}
            size={16}
          />
          {allPending > 0 && (
            <StatCell label="PENDIENTES" value={allPending} color="#ffcc00" size={16} />
          )}
        </div>
      )}

      {/* ── Stats del DÍA ──────────────────────────────────────────────── */}
      {todayB.length > 0 && (
        <div style={{
          display: "flex", gap: 28, padding: "10px 20px",
          borderBottom: "1px solid #0d0d1a", background: "#02020a",
          fontSize: 10, letterSpacing: "0.12em", alignItems: "center",
        }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.16em", marginRight: 4 }}>HOY</div>
          {[
            ["OPS",       String(todayB.length),                              "#666"],
            ["INVERTIDO", fmtUSD(todayIn),                                    "#888"],
            ["P&L",       `${todayPnl >= 0 ? "+" : ""}${fmtUSD(todayPnl)}`,  todayPnl >= 0 ? "var(--green)" : "var(--red)"],
            ["W/L",       `${todayWins}/${todayLosses}`,                      "#666"],
            ["WIN RATE",  todayWR != null ? `${todayWR}%` : "—",              todayWR == null ? "#555" : todayWR >= 50 ? "var(--green)" : "var(--red)"],
          ].map(([label, val, color]) => (
            <div key={label} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <span style={{ color: "#333" }}>{label}</span>
              <span style={{ color, fontWeight: 700, fontSize: 13 }}>{val}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Cabecera de tabla ──────────────────────────────────────────── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
        padding: "8px 16px", gap: 0,
        fontSize: 9, color: "#444", letterSpacing: "0.12em",
        borderBottom: "1px solid #0d0d1a", background: "#02020a",
        position: "sticky", top: 0, zIndex: 1, minWidth: TOTAL_W,
      }}>
        {COLS.map(c => <span key={c.label}>{c.label}</span>)}
      </div>

      {/* ── Filas ─────────────────────────────────────────────────────── */}
      {bets.length === 0 ? (
        <div style={{
          padding: "40px 16px", textAlign: "center",
          color: "var(--dim)", fontSize: 12,
        }}>
          No hay operaciones registradas. Inicia el bot para comenzar.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {bets.map((bet) => {
            if (!bet) return null;
            const pnlUsd   = calcPnlUsd(bet);
            const retorno  = calcRetorno(bet);
            const isOpen   = expanded === bet.id;
            const isClosed = bet?.result && bet.result !== "PENDING";

            // Boost de la ventana de entrada (para mini-indicator en la fila)
            const windowBoostKey = `boost_${(bet.window || "").toLowerCase().replace("-", "_")}`;
            const entryBoost     = bet[windowBoostKey] ?? null;

            return (
              <div key={bet.id || Math.random()}>
                {/* Fila principal */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
                    padding: "7px 16px", gap: 0, alignItems: "center",
                    borderBottom: isOpen ? "none" : "1px solid #08080f",
                    fontSize: 11, color: "var(--fg)", minWidth: TOTAL_W,
                    cursor: "pointer",
                    background: isOpen ? "#05050e" : "transparent",
                    transition: "background 0.15s",
                  }}
                  onClick={() => toggle(bet.id)}
                >
                  {/* ID con mini-dot de boost */}
                  <span style={{ color: "#444", fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
                    {entryBoost != null && (
                      <span title={`BoostPower ${bet.window}: ${entryBoost.toFixed(3)}`} style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: boostColor(entryBoost),
                        flexShrink: 0,
                        boxShadow: `0 0 4px ${boostColor(entryBoost)}88`,
                      }} />
                    )}
                    {bet.id}
                  </span>

                  <span style={{ color: "#555", fontSize: 10 }}>
                    {fmtTime(bet.ts)}
                  </span>
                  <span style={{
                    color: bet.dir === "UP" ? "var(--green)" : "var(--red)",
                    fontWeight: 700, fontSize: 10,
                  }}>
                    {bet.dir === "UP" ? "▲ UP" : "▼ DN"}
                  </span>
                  <span style={{ color: "#556", fontSize: 10 }}>{bet.window}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {bet.target
                      ? `$${(+bet.target).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                      : "—"}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {bet.entry
                      ? `$${(+bet.entry).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                      : "—"}
                  </span>
                  <span style={{
                    color: (bet.dist ?? 0) > 0 ? "#4488ff" : "#ff8800",
                    fontVariantNumeric: "tabular-nums", fontSize: 10,
                  }}>
                    {bet.dist
                      ? `${(+bet.dist) > 0 ? "+" : ""}$${Math.abs(+bet.dist).toFixed(0)}`
                      : "—"}
                  </span>
                  <span style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>
                    {fmtUSD(bet.stake)}
                  </span>

                  {/* Retorno: real si cerrada, estimado si pendiente */}
                  <span style={{
                    color: isClosed
                      ? (retorno != null && retorno > bet.stake
                          ? "var(--green)"
                          : retorno != null && retorno < bet.stake
                          ? "var(--red)"
                          : "#556")
                      : "#334",
                    fontVariantNumeric: "tabular-nums",
                    fontSize: 10,
                  }}>
                    {retorno != null
                      ? (isClosed ? fmtUSD(retorno) : `~${fmtUSD(retorno)}`)
                      : "—"}
                  </span>

                  <ResultBadge result={bet.result} />
                  <span style={{
                    color: pnlUsd == null
                      ? "#444"
                      : pnlUsd > 0 ? "var(--green)"
                      : pnlUsd < 0 ? "var(--red)"
                      : "#888",
                    fontWeight: pnlUsd != null ? 700 : 400,
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {pnlUsd != null
                      ? `${pnlUsd >= 0 ? "+" : ""}${fmtUSD(pnlUsd)}`
                      : "—"}
                  </span>
                </div>

                {/* Fila expandida */}
                {isOpen && <DetailRow bet={bet} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
