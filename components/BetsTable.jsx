"use client";
import { fmtUSD, fmtPct } from "../lib/constants";

const COLS = [
  { label: "ID",      width: 65  },
  { label: "DIR",     width: 55  },
  { label: "TARGET",  width: 90  },
  { label: "ENTRY",   width: 90  },
  { label: "VENTANA", width: 75  },
  { label: "DIST $",  width: 70  },
  { label: "RESULT",  width: 75  },
  { label: "P&L",     width: 80  },
];

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

export default function BetsTable({ bets }) {
  return (
    <div style={{ background: "var(--bg)", minHeight: "calc(100vh - 90px)" }}>
      {/* Header row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
        padding: "8px 16px", gap: 0,
        fontSize: 9, color: "#444", letterSpacing: "0.12em",
        borderBottom: "1px solid #0d0d1a", background: "#02020a",
        position: "sticky", top: 0,
      }}>
        {COLS.map(c => <span key={c.label}>{c.label}</span>)}
      </div>

      {bets.length === 0 ? (
        <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--dim)", fontSize: 12 }}>
          No hay operaciones registradas. Inicia el bot para comenzar.
        </div>
      ) : (
        bets.map(bet => (
          <div key={bet.id} style={{
            display: "grid",
            gridTemplateColumns: COLS.map(c => `${c.width}px`).join(" "),
            padding: "7px 16px", gap: 0,
            fontSize: 11, borderBottom: "1px solid #07070f",
            background: bet.result === "WIN"  ? "rgba(0,255,136,0.02)"
                      : bet.result === "LOSS" ? "rgba(255,68,102,0.02)"
                      : bet.result === "STOP" ? "rgba(255,136,0,0.02)"
                      : "transparent",
            transition: "background 0.2s",
          }}>
            <span style={{ color: "#444" }}>{bet.id}</span>
            <span style={{ color: bet.dir === "UP" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
              {bet.dir === "UP" ? "▲ UP" : "▼ DOWN"}
            </span>
            <span style={{ color: "#888" }}>{fmtUSD(bet.target)}</span>
            <span style={{ color: "#aaa" }}>{fmtUSD(bet.entry)}</span>
            <span style={{ color: "#666" }}>{bet.window}</span>
            <span style={{ color: "#666" }}>${bet.dist?.toFixed(0)}</span>
            <ResultBadge result={bet.result} />
            <span style={{
              color: bet.pnl > 0 ? "var(--green)" : bet.pnl < 0 ? "var(--red)" : "#444",
              fontWeight: bet.pnl != null ? 600 : 400,
            }}>
              {bet.pnl != null ? fmtPct(bet.pnl) : "—"}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
