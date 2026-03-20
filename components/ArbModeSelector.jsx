/**
 * ArbModeSelector.jsx — v1.1
 *
 * v1.1 — MIGRACIÓN: eliminado createClient de @supabase/supabase-js.
 *         Ahora usa /api/config (GET + POST) igual que ModeSelector.
 *         Corrige error "supabaseUrl is required" en build de Vercel.
 *
 * v1.0 — Implementación inicial
 */

"use client";

import { useState, useEffect, useCallback } from "react";

const S = {
  card: {
    background: "#02020a",
    border: "1px solid #0a0a1e",
    borderRadius: 4,
    padding: "18px 20px",
    marginBottom: 16,
  },
  title: {
    fontSize: 9, letterSpacing: "0.18em", color: "#444",
    marginBottom: 14, display: "flex", alignItems: "center", gap: 8,
  },
  row: { display: "flex", alignItems: "center", gap: 12 },
  label: { fontSize: 9, color: "#555", letterSpacing: "0.1em" },
  badge: (color, active) => ({
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 2,
    fontSize: 9,
    letterSpacing: "0.12em",
    fontWeight: 700,
    border: `1px solid ${color}`,
    color: active ? "#000" : color,
    background: active ? color : "transparent",
    opacity: active ? 1 : 0.5,
  }),
  btn: (variant, disabled) => ({
    background: "none",
    border: `1px solid ${
      variant === "green" ? "#00ff88" :
      variant === "red"   ? "#ff4466" :
      variant === "blue"  ? "#4488ff" : "#333"
    }`,
    color: disabled ? "#333" :
      variant === "green" ? "#00ff88" :
      variant === "red"   ? "#ff4466" :
      variant === "blue"  ? "#4488ff" : "#999",
    fontSize: 9,
    letterSpacing: "0.12em",
    padding: "5px 12px",
    cursor: disabled ? "not-allowed" : "pointer",
    borderRadius: 2,
    fontFamily: "inherit",
    opacity: disabled ? 0.4 : 1,
    transition: "all 0.15s",
  }),
  input: {
    background: "#07070f",
    border: "1px solid #1a1a2e",
    color: "#ccc",
    fontSize: 10,
    padding: "4px 8px",
    borderRadius: 2,
    fontFamily: "inherit",
    width: 70,
    textAlign: "right",
  },
  divider: {
    height: 1, background: "#0a0a1e", margin: "12px 0",
  },
  statusDot: (active) => ({
    width: 7, height: 7, borderRadius: "50%",
    background: active ? "#00ff88" : "#333",
    boxShadow: active ? "0 0 6px #00ff88" : "none",
    display: "inline-block",
    marginRight: 6,
  }),
  info: {
    fontSize: 9, color: "#333", lineHeight: 1.7, marginTop: 10,
  },
};

const DEFAULT_STATE = {
  arb_enabled:       "false",
  arb_simulate_mode: "simulate",
  arb_stake_usdc:    "5.0",
};

// ── Helper fetch /api/config ──────────────────────────────────────────────────

async function getConfig(key) {
  const res  = await fetch(`/api/config?key=${key}`, { cache: "no-store" });
  const data = await res.json();
  return data.value ?? null;
}

