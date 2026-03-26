// lib/constants.js — v3.0
//
// CAMBIOS v3.0 — Nuevas ventanas T-50, T-40, T-30, T-25
//   Amplía la cobertura de evaluación a toda la vela 1H.
//   Gaps intencionales: 32-37 min y 42-47 min (sin ventana).
//   Nuevas configKeys: t50_umbral, t40_umbral, t30_umbral, t25_umbral.
//
// CAMBIOS v2.1 — FIX getMinsLeft con fallback al reloj local
// CAMBIOS v2.0 — getDecision renombrado dir → direction; getActiveWindow objeto completo

export const WINDOWS = [
  { key: "T-50", label: "T‑50", min: 47, max: 52, configKey: "t50_umbral", color: "#6633cc" },
  { key: "T-40", label: "T‑40", min: 37, max: 42, configKey: "t40_umbral", color: "#3355cc" },
  { key: "T-30", label: "T‑30", min: 27, max: 32, configKey: "t30_umbral", color: "#0088cc" },
  { key: "T-25", label: "T‑25", min: 22, max: 27, configKey: "t25_umbral", color: "#00aaaa" },
  { key: "T-20", label: "T‑20", min: 17, max: 22, configKey: "t20_umbral", color: "#4488ff" },
  { key: "T-15", label: "T‑15", min: 12, max: 17, configKey: "t15_umbral", color: "#aa44ff" },
  { key: "T-10", label: "T‑10", min: 7,  max: 12, configKey: "t10_umbral", color: "#ff8800" },
  { key: "T-5",  label: "T‑5",  min: 2,  max: 7,  configKey: "t5_umbral",  color: "#ff4466" },
];

export const DEFAULT_CONFIG = {
  // Nuevas ventanas — umbrales más altos porque hay más tiempo de incertidumbre
  t50_umbral:    1200,
  t40_umbral:    1000,
  t30_umbral:    800,
  t25_umbral:    650,
  // Ventanas originales
  t20_umbral:    500,
  t15_umbral:    300,
  t10_umbral:    200,
  t5_umbral:     150,
  stop_loss_pct: 50,
  stake_usdc:    10,
  max_ops_dia:   24,
};

export const POLL_INTERVAL_MS = 5000;

/**
 * getDecision — evalúa si hay señal UP/DOWN/WAIT.
 */
export function getDecision(price, target, umbral) {
  if (price == null || target == null || !umbral) return null;
  const dist = price - target;
  if (dist >  umbral) return { direction: "UP",   threshold: umbral, dist, signal: true  };
  if (dist < -umbral) return { direction: "DOWN", threshold: umbral, dist, signal: true  };
  return               { direction: "WAIT", threshold: umbral, dist, signal: false };
}

/**
 * getActiveWindow — devuelve la ventana activa según minsLeft.
 * Retorna el objeto completo { key, label, min, max, configKey, color } o null.
 */
export function getActiveWindow(minsLeft, windows = WINDOWS) {
  if (minsLeft == null) return null;
  for (const w of windows) {
    if (minsLeft >= w.min && minsLeft < w.max) return w;
  }
  return null;
}

/**
 * getMinsLeft — minutos restantes hasta el cierre de la vela.
 *
 * FIX v2.1: Si endMs es null O ya está en el pasado (mercado cerrado/stale),
 * usa el reloj local como fallback.
 */
export function getMinsLeft(endMs) {
  const now = new Date();
  if (!endMs) {
    return 60 - now.getMinutes() - now.getSeconds() / 60;
  }
  const diff = (endMs - now.getTime()) / 60000;
  if (diff <= 0) {
    return 60 - now.getMinutes() - now.getSeconds() / 60;
  }
  return diff;
}

// ── Helpers de formato (re-exportados para compatibilidad) ────────────────────

export const fmt = (v, decimals = 0) =>
  v != null ? Number(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "—";

export const fmtUSD = (v) =>
  v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";

export const fmtOdds = (v) =>
  v != null ? `${(Number(v) * 100).toFixed(1)}%` : "—";

export const fmtPct = (v) =>
  v != null ? `${Number(v).toFixed(1)}%` : "—";

export const fmtBTC = (v) =>
  v != null ? `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} BTC` : "—";
