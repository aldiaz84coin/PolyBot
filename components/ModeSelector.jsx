"use client";
/**
 * components/ModeSelector.jsx — v2.4
 *
 * CAMBIOS v2.4:
 *   - Muestra el modo REAL que el bot está ejecutando en runtime (simulate_mode
 *     publicado por state_reporter.py vía /api/bot-state) con badge separado.
 *   - Si el modo configurado difiere del modo activo en el bot (lag de ~60s de
 *     propagación), muestra un aviso "propagando…" para no confundir al usuario.
 *   - Reemplaza useBotStatus() interno por useBotState() de lib/hooks (evita
 *     duplicar el fetch a /api/bot-state que ya hace hooks.js).
 *   - El botón 🔵 SIMULADO ya funciona siempre para volver de modo real.
 *
 * CAMBIOS v2.3 — check_balance INLINE (sin bot, sin Railway):
 *   - runBalanceCheck detecta respuesta directa (data.direct === true) y aplica
 *     el resultado inmediatamente sin iniciar polling.
 *
 * CAMBIOS v2.2 — Timeout en poller + aviso bot inactivo.
 * CAMBIOS v2.1 — check_clob DIRECTO.
 * CAMBIOS v2.0 — Preflight screen para cambio a modo real.
 * CAMBIOS v1.1 — safeJson con guard res.ok.
 *
 * Destino: components/ModeSelector.jsx
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useBotState } from "../lib/hooks";

// ── Estilos ───────────────────────────────────────────────────────────────

const S = {
  font: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    color: "#c8c8d8",
  },
  badge: (mode) => ({
    display: "inline-flex", alignItems: "center", gap: 6,
    fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
    padding: "4px 12px", borderRadius: 3,
    background: mode === "real" ? "rgba(255,68,102,0.1)" : "rgba(68,136,255,0.1)",
    border:     mode === "real" ? "1px solid rgba(255,68,102,0.3)" : "1px solid rgba(68,136,255,0.3)",
    color:      mode === "real" ? "#ff4466" : "#4488ff",
  }),
  badgeRuntime: (simulateMode) => ({
    display: "inline-flex", alignItems: "center", gap: 6,
    fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
    padding: "3px 10px", borderRadius: 3,
    ...(simulateMode === true  ? {
      background: "rgba(68,136,255,0.07)",
      border: "1px solid rgba(68,136,255,0.25)",
      color: "#4488ff",
    } : simulateMode === false ? {
      background: "rgba(255,68,102,0.07)",
      border: "1px solid rgba(255,68,102,0.25)",
      color: "#ff4466",
    } : {
      background: "rgba(255,255,255,0.03)",
      border: "1px solid #222",
      color: "#444",
    }),
  }),
  dot: (mode) => ({
    width: 6, height: 6, borderRadius: "50%",
    background: mode === "real" ? "#ff4466" : "#4488ff",
    animation: mode === "real" ? "pulse 1.5s infinite" : "none",
  }),
  btn: (variant = "default", disabled = false) => ({
    padding: "7px 14px", borderRadius: 3,
    fontSize: 10, letterSpacing: "0.1em",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    border: "1px solid",
    fontFamily: "inherit",
    transition: "all 0.15s",
    ...(variant === "primary"  ? { background: "rgba(0,255,136,0.08)",  borderColor: "rgba(0,255,136,0.35)",  color: "#00ff88" } :
        variant === "danger"   ? { background: "rgba(255,68,102,0.08)", borderColor: "rgba(255,68,102,0.35)", color: "#ff4466" } :
        variant === "blue"     ? { background: "rgba(68,136,255,0.08)", borderColor: "rgba(68,136,255,0.35)", color: "#4488ff" } :
                                 { background: "transparent",            borderColor: "#2a2a3a",               color: "#555"    }),
  }),
  row: { display: "flex", alignItems: "center", gap: 8 },
  col: { display: "flex", flexDirection: "column", gap: 12 },
};

// Timeout para el poller (ms) — solo aplica a test_order.
const POLL_TIMEOUT_MS = 35_000;

// ── Helpers ───────────────────────────────────────────────────────────────

async function safeJson(res) {
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    const match = body.match(/"error"\s*:\s*"([^"]+)"/);
    const msg = match ? match[1] : `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  try { return await res.json(); } catch (_) { return { ok: false, error: "JSON inválido" }; }
}

// ── CheckChip ─────────────────────────────────────────────────────────────

function CheckChip({ status }) {
  const cfg = {
    idle:    { color: "#333",     label: "PENDIENTE" },
    loading: { color: "#4488ff",  label: "COMPROBANDO…" },
    ok:      { color: "#00ff88",  label: "OK" },
    error:   { color: "#ff4466",  label: "ERROR" },
  }[status] ?? { color: "#333", label: "—" };

  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
      color: cfg.color, padding: "2px 7px", borderRadius: 2,
      border: `1px solid ${cfg.color}40`,
      background: `${cfg.color}0d`,
    }}>
      {cfg.label}
    </span>
  );
}

// ── BotStatusBadge ────────────────────────────────────────────────────────

function BotStatusBadge({ botRunning }) {
  const color = botRunning ? "#00ff88" : "#ff8800";
  const label = botRunning ? "● BOT ACTIVO" : "○ BOT INACTIVO";
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
      color, padding: "2px 8px", borderRadius: 2,
      border: `1px solid ${color}40`,
      background: `${color}0d`,
    }}>
      {label}
    </span>
  );
}

// ── useCommandPoller ──────────────────────────────────────────────────────

function useCommandPoller() {
  const timerRef    = useRef(null);
  const deadlineRef = useRef(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    deadlineRef.current = null;
  }, []);

  const poll = useCallback((id, onDone) => {
    cancel();
    deadlineRef.current = Date.now() + POLL_TIMEOUT_MS;

    timerRef.current = setInterval(async () => {
      if (Date.now() > deadlineRef.current) {
        cancel();
        onDone({
          status: "error",
          result: {
            success: false,
            error: `Sin respuesta del bot tras ${POLL_TIMEOUT_MS / 1000}s. Verifica que Railway esté activo y el bot corriendo.`,
          },
        });
        return;
      }

      try {
        const res  = await fetch(`/api/commands?id=${id}`, { cache: "no-store" });
        const data = await safeJson(res);
        if (data.status === "done" || data.status === "error") {
          cancel();
          onDone(data);
        }
      } catch (e) {
        cancel();
        onDone({ status: "error", result: { success: false, error: e.message } });
      }
    }, 2000);
  }, [cancel]);

  useEffect(() => () => cancel(), [cancel]);

  return { poll, cancel };
}

// ── PreflightStep ─────────────────────────────────────────────────────────

function PreflightStep({ num, title, description, chipStatus, children }) {
  const borderColor =
    chipStatus === "ok"      ? "rgba(0,255,136,0.25)"
    : chipStatus === "error" ? "rgba(255,68,102,0.25)"
    : chipStatus === "loading" ? "rgba(68,136,255,0.2)"
    : "#1a1a2a";

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderRadius: 4, padding: "12px 16px",
      background: "#04040e",
      transition: "border-color 0.3s",
    }}>
      <div style={{ ...S.row, justifyContent: "space-between", marginBottom: 8 }}>
        <div style={S.row}>
          <span style={{ fontSize: 9, color: "#333", letterSpacing: "0.16em" }}>
            PASO {num}
          </span>
          <span style={{ fontSize: 11, color: "#888" }}>{title}</span>
        </div>
        <CheckChip status={chipStatus} />
      </div>
      {description && (
        <p style={{ fontSize: 9, color: "#444", margin: "0 0 10px", lineHeight: 1.6 }}>
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

// ── PreflightScreen ───────────────────────────────────────────────────────

function PreflightScreen({ onCancel, onConfirm, botRunning }) {
  const { poll, cancel } = useCommandPoller();

  const [clobStatus,    setClobStatus]    = useState("idle");
  const [clobResult,    setClobResult]    = useState(null);
  const [balanceStatus, setBalanceStatus] = useState("idle");
  const [balanceResult, setBalanceResult] = useState(null);
  const [testDir,       setTestDir]       = useState("UP");
  const [testStake,     setTestStake]     = useState("1.00");
  const [testStatus,    setTestStatus]    = useState("idle");
  const [testResult,    setTestResult]    = useState(null);
  const [confirmText,   setConfirmText]   = useState("");

  const canConfirm = clobStatus === "ok" && confirmText === "REAL";

  // ── Check CLOB ────────────────────────────────────────────────────────────
  const runClobCheck = async () => {
    setClobStatus("loading"); setClobResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "check_clob" }),
      });
      const data = await safeJson(res);
      if (!data.ok) throw new Error(data.error || "Error enviando comando");

      if (data.direct) {
        const ok = data.status === "done" && data.result?.success;
        setClobStatus(ok ? "ok" : "error");
        setClobResult(data.result);
        return;
      }
      if (data.id) {
        poll(data.id, (pollData) => {
          const ok = pollData.status === "done" && pollData.result?.success;
          setClobStatus(ok ? "ok" : "error");
          setClobResult(pollData.result);
        });
      }
    } catch (e) {
      setClobStatus("error");
      setClobResult({ error: e.message });
    }
  };

  // ── Check Balance ─────────────────────────────────────────────────────────
  const runBalanceCheck = async () => {
    setBalanceStatus("loading"); setBalanceResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "check_balance" }),
      });
      const data = await safeJson(res);
      if (!data.ok) throw new Error(data.error || "Error enviando comando");

      if (data.direct) {
        const ok = data.status === "done" && data.result?.success;
        setBalanceStatus(ok ? "ok" : "error");
        setBalanceResult(data.result);
        return;
      }
      if (data.id) {
        poll(data.id, (pollData) => {
          const ok = pollData.status === "done" && pollData.result?.success;
          setBalanceStatus(ok ? "ok" : "error");
          setBalanceResult(pollData.result);
        });
      }
    } catch (e) {
      setBalanceStatus("error");
      setBalanceResult({ error: e.message });
    }
  };

  // ── Test Order ────────────────────────────────────────────────────────────
  const runTestOrder = async () => {
    setTestStatus("loading"); setTestResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "test_order",
          params: { direction: testDir, stake: parseFloat(testStake) },
        }),
      });
      const data = await safeJson(res);
      if (!data.ok) throw new Error(data.error || "Error enviando comando");
      if (data.id) {
        poll(data.id, (pollData) => {
          const ok = pollData.status === "done" && pollData.result?.success;
          setTestStatus(ok ? "ok" : "error");
          setTestResult(pollData.result);
        });
      }
    } catch (e) {
      setTestStatus("error");
      setTestResult({ error: e.message });
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)",
      zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "#02020a",
        border: "1px solid #2a2a3a",
        borderRadius: 8, padding: "28px 32px",
        maxWidth: 560, width: "100%",
        maxHeight: "90vh", overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ ...S.row, justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ fontSize: 13, color: "#ff4466", fontWeight: 700, letterSpacing: "0.1em" }}>
            ⚠ ACTIVAR MODO REAL
          </span>
          <button onClick={onCancel} style={{ ...S.btn("default"), padding: "4px 10px", fontSize: 10 }}>
            ✕ CANCELAR
          </button>
        </div>

        <p style={{ fontSize: 9, color: "#555", marginBottom: 20, lineHeight: 1.8 }}>
          Completa los checks antes de activar el modo real. El bot empezará a
          ejecutar órdenes con fondos USDC reales de tu cartera.
        </p>

        <div style={S.col}>

          {/* PASO 1: CLOB */}
          <PreflightStep
            num={1}
            title="Conectividad CLOB"
            description="Verifica que Polymarket CLOB responde y hay un mercado BTC activo."
            chipStatus={clobStatus}
          >
            <div style={S.row}>
              <button
                onClick={runClobCheck}
                disabled={clobStatus === "loading"}
                style={S.btn("primary", clobStatus === "loading")}
              >
                {clobStatus === "loading" ? "COMPROBANDO…" : "VERIFICAR CLOB"}
              </button>
            </div>
            {clobResult && (
              <div style={{
                marginTop: 8, padding: "8px 12px",
                background: "#060610", border: "1px solid #1a1a2a",
                borderRadius: 3, fontSize: 9, color: "#666", lineHeight: 1.8,
              }}>
                {clobResult.error ? (
                  <span style={{ color: "#ff4466" }}>✗ {clobResult.error}</span>
                ) : (
                  <>
                    <div>Mercado: <span style={{ color: "#888" }}>{clobResult.market_slug}</span></div>
                    <div>YES: <span style={{ color: "#00ff88" }}>{clobResult.yes_price != null ? (clobResult.yes_price * 100).toFixed(1) + "¢" : "—"}</span></div>
                    <div>NO:  <span style={{ color: "#ff4466" }}>{clobResult.no_price  != null ? (clobResult.no_price  * 100).toFixed(1) + "¢" : "—"}</span></div>
                    <div>Latencia: <span style={{ color: "#888" }}>{clobResult.latency_ms}ms</span></div>
                  </>
                )}
              </div>
            )}
          </PreflightStep>

          {/* PASO 2: Balance */}
          <PreflightStep
            num={2}
            title="Saldo USDC"
            description="Consulta el saldo de tu cartera en Polygon via JSON-RPC público. No requiere bot activo."
            chipStatus={balanceStatus}
          >
            <div style={S.row}>
              <button
                onClick={runBalanceCheck}
                disabled={balanceStatus === "loading"}
                style={S.btn("primary", balanceStatus === "loading")}
              >
                {balanceStatus === "loading" ? "CONSULTANDO…" : "VER SALDO"}
              </button>
            </div>
            {balanceResult && (
              <div style={{
                marginTop: 8, padding: "8px 12px",
                background: "#060610", border: "1px solid #1a1a2a",
                borderRadius: 3, fontSize: 9, color: "#666", lineHeight: 1.8,
              }}>
                {balanceResult.error ? (
                  <span style={{ color: "#ff4466" }}>✗ {balanceResult.error}</span>
                ) : (
                  <>
                    <div>USDC: <span style={{ color: "#00ff88" }}>${balanceResult.usdc?.toFixed(2)}</span></div>
                    <div>POL:  <span style={{ color: "#888" }}>{balanceResult.pol?.toFixed(4)}</span></div>
                    <div>Wallet: <span style={{ color: "#555" }}>{balanceResult.wallet}</span></div>
                    <div>Latencia: <span style={{ color: "#555" }}>{balanceResult.rpc_latency_ms}ms · {balanceResult.rpc_used?.split("/")[2] ?? "—"}</span></div>
                  </>
                )}
              </div>
            )}
          </PreflightStep>

          {/* PASO 3: Orden de prueba */}
          <PreflightStep
            num={3}
            title="Orden de prueba (opcional)"
            description="Ejecuta una orden real mínima para verificar L2 auth y conectividad completa con el CLOB. Usa fondos reales. Requiere bot activo en Railway."
            chipStatus={testStatus}
          >
            <div style={{ ...S.row, marginBottom: 8 }}>
              <BotStatusBadge botRunning={botRunning} />
              {!botRunning && testStatus === "idle" && (
                <span style={{ fontSize: 9, color: "#ff8800" }}>
                  ⚠ Bot inactivo — la orden no podrá ejecutarse
                </span>
              )}
            </div>
            <div style={S.row}>
              <select
                value={testDir}
                onChange={e => setTestDir(e.target.value)}
                style={{
                  background: "#060610", border: "1px solid #2a2a3a",
                  color: "#888", fontSize: 10, padding: "6px 8px",
                  borderRadius: 3, fontFamily: "inherit",
                }}
              >
                <option value="UP">UP</option>
                <option value="DOWN">DOWN</option>
              </select>
              <input
                type="number"
                value={testStake}
                onChange={e => setTestStake(e.target.value)}
                placeholder="1.00"
                min="0.5" max="10" step="0.5"
                style={{
                  width: 80, background: "#060610",
                  border: "1px solid #2a2a3a", color: "#888",
                  fontSize: 10, padding: "6px 8px",
                  borderRadius: 3, fontFamily: "inherit",
                }}
              />
              <button
                onClick={runTestOrder}
                disabled={testStatus === "loading"}
                style={S.btn("danger", testStatus === "loading")}
              >
                {testStatus === "loading" ? `EJECUTANDO… (${POLL_TIMEOUT_MS / 1000}s)` : "TEST ORDER"}
              </button>
            </div>
            {testResult && (
              <div style={{
                marginTop: 8, padding: "8px 12px",
                background: "#060610", border: "1px solid #1a1a2a",
                borderRadius: 3, fontSize: 9, color: "#666", lineHeight: 1.8,
              }}>
                {testResult.error ? (
                  <span style={{ color: "#ff4466" }}>✗ {testResult.error}</span>
                ) : (
                  <>
                    <div>Order ID: <span style={{ color: "#888" }}>{testResult.order_id}</span></div>
                    <div>Status:   <span style={{ color: "#888" }}>{testResult.status}</span></div>
                    <div>Odds:     <span style={{ color: "#00ff88" }}>{testResult.odds != null ? (testResult.odds * 100).toFixed(1) + "¢" : "—"}</span></div>
                  </>
                )}
              </div>
            )}
          </PreflightStep>

          {/* PASO 4: Confirmar */}
          <PreflightStep
            num={4}
            title="Confirmar activación"
            description='Escribe "REAL" para confirmar que entiendes que el bot usará fondos reales.'
            chipStatus={canConfirm ? "ok" : "idle"}
          >
            <div style={S.row}>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value.toUpperCase())}
                placeholder='Escribe "REAL"'
                style={{
                  background: "#060610",
                  border: `1px solid ${canConfirm ? "rgba(0,255,136,0.4)" : "#2a2a3a"}`,
                  color: canConfirm ? "#00ff88" : "#555",
                  fontSize: 11, width: 140,
                  padding: "6px 10px", borderRadius: 3,
                  fontFamily: "inherit",
                  opacity: clobStatus !== "ok" ? 0.4 : 1,
                }}
              />
              <button
                onClick={() => { cancel(); onConfirm(); }}
                disabled={!canConfirm}
                style={{ ...S.btn("danger", !canConfirm), padding: "9px 24px", fontSize: 11 }}
              >
                🔴 ACTIVAR MODO REAL
              </button>
            </div>
          </PreflightStep>

        </div>
      </div>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────

