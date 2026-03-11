"use client";
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

function ResultBadge({ result }) {
  const map = {
    WIN:     { color: "#00ff88", label: "WIN"  },
    LOSS:    { color: "#ff4466", label: "LOSS" },
    STOP:    { color: "#ff8800", label: "STOP" },
    PENDING: { color: "#ffcc00", label: "PEND" },
  };
  const { color, label } = map[result] || { color: "#555", label: result };
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

/** Calcula el retorno estimado: stake / odds */
function calcRetorno(bet) {
  const stake = bet.stake ?? 0;
  const odds  = bet.odds  ?? 0.5;
  if (!stake || !odds) return null;
  return stake / odds;         // retorno bruto si gana
}

/** P&L en USD a partir del resultado */
function calcPnlUsd(bet) {
  if (bet.pnl_usd != null) return bet.pnl_usd;
  if (bet.pnl == null)     return null;

  const stake   = bet.stake ?? 0;
  const odds    = bet.odds  ?? 0.5;

  if (bet.result === "WIN")  return +(stake / odds - stake).toFixed(2);
  if (bet.result === "LOSS") return -stake;
  if (bet.result === "STOP") return +(stake * bet.pnl / 100).toFixed(2);
  return null;
}

/** Fila expandida con todos los detalles de la operación */
function DetailRow({ bet }) {
  const retorno  = calcRetorno(bet);
  const pnlUsd   = calcPnlUsd(bet);
  const odds     = bet.odds ?? 0.5;
  const prob     = (odds * 100).toFixed(1);

  return (
    <div style={{
      gridColumn: `1 / -1`,
      background: "#05050f",
      borderTop: "1px solid #0a0a1a",
      padding: "10px 20px",
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "10px 24px",
      fontSize: 10,
    }}>
      {[
        ["Mercado slug",     bet.market_slug || "—"],
        ["Odds de entrada",  `${odds.toFixed(3)}  (${prob}% prob)`],
        ["Stake invertido",  fmtUSD(bet.stake)],
        ["Retorno estimado", retorno ? fmtUSD(retorno) : "—"],
        ["Umbral $",         bet.umbral ? `$${bet.umbral}` : "—"],
        ["Distancia $",      bet.dist ? `$${(+bet.dist).toFixed(0)}` : "—"],
        ["P&L USD",          pnlUsd != null ? fmtUSD(pnlUsd) : "—"],
        ["P&L %",            bet.pnl != null ? fmtPct(bet.pnl) : "—"],
        ["Timestamp",        bet.ts ? new Date(bet.ts).toLocaleString("es-ES") : "—"],
        ["Simulado",         bet.simulated ? "Sí" : "No"],
      ].map(([k, v]) => (
        <div key={k}>
          <span style={{ color: "#333", display: "block", marginBottom: 2, letterSpacing: "0.10em" }}>{k.toUpperCase()}</span>
          <span style={{ color: "#888" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export default function BetsTable({ bets }) {
  const [expanded, setExpanded] = useState(null);

  const toggle = (id) => setExpanded(prev => prev === id ? null : id);

  // Totales del día
  const today    = new Date().toISOString().slice(0, 10);
  const todayB   = bets.filter(b => b.ts?.startsWith(today));
  const totalIn  = todayB.reduce((s, b) => s + (b.stake ?? 0), 0);
  const totalOut = todayB.reduce((s, b) => {
    const p = calcPnlUsd(b);
    return s + (p != null ? (b.stake ?? 0) + p : 0);
  }, 0);
  const totalPnl = totalOut - totalIn;

  return (
    <div style={{ background: "var(--bg)", minHeight: "calc(100vh - 90px)" }}>

      {/* Resumen del día */}
      {todayB.length > 0 && (
        <div style={{
          display: "flex", gap: 32, padding: "12px 20px",
          borderBottom: "1px solid #0d0d1a",
          background: "#02020a",
          fontSize: 10, letterSpacing: "0.12em",
        }}>
          {[
            ["OPS HOY",  todayB.length, "#666"],
            ["INVERTIDO", fmtUSD(totalIn), "#888"],
            ["P&L DÍA",  fmtUSD(totalPnl), totalPnl >= 0 ? "var(--green)" : "var(--red)"],
          ].map(([label, val, color]) => (
            <div key={label}>
              <div style={{ color: "#333", marginBottom: 3 }}>{label}</div>
              <div style={{ color, fontWeight: 700, fontSize: 14 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Cabecera */}
      <div style={{
        display: "grid",
        gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
        padding: "8px 16px", gap: 0,
        fontSize: 9, color: "#444", letterSpacing: "0.12em",
        borderBottom: "1px solid #0d0d1a", background: "#02020a",
        position: "sticky", top: 0, zIndex: 1,
        minWidth: TOTAL_W,
      }}>
        {COLS.map(c => <span key={c.label}>{c.label}</span>)}
      </div>

      {bets.length === 0 ? (
        <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--dim)", fontSize: 12 }}>
          No hay operaciones registradas. Inicia el bot para comenzar.
        </div>
      ) : (
        bets.map(bet => {
          const retorno = calcRetorno(bet);
          const pnlUsd  = calcPnlUsd(bet);
          const isOpen  = expanded === bet.id;

          return (
            <div key={bet.id}>
              <div
                onClick={() => toggle(bet.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
                  padding: "7px 16px", gap: 0,
                  fontSize: 11, borderBottom: "1px solid #07070f",
                  minWidth: TOTAL_W,
                  cursor: "pointer",
                  background: isOpen
                    ? "#08081a"
                    : bet.result === "WIN"  ? "rgba(0,255,136,0.02)"
                    : bet.result === "LOSS" ? "rgba(255,68,102,0.02)"
                    : bet.result === "STOP" ? "rgba(255,136,0,0.02)"
                    : "transparent",
                  transition: "background 0.15s",
                }}>
                <span style={{ color: "#444", fontSize: 10 }}>{bet.id}</span>
                <span style={{ color: "#333", fontSize: 10 }}>{fmtTime(bet.ts)}</span>
                <span style={{ color: bet.dir === "UP" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
                  {bet.dir === "UP" ? "▲ UP" : "▼ DOWN"}
                </span>
                <span style={{ color: "#555", fontSize: 10 }}>{bet.window}</span>
                <span style={{ color: "#777" }}>{fmtUSD(bet.target)}</span>
                <span style={{ color: "#aaa" }}>{fmtUSD(bet.entry)}</span>
                <span style={{ color: "#555" }}>${(+(bet.dist ?? 0)).toFixed(0)}</span>
                <span style={{ color: "#888" }}>{fmtUSD(bet.stake)}</span>
                <span style={{
                  color: bet.result === "PENDING" ? "#555" : "#777",
                  fontStyle: bet.result === "PENDING" ? "italic" : "normal",
                }}>
                  {retorno ? fmtUSD(retorno) : "—"}
                </span>
                <ResultBadge result={bet.result} />
                <span style={{
                  color: pnlUsd != null
                    ? pnlUsd > 0 ? "var(--green)" : "var(--red)"
                    : "#444",
                  fontWeight: pnlUsd != null ? 600 : 400,
                }}>
                  {pnlUsd != null
                    ? (pnlUsd >= 0 ? "+" : "") + fmtUSD(pnlUsd)
                    : "—"}
                </span>
              </div>

              {/* Fila expandida */}
              {isOpen && <DetailRow bet={bet} />}
            </div>
          );
        })
      )}
    </div>
  );
}
