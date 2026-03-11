"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  WINDOWS, DEFAULT_CONFIG,
  getDecision, getActiveWindow, getMinsLeft,
  fmt, fmtUSD, fmtPct, genId,
} from "../lib/constants";
import { useBTCPrice, useMarket, useClock, useLog, useBalance } from "../lib/hooks";
import PriceChart  from "./PriceChart";
import WindowBar   from "./WindowBar";
import MarketInfo  from "./MarketInfo";
import BetsTable   from "./BetsTable";
import ConfigPanel from "./ConfigPanel";

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

  // ── Persistencia localStorage ────────────────────────────────────────────
  // Carga al montar — restaura historial de sesiones anteriores
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setBets(parsed);
      }
    } catch {}
  }, []);

  // Guarda en cada cambio (últimas 500 ops)
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(bets.slice(0, 500)));
    } catch {}
  }, [bets]);

  // ── minsLeft: calculado en tiempo real cada segundo desde end_ms ─────────
  const minsLeft = endMs
    ? Math.max(0, (endMs - now.getTime()) / 60000)
    : getMinsLeft(now);

  // ── Target = OPEN 1H de Binance (Price to Beat real) ─────────────────────
  const [target,        setTarget       ] = useState(null);
  const [targetHourUtc, setTargetHourUtc] = useState(null);
  const [targetSource,  setTargetSource ] = useState(null);
  const [targetError,   setTargetError  ] = useState(null);
  const targetLoadingRef = useRef(false);

  const marketSlugRef = useRef(null);
  marketSlugRef.current = market?.slug ?? null;

  const fetchTarget = useCallback(async () => {
    if (targetLoadingRef.current) return;
    targetLoadingRef.current = true;
    try {
      const slug = marketSlugRef.current;
      const slugParam = slug ? `?slug=${encodeURIComponent(slug)}` : "";
      const r = await fetch(`/api/target${slugParam}`);
      const d = await r.json();
      if (d.target) {
        setTarget(d.target);
        setTargetHourUtc(d.candle_hour_utc ?? null);
        setTargetSource(d.source ?? null);
        setTargetError(null);
      } else {
        setTargetError(d.error || "target no disponible");
        setTargetSource(d.source ?? null);
      }
    } catch (e) {
      setTargetError(e.message);
    } finally {
      targetLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchTarget();
    const id = setInterval(fetchTarget, 60_000);
    return () => clearInterval(id);
  }, [fetchTarget]);

  const currentUtcHour = now.getUTCHours();
  useEffect(() => {
    if (targetHourUtc !== null && targetHourUtc !== currentUtcHour) {
      addLog(
        `⚠ Price to Beat desactualizado (vela ${targetHourUtc}h, hora actual ${currentUtcHour}h UTC) — refrescando...`,
        "error",
      );
      fetchTarget();
    }
  }, [currentUtcHour, targetHourUtc, fetchTarget]);

  const targetIsStale = target !== null
    && targetHourUtc !== null
    && targetHourUtc !== currentUtcHour;

  const prevTargetRef = useRef(null);
  useEffect(() => {
    if (target && target !== prevTargetRef.current) {
      const prev = prevTargetRef.current;
      prevTargetRef.current = target;
      const changeStr = prev
        ? ` (Δ ${target > prev ? "+" : ""}${fmtUSD(target - prev)})`
        : "";
      addLog(
        `🎯 Price to Beat: ${fmtUSD(target)} — vela ${targetHourUtc ?? "?"}h UTC${changeStr}`,
        "info",
      );
    }
  }, [target]);

  const prevMarketSlug = useRef(null);
  useEffect(() => {
    if (market?.slug && market.slug !== prevMarketSlug.current) {
      prevMarketSlug.current = market.slug;
      addLog(`◈ Mercado detectado: ${market.slug}`, "success");
      fetchTarget();
    } else if (!market && prevMarketSlug.current) {
      prevMarketSlug.current = null;
      addLog(`⚠ Mercado perdido — buscando...`, "error");
    }
  }, [market?.slug, fetchTarget]);

  // Historial de precio
  useEffect(() => {
    if (!price) return;
    const ts = now.toLocaleTimeString("es-ES", { hour12: false });
    setPriceHistory(h => [...h.slice(-59), { ts, price, target }]);
  }, [price]);

  // ── Bot logic ─────────────────────────────────────────────────────────────
  const firedWindow = useRef(null);
  useEffect(() => { if (!activeWindow) firedWindow.current = null; }, [activeWindow?.key]);

  const activeWindow = getActiveWindow(minsLeft);
  const umbral       = activeWindow ? config[activeWindow.configKey] : null;
  const decision     = (running && activeWindow && price && target && !targetIsStale)
    ? getDecision(price, target, umbral) : null;

  useEffect(() => {
    if (!running || !activeWindow || !decision?.signal) return;
    if (firedWindow.current === activeWindow.key) return;
    firedWindow.current = activeWindow.key;

    // Obtener odds del mercado activo (precio del token YES o NO)
    const tokens = market?.tokens;
    const odds = tokens
      ? (decision.dir === "UP"
          ? (tokens.yes?.price ?? 0.5)
          : (tokens.no?.price  ?? 0.5))
      : 0.5;

    const stake         = config.stake_usdc;
    const retorno_est   = +(stake / odds).toFixed(2);
    const pnl_est_usd   = +(retorno_est - stake).toFixed(2);
    const pnl_est_pct   = +((pnl_est_usd / stake) * 100).toFixed(1);

    const bet = {
      id:          genId(),
      dir:         decision.dir,
      target,
      entry:       price,
      window:      activeWindow.key,
      umbral,
      stake,
      dist:        Math.abs(decision.dist),
      result:      "PENDING",
      pnl:         null,
      pnl_usd:     null,
      odds,
      retorno_est,
      pnl_est_pct,
      market_slug: market?.slug ?? null,
      simulated:   true,
      ts:          new Date().toISOString(),
    };

    setActiveBet(bet);
    setBets(b => [bet, ...b]);
    applyBet(stake);
    addLog(
      `${decision.dir === "UP" ? "▲ UP" : "▼ DOWN"} ejecutado` +
      ` | Entry: ${fmtUSD(price)} | Target: ${fmtUSD(target)}` +
      ` | Dist: $${Math.abs(decision.dist).toFixed(0)}` +
      ` | Odds: ${odds.toFixed(3)} | Stake: ${fmtUSD(stake)}` +
      ` | Retorno est.: ${fmtUSD(retorno_est)} (+${pnl_est_pct}%)` +
      ` | ${activeWindow.key}`,
      "success",
    );

    // Persiste en API (best-effort)
    fetch("/api/bets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bet),
    }).catch(() => {});

    // Análisis IA
    setAiLoading(true);
    fetch("/api/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        price, target, dist: decision.dist,
        window: activeWindow.key, decision: decision.dir,
        odds, stake, retorno_est,
      }),
    })
      .then(r => r.json())
      .then(d => { setAiText(d.text || "Análisis no disponible."); setAiLoading(false); })
      .catch(() => { setAiText("Error al obtener análisis."); setAiLoading(false); });

  }, [running, activeWindow?.key, decision?.signal, decision?.dir]);

  // ── Stop Loss ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running || !activeBet || !price) return;
    const pnl_pct = activeBet.dir === "UP"
      ? ((price - activeBet.entry) / activeBet.entry) * 100
      : ((activeBet.entry - price) / activeBet.entry) * 100;
    if (pnl_pct <= -config.stop_loss_pct) {
      const pnl_usd = +(activeBet.stake * (-config.stop_loss_pct / 100)).toFixed(2);
      setBets(b => b.map(bet =>
        bet.id === activeBet.id
          ? { ...bet, result: "STOP", pnl: -config.stop_loss_pct, pnl_usd }
          : bet
      ));
      setActiveBet(null);
      applyResult(activeBet.stake, false, config.stop_loss_pct);
      addLog(
        `🛑 STOP LOSS activado — P&L: -${config.stop_loss_pct}% (${fmtUSD(pnl_usd)})`,
        "error",
      );
      // Actualizar API
      fetch("/api/bets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: activeBet.id, result: "STOP", pnl: -config.stop_loss_pct, pnl_usd }),
      }).catch(() => {});
    }
  }, [price, activeBet, running]);

  // ── Resolución al cierre ──────────────────────────────────────────────────
  useEffect(() => {
    if (!running || !activeBet || !price || !target || minsLeft > 0.8) return;
    const won   = activeBet.dir === "UP" ? price > activeBet.target : price < activeBet.target;
    const odds  = activeBet.odds || 0.5;
    const stake = activeBet.stake;

    const pnl_usd = won
      ? +(stake / odds - stake).toFixed(2)   // ganancia neta
      : -stake;                               // pérdida total
    const pnl_pct = won
      ? +((pnl_usd / stake) * 100).toFixed(1)
      : -100;
    const result  = won ? "WIN" : "LOSS";

    setBets(b => b.map(bet =>
      bet.id === activeBet.id
        ? { ...bet, result, pnl: pnl_pct, pnl_usd }
        : bet
    ));
    setActiveBet(null);
    applyResult(stake, won, config.stop_loss_pct);
    addLog(
      won
        ? `✅ WIN — Retorno: +${fmtUSD(pnl_usd)} (+${pnl_pct}%) | Claim automático iniciado.`
        : `❌ LOSS — Pérdida: ${fmtUSD(pnl_usd)} (-100%)`,
      won ? "success" : "error",
    );
    fetch("/api/bets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeBet.id, result, pnl: pnl_pct, pnl_usd }),
    }).catch(() => {});
  }, [minsLeft, activeBet, price, running]);

  // ── Stats del día ─────────────────────────────────────────────────────────
  const today     = new Date().toISOString().slice(0, 10);
  const todayBets = bets.filter(b => b.ts?.startsWith(today));
  const wins      = todayBets.filter(b => b.result === "WIN").length;
  const losses    = todayBets.filter(b => ["LOSS", "STOP"].includes(b.result)).length;
  const winRate   = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
  const dist      = price && target ? price - target : null;

  // P&L del día en USD (suma de pnl_usd de las ops cerradas hoy)
  const pnlDayUsd = todayBets.reduce((s, b) => {
    if (b.pnl_usd != null) return s + b.pnl_usd;
    return s;
  }, 0);

  // Tags de estado
  const targetTag = targetIsStale
    ? { label: "TARGET STALE", color: "#4a1a1a" }
    : targetError
      ? { label: "TARGET ERR",   color: "#4a2a1a" }
      : target
        ? { label: "TARGET OK",   color: "#1a3a2a" }
        : null;

  const marketSlugShort = market?.slug
    ? market.slug.replace("bitcoin-up-or-down-", "").replace("-et", "")
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 52, padding: "0 24px",
        borderBottom: "1px solid var(--border)",
        background: "linear-gradient(180deg,#0a0a18 0%,var(--bg) 100%)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: running ? "var(--green)" : "var(--red)",
            boxShadow: running ? "0 0 12px var(--green)" : "0 0 8px var(--red)",
            animation: running ? "pulse 1.5s infinite" : "none",
          }} />
          <span style={{ color: "var(--green)", fontWeight: 700, letterSpacing: "0.12em", fontSize: 14 }}>
            POLYMARKET BTC BOT
          </span>
          <Tag color="#2a4a3a">v2.5</Tag>
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
          {/* Tabs */}
          {["dashboard", "historial", "config"].map(t => (
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
              transition: "color 0.4s",
            }}>
              {priceLoading ? "CARGANDO..." : price ? `$${fmt(price, 2)}` : "—"}
            </div>

            {/* PRICE TO BEAT */}
            <div style={{ marginTop: 10, fontSize: 11 }}>
              <span style={{ color: "var(--muted)" }}>PRICE TO BEAT: </span>
              <span style={{
                color: targetIsStale ? "var(--red)" : targetError ? "var(--yellow)" : target ? "var(--yellow)" : "#444",
                fontWeight: 700,
              }}>
                {target ? fmtUSD(target) : "—"}
              </span>
              {targetIsStale && (
                <span style={{ fontSize: 9, color: "var(--red)", marginLeft: 6 }}>⚠ STALE</span>
              )}
              {!targetIsStale && !targetError && target && (
                <span style={{ fontSize: 9, color: "#2a3a4a", marginLeft: 6 }}>
                  ● {targetHourUtc !== null ? `VELA ${targetHourUtc}:00–${(targetHourUtc + 1) % 24}:00 UTC` : "BINANCE 1H"}
                </span>
              )}
            </div>

            <div style={{ marginTop: 4, fontSize: 11 }}>
              DISTANCIA:{" "}
              <span style={{
                color: dist == null ? "var(--muted)" : dist > 0 ? "var(--green)" : "var(--red)",
                fontWeight: 700,
              }}>
                {dist != null ? `${dist > 0 ? "+" : ""}$${Math.abs(dist).toFixed(0)}` : "—"}
              </span>
            </div>

            {targetIsStale && (
              <div style={{
                marginTop: 8, padding: "5px 8px", fontSize: 10,
                background: "rgba(255,68,102,0.08)", border: "1px solid rgba(255,68,102,0.3)",
                borderRadius: 3, color: "var(--red)",
              }}>
                ⚠ Target de hora {targetHourUtc}h — refrescando...
              </div>
            )}
          </div>

          {/* VENTANA */}
          <div style={{ background: "var(--bg)", padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>VENTANA ACTIVA</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: activeWindow ? activeWindow.color : "#222" }}>
              {activeWindow ? activeWindow.label : "— ESPERA —"}
            </div>
            {activeWindow && (
              <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>
                {activeWindow.min}–{activeWindow.max} min restantes · umbral ${umbral}
              </div>
            )}
            <WindowBar minsLeft={minsLeft} />
          </div>

          {/* SEÑAL */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>SEÑAL</div>
            {decision ? (
              <>
                <div style={{
                  fontSize: 30, fontWeight: 700,
                  color: decision.dir === "UP" ? "var(--green)" : decision.dir === "DOWN" ? "var(--red)" : "#444",
                }}>
                  {decision.dir === "UP" ? "▲ UP" : decision.dir === "DOWN" ? "▼ DOWN" : "— WAIT —"}
                </div>
                <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>
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

            {/* Posición activa con detalles de dinero */}
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
                  <span>Retorno: {fmtUSD(activeBet.retorno_est)}</span>
                </div>
              </div>
            )}
          </div>

          {/* MARKET INFO */}
          <div style={{ gridColumn: "1/4" }}>
            <MarketInfo
              market={market}
              minsLeft={minsLeft}
              activeWindow={activeWindow}
              error={marketError}
              apiResponse={apiResponse}
            />
          </div>

          {/* STATS */}
          <div style={{
            gridColumn: "1/3", background: "var(--bg)", padding: "16px 24px",
            display: "flex", gap: 32, flexWrap: "wrap",
            borderTop: "1px solid var(--border)",
          }}>
            <StatBox
              label="P&L HOY"
              value={fmtUSD(pnlDayUsd)}
              color={pnlDayUsd >= 0 ? "var(--green)" : "var(--red)"}
            />
            <StatBox
              label="WIN RATE"
              value={winRate != null ? `${winRate}%` : "—"}
              color={winRate != null && winRate >= 50 ? "var(--green)" : "var(--red)"}
            />
            <StatBox label="WINS"    value={wins}   color="var(--green)" />
            <StatBox label="LOSSES"  value={losses} color="var(--red)"   />
            <StatBox label="BALANCE" value={fmtUSD(balance)} color={balance >= 500 ? "var(--green)" : "var(--yellow)"} />
            <StatBox label="OPS HOY" value={todayBets.length} color="#888" />
          </div>

          {/* CHART */}
          <div style={{ background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>PRECIO 1 MIN</div>
            <PriceChart data={priceHistory} target={target} />
          </div>

          {/* AI ANALYSIS */}
          <div style={{
            gridColumn: "1/4", background: "var(--bg)", padding: "16px 24px",
            borderTop: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>ANÁLISIS IA</div>
            <div style={{
              fontSize: 11, color: aiLoading ? "#333" : "var(--muted)",
              fontStyle: aiLoading ? "italic" : "normal",
            }}>
              {aiLoading ? "Analizando señal..." : aiText}
            </div>
          </div>

          {/* LOG */}
          <div style={{ gridColumn: "1/4", background: "var(--bg)", padding: "16px 24px", borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>LOG DE EVENTOS</div>
            <div style={{ height: 160, overflowY: "auto", fontFamily: "var(--font)", fontSize: 11 }}>
              {log.length === 0 && <div style={{ color: "#333" }}>Sin eventos.</div>}
              {log.map(entry => (
                <div key={entry.id} style={{
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
        </div>
      )}

      {/* ── HISTORIAL ──────────────────────────────────────────────────────── */}
      {tab === "historial" && (
        <div>
          {/* Toolbar */}
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
                  if (window.confirm("¿Borrar todo el historial?")) {
                    setBets([]);
                  }
                }}
                style={{
                  background: "rgba(255,68,102,0.1)",
                  border: "1px solid rgba(255,68,102,0.3)",
                  color: "var(--red)", fontSize: 9,
                  padding: "4px 10px", borderRadius: 3,
                  cursor: "pointer", letterSpacing: "0.12em",
                }}>
                BORRAR HISTORIAL
              </button>
            )}
          </div>
          <BetsTable bets={bets} />
        </div>
      )}

      {/* ── CONFIG ─────────────────────────────────────────────────────────── */}
      {tab === "config" && (
        <div style={{ padding: "24px" }}>
          <ConfigPanel config={config} onChange={setConfig} />
        </div>
      )}
    </div>
  );
}
