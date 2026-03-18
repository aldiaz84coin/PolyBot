"use client";
/**
 * components/ModeSelector.jsx — v2.1
 *
 * CAMBIOS v2.1 — check_clob DIRECTO:
 *   runClobCheck detecta respuesta directa (data.direct === true) y aplica
 *   el resultado inmediatamente sin iniciar polling. check_balance y
 *   test_order siguen usando el poller como antes.
 *
 * CAMBIOS v2.0 — Preflight screen para cambio a modo real.
 * CAMBIOS v1.1 — safeJson con guard res.ok.
 */

import { useState, useEffect, useRef, useCallback } from "react";

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

// ── Helpers ───────────────────────────────────────────────────────────────

async function safeJson(res) {
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    const match = body.match(/"error"\s*:\s*"([^"]+)"/);
    const msg = match ? match[1] : `HTTP ${res.status} — el servidor devolvió una respuesta no válida`;
    throw new Error(msg);
  }
  return res.json();
}

// ── CheckChip ─────────────────────────────────────────────────────────────

function CheckChip({ status }) {
  const map = {
    idle:    { color: "#333",    label: "—"       },
    loading: { color: "#4488ff", label: "..."      },
    ok:      { color: "#00ff88", label: "✓ OK"    },
    error:   { color: "#ff4466", label: "✗ ERROR"  },
  };
  const { color, label } = map[status] || map.idle;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
      color, padding: "2px 8px", borderRadius: 2,
      border: `1px solid ${color}30`,
      background: `${color}10`,
    }}>
      {label}
    </span>
  );
}

// ── useCommandPoller ──────────────────────────────────────────────────────
// Usado solo para check_balance y test_order (pasan por el bot).

