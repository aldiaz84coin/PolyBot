// components/AIAnalysis.jsx
// Módulo 1 — Diagnóstico Inteligente PolyBot AI Analytics
// Se integra en la parte superior del DataLab como sección autónoma
//
// v1.0 — Diagnóstico completo: estado, ventanas, dirección, tendencia, alertas,
//         recomendaciones, horas óptimas y próximos pasos

"use client";
import { useState, useEffect, useCallback } from "react";

// ── Paleta (consistente con DataLab/Dashboard) ────────────────────────────────
const C = {
  green:   "#00ff88",
  red:     "#ff3355",
  yellow:  "#ffcc00",
  blue:    "#4488ff",
  purple:  "#aa66ff",
  orange:  "#ff8800",
  dim:     "#666",
  border:  "#0d0d1a",
  bg:      "#010108",
  card:    "#02020e",
  cardAlt: "#030316",
};

// Estado → color + emoji
const ESTADO_META = {
  ÓPTIMO:     { color: C.green,  emoji: "◆", label: "ÓPTIMO"    },
  BUENO:      { color: C.green,  emoji: "●", label: "BUENO"     },
  NEUTRO:     { color: C.yellow, emoji: "◐", label: "NEUTRO"    },
  PRECAUCIÓN: { color: C.orange, emoji: "▲", label: "PRECAUCIÓN"},
  CRÍTICO:    { color: C.red,    emoji: "✕", label: "CRÍTICO"   },
};

const TENDENCIA_META = {
  MEJORANDO:    { color: C.green,  icon: "↑" },
  ESTABLE:      { color: C.yellow, icon: "→" },
  DETERIORANDO: { color: C.red,    icon: "↓" },
};

const ALERTA_COLOR = { ALTA: C.red, MEDIA: C.orange, BAJA: C.yellow };
const OPO_COLOR    = { ALTO: C.green, MEDIO: C.blue, BAJO: C.dim };

const LS_KEY = "polybot_ai_analysis_v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos de caché

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function saveToCache(data, simFilter) {
  try {
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    cached[simFilter ?? "all"] = { data, ts: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(cached));
  } catch { /* ignore */ }
}

function loadFromCache(simFilter) {
  try {
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const entry  = cached[simFilter ?? "all"];
    if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) return entry.data;
  } catch { /* ignore */ }
  return null;
}

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize: 9, letterSpacing: "0.2em", color: C.dim,
      borderBottom: `1px solid ${C.border}`, paddingBottom: 6, marginBottom: 14,
    }}>
      {children}
    </div>
  );
}

function MiniCard({ label, value, sub, color = "#ccc", style = {} }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      padding: "10px 14px", borderRadius: 4, minWidth: 90, flex: 1,
      ...style,
    }}>
      <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.15em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 8, color: "#444", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Badge({ text, color, small }) {
  return (
    <span style={{
      display: "inline-block",
      background: `${color}15`,
      border: `1px solid ${color}55`,
      color,
      fontSize: small ? 8 : 9,
      padding: small ? "1px 5px" : "2px 7px",
      borderRadius: 3,
      letterSpacing: "0.1em",
      fontWeight: 700,
    }}>
      {text}
    </span>
  );
}

// Score dial
function ScoreDial({ score }) {
  if (score == null) return null;
  const color = score >= 75 ? C.green : score >= 50 ? C.yellow : score >= 30 ? C.orange : C.red;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{
        width: 56, height: 56, borderRadius: "50%",
        border: `3px solid ${color}`,
        boxShadow: `0 0 14px ${color}55`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column",
        background: `${color}08`,
      }}>
        <span style={{ fontSize: 18, fontWeight: 900, color, lineHeight: 1 }}>{score}</span>
      </div>
      <span style={{ fontSize: 7, color: C.dim, letterSpacing: "0.15em" }}>SCORE</span>
    </div>
  );
}

