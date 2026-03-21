"use client";
/**
 * Dashboard.jsx — v5.1
 *
 * CAMBIOS v5.1
 *   - Import de BalanceWidget añadido
 *   - Sección "MODO DE TRADING" convertida en grid 2 columnas:
 *     izquierda → ModeSelector, derecha → BalanceWidget (liquidez + evolución)
 *
 * CAMBIOS v5.0 — Corrección integral (todos los bugs reportados)
 * ─────────────────────────────────────────────────────────────────────
 * BUG 1 FIX — getDecision recibía `config` (objeto) en lugar del umbral
 *   numérico de la ventana activa. `dist > {objeto}` es siempre false en JS
 *   → la señal siempre era WAIT. Ahora: getDecision(price, target, umbral)
 *   donde umbral = config[activeWindow.configKey] ?? 200.
 *
 * BUG 2 FIX — getDecision devolvía { dir, ... } pero el render usaba
 *   decision.direction y decision.threshold (siempre undefined).
 *   Corregido en constants.js v2.0 (direction, threshold). El render ya
 *   era correcto, solo fallaba la fuente de datos.
 *
 * BUG 3 FIX — activeWindow es un OBJETO { key, label, color, ... } pero el
 *   render hacía `{activeWindow}` → "[object Object]". Corregido:
 *   `{activeWindow?.label}`.
 *
 * BUG 4 FIX — botState se polleaba en un useEffect ad-hoc. Reemplazado por
 *   el hook useBotState() de hooks.js v4.0, que también alimenta useMarket()
 *   sin duplicar la llamada HTTP a /api/bot-state.
 *
 * BUG 5 FIX — priceHistory capturaba target desde closure; si target llegaba
 *   tarde, los primeros puntos del historial tenían target:null y la
 *   ReferenceLine no aparecía. Ahora: target se pasa directamente como prop
 *   a <PriceChart> (ya lo era) y se garantiza que el efecto registra target
 *   también cuando cambia de null a número.
 *
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
import PriceChart   from "./PriceChart";
import WindowBar    from "./WindowBar";
import MarketInfo   from "./MarketInfo";
import BetsTable    from "./BetsTable";
import ConfigPanel  from "./ConfigPanel";
import StatsPanel   from "./StatsPanel";
import ModeSelector  from "./ModeSelector";
import BalanceWidget from "./BalanceWidget";

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

  // ── Hooks de datos ────────────────────────────────────────────────────────
  //
  // FIX v5.0: useBotState() reemplaza el useEffect ad-hoc.
  // Se pasa botState.raw a useMarket() para evitar doble fetch a /api/bot-state.

  const botState = useBotState();
  const { price, prev, source, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, error: marketError, apiResponse: marketApiResponse } = useMarket(botState.raw);
  const now = useClock();

  // ── Valores derivados ─────────────────────────────────────────────────────

  const minsLeft     = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);   // objeto { key, label, ... } o null

  // Target: lo que el bot reporta como "precio de apertura de vela"
  const target = botState.target ?? null;
  const dist   = price != null && target != null ? price - target : null;

  // FIX v5.0 BUG 1: pasar el umbral numérico de la ventana activa, no el config completo.
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

  // ── Effects ───────────────────────────────────────────────────────────────

  // 1. Bets desde Supabase
  const loadBets = useCallback(async () => {
    try {
      const res  = await fetch("/api/bets?limit=500");
      if (!res.ok) return;
      const data = await res.json();
      const rows = data.bets ?? [];
      if (rows.length > 0) {
        setBets(rows);
        try { localStorage.setItem(LS_KEY, JSON.stringify(rows.slice(0, 500))); } catch {}
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) setBets(parsed);
      }
    } catch {}
    loadBets();
    const id = setInterval(loadBets, BETS_POLL_MS);
    return () => clearInterval(id);
  }, [loadBets]);

  // 2. Eventos del bot (mensajes Telegram replicados)
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

  // 3. Historial de precio para la gráfica
  //    FIX v5.0 BUG 5: target incluido en deps para que cada punto de historial
  //    capture el target correcto en cuanto llega del bot.
  useEffect(() => {
    if (!price) return;
    const ts = new Date().toLocaleTimeString("es-ES", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    setPriceHistory(h => [...h, { ts, price, target }].slice(-60));
  }, [price, target]);

  // 4. Stake USDC desde config API (si disponible)
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh", background: "var(--bg)",
      fontFamily: "'JetBrains Mono', monospace",
      color: "var(--text)", fontSize: 12,
    }}>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 20px", borderBottom: "1px solid var(--border)",
        background: "#02020a",
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: botState.running ? "var(--green)" : "var(--red)",
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
          { key: "dashboard",  label: "DASHBOARD"     },
          { key: "historial",  label: "HISTORIAL"     },
          { key: "stats",      label: "ESTADÍSTICAS"  },
          { key: "config",     label: "CONFIG"        },
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

      {/* ── PANEL PRINCIPAL 3-columnas ──────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
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
                    ({dist > 0 ? "+" : ""}{fmtUSD(dist)})
                  </span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: "#333", marginTop: 8 }}>
                TARGET — (bot offline o sin vela)
              </div>
            )}

            {/* WindowBar — FIX v5.0: minsLeft siempre válido */}
            <div style={{ marginTop: 16 }}>
              <WindowBar minsLeft={minsLeft} activeWindow={activeWindow} />
            </div>
          </div>

          {/* COLUMNA 2 — SEÑAL VISUAL */}
          <div style={{ padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>SEÑAL VISUAL</div>

            {activeWindow && decision ? (
              <>
                {/* FIX v5.0 BUG 2: decision.direction (no decision.dir) */}
                <div style={{
                  fontSize: 28, fontWeight: 700,
                  color: decision.direction === "UP"   ? "var(--green)"
                       : decision.direction === "DOWN" ? "var(--red)"
                       : "#555",
                }}>
                  {decision.direction === "UP"   ? "▲ UP"
                   : decision.direction === "DOWN" ? "▼ DOWN"
                   : "— WAIT"}
                </div>

                {/* FIX v5.0 BUG 3: activeWindow?.label no {activeWindow} */}
                <div style={{ fontSize: 10, color: activeWindow.color, marginTop: 6 }}>
                  ventana {activeWindow.label}
                </div>

                {target != null && (
                  <div style={{ marginTop: 10, fontSize: 11 }}>
                    <div style={{ color: "#444", marginBottom: 4 }}>
                      TARGET{" "}
                      <span style={{ color: "var(--yellow)", fontWeight: 700 }}>
                        ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    {dist != null && umbral != null && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ color: "#333" }}>Δ</span>
                        <span style={{
                          color: Math.abs(dist) > umbral ? "var(--green)" : "var(--red)",
                          fontWeight: 700,
                        }}>
                          ${Math.abs(dist).toFixed(0)}
                        </span>
                        <span style={{ color: "#333" }}>/ umbral ${umbral}</span>
                      </div>
                    )}
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
          <div>
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

      {/* ── GRÁFICA BTC ─────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "12px 20px" }}>
            {/* FIX v5.0: target pasado directamente como prop — ReferenceLine siempre actualizado */}
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

      {/* ── MODO DE TRADING + LIQUIDEZ ──────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 0,
          borderBottom: "1px solid var(--border)",
        }}>
          {/* Columna izquierda: modo de trading */}
          <div style={{
            padding: "20px 24px",
            borderRight: "1px solid var(--border)",
          }}>
            <ModeSelector />
          </div>

          {/* Columna derecha: liquidez + gráfico evolución */}
          <div style={{ padding: "20px 24px" }}>
            <BalanceWidget />
          </div>
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
      {tab === "config" && <ConfigPanel config={config} onChange={setConfig} />}
    </div>
  );
}
