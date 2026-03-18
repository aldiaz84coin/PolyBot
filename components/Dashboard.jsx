"use client";
/**
 * Dashboard.jsx — v3.4
 *
 * CAMBIOS v3.4 — FIX MERCADO + LOG DE EVENTOS
 * ─────────────────────────────────────────────────────────────
 *  FIX 1: Mercado activo siempre mostraba "Buscando..."
 *    - useMarket() ya devolvía error y apiResponse, pero Dashboard no
 *      los pasaba a <MarketInfo>. Añadidos error={marketError} y
 *      apiResponse={marketApiResponse} al render de MarketInfo.
 *
 *  FIX 2: Log de eventos siempre vacío
 *    - useLog() es in-memory: se llena solo mientras el dashboard
 *      está abierto. Ahora se alimenta de dos fuentes:
 *      a) Cambios de botState en tiempo real (via useRef + useEffect).
 *      b) Historial reciente de Supabase al montar (GET /api/events).
 *
 * CAMBIOS v3.3 — ARQUITECTURA: Dashboard = solo lector, Bot = único escritor
 * ─────────────────────────────────────────────────────────────────────────
 *  - Eliminados auto-bet y auto-resolve.
 *  - El bot (Railway) es la ÚNICA fuente de escritura en Supabase.
 *  - Dashboard solo lee /api/bets (Supabase) cada 10s.
 *  - activeBet se deriva de bets: la primera operación con result=PENDING.
 *  - stake_usdc se lee de /api/config?key=stake_usdc.
 *  - running se lee de /api/bot-state.
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

const LS_KEY           = "polymarket_bets_v2";
const BETS_POLL_MS     = 10_000;
const BOTSTATE_POLL_MS = 5_000;

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

export default function Dashboard() {
  // ── Config local (umbrales y stake — stake se sobreescribe desde bot_config)
  const [config, setConfig]       = useState(DEFAULT_CONFIG);
  const [tab, setTab]             = useState("dashboard");
  const [bets, setBets]           = useState([]);
  const [aiText, setAiText]       = useState("El bot debe estar activo para generar análisis IA.");
  const [aiLoading, setAiLoading] = useState(false);
  const [priceHistory, setPriceHistory] = useState([]);

  // ── Estado del bot leído desde /api/bot-state ─────────────────────────
  const [botState, setBotState] = useState(null);
  const running  = botState?.status === "running" && !botState?.stale;
  const botStale = botState?.stale ?? true;

  // ── v3.4: destructurar error y apiResponse de useMarket ──────────────
  const { price, prev, source, error: priceError, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, active: marketActive, error: marketError, apiResponse: marketApiResponse } = useMarket();
  const now = useClock();
  const { log, add: addLog } = useLog();

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

  // ── 3. Log automático desde cambios de botState (v3.4) ───────────────
  const prevBotRef = useRef(null);
  useEffect(() => {
    if (!botState) return;
    const prev = prevBotRef.current;

    if (!prev && botState.status === "running") {
      addLog("🟢 Bot conectado al dashboard", "success");
    }
    if (botState.status === "offline" && prev?.status === "running") {
      addLog("🔴 Bot desconectado", "error");
    }
    if (botState.window && botState.window !== prev?.window) {
      addLog(`📊 Ventana activa: ${botState.window}`, "info");
    }
    if (
      botState.direction &&
      botState.direction !== "WAIT" &&
      botState.direction !== prev?.direction
    ) {
      const icon   = botState.direction === "UP" ? "🟢" : "🔴";
      const btcStr = botState.price
        ? ` | BTC $${Number(botState.price).toLocaleString("en-US")}`
        : "";
      addLog(`${icon} Señal ${botState.direction} | ${botState.window ?? ""}${btcStr}`, "info");
    }
    if (botState.bet_active && !prev?.bet_active) {
      addLog("💰 Apuesta abierta", "success");
    }
    if (botState.bet_active === false && prev?.bet_active === true) {
      addLog("🏁 Posición cerrada", "info");
    }

    prevBotRef.current = botState;
  }, [botState, addLog]);

  // ── 4. Carga histórica del log desde Supabase al montar (v3.4) ───────
  useEffect(() => {
    async function loadRecentEvents() {
      try {
        const res = await fetch("/api/events?limit=30");
        if (!res.ok) return;
        const data = await res.json();
        const entries = data.events ?? [];

        // Añadir en orden cronológico inverso (más reciente primero)
        entries.forEach(ev => {
          const icon =
            ev.type === "signal"
              ? ev.direccion === "UP"   ? "🟢"
              : ev.direccion === "DOWN" ? "🔴"
              : "📊"
              : ev.resultado === "WIN"  ? "✅"
              : ev.resultado === "LOSS" ? "❌"
              : ev.resultado === "STOP" ? "🛑"
              : "🔄";

          const sim = ev.simulado ? " [SIM]" : "";

          const msg =
            ev.type === "signal"
              ? `${icon} Señal ${ev.direccion} [${ev.ventana}]${sim} | Dist $${Math.abs(ev.distancia ?? 0).toFixed(0)}`
              : `${icon} Op ${ev.resultado ?? "PENDING"} ${ev.direccion ?? ""}${sim} | P&L ${
                  ev.pnl_usd != null
                    ? (ev.pnl_usd >= 0 ? "+" : "") + "$" + Math.abs(ev.pnl_usd).toFixed(2)
                    : "—"
                }`;

          const type =
            ev.resultado === "WIN"  ? "success"
          : ev.resultado === "LOSS" || ev.resultado === "STOP" ? "error"
          : "info";

          addLog(msg, type);
        });
      } catch {}
    }
    loadRecentEvents();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 5. Leer stake_usdc del bot desde bot_config en Supabase ──────────
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

  // ── Precio history ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!price) return;
    setPriceHistory(h => {
      const ts = new Date().toLocaleTimeString("es-ES", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      return [...h, { ts, price }].slice(-60);
    });
  }, [price]);

  // ── Target (Price to Beat) ─────────────────────────────────────────────
  const [target, setTarget]               = useState(null);
  const [targetError, setTargetError]     = useState(null);
  const [targetHourUtc, setTargetHourUtc] = useState(null);
  const [targetSource, setTargetSource]   = useState(null);
  const [targetIsStale, setTargetIsStale] = useState(false);
  const targetRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchTarget() {
      try {
        const res = await fetch("/api/target");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.target) {
          setTarget(data.target);
          setTargetError(null);
          setTargetHourUtc(data.hour_utc ?? null);
          setTargetSource(data.source ?? null);
          setTargetIsStale(false);
          targetRef.current = Date.now();
        } else {
          setTargetError(data.error ?? "Sin target");
        }
      } catch (e) {
        if (!cancelled) setTargetError(e.message);
      }
    }
    fetchTarget();
    const iv = setInterval(fetchTarget, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      if (targetRef.current && Date.now() - targetRef.current > 75 * 60_000) {
        setTargetIsStale(true);
      }
    }, 30_000);
    return () => clearInterval(iv);
  }, []);

  // ── Timing ─────────────────────────────────────────────────────────────
  const minsLeft     = getMinsLeft(endMs, now);
  const activeWindow = getActiveWindow(minsLeft);

  // ── Señal visual ───────────────────────────────────────────────────────
  const umbral   = activeWindow ? config[activeWindow.configKey] : 0;
  const decision = (price && target && activeWindow)
    ? getDecision(price, target, umbral, activeWindow)
    : null;

  // ── activeBet: primera operación PENDING en Supabase ──────────────────
  const activeBet = bets.find(b => b.result === "PENDING") ?? null;

  // ── Stats derivadas de bets ────────────────────────────────────────────
  const wins     = bets.filter(b => b.result === "WIN").length;
  const losses   = bets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total    = wins + losses;
  const winrate  = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal = bets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);

  const today  = new Date().toISOString().slice(0, 10);
  const pnlDay = bets
    .filter(b => b.ts?.startsWith(today) && b.result && b.result !== "PENDING")
    .reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);

  const dist = (price && target) ? price - target : null;

  const marketSlugShort = market?.slug
    ? market.slug.replace("bitcoin-up-or-down-", "")
    : null;

  const targetTag = targetIsStale
    ? { color: "var(--red)",    label: "TARGET STALE" }
    : targetError
    ? { color: "var(--yellow)", label: "TARGET ERR"   }
    : null;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}>

      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 20px", borderBottom: "1px solid var(--border)",
        background: "#02020a", position: "sticky", top: 0, zIndex: 100,
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
          <Tag color="#2a4a3a">v3.4</Tag>
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
          {target && !targetIsStale && (
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
                <div style={{ fontSize: 11, color: decision.signal ? "var(--green)" : "#555" }}>
                  {decision.signal
                    ? `DIST $${Math.abs(decision.dist).toFixed(0)} > $${umbral} ✓`
                    : `DIST $${Math.abs(decision.dist).toFixed(0)} < $${umbral}`}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 16, color: "var(--dim)", marginTop: 8 }}>
                {targetIsStale ? "⚠ TARGET STALE"
                  : !target    ? "⚠ SIN TARGET"
                  :              "— FUERA DE VENTANA —"}
              </div>
            )}

            {activeBet && (
              <div style={{
                marginTop: 12, padding: "8px 10px",
                background: "rgba(255,204,0,0.06)", border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, fontSize: 10, color: "var(--yellow)",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ fontWeight: 700 }}>
                  ● POSICIÓN ACTIVA — {activeBet.dir ?? activeBet.direction}
                  {(activeBet.simulated || activeBet.simulado) && (
                    <span style={{ color: "#888", fontWeight: 400, marginLeft: 6 }}>[SIMULADO]</span>
                  )}
                </div>
                <div style={{ color: "#888", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" }}>
                  <span>Entry: {fmtUSD(activeBet.entry)}</span>
                  <span>Stake: {fmtUSD(activeBet.stake)}</span>
                  <span>Odds: {(activeBet.odds ?? 0.5).toFixed(3)}</span>
                  <span>Ret. est.: {fmtUSD(activeBet.retorno_est)}</span>
                </div>
              </div>
            )}
          </div>

          {/* TARGET */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>PRICE TO BEAT</div>
            <div style={{
              fontSize: 32, fontWeight: 700, lineHeight: 1,
              color: targetIsStale ? "var(--red)" : targetError ? "var(--yellow)" : "var(--text)",
            }}>
              {target ? `$${fmt(target, 2)}` : (targetError ? "ERROR" : "—")}
            </div>
            {targetHourUtc != null && (
              <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>
                Vela {targetHourUtc}:00 UTC
                {targetSource && <span style={{ marginLeft: 6, color: "#333" }}>{targetSource}</span>}
              </div>
            )}
            {targetError && (
              <div style={{ fontSize: 10, color: "var(--yellow)", marginTop: 4 }}>{targetError}</div>
            )}
            {botState && (
              <div style={{ fontSize: 9, color: "#333", marginTop: 8 }}>
                Bot last seen: {botState.last_seen
                  ? new Date(botState.last_seen).toLocaleTimeString("es-ES", { hour12: false })
                  : "—"}
                {botState.ops_today != null && (
                  <span style={{ marginLeft: 8 }}>Ops hoy: {botState.ops_today}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STATS BAR ────────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "flex", gap: 32, padding: "14px 24px",
          borderBottom: "1px solid var(--border)", background: "#02020a",
          flexWrap: "wrap", alignItems: "flex-end",
        }}>
          <StatBox
            label="STAKE/OP"
            value={fmtUSD(config.stake_usdc)}
            color="var(--yellow)"
            sub="configurado en bot"
          />
          <StatBox
            label="P&L HOY"
            value={fmtUSD(pnlDay)}
            color={pnlDay >= 0 ? "var(--green)" : "var(--red)"}
          />
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

      {/* ── MERCADO + CHART + LOG ─────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid var(--border)" }}>
          <div style={{ borderRight: "1px solid var(--border)" }}>
            {/* v3.4 FIX: pasar error y apiResponse para que MarketInfo muestre
                el panel de error en vez de quedarse en "Buscando..." */}
            <MarketInfo
              market={market}
              minsLeft={minsLeft}
              activeWindow={activeWindow}
              error={marketError}
              apiResponse={marketApiResponse}
            />
          </div>
          <div>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>PRECIO BTC — ÚLTIMOS 60s</div>
              <PriceChart data={priceHistory} target={target} />
            </div>
            <div style={{ padding: "12px 20px" }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>ANÁLISIS IA</div>
              <div style={{ fontSize: 11, color: aiLoading ? "var(--dim)" : "var(--text)", lineHeight: 1.6 }}>
                {aiLoading ? "⏳ Analizando señal..." : aiText}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LOG DE EVENTOS ────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ padding: "12px 20px" }}>
          <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>LOG DE EVENTOS</div>
          <div style={{
            maxHeight: 180, overflowY: "auto",
            background: "#010108", border: "1px solid var(--border)",
            borderRadius: 3, padding: "8px 10px",
          }}>
            {log.length === 0 && (
              <div style={{ fontSize: 10, color: "#222" }}>Sin eventos aún...</div>
            )}
            {log.map(entry => (
              <div key={entry.id} style={{
                fontSize: 10,
                color: entry.type === "success" ? "var(--green)"
                     : entry.type === "error"   ? "var(--red)"
                     : entry.type === "warning" ? "var(--yellow)"
                     : "#555",
                marginBottom: 2,
              }}>
                <span style={{ color: "#2a2a3a", marginRight: 8 }}>{entry.ts}</span>
                {entry.msg}
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
