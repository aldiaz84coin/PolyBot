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
  const { market, endMs, active: marketActive, error: marketError } = useMarket();
  const now    = useClock();
  const { log, add: addLog } = useLog();
  const { balance, pnlDay, applyBet, applyResult } = useBalance(500);

  // ── minsLeft: calculado en tiempo real cada segundo desde end_ms ──────────
  const minsLeft = endMs
    ? Math.max(0, (endMs - now.getTime()) / 60000)
    : getMinsLeft(now);

  // ── Target = OPEN 1H de Binance (Price to Beat real) ──────────────────────
  // Fuente primaria: OPEN de la vela 1H de Binance.
  // La API devuelve candle_hour_utc para validar que el target corresponde
  // a la hora UTC actual (y no a la hora anterior — bug corregido).
  const [target,        setTarget       ] = useState(null);
  const [targetHourUtc, setTargetHourUtc] = useState(null); // hora UTC de la vela
  const [targetSource,  setTargetSource ] = useState(null); // "binance_klines" | "fallback_clock"
  const [targetError,   setTargetError  ] = useState(null);
  const targetLoadingRef = useRef(false);

  const fetchTarget = useCallback(async () => {
    if (targetLoadingRef.current) return;
    targetLoadingRef.current = true;
    try {
      const r = await fetch("/api/target");
      const d = await r.json();
      if (d.target) {
        setTarget(d.target);
        setTargetHourUtc(d.candle_hour_utc ?? null);
        setTargetSource(d.source ?? null);
        setTargetError(null);
      } else {
        // target=null → fallback activo, mostrar advertencia
        setTargetError(d.error || "target no disponible");
        setTargetSource(d.source ?? null);
      }
    } catch (e) {
      setTargetError(e.message);
    } finally {
      targetLoadingRef.current = false;
    }
  }, []);

  // Carga inicial + polling cada 60s
  useEffect(() => {
    fetchTarget();
    const id = setInterval(fetchTarget, 60_000);
    return () => clearInterval(id);
  }, [fetchTarget]);

  // Refresco forzado al detectar cambio de hora UTC
  // También invalida el target si la vela no coincide con la hora actual
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

  // targetIsStale: tenemos un target pero es de otra hora UTC
  const targetIsStale = target !== null
    && targetHourUtc !== null
    && targetHourUtc !== currentUtcHour;

  // Log + alerta cuando cambia el target
  const prevTargetRef = useRef(null);
  useEffect(() => {
    if (target && target !== prevTargetRef.current) {
      const prev = prevTargetRef.current;
      prevTargetRef.current = target;
      const changeStr = prev
        ? ` (anterior: ${fmtUSD(prev)}, Δ ${target > prev ? "+" : ""}${fmtUSD(target - prev)})`
        : "";
      addLog(
        `🎯 Price to Beat fijado: ${fmtUSD(target)} — vela ${targetHourUtc ?? "?"}h UTC${changeStr}`,
        "info",
      );
    }
  }, [target]);

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

  // Label para el tag de target en el header
  const targetTag = targetIsStale
    ? { label: "TARGET STALE", color: "#4a1a1a" }
    : targetError
      ? { label: "TARGET ERR",   color: "#4a2a1a" }
      : target
        ? { label: "TARGET OK",   color: "#2a3a4a" }
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
          <Tag color="#2a4a3a">v2.3</Tag>
          {marketActive ? <Tag color="#2a4a3a">MERCADO OK</Tag> : <Tag color="#4a2a2a">SIN MERCADO</Tag>}
          {targetTag && <Tag color={targetTag.color}>{targetTag.label}</Tag>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 12 }}>
          {priceError && <span style={{ color: "var(--red)", fontSize: 10 }}>⚠ PRECIO NO DISPONIBLE</span>}
          <span style={{ color: "#444" }}>{now.toLocaleTimeString("es-ES", { hour12: false })} UTC+0: {String(currentUtcHour).padStart(2,"0")}h</span>
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

            {/* PRICE TO BEAT — bloque mejorado con validación de hora */}
            <div style={{ marginTop: 10, fontSize: 11 }}>
              <span style={{ color: "var(--muted)" }}>PRICE TO BEAT: </span>
              <span style={{
                color: targetIsStale
                  ? "var(--red)"
                  : targetError
                    ? "var(--yellow)"
                    : target ? "var(--yellow)" : "#444",
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

            {/* Advertencia si el target está stale o no disponible */}
            {targetIsStale && (
              <div style={{
                marginTop: 8, padding: "5px 8px", fontSize: 10,
                background: "rgba(255,68,102,0.08)",
                border: "1px solid rgba(255,68,102,0.3)",
                borderRadius: 3, color: "var(--red)",
              }}>
                ⚠ Target de la hora {targetHourUtc}h — refrescando...
              </div>
            )}
            {!target && targetError && (
              <div style={{
                marginTop: 8, padding: "5px 8px", fontSize: 10,
                background: "rgba(255,204,0,0.06)",
                border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, color: "var(--yellow)",
              }}>
                ⚠ Sin conexión a Binance — bot en pausa
              </div>
            )}
          </div>

          {/* VENTANA */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>VENTANA ACTIVA</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: activeWindow ? "var(--yellow)" : "var(--dim)" }}>
              {activeWindow ? activeWindow.label : minsLeft < 2 ? "≈ CIERRE" : "ESPERA"}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {activeWindow ? `UMBRAL: $${umbral}` : `FALTAN: ${fmt(minsLeft, 1)} min`}
            </div>
            {/* Cuenta atrás MM:SS en tiempo real */}
            <div style={{
              marginTop: 6, fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums",
              color: minsLeft < 5 ? "var(--red)" : minsLeft < 15 ? "var(--yellow)" : "#555",
            }}>
              {String(Math.floor(minsLeft)).padStart(2, "0")}:{String(Math.floor((minsLeft % 1) * 60)).padStart(2, "0")}
            </div>
            <div style={{ marginTop: 8 }}>
              <WindowBar minsLeft={minsLeft} activeWindow={activeWindow} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 9, color: "#333" }}>
                <span>60m</span><span>T‑20</span><span>T‑15</span><span>T‑10</span><span>T‑5</span><span>0m</span>
              </div>
            </div>
          </div>

          {/* DECISIÓN */}
          <div style={{ background: "var(--bg)", padding: "20px 24px" }}>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 8 }}>DECISIÓN</div>
            {decision ? (
              <>
                <div style={{
                  fontSize: 34, fontWeight: 700,
                  color: decision.dir === "UP" ? "var(--green)" : decision.dir === "DOWN" ? "var(--red)" : "var(--yellow)",
                  textShadow: decision.signal ? "0 0 24px currentColor" : "none",
                  letterSpacing: "0.06em",
                }}>
                  {decision.dir === "UP" ? "▲ UP" : decision.dir === "DOWN" ? "▼ DOWN" : "✕ WAIT"}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>
                  {decision.signal
                    ? `DIST $${Math.abs(decision.dist).toFixed(0)} > $${umbral} ✓`
                    : `DIST $${Math.abs(decision.dist).toFixed(0)} < $${umbral} — NO ENTRAR`}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 16, color: "var(--dim)", marginTop: 8 }}>
                {running && targetIsStale
                  ? "⚠ TARGET STALE"
                  : running && !target
                    ? "⚠ SIN TARGET"
                    : running
                      ? "— FUERA DE VENTANA —"
                      : "— BOT DETENIDO —"}
              </div>
            )}
            {activeBet && (
              <div style={{
                marginTop: 12, padding: "7px 10px",
                background: "rgba(255,204,0,0.06)",
                border: "1px solid rgba(255,204,0,0.25)",
                borderRadius: 3, fontSize: 11, color: "var(--yellow)",
              }}>
                ● POSICIÓN ACTIVA — {activeBet.dir} @ {fmtUSD(activeBet.entry)}
              </div>
            )}
          </div>

          {/* MARKET INFO */}
          <div style={{ gridColumn: "1/4" }}>
            <MarketInfo market={market} minsLeft={minsLeft} activeWindow={activeWindow} error={marketError} />
          </div>

          {/* STATS */}
          <div style={{
            gridColumn: "1/3", background: "var(--bg)", padding: "16px 24px",
            display: "flex", gap: 32, flexWrap: "wrap",
          }}>
            <StatBox label="P&L HOY"  value={fmtUSD(pnlDay)} color={pnlDay >= 0 ? "var(--green)" : "var(--red)"} />
            <StatBox label="WIN RATE" value={winRate != null ? winRate + "%" : "—"} />
            <StatBox label="OPS HOY"  value={`${todayBets.length}/${config.max_ops_dia}`} />
            <StatBox label="GANADAS"  value={wins}   color="var(--green)" />
            <StatBox label="PERDIDAS" value={losses} color="var(--red)" />
            <StatBox label="STAKE/OP" value={fmtUSD(config.stake_usdc)} />
          </div>

          {/* AI */}
          <div style={{ background: "var(--bg)", padding: "16px 24px" }}>
            <div style={{
              fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 10,
              display: "flex", gap: 8, alignItems: "center",
            }}>
              ◈ ANÁLISIS IA
              {aiLoading && <span style={{ color: "#333", animation: "blink 1s infinite" }}>PROCESANDO...</span>}
            </div>
            <p style={{ fontSize: 11, color: "#8888aa", lineHeight: 1.7, minHeight: 56, margin: 0 }}>{aiText}</p>
          </div>

          {/* CHART */}
          <div style={{ gridColumn: "1/4", background: "var(--bg2)", borderTop: "1px solid var(--border)" }}>
            <PriceChart data={priceHistory} target={target} />
          </div>

          {/* LOG */}
          <div style={{ gridColumn: "1/4", background: "#02020a", maxHeight: 180, overflowY: "auto", borderTop: "1px solid var(--border)" }}>
            <div style={{
              padding: "7px 16px", borderBottom: "1px solid var(--border)",
              fontSize: 9, color: "#333", letterSpacing: "0.12em",
              display: "flex", justifyContent: "space-between",
              position: "sticky", top: 0, background: "#02020a",
            }}>
              <span>SYSTEM LOG</span>
              <span style={{ color: "#1a3a22" }}>{log.length} eventos</span>
            </div>
            {log.length === 0
              ? <div style={{ padding: "14px 16px", color: "var(--dim)", fontSize: 11 }}>Esperando eventos...</div>
              : log.map(l => (
                <div key={l.id} style={{
                  padding: "3px 16px", display: "flex", gap: 12, fontSize: 11,
                  borderBottom: "1px solid #070710",
                  color: l.type === "success" ? "#00bb66"
                       : l.type === "error"   ? "#cc3355"
                       : "var(--muted)",
                }}>
                  <span style={{ color: "#2a2a3a", flexShrink: 0 }}>{l.ts}</span>
                  <span>{l.msg}</span>
                </div>
              ))
            }
          </div>
        </div>
      )}

      {tab === "historial" && <BetsTable bets={bets} />}
      {tab === "config"    && <ConfigPanel config={config} onChange={setConfig} />}
    </div>
  );
}
