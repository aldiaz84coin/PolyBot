"use client";
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

  return (
    <div style={{
      background: "var(--bg)", minHeight: "calc(100vh - 90px)",
      padding: "32px 32px", display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr", gap: 48,
    }}>

      {/* Umbrales */}
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

      {/* Capital */}
      <div>
        <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.15em", marginBottom: 20 }}>
          GESTIÓN DE CAPITAL
        </div>
        <Field label="STAKE USDC / OPERACIÓN"  sub="Cantidad apostada en cada entrada"  value={config.stake_usdc}    onChange={set("stake_usdc")}    color="var(--yellow)" />
        <Field label="MAX OPERACIONES / DÍA"   sub="Límite diario de entradas"          value={config.max_ops_dia}   onChange={set("max_ops_dia")}   color="var(--yellow)" />
        <Field label="STOP LOSS %"             sub="Salir si la posición pierde este %" value={config.stop_loss_pct} onChange={set("stop_loss_pct")} color="var(--red)"    />
      </div>

      {/* Info */}
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
          Usa variables de entorno en Railway y Vercel. El archivo <span style={{ color: "var(--green)" }}>.env.local</span> está en <span style={{ color: "var(--muted)" }}>.gitignore</span>.
        </div>
      </div>
    </div>
  );
}
