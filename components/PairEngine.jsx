// components/PairEngine.jsx
// ◈ MOTOR DE PARES — DataLab PolyBot
// Análisis multivariable: identifica condiciones (ventana × precio × boost × distancia × dirección × hora)
// que SIEMPRE generan beneficio dentro de un ciclo de 1H.
//
// Integración en DataLab.jsx:
//   import PairEngine from "./PairEngine";
//   // Añadir dentro del return principal de DataLab, justo después del bloque <AIAnalysis />:
//   <PairEngine />
//
// v1.0 — Resumen ejecutivo + condiciones ganadoras + pares intra-ciclo + optimizaciones

"use client";
import { useState, useEffect, useCallback } from "react";

// ── Paleta (consistente con DataLab/Dashboard) ────────────────────────────────

const C = {
  green:   "#00ff88",
  red:     "#ff3355",
  yellow:  "#ffcc00",
  blue:    "#4488ff",
  purple:  "#aa66ff",
  cyan:    "#00ccff",
  orange:  "#ff8800",
  teal:    "#00ddaa",
  dim:     "#666",
  border:  "#0d0d1a",
  bg:      "#010108",
  card:    "#02020e",
  header:  "#00050d",
};

const CONFIANZA_COLOR = { ALTA: C.green, MEDIA: C.yellow, BAJA: C.orange };
const ACCION_COLOR    = { IMPLEMENTAR: C.green, MONITORIZAR: C.yellow, DESCARTAR: C.red };
const SEVERIDAD_COLOR = { ALTA: C.red, MEDIA: C.orange, BAJA: C.yellow };
const PRIO_COLOR      = { CRÍTICA: C.red, ALTA: C.orange, MEDIA: C.yellow, BAJA: C.dim };
const VENTANA_COLOR   = { T20: C.purple, T15: C.blue, T10: C.cyan, T5: C.green };

const LS_KEY     = "polybot_pair_engine_v1";
const CACHE_TTL  = 5 * 60 * 1000;

// ── Cache helpers ─────────────────────────────────────────────────────────────