export default function ModeSelector() {
  const [mode,          setMode]          = useState("simulate");
  const [loading,       setLoading]       = useState(true);
  const [saving,        setSaving]        = useState(false);
  const [lastUpdated,   setLastUpdated]   = useState(null);
  const [showPreflight, setShowPreflight] = useState(false);

  // v2.4: leer modo runtime real del bot vía bot-state
  const botState = useBotState();
  const botRunning     = botState.running;
  const botSimMode     = botState.simulate_mode;  // true | false | null
  const botModeKnown   = botRunning && botSimMode !== null;

  // ── Cargar modo configurado ───────────────────────────────────────────
  const loadMode = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/config?key=trading_mode");
      const data = await safeJson(res);
      setMode(data.value === "real" ? "real" : "simulate");
      if (data.updated_at) setLastUpdated(data.updated_at);
    } catch (e) {
      console.warn("[ModeSelector] loadMode error:", e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMode(); }, [loadMode]);

  // ── Guardar modo ──────────────────────────────────────────────────────
  const saveMode = async (newMode) => {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key: "trading_mode", value: newMode }),
      });
      const data = await safeJson(res);
      if (data.ok) {
        setMode(newMode);
        setLastUpdated(new Date().toISOString());
      }
    } catch (e) {
      console.error("[ModeSelector] saveMode error:", e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Handler cambio de modo ────────────────────────────────────────────
  const handleModeChange = (newMode) => {
    if (newMode === mode) return;
    if (newMode === "real") {
      setShowPreflight(true);
    } else {
      saveMode("simulate");
    }
  };

  const handlePreflightConfirm = () => {
    setShowPreflight(false);
    saveMode("real");
  };

  // ── ¿El modo configurado coincide con el modo activo en el bot? ───────
  // Solo relevante si el bot está corriendo y reporta simulate_mode.
  const configuredSimulate = mode === "simulate";
  const modeInSync = !botModeKnown || (botSimMode === configuredSimulate);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{ ...S.font }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>

      {showPreflight && (
        <PreflightScreen
          onCancel={() => setShowPreflight(false)}
          onConfirm={handlePreflightConfirm}
          botRunning={botRunning}
        />
      )}

      <div style={{
        background: "#02020a",
        border: "1px solid #1a1a2a",
        borderRadius: 6,
        padding: "20px 24px",
      }}>
        {/* Título */}
        <div style={{ ...S.row, justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.16em" }}>
            MODO DE TRADING
          </span>
          {loading && <span style={{ fontSize: 9, color: "#333" }}>cargando…</span>}
        </div>

        {/* ── Badge: modo configurado ─────────────────────────────────── */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#333", marginBottom: 5, letterSpacing: "0.1em" }}>
            CONFIGURADO
          </div>
          <span style={S.badge(mode)}>
            <span style={S.dot(mode)} />
            {mode === "real" ? "🔴 MODO REAL" : "🔵 MODO SIMULADO"}
          </span>
          {lastUpdated && (
            <div style={{ marginTop: 5, fontSize: 9, color: "#2a2a2a" }}>
              {new Date(lastUpdated).toLocaleString("es-ES")}
            </div>
          )}
        </div>

        {/* ── Badge: modo activo en el bot (runtime) ─────────────────── */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 9, color: "#333", marginBottom: 5, letterSpacing: "0.1em" }}>
            BOT ACTIVO EN
          </div>
          <span style={S.badgeRuntime(botModeKnown ? botSimMode : null)}>
            {!botRunning
              ? "○ BOT OFFLINE"
              : botSimMode === null
              ? "— DESCONOCIDO"
              : botSimMode
              ? "🔵 SIMULADO"
              : "🔴 REAL"
            }
          </span>
          {/* Aviso de propagación pendiente */}
          {botModeKnown && !modeInSync && (
            <div style={{ marginTop: 6, fontSize: 9, color: "#ff8800" }}>
              ⏳ Propagando cambio al bot (~60s)…
            </div>
          )}
          {botModeKnown && modeInSync && (
            <div style={{ marginTop: 6, fontSize: 9, color: "#2a2a2a" }}>
              ✓ En sincronía con el bot
            </div>
          )}
        </div>

        {/* ── Botones de cambio de modo ──────────────────────────────── */}
        <div style={{ ...S.row, gap: 10 }}>
          <button
            onClick={() => handleModeChange("simulate")}
            disabled={saving || loading || mode === "simulate"}
            style={S.btn("blue", saving || loading || mode === "simulate")}
          >
            🔵 SIMULADO
          </button>
          <button
            onClick={() => handleModeChange("real")}
            disabled={saving || loading || mode === "real"}
            style={S.btn("danger", saving || loading || mode === "real")}
          >
            🔴 REAL
          </button>
          {saving && <span style={{ fontSize: 9, color: "#555" }}>guardando…</span>}
        </div>

        {/* ── Info contextual ────────────────────────────────────────── */}
        <p style={{ fontSize: 9, color: "#333", marginTop: 12, lineHeight: 1.7 }}>
          {mode === "simulate"
            ? "El bot registra señales y precios CLOB pero no ejecuta órdenes reales."
            : "⚠ El bot ejecuta órdenes reales con fondos USDC de tu cartera."
          }
        </p>
      </div>
    </div>
  );
}
