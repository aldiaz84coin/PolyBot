"use client";
/**
 * Dashboard.jsx — v4.0
 *
 * CAMBIOS v4.0
 * ────────────────────────────────────────────────────────────
 *  1. MERCADO ACTIVO: MarketInfo simplificado — muestra solo SLUG + link.
 *     La fuente sigue siendo bot-state (prioridad) o /api/market (fallback).
 *
 *  2. LOG DE EVENTOS: ahora muestra los mismos mensajes que Telegram.
 *     El bot (notifier.py) postea a /api/events; el dashboard los lee
 *     cada 5s. Polling simple, sin lógica de Supabase en el log.
 *
 *  3. ANÁLISIS IA: sección eliminada.
 *     - Quitados: aiText, aiLoading state, fetch a /api/analysis, y el
 *       bloque JSX "ANÁLISIS IA" de la columna derecha.
 *     - La columna derecha ahora muestra solo el gráfico BTC.
 *
 * (sin otros cambios respecto a v3.4)
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

/** Devuelve HH:MM:SS desde un ISO string o timestamp ms */
function fmtTime(tsIso) {
  try {
    const d = new Date(tsIso);
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/** Colorea el evento por su primer emoji */
function eventColor(text) {
  if (!text) return "#555";
  if (text.startsWith("✅") || text.startsWith("🟢") || text.startsWith("🤖")) return "var(--green)";
  if (text.startsWith("❌") || text.startsWith("🛑") || text.startsWith("⛔") || text.startsWith("🚨")) return "var(--red)";
  if (text.startsWith("⚠")) return "var(--yellow)";
  return "#777";
}

export default function Dashboard() {
  const [config, setConfig]       = useState(DEFAULT_CONFIG);
  const [tab, setTab]             = useState("dashboard");
  const [bets, setBets]           = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);

  // ── Estado del bot ────────────────────────────────────────────────────
  const [botState, setBotState] = useState(null);
  const running  = botState?.status === "running" && !botState?.stale;
  const botStale = botState?.stale ?? true;

  // ── Log de eventos (mensajes Telegram) ───────────────────────────────
  const [events, setEvents]       = useState([]);
  const lastEventIdRef            = useRef(null);

  // ── Hooks de precio y mercado ─────────────────────────────────────────
  const { price, prev, source, error: priceError, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, active: marketActive, error: marketError, apiResponse: marketApiResponse } = useMarket();
  const now = useClock();

  // ── Derived values ────────────────────────────────────────────────────
  const minsLeft    = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);

  // Target desde bot-state
  const target = botState?.target ?? null;
  const dist   = price != null && target != null ? price - target : null;

  // Señal visual
  const decision    = config && price && target ? getDecision(price, target, config) : null;

  // Stats desde bets
  const closedBets  = bets.filter(b => b.result && b.result !== "PENDING");
  const wins        = closedBets.filter(b => b.result === "WIN").length;
  const losses      = closedBets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total       = closedBets.length;
  const winrate     = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal    = closedBets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);
  const activeBet   = bets.find(b => b.result === "PENDING") ?? null;

  // Target tag
  const targetTag = target
    ? dist > 0
      ? { label: `▲ +$${Math.abs(dist).toFixed(0)}`, color: "#2a3a5a" }
      : dist < 0
      ? { label: `▼ -$${Math.abs(dist).toFixed(0)}`, color: "#3a2a1a" }
      : null
    : null;

  // Slug corto para header
  const marketSlugShort = market?.slug?.split("-").slice(-3).join("-") ?? null;

  // ── 1. Cargar bets desde Supabase ─────────────────────────────────────
  const loadBets = useCallback(async () => {
    try {
      const res = await fetch("/api/bets?limit=500");
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

  // ── 2. Estado del bot desde /api/bot-state ────────────────────────────
  useEffect(() => {
    async function fetchBotState() {
      try {
        const res = await fetch("/api/bot-state");
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

  // ── 3. Log de eventos: mensajes del bot (= mismos que Telegram) ───────
  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/events");
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events ?? []);
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
        const res = await fetch("/api/config?key=stake_usdc");
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

  // ── 5. Precio history ─────────────────────────────────────────────────
  useEffect(() => {
    if (!price) return;
    setPriceHistory(h => {
      const ts = new Date().toLocaleTimeString("es-ES", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      return [...h, { ts, price }].slice(-60);
    });
  }, [price]);

  // ── 6. Target stale watchdog ──────────────────────────────────────────
  // (target viene directo de bot-state, no necesitamos fetch separado)

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
            animation: running ? "pulse 1.5s infinite" : "none",
          }} />
          <span style={{ color: "var(--green)", fontWeight: 700, letterSpacing: "0.12em", fontSize: 14 }}>
            POLYMARKET BTC BOT
          </span>
          <Tag color="#2a4a3a">v4.0</Tag>
          {running
            ? <Tag color="#1a3a2a">BOT ACTIVO</Tag>
            : botStale
            ? <Tag color="#3a1a1a">BOT OFFLINE</Tag>
            : <Tag color="#2a2a1a">BOT DETENIDO</Tag>
          }
          {marketActive
            ? <Tag color="#1a3a2a">MERCADO {marketSlugShort ? `· ${marketSlugShort}` : ""}</Tag>
            : <Tag color="#3a1a1a">SIN MERCADO</Tag>
          }
          {targetTag && <Tag color={targetTag.color}>{targetTag.label}</Tag>}
          {target && (
            <Tag color="#1a2a3a">TARGET ${fmt(target, 0)}</Tag>
          )}
          {activeBet && (
            <Tag color="#3a2a1a">● {activeBet.dir ?? activeBet.direction} PENDING</Tag>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {["dashboard", "historial", "análisis", "config"].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? "var(--border)" : "transparent",
                border: "1px solid",
                borderColor: tab === t ? "var(--border)" : "transparent",
                color: tab === t ? "var(--text)" : "var(--dim)",
                padding: "4px 12px", borderRadius: 3, fontSize: 10,
                letterSpacing: "0.12em", cursor: "pointer",
                textTransform: "uppercase",
              }}>
              {t}
            </button>
          ))}
          <div style={{
            background: running ? "rgba(0,255,136,0.08)" : "rgba(255,68,102,0.08)",
            border: `1px solid ${running ? "rgba(0,255,136,0.25)" : "rgba(255,68,102,0.2)"}`,
            color: running ? "var(--green)" : "var(--red)",
            padding: "5px 16px", borderRadius: 3,
            fontSize: 10, letterSpacing: "0.14em", fontWeight: 700,
          }}>
            {running ? "● CORRIENDO" : "○ INACTIVO"}
          </div>
        </div>
      </header>

      {/* ── STATS BAR ────────────────────────────────────────────────────── */}
      {tab === "dashboard" && total > 0 && (
        <div style={{
          display: "flex", gap: 32, padding: "10px 24px",
          borderBottom: "1px solid var(--border)", background: "#020208",
          alignItems: "center",
        }}>
          <StatBox
            label="P&L TOTAL"
            value={fmtUSD(pnlTotal)}
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

      {/* ── PANEL PRINCIPAL ──────────────────────────────────────────────── */}
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
              {source && <span style={{ color: "#222", marginLeft: 6 }}>{source.toUpperCase()}</span>}
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
            {dist != null && target && (
              <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>
                Dist target: <span style={{ color: dist > 0 ? "#4488ff" : "#ff8800", fontWeight: 700 }}>
                  {dist > 0 ? "+" : ""}{fmtUSD(dist)}
                </span>
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
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ color: activeWindow.color, fontSize: 12, fontWeight: 700 }}>
                    [{activeWindow.key}]
                  </span>
                  <span style={{
                    fontSize: 28, fontWeight: 700,
                    color: decision.dir === "UP"   ? "var(--green)"
                         : decision.dir === "DOWN" ? "var(--red)"
                         : "var(--dim)",
                  }}>
                    {decision.dir === "UP" ? "▲ UP" : decision.dir === "DOWN" ? "▼ DOWN" : "— WAIT"}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "#444", lineHeight: 1.8 }}>
                  <div>Umbral: <span style={{ color: "#666" }}>${decision.threshold?.toFixed(0)}</span></div>
                  <div>Distancia: <span style={{
                    color: Math.abs(dist ?? 0) > (decision.threshold ?? 0) ? "var(--green)" : "var(--red)",
                    fontWeight: 700,
                  }}>${Math.abs(dist ?? 0).toFixed(0)}</span></div>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#333" }}>
                {!activeWindow ? "Fuera de ventana de entrada" : "Sin precio/target"}
              </div>
            )}
          </div>

          {/* MERCADO ACTIVO — simplificado v4.0 */}
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

      {/* ── MERCADO + CHART ───────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "12px 20px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>
              PRECIO BTC — ÚLTIMOS 60s
            </div>
            <PriceChart data={priceHistory} target={target} />
          </div>
        </div>
      )}

      {/* ── LOG DE EVENTOS (mensajes Telegram del bot) ────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ padding: "12px 20px" }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em" }}>
              LOG DE EVENTOS
            </div>
            <div style={{ fontSize: 9, color: "#222" }}>
              ↻ sync cada 5s · fuente: bot
            </div>
          </div>
          <div style={{
            maxHeight: 220, overflowY: "auto",
            background: "#010108", border: "1px solid var(--border)",
            borderRadius: 3, padding: "8px 10px",
          }}>
            {events.length === 0 && (
              <div style={{ fontSize: 10, color: "#222" }}>
                Sin eventos aún — el bot no ha enviado mensajes
              </div>
            )}
            {events.map(ev => (
              <div key={ev.id} style={{
                fontSize: 10,
                color: eventColor(ev.text),
                marginBottom: 3,
                lineHeight: 1.55,
                borderBottom: "1px solid #0a0a14",
                paddingBottom: 3,
              }}>
                <span style={{ color: "#2a2a3a", marginRight: 8, userSelect: "none" }}>
                  {fmtTime(ev.ts_iso)}
                </span>
                <span style={{ whiteSpace: "pre-wrap" }}>{ev.text}</span>
              </div>
            ))}
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
              {bets.length} OPERACIONES · FUENTE: SUPABASE (bot) · CLIC EN FILA PARA DETALLES
            </span>
            {bets.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm("¿Limpiar caché local? (Supabase no se modifica)")) {
                    setBets([]);
                    try { localStorage.removeItem(LS_KEY); } catch {}
                  }
                }}
                style={{
                  background: "rgba(255,68,102,0.1)",
                  border: "1px solid rgba(255,68,102,0.3)",
                  color: "var(--red)", fontSize: 9,
                  padding: "4px 10px", borderRadius: 3,
                  cursor: "pointer", letterSpacing: "0.12em",
                }}>
                LIMPIAR CACHÉ LOCAL
              </button>
            )}
          </div>
          <BetsTable bets={bets} />
        </div>
      )}

      {/* ── ANÁLISIS ─────────────────────────────────────────────────────── */}
      {tab === "análisis" && <StatsPanel />}

      {/* ── CONFIG ───────────────────────────────────────────────────────── */}
      {tab === "config" && (
        <div style={{ padding: "24px" }}>
          <div style={{ marginBottom: 32 }}>
            <ModeSelector />
          </div>
          <div style={{
            marginBottom: 16, padding: "10px 14px",
            background: "rgba(255,204,0,0.04)", border: "1px solid rgba(255,204,0,0.15)",
            borderRadius: 3, fontSize: 10, color: "#666",
          }}>
            ⚠ Los umbrales y stake que usa el bot están definidos en Railway (variables de entorno).
            Los valores aquí son solo para la <span style={{ color: "var(--yellow)" }}>visualización de señal</span> en el dashboard.
          </div>
          <ConfigPanel config={config} onChange={setConfig} />
        </div>
      )}

    </div>
  );
}