function saveCache(data, key) {
  try {
    const store = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    store[key]  = { data, ts: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
}

function loadCache(key) {
  try {
    const entry = JSON.parse(localStorage.getItem(LS_KEY) || "{}")[key];
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  } catch { /* ignore */ }
  return null;
}

// ── Mini helpers de UI ─────────────────────────────────────────────────────────

function Badge({ text, color, small }) {
  return (
    <span style={{
      display: "inline-block",
      background: `${color}18`, border: `1px solid ${color}44`,
      color, fontSize: small ? 7 : 8, padding: small ? "1px 5px" : "2px 7px",
      borderRadius: 3, letterSpacing: "0.1em", fontWeight: 700, flexShrink: 0,
    }}>{text}</span>
  );
}

function SectionLabel({ children, color = C.dim }) {
  return (
    <div style={{
      fontSize: 8, letterSpacing: "0.2em", color,
      fontWeight: 700, marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

function MetaCard({ label, value, color = "#ccc", sub }) {
  return (
    <div style={{
      background: C.card, border: `1px solid #0d0d1a`,
      borderRadius: 4, padding: "8px 14px", minWidth: 80,
    }}>
      <div style={{ fontSize: 7, color: C.dim, letterSpacing: "0.15em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 7, color: C.dim, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Score dial ─────────────────────────────────────────────────────────────────

function ScoreDial({ score }) {
  if (score == null) return null;
  const color = score >= 75 ? C.green : score >= 50 ? C.yellow : score >= 30 ? C.orange : C.red;
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", width: 72, height: 72, borderRadius: "50%",
      border: `3px solid ${color}44`, background: `${color}08`, flexShrink: 0,
    }}>
      <div style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1 }}>{score}</div>
      <div style={{ fontSize: 6, color: C.dim, letterSpacing: "0.1em" }}>SCORE</div>
    </div>
  );
}

// ── Condición ganadora ─────────────────────────────────────────────────────────

function CondicionCard({ c, i }) {
  const [open, setOpen] = useState(i < 3);
  const confColor  = CONFIANZA_COLOR[c.confianza]  ?? C.dim;
  const accionColor = ACCION_COLOR[c.accion]       ?? C.dim;
  const vColor      = VENTANA_COLOR[c.ventana]     ?? C.dim;

  return (
    <div style={{
      background: C.card, border: `1px solid #0d0d1a`,
      borderRadius: 4, overflow: "hidden", marginBottom: 6,
    }}>
      {/* Header de la condición */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          cursor: "pointer", borderBottom: open ? `1px solid #0d0d1a` : "none",
        }}
      >
        <span style={{ fontSize: 7, color: C.dim, minWidth: 40 }}>{c.id}</span>
        <Badge text={c.ventana} color={vColor} small />
        <span style={{
          fontSize: 9, color: "#bbb", flex: 1, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{c.descripcion}</span>
        <span style={{
          fontSize: 12, fontWeight: 900,
          color: c.win_rate >= 95 ? C.green : c.win_rate >= 80 ? C.yellow : C.orange,
        }}>
          {c.win_rate}%
        </span>
        <span style={{ fontSize: 8, color: C.dim }}>n={c.ciclos_muestra}</span>
        <Badge text={c.confianza}  color={confColor}   small />
        <Badge text={c.accion}     color={accionColor} small />
        <span style={{ fontSize: 9, color: C.dim }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Filtros */}
          {c.filtros && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {c.filtros.yes_price_max != null && (
                <div style={{ fontSize: 8, color: C.cyan, background: `${C.cyan}10`, border: `1px solid ${C.cyan}30`, borderRadius: 3, padding: "2px 7px" }}>
                  YES ≤ {c.filtros.yes_price_max}
                </div>
              )}
              {c.filtros.yes_price_min != null && (
                <div style={{ fontSize: 8, color: C.cyan, background: `${C.cyan}10`, border: `1px solid ${C.cyan}30`, borderRadius: 3, padding: "2px 7px" }}>
                  YES ≥ {c.filtros.yes_price_min}
                </div>
              )}
              {c.filtros.boost_min != null && (
                <div style={{ fontSize: 8, color: C.purple, background: `${C.purple}10`, border: `1px solid ${C.purple}30`, borderRadius: 3, padding: "2px 7px" }}>
                  Boost ≥ {c.filtros.boost_min}
                </div>
              )}
              {c.filtros.distancia_direccion && c.filtros.distancia_direccion !== "AMBAS" && (
                <div style={{ fontSize: 8, color: C.orange, background: `${C.orange}10`, border: `1px solid ${C.orange}30`, borderRadius: 3, padding: "2px 7px" }}>
                  Dir: {c.filtros.distancia_direccion}
                </div>
              )}
              {c.filtros.horas_utc && (
                <div style={{ fontSize: 8, color: C.yellow, background: `${C.yellow}10`, border: `1px solid ${C.yellow}30`, borderRadius: 3, padding: "2px 7px" }}>
                  🕐 {c.filtros.horas_utc}
                </div>
              )}
            </div>
          )}

          {/* P&L esperado */}
          <div style={{ display: "flex", gap: 16 }}>
            <div>
              <div style={{ fontSize: 7, color: C.dim, letterSpacing: "0.1em" }}>P&L/CICLO</div>
              <div style={{
                fontSize: 14, fontWeight: 900,
                color: (c.pnl_esperado_por_ciclo ?? 0) >= 0 ? C.green : C.red,
              }}>
                {c.pnl_esperado_por_ciclo != null
                  ? `${c.pnl_esperado_por_ciclo >= 0 ? "+" : ""}$${c.pnl_esperado_por_ciclo.toFixed(2)}`
                  : "—"}
              </div>
            </div>
          </div>

          {/* Robustez + razón */}
          {c.robustez && (
            <div style={{ fontSize: 8, color: "#555", lineHeight: 1.5 }}>
              <span style={{ color: C.dim }}>Robustez: </span>{c.robustez}
            </div>
          )}
          {c.razon && (
            <div style={{
              fontSize: 8, color: "#666", lineHeight: 1.6,
              background: "#030316", borderRadius: 3, padding: "5px 8px",
              borderLeft: `2px solid ${confColor}`,
            }}>
              {c.razon}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Par intra-ciclo ────────────────────────────────────────────────────────────

function ParCard({ par }) {
  const retColor = (par.retorno_implicito_pct ?? 0) >= 0 ? C.green : C.red;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      background: C.card, border: `1px solid #0d0d1a`,
      borderRadius: 4, padding: "8px 14px", marginBottom: 5,
    }}>
      <div style={{ minWidth: 90 }}>
        <div style={{ fontSize: 7, color: C.dim, marginBottom: 2 }}>PAR</div>
        <div style={{ fontSize: 9, color: C.teal, fontWeight: 700 }}>{par.par}</div>
      </div>
      <div style={{ minWidth: 70, textAlign: "center" }}>
        <div style={{ fontSize: 7, color: C.dim }}>COMPRAR</div>
        <div style={{ fontSize: 13, fontWeight: 900, color: C.blue }}>≤ {par.comprar_en}</div>
      </div>
      <div style={{ fontSize: 10, color: C.dim }}>→</div>
      <div style={{ minWidth: 70, textAlign: "center" }}>
        <div style={{ fontSize: 7, color: C.dim }}>VENDER</div>
        <div style={{ fontSize: 13, fontWeight: 900, color: C.yellow }}>≥ {par.vender_en}</div>
      </div>
      <div style={{ minWidth: 65, textAlign: "center" }}>
        <div style={{ fontSize: 7, color: C.dim }}>RETORNO</div>
        <div style={{ fontSize: 13, fontWeight: 900, color: retColor }}>
          +{par.retorno_implicito_pct}%
        </div>
      </div>
      <div style={{ minWidth: 60, textAlign: "center" }}>
        <div style={{ fontSize: 7, color: C.dim }}>ÉXITO</div>
        <div style={{ fontSize: 13, fontWeight: 900, color: par.tasa_exito >= 90 ? C.green : C.yellow }}>
          {par.tasa_exito}%
        </div>
      </div>
      <div style={{ minWidth: 40, textAlign: "center" }}>
        <div style={{ fontSize: 7, color: C.dim }}>n</div>
        <div style={{ fontSize: 11, color: C.dim }}>{par.ciclos_muestra}</div>
      </div>
      {par.tasa_exito >= 90 && <Badge text="HIGH" color={C.green} small />}
    </div>
  );
}

// ── Optimización ──────────────────────────────────────────────────────────────

function OptCard({ opt }) {
  const pc = PRIO_COLOR[opt.prioridad] ?? C.dim;
  return (
    <div style={{
      background: C.card, border: `1px solid ${pc}22`,
      borderRadius: 4, padding: "10px 14px", marginBottom: 6,
      borderLeft: `3px solid ${pc}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 9, color: "#ccc", fontWeight: 700 }}>{opt.parametro}</span>
        <Badge text={opt.prioridad} color={pc} small />
      </div>
      <div style={{ fontSize: 8, color: "#666", lineHeight: 1.5, marginBottom: 5 }}>{opt.descripcion}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{
          fontSize: 8, color: C.cyan, background: `${C.cyan}10`,
          border: `1px solid ${C.cyan}30`, borderRadius: 3, padding: "2px 8px",
        }}>
          → {opt.valor_recomendado}
        </div>
        <div style={{ fontSize: 8, color: C.dim }}>{opt.impacto_esperado}</div>
      </div>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function PairEngine() {
  const [simFilter, setSimFilter] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [result,    setResult]    = useState(null);
  const [activeTab, setActiveTab] = useState("condiciones");

  // Cargar caché al montar
  useEffect(() => {
    const cached = loadCache(simFilter ?? "all");
    if (cached) setResult(cached);
    else setResult(null);
  }, [simFilter]);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = simFilter != null
        ? `/api/pair-analysis?simulated=${simFilter}`
        : `/api/pair-analysis`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      saveCache(data, simFilter ?? "all");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [simFilter]);

  const { analysis, meta, raw } = result ?? {};

  const TABS = [
    { key: "condiciones", label: "CONDICIONES"   },
    { key: "pares",       label: "PARES CICLO"   },
    { key: "optimizar",   label: "OPTIMIZAR"     },
  ];

  return (
    <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>

      {/* ── CABECERA ────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 24px", borderBottom: `1px solid ${C.border}`,
        background: C.header,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 9, letterSpacing: "0.25em", color: C.teal, fontWeight: 700 }}>
            ◈ MOTOR DE PARES
          </span>
          {analysis && !loading && (
            <>
              <span style={{
                fontSize: 8, color: C.teal, background: `${C.teal}12`,
                border: `1px solid ${C.teal}33`, borderRadius: 3,
                padding: "2px 7px", letterSpacing: "0.1em", fontWeight: 700,
              }}>
                {analysis.condiciones_perfectas_encontradas ?? 0} PERFECTAS
              </span>
              <span style={{
                fontSize: 8, color: C.purple, background: `${C.purple}12`,
                border: `1px solid ${C.purple}33`, borderRadius: 3,
                padding: "2px 7px", letterSpacing: "0.1em", fontWeight: 700,
              }}>
                {analysis.ciclos_analizados ?? meta?.totalCycles ?? "—"} CICLOS
              </span>
            </>
          )}
          {meta?.generated_at && (
            <span style={{ fontSize: 8, color: "#2a2a3a" }}>
              {new Date(meta.generated_at).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {[
            { val: null,    label: "TODOS" },
            { val: "true",  label: "SIM"   },
            { val: "false", label: "REAL"  },
          ].map(({ val, label }) => (
            <button key={label} onClick={() => setSimFilter(val)} style={{
              background: simFilter === val ? `${C.teal}18` : "none",
              border: `1px solid ${simFilter === val ? C.teal : "#1a1a2e"}`,
              color: simFilter === val ? C.teal : "#444",
              fontSize: 8, padding: "3px 8px", cursor: "pointer",
              fontFamily: "inherit", letterSpacing: "0.1em", borderRadius: 3,
            }}>{label}</button>
          ))}
          <button
            onClick={runAnalysis}
            disabled={loading}
            style={{
              background: loading ? "#0d0d1a" : `${C.teal}18`,
              border: `1px solid ${loading ? "#222" : C.teal}`,
              color: loading ? "#444" : C.teal,
              fontSize: 9, padding: "4px 14px",
              cursor: loading ? "default" : "pointer",
              fontFamily: "inherit", letterSpacing: "0.15em", fontWeight: 700, borderRadius: 3,
            }}
          >
            {loading ? "ANALIZANDO…" : analysis ? "↻ RE-ANALIZAR" : "▶ EJECUTAR MOTOR"}
          </button>
        </div>
      </div>

      {/* ── ERROR ──────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ padding: "8px 24px", background: "#ff335508", borderBottom: `1px solid #ff335522` }}>
          <span style={{ fontSize: 9, color: C.red }}>✕ {error}</span>
        </div>
      )}

      {/* ── LOADING ────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{ padding: "30px 24px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
          <style>{`@keyframes pe-spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{
            display: "inline-block", width: 22, height: 22, borderRadius: "50%",
            border: `2px solid ${C.teal}33`, borderTop: `2px solid ${C.teal}`,
            animation: "pe-spin 0.8s linear infinite", marginBottom: 10,
          }} />
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em" }}>
            Computando combinaciones y consultando IA…
          </div>
        </div>
      )}

      {/* ── VACÍO ──────────────────────────────────────────────────────── */}
      {!loading && !analysis && !error && (
        <div style={{ padding: "26px 24px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.15em", marginBottom: 6 }}>
            MOTOR DE PARES NO EJECUTADO
          </div>
          <div style={{ fontSize: 8, color: "#1a1a2a" }}>
            Analiza todas las combinaciones de ventana, precio, boost, distancia, dirección y hora
            para encontrar las condiciones que SIEMPRE generan beneficio en un ciclo.
          </div>
        </div>
      )}

      {/* ── RESULTADO ──────────────────────────────────────────────────── */}
      {!loading && analysis && (
        <>
          {/* ── MÉTRICAS RÁPIDAS ─────────────────────────────────────── */}
          <div style={{
            display: "flex", gap: 10, padding: "12px 24px", flexWrap: "wrap",
            alignItems: "center", borderBottom: `1px solid ${C.border}`,
          }}>
            <ScoreDial score={analysis.score_oportunidad} />
            <MetaCard
              label="CICLOS"
              value={analysis.ciclos_analizados ?? meta?.totalCycles ?? "—"}
              color={C.teal}
            />
            <MetaCard
              label="WR GLOBAL"
              value={`${analysis.win_rate_global ?? meta?.globalWR ?? "—"}%`}
              color={(analysis.win_rate_global ?? 0) >= 55 ? C.green : C.yellow}
            />
            <MetaCard
              label="P&L TOTAL"
              value={analysis.pnl_total != null
                ? `${analysis.pnl_total >= 0 ? "+" : ""}$${analysis.pnl_total.toFixed(2)}`
                : "—"}
              color={(analysis.pnl_total ?? 0) >= 0 ? C.green : C.red}
            />
            <MetaCard
              label="PERFECTAS"
              value={analysis.condiciones_perfectas_encontradas ?? meta?.perfect_count ?? "—"}
              color={C.green}
              sub="100% WR ≥3n"
            />
            <MetaCard
              label="PARES CICLO"
              value={raw?.pair_scenarios?.length ?? "—"}
              color={C.cyan}
              sub="≥75% éxito"
            />
          </div>

          {/* ── RESUMEN EJECUTIVO ────────────────────────────────────── */}
          {analysis.resumen_ejecutivo && (
            <div style={{
              padding: "12px 24px", borderBottom: `1px solid ${C.border}`,
              background: "#01010c",
            }}>
              <div style={{ fontSize: 8, color: C.teal, letterSpacing: "0.15em", marginBottom: 6, fontWeight: 700 }}>
                ◈ RESUMEN EJECUTIVO
              </div>
              <div style={{
                fontSize: 9, color: "#888", lineHeight: 1.8,
                borderLeft: `2px solid ${C.teal}44`, paddingLeft: 12,
                maxWidth: 900,
              }}>
                {analysis.resumen_ejecutivo}
              </div>
            </div>
          )}

          {/* ── TABS ─────────────────────────────────────────────────── */}
          <div style={{
            display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`,
            background: C.header,
          }}>
            {TABS.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
                background: activeTab === t.key ? `${C.teal}12` : "none",
                borderBottom: `2px solid ${activeTab === t.key ? C.teal : "transparent"}`,
                border: "none", borderRight: `1px solid ${C.border}`,
                color: activeTab === t.key ? C.teal : "#444",
                fontSize: 8, padding: "8px 18px", cursor: "pointer",
                fontFamily: "inherit", letterSpacing: "0.15em", fontWeight: 700,
              }}>{t.label}</button>
            ))}
          </div>

          {/* ── TAB: CONDICIONES ─────────────────────────────────────── */}
          {activeTab === "condiciones" && (
            <div style={{ padding: "14px 24px" }}>

              {/* Alertas inline */}
              {analysis.alertas?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  {analysis.alertas.map((a, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 8, alignItems: "flex-start",
                      background: `${SEVERIDAD_COLOR[a.severidad] ?? C.dim}08`,
                      border: `1px solid ${SEVERIDAD_COLOR[a.severidad] ?? C.dim}30`,
                      borderRadius: 3, padding: "5px 10px", marginBottom: 5, fontSize: 8,
                    }}>
                      <span style={{ color: SEVERIDAD_COLOR[a.severidad] ?? C.dim, flexShrink: 0 }}>▲</span>
                      <span style={{ color: "#888", lineHeight: 1.5 }}>{a.mensaje}</span>
                      <Badge text={a.severidad} color={SEVERIDAD_COLOR[a.severidad] ?? C.dim} small />
                    </div>
                  ))}
                </div>
              )}

              {/* Condiciones ganadoras IA */}
              {analysis.condiciones_ganadoras?.length > 0 && (
                <>
                  <SectionLabel color={C.teal}>CONDICIONES IDENTIFICADAS POR IA</SectionLabel>
                  {analysis.condiciones_ganadoras.map((c, i) => (
                    <CondicionCard key={c.id ?? i} c={c} i={i} />
                  ))}
                </>
              )}

              {/* Combos crudos adicionales */}
              {raw?.perfect_combos?.length > 0 && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{
                    fontSize: 8, color: C.dim, cursor: "pointer", letterSpacing: "0.1em",
                    padding: "6px 0", borderTop: `1px solid ${C.border}`,
                  }}>
                    ▸ VER {raw.perfect_combos.length} COMBOS ESTADÍSTICOS CRUDOS (100% WR)
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    {raw.perfect_combos.slice(0, 30).map((c, i) => (
                      <div key={i} style={{
                        display: "flex", gap: 10, alignItems: "center",
                        padding: "4px 0", borderBottom: `1px solid #06060f`,
                      }}>
                        <span style={{
                          fontSize: 7, color: VENTANA_COLOR[c.ventana] ?? C.dim,
                          minWidth: 28, fontWeight: 700,
                        }}>{c.ventana}</span>
                        <span style={{ fontSize: 8, color: C.green, minWidth: 36 }}>
                          {c.win_rate}%
                        </span>
                        <span style={{ fontSize: 7, color: "#444", minWidth: 30 }}>n={c.total}</span>
                        <code style={{ fontSize: 7, color: "#555", flex: 1 }}>
                          {Object.entries(c.vars ?? {}).map(([k,v]) => `${k}:${v}`).join(" · ")}
                        </code>
                        <span style={{ fontSize: 8, color: (c.pnl_por_op ?? 0) >= 0 ? C.green : C.red }}>
                          {c.pnl_por_op != null ? `${c.pnl_por_op >= 0 ? "+" : ""}$${c.pnl_por_op.toFixed(2)}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Siguiente acción */}
              {analysis.siguiente_accion && (
                <div style={{
                  marginTop: 16, padding: "10px 14px",
                  background: `${C.teal}08`, border: `1px solid ${C.teal}30`,
                  borderRadius: 4,
                }}>
                  <div style={{ fontSize: 7, color: C.teal, letterSpacing: "0.12em", marginBottom: 4 }}>
                    SIGUIENTE ACCIÓN PRIORITARIA
                  </div>
                  <div style={{ fontSize: 9, color: "#aaa", lineHeight: 1.6 }}>
                    {analysis.siguiente_accion}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB: PARES INTRA-CICLO ───────────────────────────────── */}
          {activeTab === "pares" && (
            <div style={{ padding: "14px 24px" }}>
              <SectionLabel color={C.cyan}>
                PARES COMPRA/VENTA INTRA-CICLO (estadístico)
              </SectionLabel>
              <div style={{ fontSize: 8, color: "#444", marginBottom: 12, lineHeight: 1.6 }}>
                Escenarios donde el precio YES baja a un mínimo en ventana A y luego sube a un máximo
                en ventana B, dentro del mismo ciclo de 1H. Tasa de éxito = % de ciclos donde ocurrió.
              </div>

              {/* Pares IA */}
              {analysis.mejores_pares_intra_ciclo?.length > 0 && (
                <>
                  <SectionLabel color={C.purple}>INTERPRETADOS POR IA</SectionLabel>
                  {analysis.mejores_pares_intra_ciclo.map((p, i) => (
                    <ParCard key={i} par={p} />
                  ))}
                  <div style={{ marginTop: 14, marginBottom: 8 }} />
                </>
              )}

              {/* Pares crudos */}
              {raw?.pair_scenarios?.length > 0 && (
                <>
                  <SectionLabel color={C.cyan}>TODOS LOS PARES (≥75% éxito)</SectionLabel>
                  {raw.pair_scenarios.map((p, i) => (
                    <ParCard
                      key={i}
                      par={{
                        par:                   p.pair,
                        comprar_en:            p.buy_at,
                        vender_en:             p.sell_at,
                        tasa_exito:            p.success_rate,
                        retorno_implicito_pct: p.implied_return_pct,
                        ciclos_muestra:        p.eligible_cycles,
                        descripcion:           `Comprar YES ≤${p.buy_at} en ${p.pair.split("→")[0]}, vender ≥${p.sell_at} en ${p.pair.split("→")[1]}`,
                      }}
                    />
                  ))}
                </>
              )}

              {(!analysis.mejores_pares_intra_ciclo?.length && !raw?.pair_scenarios?.length) && (
                <div style={{ fontSize: 9, color: "#333", textAlign: "center", padding: "20px 0" }}>
                  Sin pares con ≥75% de éxito en el dataset actual
                </div>
              )}
            </div>
          )}

          {/* ── TAB: OPTIMIZAR ───────────────────────────────────────── */}
          {activeTab === "optimizar" && (
            <div style={{ padding: "14px 24px" }}>
              <SectionLabel color={C.orange}>
                OPTIMIZACIONES RECOMENDADAS PARA EL ALGORITMO
              </SectionLabel>

              {analysis.optimizaciones_algoritmo?.length > 0
                ? analysis.optimizaciones_algoritmo
                    .sort((a, b) => {
                      const ORDER = { CRÍTICA: 0, ALTA: 1, MEDIA: 2, BAJA: 3 };
                      return (ORDER[a.prioridad] ?? 9) - (ORDER[b.prioridad] ?? 9);
                    })
                    .map((opt, i) => <OptCard key={i} opt={opt} />)
                : (
                  <div style={{ fontSize: 9, color: "#333", textAlign: "center", padding: "20px 0" }}>
                    Sin optimizaciones detectadas con los datos actuales
                  </div>
                )
              }
            </div>
          )}
        </>
      )}
    </div>
  );
}