// Ventana ranking con colores
const VENTANA_COLORS = { T20: C.blue, T15: C.yellow, T10: C.orange, T5: C.red };
function VentanaTag({ v }) {
  const c = VENTANA_COLORS[v] ?? "#aaa";
  return (
    <span style={{
      display: "inline-block",
      background: `${c}20`, border: `1px solid ${c}55`,
      color: c, fontSize: 9, padding: "2px 6px",
      borderRadius: 3, fontWeight: 700, letterSpacing: "0.1em",
    }}>{v}</span>
  );
}

// Sección de alertas
function AlertList({ alertas }) {
  if (!alertas?.length) return <span style={{ fontSize: 9, color: "#333" }}>Sin alertas activas</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {alertas.map((a, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "6px 10px",
          background: `${ALERTA_COLOR[a.nivel] ?? C.dim}08`,
          border: `1px solid ${ALERTA_COLOR[a.nivel] ?? C.dim}22`,
          borderRadius: 3,
        }}>
          <Badge text={a.nivel} color={ALERTA_COLOR[a.nivel] ?? C.dim} small />
          <span style={{ fontSize: 10, color: "#aaa", lineHeight: 1.5 }}>{a.mensaje}</span>
        </div>
      ))}
    </div>
  );
}

// Sección de oportunidades
function OpoList({ oportunidades }) {
  if (!oportunidades?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {oportunidades.map((o, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "6px 10px",
          background: `${OPO_COLOR[o.impacto] ?? C.dim}08`,
          border: `1px solid ${OPO_COLOR[o.impacto] ?? C.dim}22`,
          borderRadius: 3,
        }}>
          <Badge text={o.impacto} color={OPO_COLOR[o.impacto] ?? C.dim} small />
          <span style={{ fontSize: 10, color: "#aaa", lineHeight: 1.5 }}>{o.mensaje}</span>
        </div>
      ))}
    </div>
  );
}

// Sección de recomendaciones
function RecoList({ recomendaciones }) {
  if (!recomendaciones?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {recomendaciones.sort((a, b) => (a.prioridad ?? 99) - (b.prioridad ?? 99)).map((r, i) => (
        <div key={i} style={{
          padding: "10px 14px",
          background: C.cardAlt,
          border: `1px solid ${C.border}`,
          borderLeft: `3px solid ${i === 0 ? C.green : i === 1 ? C.yellow : C.dim}`,
          borderRadius: "0 4px 4px 0",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 8, color: C.dim, letterSpacing: "0.1em" }}>#{r.prioridad ?? i + 1}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#ccc", letterSpacing: "0.05em" }}>
              {r.accion}
            </span>
          </div>
          <div style={{ fontSize: 10, color: "#666", lineHeight: 1.6 }}>{r.detalle}</div>
        </div>
      ))}
    </div>
  );
}

