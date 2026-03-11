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

/**
 * Calcula el P&L en USD de una operación cerrada.
 * Usa pnl_usd si está disponible (preferido — valor real).
 * Fallback: calcula desde pnl% o resultado.
 */
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

/**
 * Calcula el retorno total de una operación:
 * - PENDING → retorno estimado si WIN: stake / odds_entrada
 * - WIN / LOSS / STOP → retorno REAL = stake + pnl_usd (lo que se recibió)
 *
 * Esto evita mostrar siempre "stake * 2" cuando odds defaulteaba a 0.5.
 */
function calcRetorno(bet) {
  const stake = bet?.stake ?? 0;
  if (!stake) return null;

  const isClosed = bet?.result && bet.result !== "PENDING";

  if (isClosed) {
    // Retorno real: cuánto dinero total se recibió de vuelta
    const pnl = calcPnlUsd(bet);
    return pnl != null ? stake + pnl : null;
  }

  // PENDING: retorno estimado si gana (stake / odds_entrada)
  const odds = bet?.odds ?? 0.5;
  return odds > 0 ? stake / odds : null;
}

function DetailRow({ bet }) {
  const pnlUsd        = calcPnlUsd(bet);
  const odds          = bet?.odds ?? 0.5;
  const prob          = (odds * 100).toFixed(1);
  const isClosed      = bet?.result && bet.result !== "PENDING";
  const retornoEst    = odds > 0 ? bet.stake / odds : null;   // siempre estimado
  const retornoReal   = isClosed && pnlUsd != null ? bet.stake + pnlUsd : null;

  return (
    <div style={{
      background: "#05050f",
      borderTop: "1px solid #0a0a1a",
      padding: "10px 20px",
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "10px 24px",
      fontSize: 10,
      minWidth: TOTAL_W,
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
      ].map(([k, v]) => (
        <div key={k}>
          <span style={{ color: "#333", display: "block", marginBottom: 2, letterSpacing: "0.10em" }}>{k.toUpperCase()}</span>
          <span style={{ color: "#888" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function StatCell({ label, value, color = "#888", size = 14 }) {
  return (
    <div>
      <div style={{ color: "#333", marginBottom: 3, fontSize: 9, letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ color, fontWeight: 700, fontSize: size }}>{value}</div>
    </div>
  );
}

export default function BetsTable({ bets = [] }) {
  const [expanded, setExpanded] = useState(null);
  const toggle = (id) => setExpanded(prev => prev === id ? null : id);

  const today = new Date().toISOString().slice(0, 10);

  // Stats acumuladas
  const allClosed   = bets.filter(b => b?.result && b.result !== "PENDING");
  const allWins     = allClosed.filter(b => b.result === "WIN").length;
  const allLosses   = allClosed.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const allWinRate  = (allWins + allLosses) > 0 ? Math.round(allWins / (allWins + allLosses) * 100) : null;
  const allInvested = bets.reduce((s, b) => s + (b?.stake ?? 0), 0);
  const allPnl      = allClosed.reduce((s, b) => { const p = calcPnlUsd(b); return s + (p != null ? p : 0); }, 0);
  const allPending  = bets.filter(b => b?.result === "PENDING").length;

  // Stats del día
  const todayB      = bets.filter(b => b?.ts?.startsWith(today));
  const todayClosed = todayB.filter(b => b?.result && b.result !== "PENDING");
  const todayWins   = todayClosed.filter(b => b.result === "WIN").length;
  const todayLosses = todayClosed.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const todayWR     = (todayWins + todayLosses) > 0 ? Math.round(todayWins / (todayWins + todayLosses) * 100) : null;
  const todayIn     = todayB.reduce((s, b) => s + (b?.stake ?? 0), 0);
  const todayPnl    = todayClosed.reduce((s, b) => { const p = calcPnlUsd(b); return s + (p != null ? p : 0); }, 0);

  return (
    <div style={{ background: "var(--bg)", minHeight: "calc(100vh - 90px)" }}>

      {/* Panel ACUMULADO TOTAL */}
      {bets.length > 0 && (
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #111", background: "#03030d" }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.18em", marginBottom: 10 }}>
            ACUMULADO TOTAL — {bets.length} OPERACIONES
          </div>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ minWidth: 110 }}>
              <div style={{ fontSize: 8, color: "#444", letterSpacing: "0.12em", marginBottom: 4 }}>P&L NETO TOTAL</div>
              <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: allPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                {allPnl >= 0 ? "+" : ""}{fmtUSD(allPnl)}
              </div>
            </div>
            <div style={{ width: 1, background: "#111", alignSelf: "stretch" }} />
            <StatCell label="INVERTIDO TOTAL" value={fmtUSD(allInvested)} color="#888" size={16} />
            <StatCell label="RETORNO TOTAL"   value={fmtUSD(allInvested + allPnl)} color={allPnl >= 0 ? "#00cc66" : "#cc3344"} size={16} />
            <div style={{ width: 1, background: "#111", alignSelf: "stretch" }} />
            <StatCell label="WINS"     value={allWins}   color="#00ff88" size={16} />
            <StatCell label="LOSSES"   value={allLosses} color="#ff4466" size={16} />
            <StatCell label="WIN RATE" value={allWinRate != null ? `${allWinRate}%` : "—"} color={allWinRate == null ? "#555" : allWinRate >= 50 ? "#00ff88" : "#ff4466"} size={16} />
            {allPending > 0 && <StatCell label="PENDIENTES" value={allPending} color="#ffcc00" size={16} />}
          </div>
        </div>
      )}

      {/* Resumen del DÍA */}
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

      {/* Cabecera tabla */}
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

      {bets.length === 0 ? (
        <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--dim)", fontSize: 12 }}>
          No hay operaciones registradas. Inicia el bot para comenzar.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {bets.map((bet) => {
            if (!bet) return null;
            const pnlUsd  = calcPnlUsd(bet);
            const retorno = calcRetorno(bet);
            const isOpen  = expanded === bet.id;
            const isClosed = bet?.result && bet.result !== "PENDING";

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
                  <span style={{ color: "#444", fontSize: 10 }}>{bet.id}</span>
                  <span style={{ color: "#555", fontSize: 10 }}>{fmtTime(bet.ts)}</span>
                  <span style={{ color: bet.dir === "UP" ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 10 }}>
                    {bet.dir === "UP" ? "▲ UP" : "▼ DN"}
                  </span>
                  <span style={{ color: "#556", fontSize: 10 }}>{bet.window}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {bet.target ? `$${(+bet.target).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {bet.entry ? `$${(+bet.entry).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}
                  </span>
                  <span style={{ color: (bet.dist ?? 0) > 0 ? "#4488ff" : "#ff8800", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>
                    {bet.dist ? `${(+bet.dist) > 0 ? "+" : ""}$${Math.abs(+bet.dist).toFixed(0)}` : "—"}
                  </span>
                  <span style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>{fmtUSD(bet.stake)}</span>

                  {/* RETORNO: real para cerradas, estimado para pendientes */}
                  <span style={{
                    color: isClosed
                      ? (retorno != null && retorno > bet.stake ? "var(--green)" : retorno != null && retorno < bet.stake ? "var(--red)" : "#556")
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
                    color: pnlUsd == null ? "#444" : pnlUsd > 0 ? "var(--green)" : pnlUsd < 0 ? "var(--red)" : "#888",
                    fontWeight: pnlUsd != null ? 700 : 400,
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {pnlUsd != null ? `${pnlUsd >= 0 ? "+" : ""}${fmtUSD(pnlUsd)}` : "—"}
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
