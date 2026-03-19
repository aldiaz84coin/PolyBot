"use client";
/**
 * Dashboard.jsx — v4.2
 *
 * CAMBIOS v4.2
 * ─────────────────────────────────────────────────────────────────────
 * 1. FIX priceHistory: cada punto ahora incluye { ts, price, target }
 *    → el tooltip de PriceChart muestra el target correctamente.
 *
 * 2. FIX fmtTime: acepta tanto ts_iso (string ISO) como ts (timestamp ms).
 *    La función anterior solo intentaba parsear ts_iso; si el evento venía
 *    con ts numérico (ms) el render mostraba cadena vacía.
 *
 * 3. FIX timestamp color en eventos: cambiado de #2a2a3a (casi invisible
 *    sobre #010108) a #444 (legible).
 *
 * 4. FIX alerta FRONTEND_URL: cuando events.length === 0 y bot está activo
 *    (running), muestra un hint de que posiblemente FRONTEND_URL no está
 *    configurado en Railway.
 *
 * (v4.1 — eventos acumulativos, target visible, MarketInfo simplificado)
 * (v4.0 — simplificación MarketInfo, log de eventos desde /api/events)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  WINDOWS, DEFAULT_CONFIG,
  getDecision, getActiveWindow, getMinsLeft,
  fmt, fmtUSD, fmtPct, genId,
} from "../lib/constants";
import { useBTCPrice, useMarket, useClock, useLog } from "../lib/hooks";
import PriceChart   from "./PriceChart";
import WindowBar    from "./WindowBar";
import MarketInfo   from "./MarketInfo";
import BetsTable    from "./BetsTable";
import ConfigPanel  from "./ConfigPanel";
import StatsPanel   from "./StatsPanel";
import ModeSelector from "./ModeSelector";

const LS_KEY            = "polymarket_bets_v2";
const BETS_POLL_MS      = 10_000;
const BOTSTATE_POLL_MS  = 5_000;
const EVENTS_POLL_MS    = 5_000;

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

// FIX v4.2: acepta ts_iso (string ISO) O ts (número ms desde epoch)
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

export default function Dashboard() {
  const [config, setConfig]             = useState(DEFAULT_CONFIG);
  const [tab, setTab]                   = useState("dashboard");
  const [bets, setBets]                 = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);

  // ── Estado del bot ────────────────────────────────────────────────────
  const [botState, setBotState] = useState(null);
  const running  = botState?.status === "running" && !botState?.stale;
  const botStale = botState?.stale ?? false;

  // ── Log de eventos (mensajes Telegram) ───────────────────────────────
  const [events, setEvents] = useState([]);

  // ── Hooks de precio y mercado ─────────────────────────────────────────
  const { price, prev, source, error: priceError, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, active: marketActive, error: marketError, apiResponse: marketApiResponse } = useMarket();
  const now = useClock();

  // ── Derived values ────────────────────────────────────────────────────
  const minsLeft     = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);

  // Target desde bot-state (autoritativo)
  const target = botState?.target ?? null;
  const dist   = price != null && target != null ? price - target : null;

  // Señal visual
  const decision = config && price && target ? getDecision(price, target, config) : null;

  // Stats desde bets
  const closedBets = bets.filter(b => b.result && b.result !== "PENDING");
  const wins       = closedBets.filter(b => b.result === "WIN").length;
  const losses     = closedBets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total      = closedBets.length;
  const winrate    = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal   = closedBets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);
  const activeBet  = bets.find(b => b.result === "PENDING") ?? null;

  // Slug corto para header
  const marketSlugShort = market?.slug?.split("-").slice(-3).join("-") ?? null;

  // ─────────────────────────────────────────────────────────────────────
  // EFFECTS
  // ─────────────────────────────────────────────────────────────────────

  // ── 1. Cargar bets desde Supabase ─────────────────────────────────────
  const loadBets = useCallback(async () => {
    try {
      const res  = await fetch("/api/bets?limit=500");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = data.bets ?? [];
      if (rows.length > 0) {
        setBets(rows);
        try { localStorage.setItem(LS_KEY, JSON.stringify(rows.slice(0, 500))); } catch {}
      }
    } catch (e) {
      console.warn("[Dashboard] Error cargando bets:", e.message);
    }
  }, []);

  useEffect(() => {
    try {
      const saved  = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) setBets(parsed);
      }
    } catch {}
    loadBets();
    const id = setInterval(loadBets, BETS_POLL_MS);
    return () => clearInterval(id);
  }, [loadBets]);

  // ── 2. Estado del bot desde /api/bot-state ────────────────────────────
  useEffect(() => {
    async function fetchBotState() {
      try {
        const res  = await fetch("/api/bot-state");
        if (!res.ok) return;
        const data = await res.json();
        setBotState(data);
        if (data.stake_usdc) {
          setConfig(c => ({ ...c, stake_usdc: parseFloat(data.stake_usdc) }));
        }
      } catch {}
    }
    fetchBotState();
    const id = setInterval(fetchBotState, BOTSTATE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── 3. Log de eventos — acumulativo, no reemplaza ─────────────────────
  //
  // FIX v4.1: si el servidor devuelve [] (instancia fría de Vercel),
  // conservar el estado local. Solo añadir eventos nuevos (merge por id).
  // FIX v4.2: fmtTime ahora acepta ts_iso o ts, corregido en render.
  const loadEvents = useCallback(async () => {
    try {
      const res      = await fetch("/api/events");
      if (!res.ok) return;
      const data     = await res.json();
      const incoming = data.events ?? [];

      if (incoming.length === 0) return;

      setEvents(prev => {
        const prevIds = new Set(prev.map(e => e.id));
        const newOnes = incoming.filter(e => !prevIds.has(e.id));
        if (newOnes.length === 0) return prev;
        return [...newOnes, ...prev].slice(0, 100);
      });
    } catch {}
  }, []);

  useEffect(() => {
    loadEvents();
    const id = setInterval(loadEvents, EVENTS_POLL_MS);
    return () => clearInterval(id);
  }, [loadEvents]);

  // ── 4. Leer stake_usdc del bot desde bot_config en Supabase ──────────
  useEffect(() => {
    async function fetchStake() {
      try {
        const res  = await fetch("/api/config?key=stake_usdc");
        if (!res.ok) return;
        const data = await res.json();
        if (data.value) {
          const v = parseFloat(data.value);
          if (!isNaN(v) && v > 0) setConfig(c => ({ ...c, stake_usdc: v }));
        }
      } catch {}
    }
    fetchStake();
  }, []);

  // ── 5. Precio history — FIX v4.2: incluye target en cada punto ───────
  //
  // PriceChart usa d.target en el tooltip. Sin este campo, el tooltip
  // nunca mostraba el target aunque la ReferenceLine sí lo dibujara.
  useEffect(() => {
    if (!price) return;
    setPriceHistory(h => {
      const ts = new Date().toLocaleTimeString("es-ES", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      // Capturar target en el mismo closure donde price está actualizado
      return [...h, { ts, price, target }].slice(-60);
    });
  }, [price, target]);

  // ─────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh", background: "var(--bg)",
      fontFamily: "'JetBrains Mono', monospace",
      color: "var(--text)", fontSize: 12,
    }}>

      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 20px", borderBottom: "1px solid var(--border)",
        background: "#02020a",
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: running ? "var(--green)" : "var(--red)",
            boxShadow: running ? "0 0 12px var(--green)" : "0 0 8px var(--red)",
            animation: running ? "pulse 2s infinite" : "none",
          }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em" }}>
            POLYBOT
          </span>
          {botStale && <Tag color="var(--yellow)">BOT STALE</Tag>}
          {marketSlugShort && (
            <Tag color="#4488ff">{marketSlugShort}</Tag>
          )}
          {activeBet && (
            <Tag color={activeBet.direction === "UP" ? "var(--green)" : "var(--red)"}>
              {activeBet.direction === "UP" ? "▲" : "▼"} APUESTA ACTIVA
            </Tag>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {target && (
            <span style={{ fontSize: 10, color: "var(--yellow)", letterSpacing: "0.08em" }}>
              TARGET <span style={{ fontWeight: 700 }}>
                ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            </span>
          )}
          <span style={{ fontSize: 10, color: "#444" }}>
            {now.toLocaleTimeString("es-ES", { hour12: false })}
          </span>
        </div>
      </header>

      {/* ── TABS ─────────────────────────────────────────────────────────── */}
      <nav style={{
        display: "flex", borderBottom: "1px solid var(--border)",
        background: "#020208",
      }}>
        {[
          { key: "dashboard", label: "DASHBOARD" },
          { key: "historial", label: "HISTORIAL" },
          { key: "stats",     label: "ESTADÍSTICAS" },
          { key: "config",    label: "CONFIG" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "10px 20px", fontSize: 9, letterSpacing: "0.15em",
              color: tab === key ? "var(--text)" : "#444",
              borderBottom: tab === key ? "2px solid var(--green)" : "2px solid transparent",
              fontFamily: "inherit",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* ── STATS BAR (solo dashboard) ────────────────────────────────────── */}
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
          <StatBox label="OPS" value={total} color="var(--dim)" />
          <div style={{ marginLeft: "auto", fontSize: 9, color: "#333", alignSelf: "center" }}>
            ↻ sync cada 10s · fuente: Supabase
          </div>
        </div>
      )}

      {/* ── PANEL PRINCIPAL 3-columnas ────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          borderBottom: "1px solid var(--border)",
        }}>

          {/* BTC PRICE */}
          <div style={{ background: "var(--bg)", padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>
              BTC / USDT
              {source && <span style={{ color: "#333", marginLeft: 6 }}>{source.toUpperCase()}</span>}
            </div>
            <div style={{
              fontSize: 38, fontWeight: 700, lineHeight: 1,
              color: price && prev ? (price >= prev ? "var(--green)" : "var(--red)") : "var(--text)",
            }}>
              {price ? `$${fmt(price, 2)}` : (priceLoading ? "..." : "—")}
            </div>
            {prev && price && (
              <div style={{ fontSize: 11, color: price >= prev ? "var(--green)" : "var(--red)", marginTop: 4 }}>
                {price >= prev ? "▲" : "▼"} ${Math.abs(price - prev).toFixed(2)}
              </div>
            )}
            {/* TARGET value */}
            {target && (
              <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
                TARGET{" "}
                <span style={{ color: "var(--yellow)", fontWeight: 700 }}>
                  ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
                {dist != null && (
                  <span style={{
                    marginLeft: 8,
                    color: dist > 0 ? "#4488ff" : "#ff8800",
                    fontWeight: 700,
                  }}>
                    ({dist > 0 ? "+" : ""}{fmtUSD(dist)})
                  </span>
                )}
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <WindowBar minsLeft={minsLeft} activeWindow={activeWindow} />
            </div>
          </div>

          {/* SEÑAL */}
          <div style={{ background: "var(--bg)", padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>SEÑAL VISUAL</div>
            {activeWindow && decision ? (
              <>
                <div style={{
                  fontSize: 28, fontWeight: 700,
                  color: decision.direction === "UP" ? "var(--green)" : decision.direction === "DOWN" ? "var(--red)" : "#555",
                }}>
                  {decision.direction === "UP" ? "▲ UP" : decision.direction === "DOWN" ? "▼ DOWN" : "— WAIT"}
                </div>
                {decision.direction !== "WAIT" && (
                  <div style={{ fontSize: 10, color: "#666", marginTop: 6 }}>
                    ventana {activeWindow}
                  </div>
                )}
                {target && (
                  <div style={{ marginTop: 10, fontSize: 11 }}>
                    <div style={{ color: "#444", marginBottom: 4 }}>
                      TARGET <span style={{ color: "var(--yellow)", fontWeight: 700 }}>
                        ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    {dist != null && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ color: "#333" }}>Δ</span>
                        <span style={{
                          color: (dist ?? 0) > (decision.threshold ?? 0)
                            ? "var(--green)" : "var(--red)",
                          fontWeight: 700,
                        }}>
                          ${Math.abs(dist ?? 0).toFixed(0)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#555" }}>
                {!activeWindow ? "Fuera de ventana de entrada" : "Sin precio/target"}
                {target && (
                  <div style={{ marginTop: 8, color: "#666" }}>
                    Target:{" "}
                    <span style={{ color: "var(--yellow)" }}>
                      ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* MERCADO ACTIVO */}
          <div style={{ background: "var(--bg)" }}>
            <MarketInfo
              market={market}
              minsLeft={minsLeft}
              activeWindow={activeWindow}
              error={marketError}
              apiResponse={marketApiResponse}
            />
          </div>
        </div>
      )}

      {/* ── GRÁFICA BTC ──────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "12px 20px" }}>
            <PriceChart data={priceHistory} target={target} />
          </div>
        </div>
      )}

      {/* ── LOG DE EVENTOS ────────────────────────────────────────────────── */}
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
                  ↻ sync cada 5s · fuente: bot ({events.length})
                </div>
                {events.length > 0 && (
                  <button
                    onClick={() => setEvents([])}
                    style={{
                      background: "none", border: "1px solid #1a1a2e", color: "#333",
                      fontSize: 8, padding: "2px 6px", borderRadius: 2, cursor: "pointer",
                      fontFamily: "inherit", letterSpacing: "0.1em",
                    }}
                  >
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
                  Sin eventos aún — esperando mensajes del bot
                  {running && (
                    <span style={{ color: "#333", marginLeft: 8 }}>
                      · verifica FRONTEND_URL en Railway
                    </span>
                  )}
                </div>
              ) : (
                events.map(ev => (
                  <div key={ev.id} style={{
                    fontSize: 10,
                    color: eventColor(ev.text),
                    marginBottom: 3,
                    lineHeight: 1.55,
                    borderBottom: "1px solid #0a0a14",
                    paddingBottom: 3,
                  }}>
                    {/* FIX v4.2: timestamp visible + acepta ts_iso o ts (ms) */}
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

      {/* ── HISTORIAL ────────────────────────────────────────────────────── */}
      {tab === "historial" && (
        <div>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            background: "#02020a",
          }}>
            <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.12em" }}>
              {bets.length} OPERACIONES · FUENTE: SUPABASE · CLIC EN FILA PARA DETALLES
            </span>
            {bets.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm("¿Limpiar caché local?")) {
                    localStorage.removeItem(LS_KEY);
                    setBets([]);
                  }
                }}
                style={{
                  background: "none", border: "1px solid #1a1a2e",
                  color: "#333", fontSize: 9, padding: "3px 8px",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                LIMPIAR CACHÉ
              </button>
            )}
          </div>
          <BetsTable bets={bets} />
        </div>
      )}

      {/* ── ESTADÍSTICAS ─────────────────────────────────────────────────── */}
      {tab === "stats" && <StatsPanel />}

      {/* ── CONFIG ───────────────────────────────────────────────────────── */}
      {tab === "config" && (
        <ConfigPanel config={config} onChange={setConfig} />
      )}
    </div>
  );
}
