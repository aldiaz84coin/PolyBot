/**
 * components/ConfigPanel.jsx — v1.4
 *
 * v1.4 — AlgorithmSelector: toggle Standard / Optimizado.
 *         Persiste en bot_config.algorithm_version via /api/config.
 *         El bot carga el valor cada ~60s y aplica las reglas:
 *           OPTIMIZADO → bloquea T-5 y horas 12–16 UTC.
 *         Las operaciones se taggean con algorithm_version para comparativa.
 * v1.3 — Aviso "requiere editar config.yaml" en umbrales y capital.
 * v1.2 — Botón GUARDAR stake_usdc con feedback visual.
 * v1.1 — Grid original (umbrales / capital / env vars).
 */

"use client";
import { useState, useEffect } from "react";
import { WINDOWS } from "../lib/constants";

// ── Sub-componentes ──────────────────────────────────────────────────────────

function Field({ label, sub, value, onChange, color = "var(--green)" }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ fontSize: 11, color: "#666", display: "block", marginBottom: 2 }}>{label}</label>
      {sub && <div style={{ fontSize: 9, color: "#444", marginBottom: 6 }}>{sub}</div>}
      <input
        type="number"
        value={value}
        onChange={e => onChange(+e.target.value)}
        style={{
          background: "var(--bg3)", border: "1px solid var(--border2)",
          color, padding: "8px 14px", fontFamily: "var(--font)",
          fontSize: 15, width: 140, outline: "none", borderRadius: 3,
          transition: "border-color 0.2s",
        }}
        onFocus={e => e.target.style.borderColor = color}
        onBlur={e => e.target.style.borderColor = "var(--border2)"}
      />
    </div>
  );
}

/** Aviso para parámetros que requieren editar config.yaml en Railway */
function ConfigYamlNote() {
  return (
    <div style={{
      marginTop: 4, marginBottom: 4,
      padding: "10px 14px",
      background: "#02020e",
      border: "1px solid #1a1a2e",
      borderRadius: 3,
      fontSize: 9,
      color: "#555",
      lineHeight: 1.8,
    }}>
      <span style={{ color: "#333", marginRight: 6 }}>⚠</span>
      Estos valores son de <span style={{ color: "#888" }}>solo lectura</span> en el dashboard.
      Para cambiarlos edita{" "}
      <span style={{ color: "var(--yellow)" }}>config.yaml</span>{" "}
      en Railway y reinicia el bot.
    </div>
  );
}

// ── Algorithm Version Selector ───────────────────────────────────────────────

