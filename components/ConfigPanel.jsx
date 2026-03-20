/**
 * components/ConfigPanel.jsx — v1.2
 *
 * v1.2 — Botón GUARDAR stake_usdc con feedback visual (✅ / ❌).
 *         POST /api/config persiste el valor en Supabase para que el bot
 *         lo recoja en el siguiente ciclo de polling (~60s).
 * v1.1 — Grid original (umbrales / capital / env vars)
 */

"use client";
import { useState } from "react";
import { WINDOWS } from "../lib/constants";

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

export default function ConfigPanel({ config, onChange }) {
  const set = (key) => (val) => onChange(c => ({ ...c, [key]: val }));

  // ── Estado del guardado ──────────────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState("idle"); // "idle" | "saving" | "ok" | "error"
  const [saveMsg,    setSaveMsg]    = useState("");

  const handleSave = async () => {
    setSaveStatus("saving");
    setSaveMsg("");

    const toSave = [
      { key: "stake_usdc",    value: String(config.stake_usdc)    },
    ];

    try {
      const results = await Promise.all(
        toSave.map(({ key, value }) =>
          fetch("/api/config", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ key, value }),
          }).then(r => r.json())
        )
      );

      const allOk = results.every(r => r.ok !== false && !r.error);
      if (allOk) {
        setSaveStatus("ok");
        setSaveMsg("✅ Configuración guardada — el bot la cargará en ~60s");
      } else {
        const err = results.find(r => r.error)?.error ?? "Error desconocido";
        setSaveStatus("error");
        setSaveMsg(`❌ Error: ${err}`);
      }
    } catch (e) {
      setSaveStatus("error");
      setSaveMsg(`❌ ${e.message}`);
    }

    // Reset a "idle" tras 4 segundos
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
      </div>

      {/* ── CAPITAL ────────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
          GESTIÓN DE CAPITAL
        </div>

        <Field
          label="STAKE USDC / OPERACIÓN"
          sub="Cantidad apostada en cada entrada"
          value={config.stake_usdc}
          onChange={set("stake_usdc")}
          color="var(--yellow)"
        />
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

        {/* ── Botón guardar ────────────────────────────────────────────── */}
        <div style={{ marginTop: 8 }}>
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
              padding: "9px 22px", cursor: saveStatus === "saving" ? "default" : "pointer",
              fontFamily: "inherit", borderRadius: 3,
              opacity: saveStatus === "saving" ? 0.6 : 1,
              transition: "all 0.2s",
            }}
          >
            {saveStatus === "saving" ? "GUARDANDO…" : "GUARDAR CONFIG"}
          </button>

          {/* Mensaje de confirmación */}
          {saveMsg && (
            <div style={{
              marginTop: 10,
              fontSize: 10,
              color: saveStatus === "ok" ? "var(--green)" : "var(--red)",
              lineHeight: 1.6,
              maxWidth: 260,
            }}>
              {saveMsg}
            </div>
          )}
        </div>
      </div>

      {/* ── ENV VARS (info) ─────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
          VARIABLES DE ENTORNO (RAILWAY / VERCEL)
        </div>
        {[
          ["ANTHROPIC_API_KEY",       "Requerida para análisis IA", "var(--blue)"],
          ["POLYMARKET_PRIVATE_KEY",  "Wallet privada del bot",     "var(--red)"],
          ["POLYMARKET_FUNDER",       "Dirección proxy Polymarket", "var(--red)"],
          ["TELEGRAM_BOT_TOKEN",      "Bot de Telegram",            "var(--green)"],
          ["TELEGRAM_CHAT_ID",        "Chat ID de alertas",         "var(--green)"],
          ["STAKE_USDC",              "Override de stake",          "var(--yellow)"],
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
  );
}
