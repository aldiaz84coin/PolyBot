"use client";
/**
 * Dashboard.jsx — v3.1
 *
 * CAMBIOS v3.1:
 *   - Import de ModeSelector añadido.
 *   - ModeSelector renderizado al inicio de la pestaña "config".
 *
 * CAMBIOS v3.0 (Supabase):
 *   - Persistencia real: carga historial desde /api/bets (Supabase) al montar.
 *   - localStorage como caché rápida de sesión; la fuente canónica es la BD.
 *   - Nueva pestaña "análisis" → <StatsPanel /> con métricas de rendimiento.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  WINDOWS, DEFAULT_CONFIG,
  getDecision, getActiveWindow, getMinsLeft,
  fmt, fmtUSD, fmtPct, genId,
} from "../lib/constants";
import { useBTCPrice, useMarket, useClock, useLog, useBalance } from "../lib/hooks";
import PriceChart   from "./PriceChart";
import WindowBar    from "./WindowBar";
import MarketInfo   from "./MarketInfo";
import BetsTable    from "./BetsTable";
import ConfigPanel  from "./ConfigPanel";
import StatsPanel   from "./StatsPanel";
import ModeSelector from "./ModeSelector"; // v3.1

const LS_KEY = "polymarket_bets_v2";

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
  const [running, setRunning]     = useState(false);
  const [config, setConfig]       = useState(DEFAULT_CONFIG);
  const [tab, setTab]             = useState("dashboard");
  const [bets, setBets]           = useState([]);
  const [activeBet, setActiveBet] = useState(null);
  const [aiText, setAiText]       = useState("Inicia el bot para obtener análisis IA en tiempo real.");
  const [aiLoading, setAiLoading] = useState(false);
  const [priceHistory, setPriceHistory] = useState([]);

  const { price, prev, source, error: priceError, loading: priceLoading } = useBTCPrice(true);
  const { market, endMs, active: marketActive, error: marketError, apiResponse } = useMarket();
  const now    = useClock();
  const { log, add: addLog } = useLog();
  const { balance, pnlDay, applyBet, applyResult } = useBalance(500);

  // ── v3.0 Persistencia: Supabase (vía /api/bets) + localStorage ──────────
  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      // 1. Mostrar localStorage de inmediato como caché rápida
      try {
        const saved = localStorage.getItem(LS_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) setBets(parsed);
        }
      } catch {}

      // 2. Cargar desde Supabase (fuente canónica)
      try {
        const res = await fetch("/api/bets?limit=500");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rows = data.bets ?? [];
        if (!cancelled && rows.length > 0) {
          setBets(rows);
          try { localStorage.setItem(LS_KEY, JSON.stringify(rows.slice(0, 500))); } catch {}
        }
      } catch (e) {
        console.warn("[Dashboard] Supabase load failed:", e.message);
      }
    }

    loadHistory();
    return () => { cancelled = true; };
  }, []);

  // ── Persistir bets en localStorage cuando cambian ─────────────────────
  useEffect(() => {
    if (bets.length === 0) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(bets.slice(0, 500))); } catch {}
  }, [bets]);

  // ── Precio history ────────────────────────────────────────────────────
  useEffect(() => {
    if (!price) return;
    setPriceHistory(h => {
      const next = [...h, { t: Date.now(), p: price }];
      return next.slice(-60);
    });
  }, [price]);

  // ── Target (Price to Beat) ─────────────────────────────────────────────
  const [target, setTarget]           = useState(null);
  const [targetError, setTargetError] = useState(null);
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

  // Marcar stale si target > 75 min sin actualizar
  useEffect(() => {
    const iv = setInterval(() => {
      if (targetRef.current && Date.now() - targetRef.current > 75 * 60_000) {
        setTargetIsStale(true);
      }
    }, 30_000);
    return () => clearInterval(iv);
  }, []);

  // ── Derived timing ────────────────────────────────────────────────────
  const minsLeft    = getMinsLeft(endMs, now);
  const activeWindow = running ? getActiveWindow(minsLeft) : null;

  // ── Señal / decisión ──────────────────────────────────────────────────
  const umbral  = activeWindow ? config[activeWindow.configKey] : 0;
  const decision = (running && price && target && activeWindow)
    ? getDecision(price, target, umbral, activeWindow)
    : null;

  // ── Auto-bet ──────────────────────────────────────────────────────────
  const lastBetWindow = useRef(null);
  useEffect(() => {
    if (!running || !decision?.signal || !activeWindow) return;
    if (lastBetWindow.current === activeWindow.key) return;
    lastBetWindow.current = activeWindow.key;

    const odds = 0.5;
    const stake = config.stake_usdc;
    const retorno_est = stake * (1 / odds - 1);
    const newBet = {
      id: genId(), dir: decision.dir, entry: price,
      stake, odds, retorno_est,
      window: activeWindow.key, result: "PENDING",
      pnl: null, pnl_usd: null,
      ts: new Date().toISOString(),
    };
    setActiveBet(newBet);
    setBets(prev => [newBet, ...prev]);
    applyBet(stake);
    addLog(`📍 ${decision.dir} @ $${fmt(price, 2)} · ventana ${activeWindow.key}`, "success");

    fetch("/api/bets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newBet),
    }).catch(() => {});
  }, [decision, activeWindow, running]);

  // ── Auto-resolve ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeBet || minsLeft > 0 || !price) return;
    const won = activeBet.dir === "UP" ? price > activeBet.entry : price < activeBet.entry;
    const stake = activeBet.stake;
    const pnl_usd = won ? stake * (1 / activeBet.odds - 1) : -stake;
    const pnl_pct = parseFloat(((pnl_usd / stake) * 100).toFixed(1));

    setBets(prev => prev.map(bet =>
      bet.id === activeBet.id
        ? { ...bet, result: won ? "WIN" : "LOSS", pnl: pnl_pct, pnl_usd }
        : bet
    ));
    setActiveBet(null);
    applyResult(stake, won, config.stop_loss_pct);
    addLog(
      `${won ? "✅ WIN" : "❌ LOSS"} — P&L: ${fmtUSD(pnl_usd)} (${pnl_pct > 0 ? "+" : ""}${pnl_pct}%)`,
      won ? "success" : "error",
    );

    fetch("/api/bets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeBet.id, result: won ? "WIN" : "LOSS", pnl: pnl_pct, pnl_usd }),
    }).catch(() => {});
  }, [minsLeft, running, activeBet, price, target]);

  // ── Derived display values ─────────────────────────────────────────────
  const dist = (price && target) ? price - target : null;

  const marketSlugShort = market?.slug
    ? market.slug.replace("bitcoin-up-or-down-", "")
    : null;

  const targetTag = targetIsStale
    ? { color: "var(--red)",    label: "TARGET STALE" }
    : targetError
    ? { color: "var(--yellow)", label: "TARGET ERR"   }
    : null;

  const wins     = bets.filter(b => b.result === "WIN").length;
  const losses   = bets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total    = wins + losses;
  const winrate  = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal = bets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
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
          {/* v3.1 — bumped */}
          <Tag color="#2a4a3a">v3.1</Tag>
          {marketActive
            ? <Tag color="#1a3a2a">MERCADO ACTIVO {marketSlugShort ? `· ${marketSlugShort}` : ""}</Tag>
            : <Tag color="#3a1a1a">SIN MERCADO</Tag>
          }
          {targetTag && <Tag color={targetTag.color}>{targetTag.label}</Tag>}
          {target && !targetIsStale && (
            <Tag color="#1a2a3a">TARGET ${fmt(target, 0)}</Tag>
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
          <button
            onClick={() => setRunning(r => !r)}
            style={{
              background: running ? "rgba(255,68,102,0.15)" : "rgba(0,255,136,0.12)",
              border: `1px solid ${running ? "rgba(255,68,102,0.4)" : "rgba(0,255,136,0.3)"}`,
              color: running ? "var(--red)" : "var(--green)",
              padding: "5px 16px", borderRadius: 3,
              fontSize: 10, letterSpacing: "0.14em", cursor: "pointer",
              fontWeight: 700,
            }}>
            {running ? "■ DETENER" : "▶ INICIAR"}
          </button>
        </div>
      </header>

      {/* ── DASHBOARD ──────────────────────────────────────────────────────── */}
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
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>SEÑAL ACTIVA</div>
            {activeWindow && decision ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ color: activeWindow.color, fontSize: 12, fontWeight: 700 }}>
                    [{activeWindow.key}]
                  </span>
                  <span style={{
                    fontSize: 28, fontWeight: 700,
                    color: decision.dir === "UP" ? "var(--green)"
                         : decision.dir === "DOWN" ? "var(--red)" : "var(--dim)",
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
                {running && targetIsStale  ? "⚠ TARGET STALE"
                 : running && !target      ? "⚠ SIN TARGET"
                 : running                 ? "— FUERA DE VENTANA —"
                 :                          "— BOT DETENIDO —"}
              </div>
            )}

            {activeBet && (
              <div style={{
                marginTop: 12, padding: "8px 10px",
                background: "rgba(255,204,0,0.06)", border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, fontSize: 10, color: "var(--yellow)",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ fontWeight: 700 }}>● POSICIÓN ACTIVA — {activeBet.dir}</div>
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
          </div>
        </div>
      )}

      {/* ── STATS BAR ──────────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "flex", gap: 32, padding: "14px 24px",
          borderBottom: "1px solid var(--border)", background: "#02020a",
          flexWrap: "wrap",
        }}>
          <StatBox label="BALANCE"   value={fmtUSD(balance)}  color={balance >= 500 ? "var(--green)" : "var(--red)"} />
          <StatBox label="P&L HOY"   value={fmtUSD(pnlDay)}   color={pnlDay   >= 0  ? "var(--green)" : "var(--red)"} />
          <StatBox label="P&L TOTAL" value={fmtUSD(pnlTotal)} color={pnlTotal >= 0  ? "var(--green)" : "var(--red)"} />
          <StatBox label="WINRATE"   value={winrate != null ? `${winrate.toFixed(0)}%` : "—"} color="var(--yellow)" sub={`${wins}W / ${losses}L`} />
          <StatBox label="OPS"       value={total}             color="var(--dim)" />
        </div>
      )}

      {/* ── MERCADO + CHART + LOG ───────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid var(--border)" }}>
          <div style={{ borderRight: "1px solid var(--border)" }}>
            <MarketInfo market={market} minsLeft={minsLeft} activeWindow={activeWindow} />
          </div>
          <div>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>PRECIO BTC — ÚLTIMOS 60s</div>
              <PriceChart data={priceHistory} target={target} />
            </div>
            {/* IA */}
            <div style={{ padding: "12px 20px" }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 6 }}>ANÁLISIS IA</div>
              <div style={{ fontSize: 11, color: aiLoading ? "var(--dim)" : "var(--text)", lineHeight: 1.6 }}>
                {aiLoading ? "⏳ Analizando señal..." : aiText}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LOG ────────────────────────────────────────────────────────────── */}
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

      {/* ── HISTORIAL ──────────────────────────────────────────────────────── */}
      {tab === "historial" && (
        <div>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            background: "#02020a",
          }}>
            <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.12em" }}>
              {bets.length} OPERACIONES REGISTRADAS · CLIC EN FILA PARA DETALLES
            </span>
            {bets.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm("¿Borrar historial local? (Supabase no se modifica)")) {
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

      {/* ── ANÁLISIS (v3.0) ────────────────────────────────────────────────── */}
      {tab === "análisis" && <StatsPanel />}

      {/* ── CONFIG (v3.1: ModeSelector añadido) ───────────────────────────── */}
      {tab === "config" && (
        <div style={{ padding: "24px" }}>
          {/* Selector de modo Simulado / Real */}
          <div style={{ marginBottom: 32 }}>
            <ModeSelector />
          </div>
          {/* Parámetros de estrategia */}
          <ConfigPanel config={config} onChange={setConfig} />
        </div>
      )}

    </div>
  );
}
