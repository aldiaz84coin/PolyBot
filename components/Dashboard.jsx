/**
 * Dashboard.jsx — v12.0
 *
 * v12.0 — ESTRATEGIA ARB EN PARALELO
 *  - Tab "⚖ ARBITRAJE": historial de operaciones arb_operations con filtros y stats.
 *  - Tab "COMPARATIVA": métricas side-by-side + PnL diario de ambas estrategias.
 *  - ArbModeSelector en panel DASHBOARD: controla activación y modo sim/real ARB.
 *
 * (v5.1 — FIX BUG 1-5)
 * (v4.2 — fmtTime, hints de eventos)
 * (v4.1 — eventos acumulativos)
 * (v4.0 — simplificación MarketInfo, log de eventos)
 */

import { useState, useEffect, useCallback } from "react";
import {
  DEFAULT_CONFIG,
  getDecision, getActiveWindow, getMinsLeft,
  fmt, fmtUSD,
} from "../lib/constants";
import { useBotState, useBTCPrice, useMarket, useClock } from "../lib/hooks";
import PriceChart    from "./PriceChart";
import WindowBar     from "./WindowBar";
import MarketInfo    from "./MarketInfo";
import BetsTable     from "./BetsTable";
import ConfigPanel   from "./ConfigPanel";
import StatsPanel    from "./StatsPanel";
import ModeSelector  from "./ModeSelector";
import ArbModeSelector from "./ArbModeSelector";   // v12.0
import ArbHistorial    from "./ArbHistorial";       // v12.0
import Comparativa     from "./Comparativa";        // v12.0

const LS_KEY        = "polymarket_bets_v2";
const BETS_POLL_MS  = 10_000;
const EVENTS_POLL_MS = 5_000;

// ── Micro-componentes ─────────────────────────────────────────────────────────

function Tag({ children, color = "#555" }) {
  return (
    <span style={{
      fontSize: 9, letterSpacing: "0.14em", color,
      border: `1px solid ${color}33`, padding: "1px 6px", borderRadius: 2,
    }}>
      {children}
    </span>
  );
}

