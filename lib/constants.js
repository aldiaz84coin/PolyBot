// lib/constants.js

export const WINDOWS = [
  { key: "T-20", label: "T‑20", min: 17, max: 22, configKey: "t20_umbral", color: "#4488ff" },
  { key: "T-15", label: "T‑15", min: 12, max: 17, configKey: "t15_umbral", color: "#aa44ff" },
  { key: "T-10", label: "T‑10", min: 7,  max: 12, configKey: "t10_umbral", color: "#ff8800" },
  { key: "T-5",  label: "T‑5",  min: 2,  max: 7,  configKey: "t5_umbral",  color: "#ff4466" },
];

export const DEFAULT_CONFIG = {
  t20_umbral: 500,
  t15_umbral: 300,
  t10_umbral: 200,
  t5_umbral:  150,
  stop_loss_pct: 50,
  stake_usdc: 50,
  max_ops_dia: 24,
};

export const POLL_INTERVAL_MS = 5000;  // cada 5s — igual que el bot Python

export function getDecision(price, target, umbral) {
  if (!price || !target || !umbral) return null;
  const dist = price - target;
  if (dist > umbral)  return { dir: "UP",   dist, signal: true  };
  if (dist < -umbral) return { dir: "DOWN", dist, signal: true  };
  return { dir: "WAIT", dist, signal: false };
}

export function getActiveWindow(minsLeft, windows = WINDOWS) {
  for (const w of windows) {
    if (minsLeft >= w.min && minsLeft < w.max) return w;
  }
  return null;
}

export function getMinsLeft(date = new Date()) {
  return 60 - date.getMinutes() - date.getSeconds() / 60;
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
