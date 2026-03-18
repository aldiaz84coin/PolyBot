/**
 * components/ModeSelector.jsx — v1.1
 *
 * CAMBIOS v1.1:
 *   - Guard res.ok antes de res.json() en runClobCheck, runBalanceCheck y
 *     runTestOrder: evita el crash "Unexpected token '<'" cuando el servidor
 *     devuelve HTML (500/404) en lugar de JSON.
 *   - Helper safeJson() centraliza la comprobación en los tres handlers.
 *
 * Panel completo para:
 *  1. Mostrar modo actual (SIMULADO / REAL) leído desde Supabase vía /api/config
 *  2. Cambiar de modo (escribir en Supabase → el bot lo recarga en ~60s)
 *  3. Pantalla de pre-vuelo al pasar a REAL:
 *       - Check CLOB connectivity  (comando check_clob → bot)
 *       - Check saldo USDC         (comando check_balance → bot)
 *       - Orden de prueba manual   (comando test_order → bot, opcional)
 *       - Confirmación de activación
 */

"use client";
import { useState, useEffect, useCallback, useRef } from "react";

// ── Helpers visuales ──────────────────────────────────────────────────────

const S = {
  font: { fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)" },
  badge: (mode) => ({
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "4px 12px", borderRadius: 3,
    fontSize: 11, fontWeight: 700, letterSpacing: "0.14em",
    background: mode === "real"
      ? "rgba(255, 68, 102, 0.12)"
      : "rgba(0, 102, 255, 0.10)",
    border: `1px solid ${mode === "real" ? "rgba(255,68,102,0.4)" : "rgba(0,102,255,0.3)"}`,
    color: mode === "real" ? "#ff4466" : "#4488ff",
  }),
  dot: (mode) => ({
    width: 7, height: 7, borderRadius: "50%",
    background: mode === "real" ? "#ff4466" : "#4488ff",
    animation: "pulse 2s infinite",
  }),
  btn: (variant = "default", disabled = false) => ({
    padding: "7px 18px", borderRadius: 3,
    fontSize: 10, letterSpacing: "0.12em", fontWeight: 700,
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

// ── v1.1: helper para fetch → JSON con guard res.ok ───────────────────────
async function safeJson(res) {
  if (!res.ok) {
    // El servidor devolvió HTML (500/404) — leer como texto para debug
    let body = "";
    try { body = await res.text(); } catch (_) {}
    // Extraer mensaje legible si hay JSON dentro del HTML
    const match = body.match(/"error"\s*:\s*"([^"]+)"/);
    const msg = match ? match[1] : `HTTP ${res.status} — el servidor devolvió una respuesta no válida`;
    throw new Error(msg);
  }
  return res.json();
}

// ── CheckChip ────────────────────────────────────────────────────────────

function CheckChip({ status }) {
  const map = {
    idle:    { color: "#333",     label: "—"      },
    loading: { color: "#4488ff",  label: "..."     },
    ok:      { color: "#00ff88",  label: "✓ OK"   },
    error:   { color: "#ff4466",  label: "✗ ERROR" },
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

  const bg =
    chipStatus === "ok"      ? "rgba(0,255,136,0.15)"
    : chipStatus === "error" ? "rgba(255,68,102,0.15)"
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

  // ── Check CLOB ───────────────────────────────────────────────────────────
  const runClobCheck = async () => {
    setClobStatus("loading"); setClobResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "check_clob" }),
      });
      // v1.1: guard res.ok — evita crash si el servidor devuelve HTML
      const { ok, id, error } = await safeJson(res);
      if (!ok) throw new Error(error || "Error enviando comando");
      poll(id, (data) => {
        const ok2 = data.status === "done" && data.result?.success;
        setClobStatus(ok2 ? "ok" : "error");
        setClobResult(data.result);
      });
    } catch (e) {
      setClobStatus("error");
      setClobResult({ error: e.message });
    }
  };

  // ── Check Balance ────────────────────────────────────────────────────────
  const runBalanceCheck = async () => {
    setBalanceStatus("loading"); setBalanceResult(null);
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "check_balance" }),
      });
      // v1.1: guard res.ok
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

  // ── Orden de prueba ───────────────────────────────────────────────────────
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
      // v1.1: guard res.ok
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
            description="Verifica que el bot puede conectarse a clob.polymarket.com, autenticarse con Level 2 y leer precios de mercado."
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
                {clobResult.error
                  ? <span style={{ color: "#ff4466" }}>Error: {clobResult.error}</span>
                  : (
                    <>
                      <div>Latencia CLOB: <b style={{ color: "#4488ff" }}>{clobResult.latency_ms}ms</b></div>
                      {clobResult.market_slug && (
                        <div>Mercado activo: <b style={{ color: "#888" }}>{clobResult.market_slug}</b></div>
                      )}
                      {clobResult.yes_price != null && (
                        <div>
                          Precio YES: <b style={{ color: "#00ff88" }}>{(clobResult.yes_price * 100).toFixed(1)}¢</b>
                          {" · "}
                          NO: <b style={{ color: "#ff4466" }}>{(clobResult.no_price * 100).toFixed(1)}¢</b>
                        </div>
                      )}
                    </>
                  )
                }
              </div>
            )}
          </PreflightStep>

          {/* PASO 2: Balance */}
          <PreflightStep
            num={2}
            title="Saldo USDC"
            description="Consulta el balance de USDC disponible en la cartera de la cuenta de trading."
            chipStatus={balanceStatus}
          >
            <div style={S.row}>
              <button
                onClick={runBalanceCheck}
                disabled={balanceStatus === "loading"}
                style={S.btn("blue", balanceStatus === "loading")}
              >
                {balanceStatus === "loading" ? "CONSULTANDO…" : "CONSULTAR SALDO"}
              </button>
            </div>
            {balanceResult && (
              <div style={{
                marginTop: 8, padding: "8px 12px",
                background: "#060610", border: "1px solid #1a1a2a",
                borderRadius: 3, fontSize: 9, color: "#666", lineHeight: 1.8,
              }}>
                {balanceResult.error
                  ? <span style={{ color: "#ff4466" }}>Error: {balanceResult.error}</span>
                  : (
                    <>
                      {balanceResult.usdc != null && (
                        <div>USDC: <b style={{ color: "#00ff88" }}>${balanceResult.usdc?.toFixed(2)}</b></div>
                      )}
                      {balanceResult.pol != null && (
                        <div>POL (gas): <b style={{ color: "#888" }}>{balanceResult.pol?.toFixed(4)}</b></div>
                      )}
                    </>
                  )
                }
              </div>
            )}
          </PreflightStep>

          {/* PASO 3: Orden de prueba (opcional) */}
          <PreflightStep
            num={3}
            title="Orden de prueba (opcional)"
            description="Ejecuta una orden REAL mínima para confirmar que las credenciales Level 2 y el saldo son suficientes. Esta orden USA FONDOS REALES."
            chipStatus={testStatus}
          >
            <div style={{ ...S.row, flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              {["UP", "DOWN"].map(d => (
                <button key={d} onClick={() => setTestDir(d)} style={{
                  ...S.btn(testDir === d ? (d === "UP" ? "primary" : "danger") : "default"),
                  padding: "5px 14px",
                }}>
                  {d === "UP" ? "▲ UP" : "▼ DOWN"}
                </button>
              ))}
              <div style={{ ...S.row, gap: 4 }}>
                <span style={{ fontSize: 9, color: "#444" }}>STAKE:</span>
                <input
                  type="number" min="0.5" max="10" step="0.5"
                  value={testStake}
                  onChange={e => setTestStake(e.target.value)}
                  style={{
                    width: 60, padding: "4px 8px",
                    background: "#07070f", border: "1px solid #2a2a3a",
                    color: "#888", fontSize: 10, borderRadius: 3,
                    fontFamily: "inherit",
                  }}
                />
                <span style={{ fontSize: 9, color: "#444" }}>USDC</span>
              </div>
            </div>
            <div style={S.row}>
              <button
                onClick={runTestOrder}
                disabled={testStatus === "loading" || clobStatus !== "ok"}
                style={S.btn("danger", testStatus === "loading" || clobStatus !== "ok")}
              >
                {testStatus === "loading" ? "EJECUTANDO…" : "EJECUTAR ORDEN PRUEBA"}
              </button>
              {clobStatus !== "ok" && (
                <span style={{ fontSize: 9, color: "#444" }}>(requiere paso 1 OK)</span>
              )}
            </div>
            {testResult && (
              <div style={{
                marginTop: 8, padding: "8px 12px",
                background: "#060610", border: "1px solid #1a1a2a",
                borderRadius: 3, fontSize: 9, color: "#666", lineHeight: 1.8,
              }}>
                {testResult.error
                  ? <span style={{ color: "#ff4466" }}>Error: {testResult.error}</span>
                  : (
                    <>
                      <div>Order ID: <b style={{ color: "#4488ff" }}>{testResult.order_id || "—"}</b></div>
                      <div>Status: <b style={{ color: "#00ff88" }}>{testResult.status || "—"}</b></div>
                      {testResult.odds != null && (
                        <div>Odds ejecutadas: <b style={{ color: "#888" }}>{(testResult.odds * 100).toFixed(1)}¢</b></div>
                      )}
                    </>
                  )
                }
              </div>
            )}
          </PreflightStep>

          {/* PASO 4: Confirmación */}
          <PreflightStep
            num={4}
            title="Confirmar activación"
            description={`Escribe "REAL" para confirmar. El bot cambiará de modo en el próximo ciclo de polling (~60s).${clobStatus !== "ok" ? " ⚠ Requiere completar el paso 1." : ""}`}
            chipStatus={canConfirm ? "ok" : "idle"}
          >
            <div style={S.col}>
              <div style={S.row}>
                <input
                  type="text"
                  placeholder='Escribe "REAL"'
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value.toUpperCase())}
                  disabled={clobStatus !== "ok"}
                  style={{
                    padding: "6px 12px", borderRadius: 3,
                    background: "#07070f",
                    border: `1px solid ${canConfirm ? "rgba(0,255,136,0.4)" : "#2a2a3a"}`,
                    color: canConfirm ? "#00ff88" : "#555",
                    fontSize: 11, width: 140,
                    fontFamily: "inherit",
                    opacity: clobStatus !== "ok" ? 0.4 : 1,
                  }}
                />
              </div>
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
      // v1.1: guard res.ok
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
      // v1.1: guard res.ok
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
