// lib/constants.js — v3.0
//
// CAMBIOS v3.0 — Nuevas ventanas T-50, T-40, T-30, T-25
//   Amplía la cobertura de evaluación a toda la vela 1H.
//   Gaps intencionales: 32-37 min y 42-47 min (sin ventana).
//   Nuevos configKeys: t50_umbral, t40_umbral, t30_umbral, t25_umbral.
//
// CAMBIOS v2.1 — FIX CRÍTICO: getMinsLeft con fallback al reloj local
// ─────────────────────────────────────────────────────────────────────
//  BUG: `getMinsLeft` usaba `Math.max(0, diff)`.
//       Cuando `endMs` es el timestamp del mercado anterior (ya cerrado),
//       diff es negativo → Math.max(0, negativo) = 0 → minsLeft = 0 siempre.
//       Resultado: countdown fijo en "00:00", cursor WindowBar atascado al 100%.
//
//  FIX: Si diff <= 0 (endMs pasado o nulo), caer al reloj local:
//       `60 - now.getMinutes() - now.getSeconds() / 60`
//       Funciona porque ET (UTC-4/-5) y Madrid (UTC+1/+2) son offsets enteros
//       de UTC → los minutos dentro de la hora son idénticos en todas las zonas.
//
// CAMBIOS v2.0 (referencia):
//   - getDecision: renombrado "dir" → "direction" para coincidir con render.
//   - getActiveWindow: devuelve objeto completo { key, label, min, max, ... }.

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
  t50_umbral:    1500,
  t40_umbral:    1200,
  t30_umbral:     900,
  t25_umbral:     650,
  t20_umbral:     500,
  t15_umbral:     300,
  t10_umbral:     200,
  t5_umbral:      150,
  stop_loss_pct:   50,
  stake_usdc:      10,
  max_ops_dia:     24,
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
 *
 * FIX v2.1: Si endMs es null O ya está en el pasado (mercado cerrado/stale),
 * usa el reloj local como fallback: minutos restantes hasta la próxima hora en
 * punto. Esto es correcto para mercados Polymarket BTC hourly porque los
 * horarios ET (UTC-4/-5) son offsets enteros de UTC → los minutos dentro de la
 * hora son idénticos en todas las zonas horarias.
 *
 * Antes: Math.max(0, diff) → si endMs está en el pasado, siempre devuelve 0
 *        → countdown fijo en "00:00", ventana siempre "FUERA".
 * Ahora: endMs pasado → fallback al reloj local → timer dinámico correcto.
 */
export function getMinsLeft(endMs, now = new Date()) {
  if (endMs != null) {
    const diff = (endMs - now.getTime()) / 60000;
    if (diff > 0) return diff;
    // endMs está en el pasado (mercado anterior o dato stale) → fallback
  }
  // Fallback: minutos restantes hasta la próxima hora en punto (local).
  // Válido para mercados ET porque getMinutes() es timezone-invariant
  // respecto a offsets de hora entera (ET, Madrid, UTC todos comparten
  // los mismos minutos 0–59 dentro de la hora).
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