function StatBox({ label, value, color = "#c8c8d8", sub }) {
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.14em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function fmtTime(tsIsoOrMs) {
  try {
    if (!tsIsoOrMs) return "";
    const d = typeof tsIsoOrMs === "number"
      ? new Date(tsIsoOrMs)
      : new Date(tsIsoOrMs);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}

function eventColor(text) {
  if (!text) return "#666";
  if (text.startsWith("✅") || text.startsWith("🟢") || text.startsWith("🤖")) return "var(--green)";
  if (text.startsWith("❌") || text.startsWith("🛑") || text.startsWith("⛔") || text.startsWith("🚨")) return "var(--red)";
  if (text.startsWith("⚠")  || text.startsWith("🟡")) return "var(--yellow)";
  if (text.startsWith("📊") || text.startsWith("📈") || text.startsWith("📉")) return "#4488ff";
  if (text.startsWith("⚖"))  return "#4488ff";
  return "#888";
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function Dashboard() {
  const [config, setConfig]             = useState(DEFAULT_CONFIG);
  const [tab, setTab]                   = useState("dashboard");
  const [bets, setBets]                 = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [events, setEvents]             = useState([]);

  // ── Hooks de datos ────────────────────────────────────────────────────────
  const botState = useBotState();
  const { price, prev, source, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, error: marketError, apiResponse: marketApiResponse } = useMarket(botState.raw);
  const now = useClock();

  // ── Valores derivados ─────────────────────────────────────────────────────
  const minsLeft     = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);

  const target = botState.target ?? null;
  const dist   = price != null && target != null ? price - target : null;

  const umbral   = activeWindow ? (config[activeWindow.configKey] ?? 200) : null;
  const decision = price != null && target != null && umbral != null
    ? getDecision(price, target, umbral)
    : null;

  // Stats de bets
  const closedBets = bets.filter(b => b.result && b.result !== "PENDING");
  const wins       = closedBets.filter(b => b.result === "WIN").length;
  const losses     = closedBets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total      = closedBets.length;
  const winrate    = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal   = closedBets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);
  const activeBet  = bets.find(b => b.result === "PENDING") ?? null;
  const marketSlugShort = market?.slug?.split("-").slice(-3).join("-") ?? null;

  // ── Historial de bets ─────────────────────────────────────────────────────
  const loadBets = useCallback(async () => {
    try {
      const res  = await fetch("/api/bets?limit=500");
      const data = await res.json();
      setBets(data.bets ?? []);
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    loadBets();
    const id = setInterval(loadBets, BETS_POLL_MS);
    return () => clearInterval(id);
  }, [loadBets]);

  // ── Eventos del bot ───────────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    try {
      const res  = await fetch("/api/events");
      const data = await res.json();
      setEvents(prev => {
        const incoming = data.events ?? [];
        if (!incoming.length) return prev;
        const ids = new Set(prev.map(e => e.id));
        const merged = [
          ...incoming.filter(e => !ids.has(e.id)),
          ...prev,
        ].slice(0, 60);
        return merged;
      });
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    loadEvents();
    const id = setInterval(loadEvents, EVENTS_POLL_MS);
    return () => clearInterval(id);
  }, [loadEvents]);

  // ── Historial de precio ───────────────────────────────────────────────────
  useEffect(() => {
    if (price == null) return;
    setPriceHistory(h => {
      const last = h[h.length - 1];
      if (last && last.price === price) return h;
      const next = [...h, { time: Date.now(), price, target }].slice(-120);
      return next;
    });
  }, [price, target]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: "var(--bg)", minHeight: "100vh",
      fontFamily: "var(--font-mono)", color: "var(--text)",
    }}>
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "0 20px", height: 44,
        borderBottom: "1px solid var(--border)", background: "#010108",
      }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: botState.running ? "var(--green)" : "#333",
            boxShadow: botState.running ? "0 0 12px var(--green)" : "0 0 8px var(--red)",
            animation: botState.running ? "pulse 2s infinite" : "none",
          }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em" }}>POLYBOT</span>
          {botState.stale   && <Tag color="var(--yellow)">BOT STALE</Tag>}
          {marketSlugShort  && <Tag color="#4488ff">{marketSlugShort}</Tag>}
          {activeBet && (
            <Tag color={activeBet.direction === "UP" ? "var(--green)" : "var(--red)"}>
              {activeBet.direction === "UP" ? "▲" : "▼"} APUESTA ACTIVA
            </Tag>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {target != null && (
            <span style={{ fontSize: 10, color: "var(--yellow)", letterSpacing: "0.08em" }}>
              TARGET{" "}
              <span style={{ fontWeight: 700 }}>
                ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            </span>
          )}
          <span style={{ fontSize: 10, color: "#444" }}>
            {now.toLocaleTimeString("es-ES", { hour12: false })}
          </span>
        </div>
      </header>

      {/* ── TABS ────────────────────────────────────────────────────────── */}
      <nav style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "#020208" }}>
        {[
          { key: "dashboard",   label: "DASHBOARD"    },
          { key: "historial",   label: "HISTORIAL"    },
          { key: "arbitraje",   label: "⚖ ARBITRAJE"  },
          { key: "comparativa", label: "COMPARATIVA"  },
          { key: "stats",       label: "ESTADÍSTICAS" },
          { key: "config",      label: "CONFIG"       },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 20px", fontSize: 9, letterSpacing: "0.15em",
            color: tab === key ? "var(--text)" : "#444",
            borderBottom: tab === key ? "2px solid var(--green)" : "2px solid transparent",
            fontFamily: "inherit",
          }}>
            {label}
          </button>
        ))}
      </nav>

      {/* ── STATS BAR ───────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "flex", gap: 32, padding: "12px 20px",
          borderBottom: "1px solid var(--border)", background: "#010108",
          overflowX: "auto",
        }}>
          <StatBox
            label="P&L TOTAL"
            value={total > 0 ? `${pnlTotal >= 0 ? "+" : ""}${fmtUSD(pnlTotal)}` : "—"}
            color={pnlTotal >= 0 ? "var(--green)" : "var(--red)"}
          />
          <StatBox
            label="WINRATE"
            value={winrate != null ? `${winrate.toFixed(0)}%` : "—"}
            color={winrate != null && winrate >= 50 ? "var(--green)" : "var(--red)"}
            sub={total > 0 ? `${wins}W / ${losses}L` : undefined}
          />
          <StatBox
            label="OPS HOY"
            value={botState.ops_today ?? 0}
            color="#c8c8d8"
          />
          {price != null && (
            <StatBox
              label="BTC PRECIO"
              value={`$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
              color={prev != null && price > prev ? "var(--green)" : prev != null && price < prev ? "var(--red)" : "#c8c8d8"}
            />
          )}
          {dist != null && (
            <StatBox
              label="DISTANCIA"
              value={`${dist >= 0 ? "+" : ""}${dist.toFixed(0)}`}
              color={Math.abs(dist) > (umbral ?? 200) ? "var(--green)" : "var(--yellow)"}
              sub="vs Target"
            />
          )}
          {decision && (
            <StatBox
              label="SEÑAL"
              value={decision}
              color={decision === "UP" ? "var(--green)" : decision === "DOWN" ? "var(--red)" : "var(--yellow)"}
            />
          )}
        </div>
      )}

      {/* ── CHART + MERCADO ─────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ borderRight: "1px solid var(--border)", padding: "16px 20px" }}>
            <PriceChart
              data={priceHistory}
              target={target}
              activeWindow={activeWindow}
              minsLeft={minsLeft}
            />
          </div>
          <div style={{ padding: "16px 20px" }}>
            <WindowBar minsLeft={minsLeft} activeWindow={activeWindow} />
            <MarketInfo
              market={market}
              endMs={endMs}
              minsLeft={minsLeft}
              botState={botState}
              activeBet={activeBet}
            />
          </div>
        </div>
      )}

      {/* ── EVENTOS DEL BOT ─────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.14em", marginBottom: 10 }}>
            EVENTOS DEL BOT
          </div>
          <div style={{
            maxHeight: 180, overflowY: "auto",
            background: "#01010a", border: "1px solid #0a0a18",
            borderRadius: 3, padding: "8px 10px",
          }}>
            {events.length === 0 ? (
              <div style={{ fontSize: 10, color: "#2a2a3a" }}>
                Sin eventos — esperando mensajes del bot
                {botState.running && (
                  <span style={{ color: "#333", marginLeft: 8 }}>
                    · verifica FRONTEND_URL en Railway
                  </span>
                )}
              </div>
            ) : (
              events.map(ev => (
                <div key={ev.id} style={{
                  fontSize: 10, color: eventColor(ev.text),
                  marginBottom: 3, lineHeight: 1.55,
                  borderBottom: "1px solid #0a0a14", paddingBottom: 3,
                }}>
                  <span style={{ color: "#444", marginRight: 8, userSelect: "none" }}>
                    {fmtTime(ev.ts_iso ?? ev.ts)}
                  </span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{ev.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── MODO DE TRADING ─────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
          <ModeSelector />
          <ArbModeSelector />
        </div>
      )}

      {/* ── HISTORIAL ───────────────────────────────────────────────────── */}
      {tab === "historial" && (
        <div>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            background: "#02020a",
          }}>
            <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.12em" }}>
              {bets.length} OPERACIONES · SUPABASE
            </span>
            {bets.length > 0 && (
              <button onClick={() => {
                if (window.confirm("¿Limpiar caché local?")) {
                  localStorage.removeItem(LS_KEY);
                  setBets([]);
                }
              }} style={{
                background: "none", border: "1px solid #1a1a2e",
                color: "#333", fontSize: 9, padding: "3px 8px",
                cursor: "pointer", fontFamily: "inherit",
              }}>
                LIMPIAR CACHÉ
              </button>
            )}
          </div>
          <BetsTable bets={bets} />
        </div>
      )}

      {/* ── ARBITRAJE ───────────────────────────────────────────────────── */}
      {tab === "arbitraje" && (
        <div>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            background: "#02020a",
          }}>
            <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.12em" }}>
              ⚖ HISTORIAL ARBITRAJE · SUPABASE
            </span>
          </div>
          <ArbHistorial />
        </div>
      )}

      {/* ── COMPARATIVA ─────────────────────────────────────────────────── */}
      {tab === "comparativa" && (
        <div>
          <div style={{
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            background: "#02020a",
            fontSize: 10, color: "#444", letterSpacing: "0.12em",
          }}>
            COMPARATIVA — ESTRATEGIA DIRECCIONAL vs ARBITRAJE
          </div>
          <Comparativa />
        </div>
      )}

      {tab === "stats"  && <StatsPanel />}
      {tab === "config" && <ConfigPanel config={config} onChange={setConfig} />}
    </div>
  );
}