function AlgorithmSelector() {
  const [version,    setVersion]    = useState("standard");
  const [saveStatus, setSaveStatus] = useState("idle"); // idle | saving | ok | error
  const [saveMsg,    setSaveMsg]    = useState("");
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch("/api/config?key=algorithm_version");
        const data = await res.json();
        if (data.value) setVersion(data.value);
      } catch (e) {
        console.warn("[AlgorithmSelector] load error:", e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveVersion = async (newVersion) => {
    if (newVersion === version) return;
    setSaveStatus("saving");
    setSaveMsg("");
    try {
      const res  = await fetch("/api/config", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key: "algorithm_version", value: newVersion }),
      });
      const data = await res.json();
      if (data.ok !== false && !data.error) {
        setVersion(newVersion);
        setSaveStatus("ok");
        setSaveMsg(
          newVersion === "optimized"
            ? "✅ Modo Optimizado activado — el bot lo cargará en ~60s"
            : "✅ Modo Estándar activado — el bot lo cargará en ~60s"
        );
      } else {
        setSaveStatus("error");
        setSaveMsg(`❌ Error: ${data.error ?? "desconocido"}`);
      }
    } catch (e) {
      setSaveStatus("error");
      setSaveMsg(`❌ ${e.message}`);
    }
    setTimeout(() => { setSaveStatus("idle"); setSaveMsg(""); }, 5000);
  };

  const OPTIONS = [
    {
      id:    "standard",
      label: "ESTÁNDAR",
      desc:  "Opera en todas las ventanas (T-50 → T-5) y todas las horas. Comportamiento original del bot.",
      color: "#4488ff",
      icon:  "◈",
    },
    {
      id:    "optimized",
      label: "OPTIMIZADO",
      desc:  "Bloquea T-5 y horas 12–16 UTC. Solo opera T-20/T-15/T-10 donde el edge histórico es mayor.",
      color: "#00ff88",
      icon:  "⬡",
    },
  ];

  return (
    <div>
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 16 }}>
        VERSIÓN DE ALGORITMO
      </div>

      {loading ? (
        <div style={{ fontSize: 10, color: "#333" }}>cargando…</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
            {OPTIONS.map(opt => {
              const active = version === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => saveVersion(opt.id)}
                  disabled={saveStatus === "saving" || active}
                  style={{
                    background:   active ? `${opt.color}10` : "#02020a",
                    border:       `1px solid ${active ? opt.color : "#1a1a2e"}`,
                    borderRadius: 4,
                    padding:      "12px 16px",
                    cursor:       active ? "default" : (saveStatus === "saving" ? "wait" : "pointer"),
                    textAlign:    "left",
                    fontFamily:   "inherit",
                    transition:   "all 0.2s",
                    opacity:      saveStatus === "saving" && !active ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ color: opt.color, fontSize: 14 }}>{opt.icon}</span>
                    <span style={{ fontSize: 10, color: opt.color, letterSpacing: "0.12em" }}>
                      {opt.label}
                    </span>
                    {active && (
                      <span style={{
                        fontSize: 8, letterSpacing: "0.1em",
                        padding: "1px 6px", borderRadius: 2,
                        background: `${opt.color}18`,
                        border: `1px solid ${opt.color}44`,
                        color: opt.color, marginLeft: "auto",
                      }}>
                        ACTIVO
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 9, color: "#555", lineHeight: 1.6, textAlign: "left" }}>
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>

          {saveMsg && (
            <div style={{
              fontSize: 10, lineHeight: 1.6, padding: "8px 12px",
              borderRadius: 3, marginBottom: 12,
              background: saveStatus === "ok" ? "rgba(0,255,136,0.06)" : "rgba(255,68,102,0.08)",
              border: `1px solid ${saveStatus === "ok" ? "rgba(0,255,136,0.3)" : "rgba(255,68,102,0.3)"}`,
              color: saveStatus === "ok" ? "var(--green)" : "var(--red)",
            }}>
              {saveMsg}
            </div>
          )}

          {/* Reglas activas en modo Optimizado */}
          {version === "optimized" && (
            <div style={{
              padding: "10px 14px",
              background: "#020e06",
              border: "1px solid #003322",
              borderRadius: 3,
              fontSize: 9,
              color: "#446655",
              lineHeight: 1.9,
            }}>
              <div style={{ color: "#00cc66", marginBottom: 4, letterSpacing: "0.1em" }}>
                ⬡ REGLAS ACTIVAS
              </div>
              <div>❌ T-5 bloqueada (alta volatilidad vs real)</div>
              <div>❌ Horas 12–16 UTC bloqueadas (degradación detectada)</div>
              <div>✅ T-20 · T-15 · T-10 activas</div>
              <div style={{ marginTop: 4, color: "#336644" }}>
                🏷 Ops tageadas:{" "}
                <span style={{ color: "#00ff88", fontFamily: "monospace" }}>optimized</span>
              </div>
            </div>
          )}

          {version === "standard" && (
            <div style={{
              padding: "10px 14px",
              background: "#020814",
              border: "1px solid #001133",
              borderRadius: 3,
              fontSize: 9,
              color: "#334466",
              lineHeight: 1.9,
            }}>
              <div style={{ color: "#3366cc", marginBottom: 4, letterSpacing: "0.1em" }}>
                ◈ REGLAS ACTIVAS
              </div>
              <div>✅ Todas las ventanas activas (T-50 → T-5)</div>
              <div>✅ Todas las horas UTC sin restricción</div>
              <div style={{ marginTop: 4, color: "#223344" }}>
                🏷 Ops tageadas:{" "}
                <span style={{ color: "#4488ff", fontFamily: "monospace" }}>standard</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Componente principal ─────────────────────────────────────────────────────

export default function ConfigPanel({ config, onChange }) {
  const set = (key) => (val) => onChange(c => ({ ...c, [key]: val }));

  // Estado del guardado de stake
  const [saveStatus, setSaveStatus] = useState("idle"); // "idle"|"saving"|"ok"|"error"
  const [saveMsg,    setSaveMsg]    = useState("");

  const handleSave = async () => {
    setSaveStatus("saving");
    setSaveMsg("");
    try {
      const res  = await fetch("/api/config", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key: "stake_usdc", value: String(config.stake_usdc) }),
      });
      const data = await res.json();
      if (data.ok !== false && !data.error) {
        setSaveStatus("ok");
        setSaveMsg("✅ Stake guardado — el bot lo cargará en ~60s");
      } else {
        setSaveStatus("error");
        setSaveMsg(`❌ Error: ${data.error ?? "desconocido"}`);
      }
    } catch (e) {
      setSaveStatus("error");
      setSaveMsg(`❌ ${e.message}`);
    }
    setTimeout(() => { setSaveStatus("idle"); setSaveMsg(""); }, 4000);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: "var(--bg)", minHeight: "calc(100vh - 90px)",
      padding: "32px 32px", display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr", gap: 48,
    }}>

      {/* ── UMBRALES ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
          UMBRALES DE ENTRADA (USD)
        </div>
        {WINDOWS.map(w => (
          <Field
            key={w.key}
            label={`${w.label}  (${w.min}–${w.max} min antes)`}
            sub={`Distancia mínima al target para entrar en ventana ${w.label}`}
            value={config[w.configKey]}
            onChange={set(w.configKey)}
            color={w.color}
          />
        ))}
        <ConfigYamlNote />
      </div>

      {/* ── CAPITAL ────────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
          GESTIÓN DE CAPITAL
        </div>

        {/* Stake — persiste en Supabase */}
        <Field
          label="STAKE USDC / OPERACIÓN"
          sub="Cantidad apostada en cada entrada"
          value={config.stake_usdc}
          onChange={set("stake_usdc")}
          color="var(--yellow)"
        />

        {/* Botón guardar stake */}
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={handleSave}
            disabled={saveStatus === "saving"}
            style={{
              background: saveStatus === "ok"
                ? "rgba(0,255,136,0.12)"
                : saveStatus === "error"
                  ? "rgba(255,68,102,0.12)"
                  : "rgba(255,204,0,0.08)",
              border: `1px solid ${
                saveStatus === "ok"    ? "rgba(0,255,136,0.4)"  :
                saveStatus === "error" ? "rgba(255,68,102,0.4)" :
                                         "rgba(255,204,0,0.3)"
              }`,
              color: saveStatus === "ok"
                ? "var(--green)"
                : saveStatus === "error"
                  ? "var(--red)"
                  : "var(--yellow)",
              fontSize: 10, letterSpacing: "0.12em",
              padding: "9px 22px",
              cursor: saveStatus === "saving" ? "default" : "pointer",
              fontFamily: "inherit", borderRadius: 3,
              opacity: saveStatus === "saving" ? 0.6 : 1,
              transition: "all 0.2s",
            }}
          >
            {saveStatus === "saving" ? "GUARDANDO…" : "GUARDAR STAKE"}
          </button>

          {saveMsg && (
            <div style={{
              marginTop: 10, fontSize: 10, lineHeight: 1.6, maxWidth: 260,
              color: saveStatus === "ok" ? "var(--green)" : "var(--red)",
            }}>
              {saveMsg}
            </div>
          )}
        </div>

        {/* Max ops y stop loss — solo config.yaml */}
        <Field
          label="MAX OPERACIONES / DÍA"
          sub="Límite diario de entradas"
          value={config.max_ops_dia}
          onChange={set("max_ops_dia")}
          color="var(--yellow)"
        />
        <Field
          label="STOP LOSS %"
          sub="Salir si la posición pierde este %"
          value={config.stop_loss_pct}
          onChange={set("stop_loss_pct")}
          color="var(--red)"
        />
        <ConfigYamlNote />
      </div>

      {/* ── ALGORITMO + ENV VARS ────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>

        {/* Algoritmo — persiste en Supabase */}
        <AlgorithmSelector />

        {/* ENV VARS (informativo) */}
        <div>
          <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
            VARIABLES DE ENTORNO (RAILWAY / VERCEL)
          </div>
          {[
            ["ANTHROPIC_API_KEY",       "Requerida para análisis IA",     "var(--blue)"],
            ["POLYMARKET_PRIVATE_KEY",  "Wallet privada del bot",         "var(--red)"],
            ["POLYMARKET_FUNDER",       "Dirección proxy Polymarket",     "var(--red)"],
            ["TELEGRAM_BOT_TOKEN",      "Bot de Telegram",                "var(--green)"],
            ["TELEGRAM_CHAT_ID",        "Chat ID de alertas",             "var(--green)"],
            ["STAKE_USDC",              "Override de stake (env > yaml)", "var(--yellow)"],
            ["STOP_LOSS_PCT",           "Stop loss % (env > yaml)",       "var(--yellow)"],
          ].map(([k, desc, color]) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color, fontWeight: 600 }}>{k}</div>
              <div style={{ fontSize: 9, color: "#444" }}>{desc}</div>
            </div>
          ))}
          <div style={{
            marginTop: 24, padding: 14,
            background: "#02020a", border: "1px solid #0d0d1a",
            borderRadius: 3, fontSize: 10, color: "#444", lineHeight: 1.8,
          }}>
            <div style={{ color: "#2a4a3a", marginBottom: 6 }}>⚠ SEGURIDAD</div>
            Nunca expongas tu <span style={{ color: "var(--red)" }}>PRIVATE_KEY</span> en el código.
            Usa variables de entorno en Railway y Vercel. El archivo{" "}
            <span style={{ color: "var(--green)" }}>.env.local</span> está en{" "}
            <span style={{ color: "var(--muted)" }}>.gitignore</span>.
          </div>
        </div>
      </div>

    </div>
  );
}