// Grid de horas 0–23
function HorasGrid({ optimas = [], evitar = [] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 3 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const isOpt    = optimas.includes(h);
        const isEvitar = evitar.includes(h);
        const color    = isOpt ? C.green : isEvitar ? C.red : "#1a1a2a";
        const textCol  = isOpt || isEvitar ? "#fff" : "#333";
        return (
          <div key={h} style={{
            background: isOpt ? `${C.green}22` : isEvitar ? `${C.red}22` : C.card,
            border: `1px solid ${isOpt ? `${C.green}55` : isEvitar ? `${C.red}33` : C.border}`,
            borderRadius: 3, padding: "4px 2px", textAlign: "center",
          }}>
            <div style={{ fontSize: 8, color: textCol, fontWeight: isOpt || isEvitar ? 700 : 400 }}>
              {String(h).padStart(2, "0")}h
            </div>
            {isOpt    && <div style={{ fontSize: 6, color: C.green }}>▲</div>}
            {isEvitar && <div style={{ fontSize: 6, color: C.red   }}>▼</div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function AIAnalysis() {
  const [simFilter, setSimFilter] = useState(null); // null = todos, "true", "false"
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [result,    setResult]    = useState(null); // { analysis, meta }
  const [activeTab, setActiveTab] = useState("diagnostico");

  // Cargar caché al montar
  useEffect(() => {
    const cached = loadFromCache(simFilter);
    if (cached) setResult(cached);
  }, [simFilter]);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = simFilter != null
        ? `/api/ai-analysis?simulated=${simFilter}`
        : `/api/ai-analysis`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      saveToCache(data, simFilter);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [simFilter]);

  const { analysis, meta } = result ?? {};
  const estadoMeta = ESTADO_META[analysis?.estado] ?? ESTADO_META.NEUTRO;
  const tendMeta   = TENDENCIA_META[analysis?.tendencia?.direccion] ?? TENDENCIA_META.ESTABLE;

  const TABS = [
    { key: "diagnostico",     label: "DIAGNÓSTICO"   },
    { key: "recomendaciones", label: "ACCIONES"      },
    { key: "horas",           label: "MAPA DE HORAS" },
  ];

  return (
    <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>

      {/* ── CABECERA ────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", borderBottom: `1px solid ${C.border}`,
        background: "#00050d",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            fontSize: 9, letterSpacing: "0.25em", color: C.purple,
            fontWeight: 700,
          }}>
            ◈ AI DIAGNÓSTICO
          </span>
          {analysis && !loading && (
            <span style={{
              fontSize: 8, color: estadoMeta.color, letterSpacing: "0.12em",
              background: `${estadoMeta.color}15`,
              border: `1px solid ${estadoMeta.color}44`,
              padding: "2px 7px", borderRadius: 3, fontWeight: 700,
            }}>
              {estadoMeta.emoji} {estadoMeta.label}
            </span>
          )}
          {meta && (
            <span style={{ fontSize: 8, color: "#333" }}>
              Generado {fmtDate(meta.generated_at)} · {fmtTime(meta.generated_at)}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Filtro modo */}
          {[
            { val: null,    label: "TODOS"   },
            { val: "true",  label: "SIM"     },
            { val: "false", label: "REAL"    },
          ].map(({ val, label }) => (
            <button key={label} onClick={() => setSimFilter(val)} style={{
              background: simFilter === val ? `${C.purple}22` : "none",
              border: `1px solid ${simFilter === val ? C.purple : "#1a1a2e"}`,
              color:  simFilter === val ? C.purple : "#444",
              fontSize: 8, padding: "3px 8px",
              cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em",
              borderRadius: 3,
            }}>{label}</button>
          ))}

          {/* Botón analizar */}
          <button
            onClick={runAnalysis}
            disabled={loading}
            style={{
              background: loading ? "#0d0d1a" : `${C.purple}22`,
              border: `1px solid ${loading ? "#222" : C.purple}`,
              color: loading ? "#444" : C.purple,
              fontSize: 9, padding: "4px 14px",
              cursor: loading ? "default" : "pointer",
              fontFamily: "inherit", letterSpacing: "0.15em", fontWeight: 700,
              borderRadius: 3,
              transition: "all 0.15s",
            }}
          >
            {loading ? "ANALIZANDO…" : analysis ? "↻ REANALIZAR" : "◈ ANALIZAR AHORA"}
          </button>
        </div>
      </div>

      {/* ── ERROR ───────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          padding: "10px 24px", background: `${C.red}08`,
          borderBottom: `1px solid ${C.red}22`,
        }}>
          <span style={{ fontSize: 9, color: C.red }}>✕ Error: {error}</span>
        </div>
      )}

      {/* ── LOADING ─────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{
          padding: "32px 24px", textAlign: "center",
          color: "#333", fontSize: 9, letterSpacing: "0.15em",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{
            display: "inline-block", width: 24, height: 24, borderRadius: "50%",
            border: `2px solid ${C.purple}33`,
            borderTop: `2px solid ${C.purple}`,
            animation: "spin 0.8s linear infinite",
            marginBottom: 12,
          }} />
          <div>Cargando datos de Supabase y consultando IA…</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── PLACEHOLDER si no hay análisis ──────────────────────────────── */}
      {!loading && !analysis && !error && (
        <div style={{
          padding: "28px 24px", textAlign: "center",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em", marginBottom: 8 }}>
            Sin análisis generado
          </div>
          <div style={{ fontSize: 9, color: "#222" }}>
            Pulsa "ANALIZAR AHORA" para que la IA diagnostique el rendimiento de la estrategia
          </div>
        </div>
      )}

      {/* ── CONTENIDO PRINCIPAL ─────────────────────────────────────────── */}
      {!loading && analysis && (
        <>
          {/* Barra de métricas globales */}
          <div style={{
            display: "flex", gap: 12, padding: "14px 24px", flexWrap: "wrap",
            borderBottom: `1px solid ${C.border}`,
            background: "#010108",
          }}>
            <ScoreDial score={analysis.score} />

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flex: 1, alignItems: "center" }}>
              <MiniCard
                label="OPERACIONES"
                value={meta?.totalOps ?? "—"}
                sub={meta?.mode}
                color="#ccc"
              />
              <MiniCard
                label="P&L ACUMULADO"
                value={meta?.totalPnl != null ? `$${meta.totalPnl.toFixed(2)}` : "—"}
                color={meta?.totalPnl >= 0 ? C.green : C.red}
              />
              <MiniCard
                label="WIN RATE"
                value={meta?.globalWR != null ? `${meta.globalWR}%` : "—"}
                sub={`${meta?.totalWins ?? 0}W / ${meta?.totalLoss ?? 0}L`}
                color={parseFloat(meta?.globalWR) >= 55 ? C.green : parseFloat(meta?.globalWR) >= 45 ? C.yellow : C.red}
              />
              <MiniCard
                label="TENDENCIA"
                value={`${tendMeta.icon} ${analysis.tendencia?.direccion ?? "—"}`}
                sub={analysis.tendencia?.analisis?.slice(0, 40) + "…"}
                color={tendMeta.color}
              />
              {analysis.edge && (
                <MiniCard
                  label="EDGE"
                  value={analysis.edge.tiene_edge ? "✓ SÍ" : "✕ NO"}
                  sub={analysis.edge.explicacion?.slice(0, 45) + "…"}
                  color={analysis.edge.tiene_edge ? C.green : C.red}
                />
              )}
            </div>
          </div>

          {/* Resumen ejecutivo */}
          <div style={{
            padding: "14px 24px", borderBottom: `1px solid ${C.border}`,
            background: `${estadoMeta.color}06`,
          }}>
            <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.15em", marginBottom: 6 }}>
              DIAGNÓSTICO EJECUTIVO
            </div>
            <p style={{
              fontSize: 11, color: "#bbb", lineHeight: 1.7, margin: 0,
              borderLeft: `3px solid ${estadoMeta.color}`,
              paddingLeft: 12,
            }}>
              {analysis.resumen}
            </p>
            {analysis.proximos_pasos && (
              <div style={{
                marginTop: 10, padding: "6px 12px",
                background: `${C.purple}10`, border: `1px solid ${C.purple}33`,
                borderRadius: 3, display: "inline-flex", gap: 8, alignItems: "center",
              }}>
                <span style={{ fontSize: 8, color: C.purple, letterSpacing: "0.12em" }}>PRÓXIMO PASO</span>
                <span style={{ fontSize: 10, color: "#aaa" }}>{analysis.proximos_pasos}</span>
              </div>
            )}
          </div>

          {/* Sub-tabs */}
          <div style={{
            display: "flex", borderBottom: `1px solid ${C.border}`,
            background: "#00040c", paddingLeft: 24,
          }}>
            {TABS.map(({ key, label }) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 16px", fontSize: 8, letterSpacing: "0.15em",
                color: activeTab === key ? C.purple : "#333",
                borderBottom: activeTab === key ? `2px solid ${C.purple}` : "2px solid transparent",
                fontFamily: "inherit",
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* ── Tab: DIAGNÓSTICO ──────────────────────────────────────── */}
          {activeTab === "diagnostico" && (
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr",
              borderBottom: `1px solid ${C.border}`,
            }}>
              {/* Ventanas */}
              <div style={{ padding: "18px 24px", borderRight: `1px solid ${C.border}` }}>
                <SectionTitle>RENDIMIENTO POR VENTANA</SectionTitle>
                {analysis.ventanas && (
                  <>
                    <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 8, color: C.dim, marginBottom: 4, letterSpacing: "0.1em" }}>
                          MEJOR VENTANA
                        </div>
                        <VentanaTag v={analysis.ventanas.mejor} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 8, color: C.dim, marginBottom: 4, letterSpacing: "0.1em" }}>
                          PEOR VENTANA
                        </div>
                        <VentanaTag v={analysis.ventanas.peor} />
                      </div>
                    </div>
                    {analysis.ventanas.ranking?.length > 0 && (
                      <div style={{ display: "flex", gap: 4, marginBottom: 10, alignItems: "center" }}>
                        <span style={{ fontSize: 8, color: C.dim }}>RANKING</span>
                        {analysis.ventanas.ranking.map((v, i) => (
                          <span key={v} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            {i > 0 && <span style={{ color: "#333", fontSize: 8 }}>›</span>}
                            <VentanaTag v={v} />
                          </span>
                        ))}
                      </div>
                    )}
                    <p style={{ fontSize: 10, color: "#666", lineHeight: 1.6, margin: 0 }}>
                      {analysis.ventanas.analisis}
                    </p>
                  </>
                )}
              </div>

              {/* Dirección + Alertas */}
              <div style={{ padding: "18px 24px" }}>
                <SectionTitle>SESGO DIRECCIONAL</SectionTitle>
                {analysis.direccion && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <Badge
                        text={analysis.direccion.sesgo}
                        color={
                          analysis.direccion.sesgo === "UP"   ? C.green :
                          analysis.direccion.sesgo === "DOWN" ? C.red   : C.yellow
                        }
                      />
                      {analysis.direccion.confianza && (
                        <Badge text={`CONFIANZA ${analysis.direccion.confianza}`} color={C.dim} small />
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: "#666", lineHeight: 1.6, margin: 0 }}>
                      {analysis.direccion.analisis}
                    </p>
                  </div>
                )}

                <SectionTitle>ALERTAS ACTIVAS</SectionTitle>
                <AlertList alertas={analysis.alertas} />
              </div>
            </div>
          )}

          {/* ── Tab: ACCIONES ─────────────────────────────────────────── */}
          {activeTab === "recomendaciones" && (
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr",
              borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={{ padding: "18px 24px", borderRight: `1px solid ${C.border}` }}>
                <SectionTitle>RECOMENDACIONES PRIORITARIAS</SectionTitle>
                <RecoList recomendaciones={analysis.recomendaciones} />
              </div>
              <div style={{ padding: "18px 24px" }}>
                <SectionTitle>OPORTUNIDADES DETECTADAS</SectionTitle>
                <OpoList oportunidades={analysis.oportunidades} />
                {!analysis.oportunidades?.length && (
                  <span style={{ fontSize: 9, color: "#333" }}>Sin oportunidades destacadas</span>
                )}
              </div>
            </div>
          )}

          {/* ── Tab: MAPA DE HORAS ────────────────────────────────────── */}
          {activeTab === "horas" && (
            <div style={{ padding: "18px 24px", borderBottom: `1px solid ${C.border}` }}>
              <SectionTitle>MAPA DE RENDIMIENTO POR HORA UTC</SectionTitle>
              <div style={{ marginBottom: 10, display: "flex", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: 2,
                    background: `${C.green}22`, border: `1px solid ${C.green}55`,
                  }} />
                  <span style={{ fontSize: 9, color: "#555" }}>
                    Horas óptimas ({analysis.horas_optimas?.join(", ") || "—"}h UTC)
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: 2,
                    background: `${C.red}22`, border: `1px solid ${C.red}33`,
                  }} />
                  <span style={{ fontSize: 9, color: "#555" }}>
                    Horas a evitar ({analysis.horas_evitar?.join(", ") || "—"}h UTC)
                  </span>
                </div>
              </div>
              <HorasGrid optimas={analysis.horas_optimas ?? []} evitar={analysis.horas_evitar ?? []} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
