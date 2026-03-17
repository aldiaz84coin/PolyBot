/**
 * components/ModeSelector.jsx — v1.0
 *
 * Panel completo para:
 *  1. Mostrar modo actual (SIMULADO / REAL) leído desde Supabase vía /api/config
 *  2. Cambiar de modo (escribir en Supabase → el bot lo recarga en ~60s)
 *  3. Pantalla de pre-vuelo al pasar a REAL:
 *       - Check CLOB connectivity  (comando check_clob → bot)
 *       - Check saldo USDC         (comando check_balance → bot)
 *       - Orden de prueba manual   (comando test_order → bot, opcional)
 *       - Confirmación de activación
 *
 * Uso: importar desde ConfigPanel.jsx o Dashboard.jsx donde corresponda.
 *
 * <ModeSelector />
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
    transition: "opacity 0.15s",
    ...(variant === "danger"  && { background: "rgba(255,68,102,0.12)", borderColor: "rgba(255,68,102,0.4)", color: "#ff4466" }),
    ...(variant === "primary" && { background: "rgba(0,255,136,0.10)", borderColor: "rgba(0,255,136,0.4)", color: "#00ff88" }),
    ...(variant === "blue"    && { background: "rgba(0,102,255,0.10)", borderColor: "rgba(0,102,255,0.3)", color: "#4488ff" }),
    ...(variant === "default" && { background: "transparent", borderColor: "#2a2a3a", color: "#555" }),
  }),
  row: { display: "flex", alignItems: "center", gap: 10 },
  col: { display: "flex", flexDirection: "column", gap: 8 },
};

// ── Status chip para cada check ───────────────────────────────────────────

function CheckChip({ status }) {
  const map = {
    idle:    { label: "—",        color: "#333" },
    loading: { label: "CARGANDO…", color: "#888" },
    ok:      { label: "✓ OK",     color: "#00ff88" },
    error:   { label: "✗ ERROR",  color: "#ff4466" },
    warn:    { label: "⚠ AVISO",  color: "#ffaa00" },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: s.color, letterSpacing: "0.1em" }}>
      {s.label}
    </span>
  );
}

// ── Hook: polling de un comando hasta done|error ──────────────────────────

function useCommandPoller() {
  const pollerRef = useRef(null);

  const poll = useCallback((commandId, onResult) => {
    let attempts = 0;
    const MAX = 60; // 60 × 2s = 120s timeout

    const tick = async () => {
      attempts++;
      try {
        const res = await fetch(`/api/commands?id=${commandId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.status === "done" || data.status === "error") {
          onResult(data);
          return;
        }
        if (attempts >= MAX) {
          onResult({ status: "error", result: { error: "Timeout esperando respuesta del bot" } });
          return;
        }
        pollerRef.current = setTimeout(tick, 2000);
      } catch (e) {
        onResult({ status: "error", result: { error: e.message } });
      }
    };

    pollerRef.current = setTimeout(tick, 1500);
  }, []);

  const cancel = useCallback(() => {
    if (pollerRef.current) clearTimeout(pollerRef.current);
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  return { poll, cancel };
}

// ── Step de pre-vuelo individual ──────────────────────────────────────────

function PreflightStep({ num, title, description, chipStatus, children }) {
  const borderColor = chipStatus === "ok" ? "rgba(0,255,136,0.15)"
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

// ── Pantalla de pre-vuelo ─────────────────────────────────────────────────

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
      const { ok, id, error } = await res.json();
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
      const { ok, id, error } = await res.json();
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
      const { ok, id, error } = await res.json();
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
                      {clobResult.market_slug && <div>Mercado activo: <b style={{ color: "#888" }}>{clobResult.market_slug}</b></div>}
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
                      <div>USDC disponible: <b style={{ color: "#00ff88" }}>${Number(balanceResult.usdc_balance).toFixed(2)}</b></div>
                      {balanceResult.pol_balance != null && (
                        <div>POL (gas): <b style={{ color: "#888" }}>{Number(balanceResult.pol_balance).toFixed(4)}</b></div>
                      )}
                      {Number(balanceResult.usdc_balance) < 5 && (
                        <div style={{ color: "#ffaa00", marginTop: 4 }}>
                          ⚠ Saldo bajo — recarga USDC antes de operar en real
                        </div>
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
            description="Ejecuta una orden real de bajo importe para confirmar que el flujo completo de compra funciona. Esta orden USA FONDOS REALES."
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
                <span style={{ fontSize: 9, color: "#444" }}>
                  (requiere paso 1 OK)
                </span>
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
  const [mode,        setMode]        = useState("simulate"); // simulate | real
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showPreflight, setShowPreflight] = useState(false);

  // ── Cargar modo actual ────────────────────────────────────────────────
  const loadMode = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/config?key=trading_mode");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMode(data.value === "real" ? "real" : "simulate");
      if (data.updated_at) setLastUpdated(new Date(data.updated_at));
    } catch (e) {
      console.error("[ModeSelector] Error loading mode:", e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMode(); }, [loadMode]);

  // ── Guardar modo ──────────────────────────────────────────────────────
  const saveMode = useCallback(async (newMode) => {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "trading_mode", value: newMode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMode(newMode);
      setLastUpdated(new Date());
    } catch (e) {
      console.error("[ModeSelector] Error saving mode:", e.message);
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Handler del toggle ────────────────────────────────────────────────
  const handleToggle = () => {
    if (mode === "simulate") {
      setShowPreflight(true);
    } else {
      // De real → simulate: sin confirmación extra
      saveMode("simulate");
    }
  };

  const fmtDate = (d) => d
    ? `${d.toLocaleDateString("es-ES")} ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
    : "—";

  return (
    <>
      {/* ── Panel principal ───────────────────────────────────────────── */}
      <div style={{
        border: `1px solid ${mode === "real" ? "rgba(255,68,102,0.25)" : "rgba(0,102,255,0.15)"}`,
        borderRadius: 4, padding: "16px 20px",
        background: mode === "real" ? "rgba(255,68,102,0.04)" : "rgba(0,102,255,0.03)",
        transition: "all 0.4s",
        ...S.font,
      }}>

        {/* Header */}
        <div style={{ ...S.row, justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.18em" }}>
            MODO DE OPERACIÓN
          </div>
          <div style={{ fontSize: 9, color: "#2a2a3a" }}>
            Actualizado: {fmtDate(lastUpdated)}
          </div>
        </div>

        {/* Badge + toggle */}
        <div style={{ ...S.row, justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={S.row}>
            {loading ? (
              <span style={{ fontSize: 10, color: "#333" }}>cargando…</span>
            ) : (
              <div style={S.badge(mode)}>
                <span style={S.dot(mode)} />
                {mode === "real" ? "MODO REAL" : "MODO SIMULADO"}
              </div>
            )}
          </div>

          {!loading && (
            <button
              onClick={handleToggle}
              disabled={saving}
              style={S.btn(mode === "simulate" ? "danger" : "blue", saving)}
            >
              {saving
                ? "GUARDANDO…"
                : mode === "simulate"
                  ? "→ PASAR A MODO REAL"
                  : "→ VOLVER A SIMULADO"
              }
            </button>
          )}
        </div>

        {/* Descripción contextual */}
        <div style={{
          marginTop: 12, padding: "10px 14px",
          background: "#04040e", border: "1px solid #0d0d1a",
          borderRadius: 3, fontSize: 9, color: "#444", lineHeight: 1.8,
        }}>
          {mode === "real" ? (
            <>
              <b style={{ color: "#ff4466" }}>⚠ MODO REAL ACTIVO.</b>{" "}
              El bot ejecuta órdenes reales en Polymarket usando fondos USDC de tu cartera.
              Las operaciones incurren en costes reales de gas y spread. Para volver a simulación
              haz clic en "Volver a simulado" — el bot lo aplicará en el siguiente ciclo.
            </>
          ) : (
            <>
              <b style={{ color: "#4488ff" }}>● MODO SIMULADO.</b>{" "}
              El bot evalúa señales y registra operaciones como si fueran reales,
              pero no envía ninguna orden al CLOB. Los P&L registrados son teóricos.
              Usa esta fase para validar la estrategia antes de arriesgar capital.
            </>
          )}
        </div>

        {/* Info de sincronización */}
        <div style={{ marginTop: 8, fontSize: 9, color: "#2a2a3a" }}>
          El bot recarga la configuración cada ~60s · Este estado se almacena en Supabase
        </div>
      </div>

      {/* ── Pantalla pre-vuelo ────────────────────────────────────────────── */}
      {showPreflight && (
        <PreflightScreen
          onCancel={() => setShowPreflight(false)}
          onConfirm={async () => {
            setShowPreflight(false);
            await saveMode("real");
          }}
        />
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </>
  );
}
