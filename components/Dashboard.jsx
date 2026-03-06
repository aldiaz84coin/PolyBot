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

  // Ref para leer el slug actual dentro de fetchTarget sin añadirlo como
  // dependencia del useCallback (evita recrear el callback en cada render).
  const marketSlugRef = useRef(null);
  marketSlugRef.current = market?.slug ?? null;

  const fetchTarget = useCallback(async () => {
    if (targetLoadingRef.current) return;
    targetLoadingRef.current = true;
    try {
      // Pasamos el slug para que /api/target pida la vela exacta a Binance.
      // El slug codifica la hora del mercado (p.ej. "march-6-6am-et").
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
  }, []); // sin dependencias: usa ref para el slug

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

  // Log cuando se detecta/pierde el mercado.
  // Al detectar un nuevo slug re-fetch inmediato del target con ese slug.
  const prevMarketSlug = useRef(null);
  useEffect(() => {
    if (market?.slug && market.slug !== prevMarketSlug.current) {
      prevMarketSlug.current = market.slug;
      addLog(`◈ Mercado detectado: ${market.slug}`, "success");
      // Nuevo mercado → pedir target con el slug correcto sin esperar al intervalo
      fetchTarget();
    } else if (!market && prevMarketSlug.current) {
      prevMarketSlug.current = null;
      addLog(`⚠ Mercado perdido — buscando...`, "error");
    }
  }, [market?.slug, fetchTarget]);

  const activeWindow = getActiveWindow(minsLeft);
  const umbral       = activeWindow ? config[activeWindow.configKey] : null;
  const decision     = (running && activeWindow && price && target && !targetIsStale)
    ? getDecision(price, target, umbral) : null;

  // Historial de precio
  useEffect(() => {
    if (!price) return;
    const ts = now.toLocaleTimeString("es-ES", { hour12: false });
    setPriceHistory(h => [...h.slice(-59), { ts, price, target }]);
  }, [price]);

  // ── Bot logic ─────────────────────────────────────────────────────────────
  const firedWindow = useRef(null);
  useEffect(() => { if (!activeWindow) firedWindow.current = null; }, [activeWindow?.key]);

  useEffect(() => {
    if (!running || !activeWindow || !decision?.signal) return;
    if (firedWindow.current === activeWindow.key) return;
    firedWindow.current = activeWindow.key;

    const bet = {
      id: genId(), dir: decision.dir, target, entry: price,
      window: activeWindow.key, umbral, stake: config.stake_usdc,
      dist: Math.abs(decision.dist), result: "PENDING", pnl: null,
      ts: new Date().toISOString(),
    };
    setActiveBet(bet);
    setBets(b => [bet, ...b]);
    applyBet(config.stake_usdc);
    addLog(
      `${decision.dir === "UP" ? "▲ UP" : "▼ DOWN"} ejecutado — Entry: ${fmtUSD(price)} | Target: ${fmtUSD(target)} | Dist: $${Math.abs(decision.dist).toFixed(0)} | ${activeWindow.key}`,
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
      body: JSON.stringify({ price, target, dist: decision.dist, window: activeWindow.key, decision: decision.dir }),
    })
      .then(r => r.json())
      .then(d => { setAiText(d.text || "Análisis no disponible."); setAiLoading(false); })
      .catch(() => { setAiText("Error al obtener análisis."); setAiLoading(false); });
  }, [running, activeWindow?.key, decision?.signal, decision?.dir]);

  // Stop Loss
  useEffect(() => {
    if (!running || !activeBet || !price) return;
    const pnl = activeBet.dir === "UP"
      ? ((price - activeBet.entry) / activeBet.entry) * 100
      : ((activeBet.entry - price) / activeBet.entry) * 100;
    if (pnl <= -config.stop_loss_pct) {
      setBets(b => b.map(bet =>
        bet.id === activeBet.id ? { ...bet, result: "STOP", pnl: -config.stop_loss_pct } : bet
      ));
      setActiveBet(null);
      applyResult(activeBet.stake, false, config.stop_loss_pct);
      addLog(`🛑 STOP LOSS activado — P&L: -${config.stop_loss_pct}%`, "error");
    }
  }, [price, activeBet, running]);

  // Resolución al cierre
  useEffect(() => {
    if (!running || !activeBet || !price || !target || minsLeft > 0.8) return;
    const won = activeBet.dir === "UP" ? price > activeBet.target : price < activeBet.target;
    setBets(b => b.map(bet =>
      bet.id === activeBet.id
        ? { ...bet, result: won ? "WIN" : "LOSS", pnl: won ? 90 : -config.stop_loss_pct }
        : bet
    ));
    setActiveBet(null);
    applyResult(activeBet.stake, won, config.stop_loss_pct);
    addLog(
      won ? "✅ WIN — Claim automático iniciado." : "❌ LOSS — Evento perdido.",
      won ? "success" : "error",
    );
  }, [minsLeft, activeBet, price, running]);

  const today     = new Date().toISOString().slice(0, 10);
  const todayBets = bets.filter(b => b.ts?.startsWith(today));
  const wins      = todayBets.filter(b => b.result === "WIN").length;
  const losses    = todayBets.filter(b => ["LOSS", "STOP"].includes(b.result)).length;
  const winRate   = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
  const dist      = price && target ? price - target : null;

  // Tag de estado del target
  const targetTag = targetIsStale
    ? { label: "TARGET STALE", color: "#4a1a1a" }
    : targetError
      ? { label: "TARGET ERR",   color: "#4a2a1a" }
      : target
        ? { label: "TARGET OK",   color: "#1a3a2a" }
        : null;

  // Tag estado del mercado con info de slug
  const marketSlugShort = market?.slug
    ? market.slug.replace("bitcoin-up-or-down-", "").replace("-et", "")
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>

      {/* HEADER */}
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
          <Tag color="#2a4a3a">v2.4</Tag>
          {marketActive
            ? <Tag color="#1a3a2a">◈ {marketSlugShort || "MERCADO OK"}</Tag>
            : <Tag color="#4a2a2a">◈ SIN MERCADO</Tag>
          }
          {targetTag && <Tag color={targetTag.color}>{targetTag.label}</Tag>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 12 }}>
          {priceError && <span style={{ color: "var(--red)", fontSize: 10 }}>⚠ PRECIO NO DISPONIBLE</span>}
          <span style={{ color: "#444" }}>
            {now.toLocaleTimeString("es-ES", { hour12: false })}
            <span style={{ marginLeft: 8, color: "#2a2a3a" }}>UTC {String(currentUtcHour).padStart(2,"0")}h</span>
          </span>
          <span style={{ color: balance < 100 ? "var(--red)" : "var(--green)" }}>BAL: {fmtUSD(balance)}</span>
          <button
            onClick={() => {
              const n = !running;
              setRunning(n);
              addLog(n ? "🤖 Bot iniciado." : "🛑 Bot detenido.", n ? "success" : "error");
            }}
            style={{
              background: running ? "rgba(255,68,102,0.12)" : "rgba(0,255,136,0.12)",
              border: `1px solid ${running ? "var(--red)" : "var(--green)"}`,
              color: running ? "var(--red)" : "var(--green)",
              padding: "6px 18px", borderRadius: 3, fontFamily: "var(--font)",
              fontSize: 12, letterSpacing: "0.08em", fontWeight: 700, transition: "all 0.2s",
            }}
          >{running ? "■ DETENER" : "▶ INICIAR"}</button>
        </div>
      </header>

      {/* TABS */}
      <nav style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 24px" }}>
        {["dashboard", "historial", "config"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "none", border: "none",
            borderBottom: tab === t ? "2px solid var(--green)" : "2px solid transparent",
            color: tab === t ? "var(--green)" : "var(--muted)",
            padding: "10px 20px", fontFamily: "var(--font)", fontSize: 12,
            letterSpacing: "0.1em", textTransform: "uppercase", transition: "color 0.15s",
          }}>{t}</button>
        ))}
      </nav>

      {tab === "dashboard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, background: "var(--border)" }}>

          {/* PRECIO */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>
              BTC/USDT — {source?.toUpperCase() ?? "—"}
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
              {!targetIsStale && targetError && (
                <span style={{ fontSize: 9, color: "var(--yellow)", marginLeft: 6 }}>⚠ FALLBACK</span>
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
            {!target && targetError && (
              <div style={{
                marginTop: 8, padding: "5px 8px", fontSize: 10,
                background: "rgba(255,204,0,0.06)", border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, color: "var(--yellow)",
              }}>
                ⚠ Sin conexión a Binance — bot en pausa
              </div>
            )}
          </div>

          {/* VENTANA */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>VENTANA ACTIVA</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: activeWindow ? activeWindow.color : "#222" }}>
              {activeWindow ? activeWindow.label : "— ESPERA —"}
            </div>
            {activeWindow && (
              <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>
                {activeWindow.min}–{activeWindow.max} min restantes
              </div>
            )}
            <WindowBar minsLeft={minsLeft} />
          </div>

          {/* DECISIÓN */}
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
                    : `DIST $${Math.abs(decision.dist).toFixed(0)} < $${umbral} — NO ENTRAR`}
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
                marginTop: 12, padding: "7px 10px",
                background: "rgba(255,204,0,0.06)", border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, fontSize: 11, color: "var(--yellow)",
              }}>
                ● POSICIÓN ACTIVA — {activeBet.dir} @ {fmtUSD(activeBet.entry)}
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
          }}>
            <StatBox label="P&L HOY"  value={fmtUSD(pnlDay)} color={pnlDay >= 0 ? "var(--green)" : "var(--red)"} />
            <StatBox label="WIN RATE" value={winRate != null ? `${winRate}%` : "—"} color={winRate != null && winRate >= 50 ? "var(--green)" : "var(--red)"} />
            <StatBox label="WINS"     value={wins}   color="var(--green)" />
            <StatBox label="LOSSES"   value={losses} color="var(--red)"   />
            <StatBox label="BALANCE"  value={fmtUSD(balance)} color={balance >= 500 ? "var(--green)" : "var(--yellow)"} />
          </div>

          {/* CHART */}
          <div style={{ background: "var(--bg)", padding: "16px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>PRECIO 1 MIN</div>
            <PriceChart data={priceHistory} target={target} />
          </div>

          {/* LOG */}
          <div style={{ gridColumn: "1/4", background: "var(--bg)", padding: "16px 24px" }}>
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

      {tab === "historial" && (
        <div style={{ padding: "24px" }}>
          <BetsTable bets={bets} />
        </div>
      )}

      {tab === "config" && (
        <div style={{ padding: "24px" }}>
          <ConfigPanel config={config} onChange={setConfig} />
        </div>
      )}
    </div>
  );
}
