// lib/constants.js — v2.0
//
// CAMBIOS v2.0
//   - getDecision: renombrado "dir" → "direction" para coincidir con el render
//     de Dashboard.jsx y MarketInfo.jsx. Añadido campo "threshold" al retorno.
//   - getActiveWindow: sin cambios, devuelve objeto { key, label, min, max, configKey, color }

export const WINDOWS = [
  { key: "T-20", label: "T‑20", min: 17, max: 22, configKey: "t20_umbral", color: "#4488ff" },
  { key: "T-15", label: "T‑15", min: 12, max: 17, configKey: "t15_umbral", color: "#aa44ff" },
  { key: "T-10", label: "T‑10", min: 7,  max: 12, configKey: "t10_umbral", color: "#ff8800" },
  { key: "T-5",  label: "T‑5",  min: 2,  max: 7,  configKey: "t5_umbral",  color: "#ff4466" },
];

export const DEFAULT_CONFIG = {
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
 *
 * @param {number} price   - Precio actual BTC
 * @param {number} target  - Precio de apertura de la vela (target del bot)
 * @param {number} umbral  - Umbral en USD para la ventana activa (ej: 300)
 * @returns {{ direction: "UP"|"DOWN"|"WAIT", threshold: number, dist: number, signal: boolean }}
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
 * Si endMs es null, usa el reloj local como fallback.
 */
export function getMinsLeft(endMs, now = new Date()) {
  if (endMs != null) return Math.max(0, (endMs - now.getTime()) / 60000);
  return 60 - now.getMinutes() - now.getSeconds() / 60;
}

export function fmt(n, dec = 0) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

export function fmtUSD(n) {
  if (n == null) return "—";
  return "$" + fmt(n, 2);
}

export function fmtPct(n, showPlus = true) {
  if (n == null) return "—";
  return (showPlus && n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

export function genId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
