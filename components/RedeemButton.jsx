"use client";
// components/RedeemButton.jsx
// Botón para disparar el scan de redención desde el dashboard.
// Encola un comando trigger_redeem en bot_commands → el bot lo ejecuta en segundos.
// Añadir en cualquier panel del dashboard: <RedeemButton />

import { useState } from "react";

export default function RedeemButton() {
  const [status, setStatus]   = useState("idle"); // idle | loading | ok | error
  const [result, setResult]   = useState(null);
  const [cmdId,  setCmdId]    = useState(null);

  async function triggerRedeem() {
    setStatus("loading");
    setResult(null);

    try {
      // 1. Encolar comando en bot_commands
      const res = await fetch("/api/commands", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ command: "trigger_redeem", params: {} }),
      });
      const json = await res.json();

      if (!json.ok) {
        setStatus("error");
        setResult({ error: json.error || "Error al encolar comando" });
        return;
      }

      const id = json.id;
      setCmdId(id);

      // 2. Polling hasta que el bot complete el comando (máx 60s)
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const r = await fetch(`/api/commands?id=${id}`);
          const j = await r.json();

          if (j.status === "done" || j.status === "error") {
            clearInterval(poll);
            if (j.status === "done" && j.result) {
              setStatus("ok");
              setResult(j.result);
            } else {
              setStatus("error");
              setResult(j.result || { error: "El bot no pudo completar el redeem" });
            }
          } else if (attempts >= 24) {
            // 60s sin respuesta → timeout
            clearInterval(poll);
            setStatus("error");
            setResult({ error: "Timeout esperando respuesta del bot (60s)" });
          }
        } catch (_) {
          // silencioso, seguir intentando
        }
      }, 2_500);

    } catch (err) {
      setStatus("error");
      setResult({ error: err.message });
    }
  }

  const isLoading = status === "loading";

  return (
    <div style={{ display: "inline-block" }}>
      <button
        onClick={triggerRedeem}
        disabled={isLoading}
        style={{
          background:    isLoading ? "#333" : "#00ff88",
          color:         "#000",
          border:        "none",
          borderRadius:  "6px",
          padding:       "8px 18px",
          fontFamily:    "monospace",
          fontWeight:    "bold",
          fontSize:      "13px",
          cursor:        isLoading ? "not-allowed" : "pointer",
          opacity:       isLoading ? 0.6 : 1,
          transition:    "all 0.2s",
          letterSpacing: "0.5px",
        }}
      >
        {isLoading ? "⏳ Ejecutando…" : "💸 Trigger Redeem"}
      </button>

      {/* Resultado */}
      {result && (
        <div
          style={{
            marginTop:    "10px",
            padding:      "10px 14px",
            borderRadius: "6px",
            fontFamily:   "monospace",
            fontSize:     "12px",
            background:   status === "ok" ? "rgba(0,255,136,0.08)" : "rgba(255,51,85,0.1)",
            border:       `1px solid ${status === "ok" ? "#00ff88" : "#ff3355"}`,
            color:        status === "ok" ? "#00ff88" : "#ff3355",
            minWidth:     "220px",
          }}
        >
          {status === "ok" ? (
            <>
              <div>✅ Scan completado</div>
              <div style={{ marginTop: 4, color: "#aaa" }}>
                Redimidos: <b style={{ color: "#00ff88" }}>{result.ok ?? 0}</b>
                {" · "}Skip: <b style={{ color: "#ffcc00" }}>{result.skip ?? 0}</b>
                {" · "}Errores: <b style={{ color: "#ff3355" }}>{result.error ?? 0}</b>
              </div>
              {cmdId && (
                <div style={{ marginTop: 4, color: "#555", fontSize: 11 }}>
                  cmd #{cmdId}
                </div>
              )}
            </>
          ) : (
            <div>❌ {result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
