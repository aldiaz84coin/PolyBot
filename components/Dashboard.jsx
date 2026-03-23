"use client";
/**
 * Dashboard.jsx — v5.3
 *
 * CAMBIOS v5.2
 * ─────────────────────────────────────────────────────────────────────
 *  - BalanceWidget movido encima del grid de 3 columnas (más visible).
 *    Antes estaba al final del tab, debajo de ModeSelector.
 *
 * (v5.1 — Integración BalanceWidget)
 * (v5.0 — Corrección integral: getDecision, activeWindow, useBotState,
 *          target en PriceChart)
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
import BoostLive     from "./BoostLive";
import DataLab from "./DataLab";

const LS_KEY         = "polymarket_bets_v2";
const BETS_POLL_MS   = 10_000;
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
  return "#888";
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function Dashboard() {
  const [config, setConfig]             = useState(DEFAULT_CONFIG);
  const [tab, setTab]                   = useState("dashboard");
  const [bets, setBets]                 = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [events, setEvents]             = useState([]);

  const botState = useBotState();
  const { price, prev, source, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, error: marketError, apiResponse: marketApiResponse } = useMarket(botState.raw);
  const now = useClock();

  const minsLeft     = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);

  const target = botState.target ?? null;
  const dist   = price != null && target != null ? price - target : null;

  const umbral   = activeWindow ? (config[activeWindow.configKey] ?? 200) : null;
  const decision = price != null && target != null && umbral != null
    ? getDecision(price, target, umbral)
    : null;

  const closedBets      = bets.filter(b => b.result && b.result !== "PENDING");
  const wins            = closedBets.filter(b => b.result === "WIN").length;
  const losses          = closedBets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total           = closedBets.length;
  const winrate         = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal        = closedBets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);
  const activeBet       = bets.find(b => b.result === "PENDING") ?? null;
  const marketSlugShort = market?.slug?.split("-").slice(-3).join("-") ?? null;

  // ── Fetch bets ────────────────────────────────────────────────────────────

  const fetchBets = useCallback(async () => {
    try {
      const res  = await fetch("/api/bets?limit=500");
      if (!res.ok) return;
      const data = await res.json();
      const list = data.bets ?? data.data ?? (Array.isArray(data) ? data : []);
      setBets(list);
      if (Array.isArray(list)) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(list.slice(-500))); } catch {}
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const cached = localStorage.getItem(LS_KEY);
      if (cached) setBets(JSON.parse(cached));
    } catch {}
    fetchBets();
    const id = setInterval(fetchBets, BETS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchBets]);

  // ── Fetch eventos ─────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    try {
      const res  = await fetch("/api/events?limit=100");
      if (!res.ok) return;
      const data = await res.json();
      const list = data.events ?? data ?? [];
      if (!Array.isArray(list)) return;
      setEvents(prev => {
        const existingIds = new Set(prev.map(e => e.id));
        const newOnes     = list.filter(e => !existingIds.has(e.id));
        if (!newOnes.length) return prev;
        return [...newOnes, ...prev].slice(0, 200);
      });
    } catch {}
  }, []);

  useEffect(() => {
    fetchEvents();
    const id = setInterval(fetchEvents, EVENTS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchEvents]);

  // ── Historial de precio ───────────────────────────────────────────────────

  useEffect(() => {
    if (price == null) return;
    setPriceHistory(prev => {
      const point = { ts: Date.now(), price, target };
      if (prev.length && prev[prev.length - 1].price === price) return prev;
      return [...prev, point].slice(-300);
    });
  }, [price, target]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      background: "var(--bg, #020209)",
      color: "var(--text, #c8c8d8)",
      minHeight: "100vh",
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>

      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 20px", borderBottom: "1px solid var(--border, #0d0d1a)",
        background: "#010108",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: botState.running ? "var(--green, #00ff88)" : "#333",
            boxShadow: botState.running ? "0 0 12px var(--green)" : "0 0 8px var(--red)",
            animation: botState.running ? "pulse 2s infinite" : "none",
          }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em" }}>POLYBOT</span>
          {botState.stale  && <Tag color="var(--yellow)">BOT STALE</Tag>}
          {marketSlugShort && <Tag color="#4488ff">{marketSlugShort}</Tag>}
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
          { key: "dashboard", label: "DASHBOARD"    },
          { key: "historial", label: "HISTORIAL"    },
          { key: "stats",     label: "ESTADÍSTICAS" },
          { key: "datalab",   label: "DATA LAB"     },
          { key: "config",    label: "CONFIG"       },
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
            color="var(--yellow)"
            sub={`${wins}W / ${losses}L`}
          />
          <StatBox label="OPS" value={total || "—"} color="var(--dim)" />
          <div style={{ marginLeft: "auto", fontSize: 9, color: "#333", alignSelf: "center" }}>
            ↻ sync cada 10s · fuente: Supabase
          </div>
        </div>
      )}

      {/* ── PANEL PRINCIPAL 4-columnas ──────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 1fr 1fr 1fr",
          borderBottom: "1px solid var(--border)",
        }}>

          {/* COLUMNA 1 — BTC PRECIO + TARGET + WINDOWBAR */}
          <div style={{ padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>
              BTC / USDT
              {source && <span style={{ color: "#333", marginLeft: 6 }}>{source.toUpperCase()}</span>}
            </div>
            <div style={{
              fontSize: 38, fontWeight: 700, lineHeight: 1,
              color: price && prev ? (price >= prev ? "var(--green)" : "var(--red)") : "var(--text)",
            }}>
              {price ? `$${fmt(price, 2)}` : (priceLoading ? "…" : "—")}
            </div>
            {prev && price && (
              <div style={{ fontSize: 11, color: price >= prev ? "var(--green)" : "var(--red)", marginTop: 4 }}>
                {price >= prev ? "▲" : "▼"} ${Math.abs(price - prev).toFixed(2)}
              </div>
            )}

            {target != null ? (
              <div style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
                TARGET{" "}
                <span style={{ color: "var(--yellow)", fontWeight: 700 }}>
                  ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
                {dist != null && (
                  <span style={{ marginLeft: 8, color: dist > 0 ? "#4488ff" : "#ff8800", fontWeight: 700 }}>
                    ({dist > 0 ? "+" : ""}{dist.toFixed(0)})
                  </span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "#444", marginTop: 8 }}>
                TARGET esperando bot…
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <WindowBar minsLeft={minsLeft} />
            </div>
          </div>

          {/* COLUMNA 2 — SEÑAL */}
          <div style={{ padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 12 }}>
              SEÑAL ACTUAL
            </div>

            {decision ? (
              <>
                <div style={{
                  fontSize: 32, fontWeight: 700, lineHeight: 1,
                  color: decision.direction === "UP"
                    ? "var(--green)"
                    : decision.direction === "DOWN"
                    ? "var(--red)"
                    : "#555",
                }}>
                  {decision.direction === "UP"    ? "▲ UP"
                   : decision.direction === "DOWN" ? "▼ DOWN"
                   : "— WAIT"}
                </div>

                {activeWindow && (
                  <div style={{ fontSize: 11, color: activeWindow.color ?? "#888", marginTop: 6 }}>
                    Ventana {activeWindow.label}
                  </div>
                )}

                {dist != null && umbral != null && decision.direction !== "WAIT" && (
                  <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
                    dist{" "}
                    <span style={{
                      color: decision.direction === "UP" ? "var(--green)" : "var(--red)",
                      fontWeight: 700,
                    }}>
                      ${Math.abs(dist).toFixed(0)}
                    </span>
                    <span style={{ color: "#333" }}>/ umbral ${umbral}</span>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#555" }}>
                {!activeWindow ? "Fuera de ventana" : target == null ? "Sin target del bot" : "Sin precio"}
                {target != null && (
                  <div style={{ marginTop: 8, color: "#555" }}>
                    Target:{" "}
                    <span style={{ color: "var(--yellow)" }}>
                      ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* COLUMNA 3 — MERCADO ACTIVO + TOKENS */}
          <div style={{ borderRight: "1px solid var(--border)" }}>
            <MarketInfo
              market={market}
              minsLeft={minsLeft}
              activeWindow={activeWindow}
              error={marketError}
              apiResponse={marketApiResponse}
            />
          </div>

          {/* COLUMNA 4 — BOOST POWER TENDENCIA BTC */}
          <div>
            <BoostLive />
          </div>
        </div>
      )}

      {/* ── GRÁFICA BTC ─────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "12px 20px" }}>
            <PriceChart data={priceHistory} target={target} />
          </div>
        </div>
      )}

      {/* ── LOG DE EVENTOS ──────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "12px 20px" }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              marginBottom: 8,
            }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
                LOG DE EVENTOS
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 9, color: "#222" }}>
                  ↻ 5s · {events.length} mensajes
                </div>
                {events.length > 0 && (
                  <button onClick={() => setEvents([])} style={{
                    background: "none", border: "1px solid #1a1a2e", color: "#333",
                    fontSize: 8, padding: "2px 6px", borderRadius: 2,
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                    LIMPIAR
                  </button>
                )}
              </div>
            </div>
            <div style={{
              maxHeight: 220, overflowY: "auto",
              background: "#010108", border: "1px solid var(--border)",
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
        </div>
      )}

      {/* ── MODO DE TRADING ─────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
          <ModeSelector />
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

      {tab === "stats"  && <StatsPanel />}
      {tab === "datalab" && <DataLab />}
      {tab === "config" && <ConfigPanel config={config} onChange={setConfig} />}
    </div>
  );
}
