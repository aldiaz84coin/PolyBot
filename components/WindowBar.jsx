"use client";
import { WINDOWS } from "../lib/constants";

export default function WindowBar({ minsLeft, activeWindow }) {
  // Progreso general de la hora: de 0% (inicio) a 100% (cierre)
  const pct = Math.min(100, Math.max(0, ((60 - minsLeft) / 60) * 100));

  // Tiempo restante formateado mm:ss para el label del cursor
  const totalSecs  = Math.max(0, minsLeft * 60);
  const mm         = String(Math.floor(totalSecs / 60)).padStart(2, "0");
  const ss         = String(Math.floor(totalSecs % 60)).padStart(2, "0");
  const timeLabel  = `${mm}:${ss}`;
  const cursorColor = minsLeft < 5 ? "#ff4466" : minsLeft < 15 ? "#ff8800" : "#00ff88";

  return (
    <div style={{ position: "relative", paddingTop: 18 }}>
      {/* Label flotante sobre el cursor */}
      <div style={{
        position: "absolute",
        top: 0,
        left: `${pct}%`,
        transform: "translateX(-50%)",
        fontSize: 9,
        fontWeight: 700,
        color: cursorColor,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        letterSpacing: "0.05em",
        textShadow: `0 0 6px ${cursorColor}88`,
        transition: "left 1s linear, color 0.3s",
        pointerEvents: "none",
      }}>
        {timeLabel}
      </div>

      {/* Barra principal */}
      <div style={{
        position: "relative", height: 28,
        background: "#060612", borderRadius: 3,
        overflow: "hidden", border: "1px solid #111122",
      }}>
        {/* Zonas de ventana */}
        {WINDOWS.map(w => {
          const isActive = activeWindow?.key === w.key;
          // Progreso dentro de la ventana activa: 0% al entrar, 100% al salir
          const windowPct = isActive
            ? Math.min(100, Math.max(0, ((w.max - minsLeft) / (w.max - w.min)) * 100))
            : 0;

          return (
            <div key={w.key} style={{
              position: "absolute",
              left: `${((60 - w.max) / 60) * 100}%`,
              width: `${((w.max - w.min) / 60) * 100}%`,
              top: 0, bottom: 0,
              background: isActive ? `${w.color}18` : "rgba(255,255,255,0.02)",
              borderLeft: `1px solid ${isActive ? w.color + "55" : "#111122"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden",
              transition: "background 0.3s",
            }}>
              {/* Relleno de progreso interno de la ventana activa */}
              {isActive && (
                <div style={{
                  position: "absolute",
                  left: 0, top: 0, bottom: 0,
                  width: `${windowPct}%`,
                  background: `${w.color}28`,
                  transition: "width 1s linear",
                }} />
              )}
              <span style={{
                fontSize: 8,
                color: isActive ? w.color : "#333",
                fontWeight: isActive ? 700 : 400,
                transition: "color 0.3s",
                position: "relative", zIndex: 1,
              }}>
                {w.label}
              </span>
            </div>
          );
        })}

        {/* Cursor de progreso global */}
        <div style={{
          position: "absolute",
          left: `${pct}%`,
          top: 0, bottom: 0,
          width: 2,
          background: cursorColor,
          boxShadow: `0 0 8px ${cursorColor}, 0 0 2px ${cursorColor}`,
          transition: "left 1s linear, background 0.3s, box-shadow 0.3s",
          zIndex: 2,
        }} />
      </div>
    </div>
  );
}
