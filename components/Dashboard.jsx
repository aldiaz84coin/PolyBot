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
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setBets(parsed);
      }
    } catch {}
  }, []);

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
  // ✅ FIX: activeWindow/umbral/decision declarados ANTES del useEffect que los usa
  const activeWindow = getActiveWindow(minsLeft);
  const umbral       = activeWindow ? config[activeWindow.configKey] : null;
  const decision     = (running && activeWindow && price && target && !targetIsStale)
    ? getDecision(price, target, umbral) : null;

  const firedWindow = useRef(null);
  useEffect(() => { if (!activeWindow) firedWindow.current = null; }, [activeWindow?.key]);

  useEffect(() => {
    if (!running || !activeWindow || !decision?.signal) return;
    if (firedWindow.current === activeWindow.key) return;
    firedWindow.current = activeWindow.key;

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

    fetch("/api/bets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bet),
    }).catch(() => {});

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
  // FIX v2.7: El P&L del stop ya no usa un porcentaje fijo (stake * stop_pct%).
  // Ahora usa el precio REAL del token en Polymarket en el momento del stop:
  //   shares = stake / odds_entrada
  //   proceeds = shares * precio_actual_del_token
  //   pnl_usd = proceeds - stake
  // Esto refleja lo que realmente se recuperaría al vender la posición.
  useEffect(() => {
    if (!running || !activeBet || !price) return;

    // Trigger del stop: sigue basado en movimiento de BTC vs entry
    const pnl_pct_btc = activeBet.dir === "UP"
      ? ((price - activeBet.entry) / activeBet.entry) * 100
      : ((activeBet.entry - price) / activeBet.entry) * 100;

    if (pnl_pct_btc <= -config.stop_loss_pct) {
      // Precio actual del token en Polymarket (refleja la apuesta en tiempo real)
      const tokenPrice = activeBet.dir === "UP"
        ? (market?.tokens?.yes?.price ?? 0)
        : (market?.tokens?.no?.price  ?? 0);

      // Cálculo real: shares comprados × precio actual = lo que se recupera
      const sharesHeld  = activeBet.stake / Math.max(activeBet.odds ?? 0.5, 0.001);
      const proceeds    = sharesHeld * tokenPrice;
      const pnl_usd     = +(proceeds - activeBet.stake).toFixed(2);
      const pnl_pct_real = +((pnl_usd / activeBet.stake) * 100).toFixed(1);

      setBets(b => b.map(bet =>
        bet.id === activeBet.id
          ? { ...bet, result: "STOP", pnl: pnl_pct_real, pnl_usd }
          : bet
      ));
      setActiveBet(null);
      applyResult(activeBet.stake, false, Math.abs(pnl_pct_real));
      addLog(
        `🛑 STOP LOSS — P&L real: ${fmtUSD(pnl_usd)} (${pnl_pct_real >= 0 ? "+" : ""}${pnl_pct_real}%)` +
        ` [token: ${tokenPrice.toFixed(3)} · shares: ${sharesHeld.toFixed(4)}]`,
        "error",
      );
      fetch("/api/bets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: activeBet.id, result: "STOP", pnl: pnl_pct_real, pnl_usd }),
      }).catch(() => {});
    }
  }, [price, activeBet, running, market]);

  // ── Resolución al cierre ──────────────────────────────────────────────────
  useEffect(() => {
    if (!running || !activeBet || !price || !target || minsLeft > 0.8) return;
    const won   = activeBet.dir === "UP" ? price > activeBet.target : price < activeBet.target;
    // odds reales de entrada (corregido desde v2.7 — ya no defaultea a 0.5)
    const odds  = activeBet.odds || 0.5;
    const stake = activeBet.stake;
    // WIN: cada share resuelve a $1 → retorno real = stake / odds
    // LOSS: cada share resuelve a $0 → pnl = -stake
    const pnl_usd = won
      ? +(stake / odds - stake).toFixed(2)
      : +(-stake).toFixed(2);
    const pnl_pct = +((pnl_usd / stake) * 100).toFixed(1);

    setBets(b => b.map(bet =>
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
  }, [minsLeft, running]);

  // ── Derived display values ────────────────────────────────────────────────
  const dist = (price && target) ? price - target : null;

  const marketSlugShort = market?.slug
    ? market.slug.replace("bitcoin-up-or-down-", "")
    : null;

  const targetTag = targetIsStale
    ? { color: "var(--red)",    label: "TARGET STALE" }
    : targetError
    ? { color: "var(--yellow)", label: "TARGET ERR"   }
    : null;

  // Stats
  const wins    = bets.filter(b => b.result === "WIN").length;
  const losses  = bets.filter(b => b.result === "LOSS" || b.result === "STOP").length;
  const total   = wins + losses;
  const winrate = total > 0 ? (wins / total) * 100 : null;
  const pnlTotal = bets.reduce((acc, b) => acc + (b.pnl_usd ?? 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────
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
          <Tag color="#2a4a3a">v2.7</Tag>
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
                  {dist > 0 ? "+" : ""}${dist.toFixed(0)}
                </span>
              </div>
            )}
            {priceError && <div style={{ fontSize: 9, color: "var(--red)", marginTop: 4 }}>{priceError}</div>}
          </div>

          {/* VENTANA */}
          <div style={{ background: "var(--bg)", padding: "20px 24px", borderRight: "1px solid var(--border)" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>VENTANA</div>
            <div style={{
              fontSize: 22, fontWeight: 700,
              color: activeWindow ? activeWindow.color : "#333",
            }}>
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
        </div>
      )}

      {/* ── STATS BAR ──────────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div style={{
          display: "flex", gap: 32, padding: "14px 24px",
          borderBottom: "1px solid var(--border)", background: "#02020a",
          flexWrap: "wrap",
        }}>
          <StatBox label="BALANCE" value={fmtUSD(balance)} color={balance >= 500 ? "var(--green)" : "var(--red)"} />
          <StatBox label="P&L HOY"  value={fmtUSD(pnlDay)}  color={pnlDay >= 0 ? "var(--green)" : "var(--red)"} />
          <StatBox label="P&L TOTAL" value={fmtUSD(pnlTotal)} color={pnlTotal >= 0 ? "var(--green)" : "var(--red)"} />
          <StatBox label="WINRATE"  value={winrate != null ? `${winrate.toFixed(0)}%` : "—"} color="var(--yellow)" sub={`${wins}W / ${losses}L`} />
          <StatBox label="OPS" value={total} color="var(--dim)" />
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