function useCommandPoller() {
  const timerRef = useRef(null);

  const cancel = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const poll = useCallback((id, onDone) => {
    cancel();
    timerRef.current = setInterval(async () => {
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

function PreflightScreen({ onCancel, onConfirm }) {
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

  // ── Check CLOB — v2.1: ejecución directa, sin polling ────────────────────
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

      // Respuesta directa — la API route ejecutó check_clob inline, sin bot.
      if (data.direct) {
        const ok = data.status === "done" && data.result?.success;
        setClobStatus(ok ? "ok" : "error");
        setClobResult(data.result);
        return;
      }

      // Fallback legacy: si por alguna razón llega id (no debería pasar para check_clob).
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

  // ── Check Balance — pasa por el bot (necesita wallet) ────────────────────
  const runBalanceCheck = async () => {
    setBalanceStatus("loading"); setBalanceResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "check_balance" }),
      });
      const { ok, id, error } = await safeJson(res);
      if (!ok) throw new Error(error || "Error enviando comando");
      poll(id, (data) => {
        const ok2 = data.status === "done" && data.result?.success;
        setBalanceStatus(ok2 ? "ok" : "error");
        setBalanceResult(data.result);
      });
    } catch (e) {
      setBalanceStatus("error");
      setBalanceResult({ error: e.message });
    }
  };

  // ── Orden de prueba — pasa por el bot (necesita L2 auth) ─────────────────
  const runTestOrder = async () => {
    setTestStatus("loading"); setTestResult(null);
    const stake = parseFloat(testStake);
    if (isNaN(stake) || stake < 0.5 || stake > 10) {
      setTestStatus("error");
      setTestResult({ error: "Stake debe estar entre 0.50 y 10.00 USDC" });
      return;
    }
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test_order", params: { direction: testDir, stake } }),
      });
      const { ok, id, error } = await safeJson(res);
      if (!ok) throw new Error(error || "Error enviando comando");
      poll(id, (data) => {
        const ok2 = data.status === "done" && data.result?.success;
        setTestStatus(ok2 ? "ok" : "error");
        setTestResult(data.result);
      });
    } catch (e) {
      setTestStatus("error");
      setTestResult({ error: e.message });
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.85)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
      ...S.font,
    }}>
      <div style={{
        background: "#02020a", border: "1px solid #1a1a2a",
        borderRadius: 6, padding: 28,
        width: "100%", maxWidth: 560,
        maxHeight: "90vh", overflowY: "auto",
        boxShadow: "0 0 60px rgba(255,68,102,0.08)",
      }}>
        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ ...S.row, justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: "#ff4466", fontWeight: 700, letterSpacing: "0.12em" }}>
              ⚠ CAMBIO A MODO REAL
            </div>
            <button onClick={() => { cancel(); onCancel(); }} style={S.btn("default")}>
              ✕ CANCELAR
            </button>
          </div>
          <p style={{ fontSize: 10, color: "#555", lineHeight: 1.7, margin: 0 }}>
            Antes de activar el modo real, verifica que el bot tiene conectividad
            con Polymarket y que las credenciales son correctas. Las órdenes reales
            usan fondos USDC reales de tu cartera.
          </p>
        </div>

        <div style={S.col}>

          {/* PASO 1: CLOB */}
          <PreflightStep
            num={1}
            title="Conexión CLOB"
            description="Verifica que el mercado BTC está activo en Polymarket y los precios CLOB están disponibles. Ejecutado directamente desde Vercel — sin depender del bot."
            chipStatus={clobStatus}
          >
            <div style={S.row}>
              <button
                onClick={runClobCheck}
                disabled={clobStatus === "loading"}
                style={S.btn("blue", clobStatus === "loading")}
              >
                {clobStatus === "loading" ? "VERIFICANDO…" : "VERIFICAR CONEXIÓN"}
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
            title="Balance de cartera"
            description="Consulta el saldo USDC y POL en tu cartera de Polygon. Requiere que el bot esté activo en Railway."
            chipStatus={balanceStatus}
          >
            <div style={S.row}>
              <button
                onClick={runBalanceCheck}
                disabled={balanceStatus === "loading"}
                style={S.btn("blue", balanceStatus === "loading")}
              >
                {balanceStatus === "loading" ? "CONSULTANDO…" : "CONSULTAR BALANCE"}
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
                    <div>USDC: <span style={{ color: "#00ff88" }}>${parseFloat(balanceResult.usdc || 0).toFixed(2)}</span></div>
                    <div>POL:  <span style={{ color: "#888" }}>{parseFloat(balanceResult.pol || 0).toFixed(4)}</span></div>
                    {balanceResult.rpc_attempts && (
                      <div style={{ color: "#444" }}>RPC: {balanceResult.rpc_attempts}</div>
                    )}
                  </>
                )}
              </div>
            )}
          </PreflightStep>

          {/* PASO 3: Orden de prueba */}
          <PreflightStep
            num={3}
            title="Orden de prueba (opcional)"
            description="Ejecuta una orden real mínima para verificar L2 auth y conectividad completa con el CLOB. Usa fondos reales."
            chipStatus={testStatus}
          >
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
                {testStatus === "loading" ? "EJECUTANDO…" : "TEST ORDER"}
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
                style={{
                  ...S.btn("danger", !canConfirm),
                  padding: "9px 24px",
                  fontSize: 11,
                }}
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

  // ── Cargar modo actual ────────────────────────────────────────────────
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "trading_mode", value: newMode }),
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

  const handlePreflightCancel = () => {
    setShowPreflight(false);
  };

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
          onCancel={handlePreflightCancel}
          onConfirm={handlePreflightConfirm}
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
          {loading && (
            <span style={{ fontSize: 9, color: "#333" }}>cargando…</span>
          )}
        </div>

        {/* Badge modo actual */}
        <div style={{ marginBottom: 20 }}>
          <span style={S.badge(mode)}>
            <span style={S.dot(mode)} />
            {mode === "real" ? "🔴 MODO REAL" : "🔵 MODO SIMULADO"}
          </span>
          {lastUpdated && (
            <div style={{ marginTop: 6, fontSize: 9, color: "#333" }}>
              Actualizado: {new Date(lastUpdated).toLocaleString("es-ES")}
            </div>
          )}
        </div>

        {/* Selector */}
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
          {saving && (
            <span style={{ fontSize: 9, color: "#555" }}>guardando…</span>
          )}
        </div>

        {/* Info */}
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
