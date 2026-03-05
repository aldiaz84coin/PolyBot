"use client";
import { WINDOWS } from "../lib/constants";

export default function WindowBar({ minsLeft, activeWindow }) {
  const pct = Math.min(100, Math.max(0, ((60 - minsLeft) / 60) * 100));

  return (
    <div style={{
      position: "relative", height: 28,
      background: "#060612", borderRadius: 3,
      overflow: "hidden", border: "1px solid #111122",
    }}>
      {WINDOWS.map(w => {
        const isActive = activeWindow?.key === w.key;
        return (
          <div key={w.key} style={{
            position: "absolute",
            left: `${((60 - w.max) / 60) * 100}%`,
            width: `${((w.max - w.min) / 60) * 100}%`,
            top: 0, bottom: 0,
            background: isActive ? `${w.color}18` : "rgba(255,255,255,0.02)",
            borderLeft: `1px solid ${isActive ? w.color + "44" : "#111122"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.3s",
          }}>
            <span style={{
              fontSize: 8,
              color: isActive ? w.color : "#333",
              fontWeight: isActive ? 700 : 400,
              transition: "color 0.3s",
            }}>
              {w.label}
            </span>
          </div>
        );
      })}

      {/* Cursor de progreso */}
      <div style={{
        position: "absolute",
        left: `${pct}%`,
        top: 0, bottom: 0,
        width: 2,
        background: "var(--green)",
        boxShadow: "0 0 8px var(--green)",
        transition: "left 1s linear",
        zIndex: 2,
      }} />
    </div>
  );
}