async function setConfig(key, value) {
  await fetch("/api/config", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ key, value: String(value) }),
  });
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function ArbModeSelector() {
  const [state,       setState]      = useState(DEFAULT_STATE);
  const [stakeInput,  setStakeInput] = useState("5.0");
  const [loading,     setLoading]    = useState(true);
  const [saving,      setSaving]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  // ── Cargar config ─────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const [enabled, simMode, stake] = await Promise.all([
        getConfig("arb_enabled"),
        getConfig("arb_simulate_mode"),
        getConfig("arb_stake_usdc"),
      ]);
      const merged = {
        arb_enabled:       enabled  ?? DEFAULT_STATE.arb_enabled,
        arb_simulate_mode: simMode  ?? DEFAULT_STATE.arb_simulate_mode,
        arb_stake_usdc:    stake    ?? DEFAULT_STATE.arb_stake_usdc,
      };
      setState(merged);
      setStakeInput(merged.arb_stake_usdc);
      setLastUpdated(new Date().toISOString());
    } catch (e) {
      console.error("[ArbModeSelector] loadConfig:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    const interval = setInterval(loadConfig, 15_000);
    return () => clearInterval(interval);
  }, [loadConfig]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleEnable = async (enabled) => {
    setSaving(true);
    try {
      await setConfig("arb_enabled", enabled ? "true" : "false");
      setState(s => ({ ...s, arb_enabled: enabled ? "true" : "false" }));
    } finally {
      setSaving(false);
    }
  };

  const handleMode = async (mode) => {
    setSaving(true);
    try {
      await setConfig("arb_simulate_mode", mode);
      setState(s => ({ ...s, arb_simulate_mode: mode }));
    } finally {
      setSaving(false);
    }
  };

  const handleStake = async () => {
    const val = parseFloat(stakeInput);
    if (isNaN(val) || val <= 0) return;
    setSaving(true);
    try {
      await setConfig("arb_stake_usdc", val.toFixed(2));
      setState(s => ({ ...s, arb_stake_usdc: val.toFixed(2) }));
    } finally {
      setSaving(false);
    }
  };

  // ── Derivados ─────────────────────────────────────────────────────────────
  const isEnabled  = state.arb_enabled === "true";
  const isSimulate = state.arb_simulate_mode === "simulate";

  if (loading) {
    return (
      <div style={S.card}>
        <div style={S.title}>⚖️ ARBITRAJE</div>
        <div style={{ fontSize: 9, color: "#333" }}>cargando…</div>
      </div>
    );
  }

  return (
    <div style={S.card}>
      {/* ── Título ─────────────────────────────────────────────────────────── */}
      <div style={S.title}>
        <span style={S.statusDot(isEnabled)} />
        ⚖️ ESTRATEGIA DE ARBITRAJE
        {lastUpdated && (
          <span style={{ marginLeft: "auto", fontSize: 8, color: "#2a2a2a" }}>
            {new Date(lastUpdated).toLocaleTimeString("es-ES")}
          </span>
        )}
      </div>

      {/* ── Enable / Disable ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ ...S.label, marginBottom: 7 }}>ESTADO</div>
        <div style={S.row}>
          <button
            onClick={() => handleEnable(true)}
            disabled={saving || isEnabled}
            style={S.btn("green", saving || isEnabled)}
          >
            ◉ ACTIVADO
          </button>
          <button
            onClick={() => handleEnable(false)}
            disabled={saving || !isEnabled}
            style={S.btn("red", saving || !isEnabled)}
          >
            ○ DESACTIVADO
          </button>
          {saving && <span style={{ fontSize: 9, color: "#555" }}>guardando…</span>}
        </div>
      </div>

      <div style={S.divider} />

      {/* ── Modo Simulado / Real ───────────────────────────────────────────── */}
      <div style={{ marginBottom: 14, opacity: isEnabled ? 1 : 0.4 }}>
        <div style={{ ...S.label, marginBottom: 7 }}>MODO ARB</div>
        <div style={S.row}>
          <button
            onClick={() => handleMode("simulate")}
            disabled={saving || isSimulate || !isEnabled}
            style={S.btn("blue", saving || isSimulate || !isEnabled)}
          >
            🔵 SIMULADO
          </button>
          <button
            onClick={() => handleMode("real")}
            disabled={saving || !isSimulate || !isEnabled}
            style={S.btn("red", saving || !isSimulate || !isEnabled)}
          >
            🔴 REAL
          </button>
        </div>
        <div style={{ marginTop: 7 }}>
          <span style={S.badge(isSimulate ? "#4488ff" : "#ff4466", true)}>
            {isSimulate ? "🔵 SIMULADO" : "🔴 REAL"}
          </span>
        </div>
      </div>

      <div style={S.divider} />

      {/* ── Stake por pata ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 6, opacity: isEnabled ? 1 : 0.4 }}>
        <div style={{ ...S.label, marginBottom: 7 }}>STAKE POR PATA (USDC)</div>
        <div style={S.row}>
          <input
            type="number"
            min="0.1"
            step="0.5"
            value={stakeInput}
            onChange={e => setStakeInput(e.target.value)}
            style={S.input}
            disabled={!isEnabled}
          />
          <button
            onClick={handleStake}
            disabled={saving || !isEnabled}
            style={S.btn("green", saving || !isEnabled)}
          >
            GUARDAR
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 9, color: "#444" }}>
          Invertido total por par:{" "}
          <b style={{ color: "#888" }}>
            ${(parseFloat(stakeInput || "0") * 2).toFixed(2)} USDC
          </b>
        </div>
      </div>

      {/* ── Info ──────────────────────────────────────────────────────────── */}
      <p style={S.info}>
        {isEnabled
          ? isSimulate
            ? "⚖️ Bot ARB activo en modo simulado. Monitorea oportunidades de par sin ejecutar órdenes reales."
            : "⚠️ Bot ARB activo en modo REAL. Ejecuta órdenes CLOB cuando pair_cost < umbral."
          : "Bot ARB desactivado. Actívalo para monitorear oportunidades de arbitraje en paralelo."
        }
      </p>
      <p style={{ ...S.info, color: "#2a2a3a" }}>
        Los cambios se propagan al bot en ~60s.
      </p>
    </div>
  );
}
