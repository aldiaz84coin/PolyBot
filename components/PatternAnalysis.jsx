// components/PatternAnalysis.jsx
// Módulo 2 — Análisis de Patrones de Precio en Ventanas
// Se integra en DataLab como nueva sección (tab PATRONES)
//
// v1.0 — Pares condicionales, bandas óptimas, escenarios buy/sell, alertas SL

"use client";
import { useState, useEffect, useCallback } from "react";

// ── Paleta (consistente con DataLab) ─────────────────────────────────────────
const C = {
  green:  "#00ff88", red:    "#ff3355", yellow: "#ffcc00",
  blue:   "#4488ff", purple: "#aa66ff", orange: "#ff8800",
  dim:    "#666",    border: "#0d0d1a", bg:     "#010108",
  card:   "#02020e", cardAlt:"#030316",
};

const WINDOW_COLORS  = { "T-20": C.blue, "T-15": C.yellow, "T-10": C.orange, "T-5": C.red };
const WINDOW_ORDER   = ["T-20", "T-15", "T-10", "T-5"];
const LS_KEY         = "polybot_pattern_analysis_v1";
const CACHE_TTL      = 10 * 60 * 1000; // 10 min

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtOdds = (v) => v != null ? `${(Number(v) * 100).toFixed(1)}¢` : "—";
const fmtPct  = (v) => v != null ? `${v}%` : "—";
const fmtUSD  = (v) => v != null ? `$${Number(v).toFixed(2)}` : "—";
const fmtReturn = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "—";

function confColor(pct) {
  if (pct == null) return C.dim;
  if (pct >= 90)   return C.green;
  if (pct >= 75)   return C.yellow;
  return C.orange;
}

function winRateColor(wr) {
  if (wr == null) return C.dim;
  if (wr >= 75)   return C.green;
  if (wr >= 55)   return C.yellow;
  if (wr >= 40)   return C.orange;
  return C.red;
}

function saveCache(data, key) {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    s[key] = { data, ts: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

function loadCache(key) {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const e = s[key];
    if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  } catch {}
  return null;
}

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SectionTitle({ children, accent }) {
  return (
    <div style={{
      fontSize: 9, letterSpacing: "0.2em",
      color: accent ?? C.dim,
      borderBottom: `1px solid ${C.border}`,
      paddingBottom: 7, marginBottom: 14,
    }}>
      {children}
    </div>
  );
}

function Tag({ text, color = C.dim, small = false }) {
  return (
    <span style={{
      display: "inline-block", fontSize: small ? 7 : 8, fontWeight: 700,
      letterSpacing: "0.1em", padding: small ? "1px 5px" : "2px 7px",
      background: `${color}15`, border: `1px solid ${color}44`,
      color, borderRadius: 3,
    }}>{text}</span>
  );
}

function WindowTag({ v }) {
  const c = WINDOW_COLORS[v] ?? C.dim;
  return <Tag text={v} color={c} />;
}

function ConfidenceDial({ pct: p }) {
  if (p == null) return <span style={{ color: C.dim, fontSize: 11 }}>—</span>;
  const color = confColor(p);
  return (
    <span style={{
      fontSize: 14, fontWeight: 900, color,
      textShadow: `0 0 8px ${color}55`,
    }}>
      {p}%
    </span>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes pat-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ textAlign: "center", padding: "28px 0" }}>
        <div style={{
          display: "inline-block", width: 20, height: 20, borderRadius: "50%",
          border: `2px solid ${C.purple}33`, borderTop: `2px solid ${C.purple}`,
          animation: "pat-spin 0.8s linear infinite", marginBottom: 10,
        }} />
        <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em" }}>
          Calculando patrones estadísticos y consultando IA…
        </div>
      </div>
    </>
  );
}

function Empty({ msg = "Sin datos suficientes" }) {
  return <div style={{ fontSize: 9, color: "#2a2a3a", padding: "12px 0" }}>{msg}</div>;
}

// ── Sección 1: Patrones fiables (pares condicionales) ─────────────────────────

function PatternCards({ patterns }) {
  if (!patterns?.length) return <Empty msg="Sin patrones con confianza suficiente aún" />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {patterns.map((p, i) => (
        <div key={i} style={{
          background: C.cardAlt,
          border: `1px solid ${C.border}`,
          borderLeft: `3px solid ${confColor(p.confianza_pct)}`,
          borderRadius: "0 4px 4px 0",
          padding: "12px 16px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <WindowTag v={p.ventana_inicio} />
              <span style={{ color: "#333", fontSize: 10 }}>→</span>
              <WindowTag v={p.ventana_fin} />
              {p.sesiones_base && (
                <span style={{ fontSize: 8, color: "#333" }}>{p.sesiones_base} sesiones</span>
              )}
            </div>
            <ConfidenceDial pct={p.confianza_pct} />
          </div>
          <div style={{ fontSize: 10, color: "#999", lineHeight: 1.6, marginBottom: 6 }}>
            {p.descripcion}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 7, color: "#444", letterSpacing: "0.1em", marginBottom: 2 }}>SI PRECIO EN</div>
              <code style={{ fontSize: 9, color: C.yellow, background: "#0a0a00", padding: "1px 5px" }}>
                {p.condicion_entrada}
              </code>
            </div>
            <div>
              <div style={{ fontSize: 7, color: "#444", letterSpacing: "0.1em", marginBottom: 2 }}>ENTONCES</div>
              <div style={{ fontSize: 9, color: confColor(p.confianza_pct) }}>{p.comportamiento_esperado}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Sección 2: Bandas óptimas por ventana ─────────────────────────────────────

function OptimalBandsTable({ bandas }) {
  if (!bandas || !Object.keys(bandas).length) return <Empty />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {WINDOW_ORDER.map(w => {
        const b = bandas[w];
        if (!b) return null;
        const wc = WINDOW_COLORS[w] ?? C.dim;
        return (
          <div key={w} style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 4, padding: "12px 16px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <WindowTag v={w} />
              {b.win_rate_historico && (
                <Tag text={`WR ${b.win_rate_historico}%`} color={winRateColor(b.win_rate_historico)} />
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 7, color: "#444", marginBottom: 3, letterSpacing: "0.1em" }}>COMPRAR EN</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{b.compra_rango}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#444", marginBottom: 3, letterSpacing: "0.1em" }}>VENDER A</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.yellow }}>
                  {b.venta_objetivo ? fmtOdds(b.venta_objetivo) : "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#444", marginBottom: 3, letterSpacing: "0.1em" }}>RETORNO EST.</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>
                  {b.venta_objetivo && b.compra_rango
                    ? (() => {
                        const buyMid = b.compra_rango.split("-").map(Number).reduce((a, b) => (a + b) / 2);
                        return buyMid > 0 ? `+${((b.venta_objetivo / buyMid - 1) * 100).toFixed(0)}%` : "—";
                      })()
                    : "—"}
                </div>
              </div>
            </div>
            {b.nota && (
              <div style={{ fontSize: 9, color: "#555", marginTop: 8, lineHeight: 1.5, fontStyle: "italic" }}>
                {b.nota}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sección 3: Escenarios buy/sell ────────────────────────────────────────────

function ScenarioTable({ scenarios }) {
  if (!scenarios?.length) return <Empty msg="Insuficientes datos históricos para escenarios fiables" />;

  const top = scenarios.filter(s => s.is_high_confidence).slice(0, 12);
  if (!top.length) return <Empty msg="Sin escenarios con >80% de éxito aún. Necesitas más sesiones históricas." />;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
        <thead>
          <tr>
            {["COMPRA EN", "VENTA EN", "RETORNO", "SESIONES", "ÉXITO", "CONFIANZA"].map(h => (
              <th key={h} style={{
                textAlign: "left", padding: "6px 10px", fontSize: 8,
                color: "#444", letterSpacing: "0.12em", borderBottom: `1px solid ${C.border}`,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {top.map((s, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #05050f" }}>
              <td style={{ padding: "7px 10px", color: C.green, fontWeight: 700 }}>
                {fmtOdds(s.buy_at)}
              </td>
              <td style={{ padding: "7px 10px", color: C.yellow, fontWeight: 700 }}>
                {fmtOdds(s.sell_at)}
              </td>
              <td style={{ padding: "7px 10px", color: C.blue, fontWeight: 700 }}>
                {fmtReturn(s.implied_return_pct)}
              </td>
              <td style={{ padding: "7px 10px", color: "#666" }}>
                {s.sessions_eligible}
              </td>
              <td style={{ padding: "7px 10px", color: "#888" }}>
                {s.sessions_success}/{s.sessions_eligible}
              </td>
              <td style={{ padding: "7px 10px" }}>
                <ConfidenceDial pct={s.success_rate_pct} />
                {s.is_very_high_confidence && (
                  <Tag text="★ MUY ALTA" color={C.green} small style={{ marginLeft: 6 }} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sección 4: Reglas de TP y alertas de SL ───────────────────────────────────

function TakeProfitRules({ rules, alerts }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {/* TP Rules */}
      <div>
        <SectionTitle accent={C.green}>REGLAS DE TAKE PROFIT</SectionTitle>
        {!rules?.length
          ? <Empty />
          : rules.map((r, i) => (
            <div key={i} style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 4, padding: "10px 14px", marginBottom: 8,
            }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <WindowTag v={r.ventana} />
                <span style={{ fontSize: 8, color: "#444" }}>si entra en</span>
                <code style={{ fontSize: 9, color: C.yellow, background: "#0a0a00", padding: "1px 5px" }}>
                  {r.si_compra_en_rango}
                </code>
              </div>
              <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 7, color: "#444", letterSpacing: "0.1em", marginBottom: 2 }}>TP RECOMENDADO</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>
                    {r.tp_recomendado != null ? fmtOdds(r.tp_recomendado) : "—"}
                  </div>
                </div>
                {r.sl_sugerido && (
                  <div>
                    <div style={{ fontSize: 7, color: "#444", letterSpacing: "0.1em", marginBottom: 2 }}>SL SUGERIDO</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.red }}>
                      {fmtOdds(r.sl_sugerido)}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 9, color: "#555", lineHeight: 1.5 }}>{r.razon}</div>
            </div>
          ))
        }
      </div>

      {/* SL Alerts */}
      <div>
        <SectionTitle accent={C.red}>ALERTAS DE STOP LOSS</SectionTitle>
        {!alerts?.length
          ? <Empty />
          : alerts.map((a, i) => (
            <div key={i} style={{
              background: "#100008", border: `1px solid ${C.red}22`,
              borderRadius: 4, padding: "10px 14px", marginBottom: 8,
            }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                {a.ventana_mas_afectada && <WindowTag v={a.ventana_mas_afectada} />}
                {a.precio_entrada_riesgo && (
                  <code style={{ fontSize: 9, color: C.red, background: "#100008", padding: "1px 5px" }}>
                    entrada {a.precio_entrada_riesgo}
                  </code>
                )}
              </div>
              <div style={{ fontSize: 9, color: "#999", marginBottom: 6, lineHeight: 1.5 }}>{a.patron}</div>
              {a.señal_de_alerta && (
                <div style={{
                  fontSize: 8, color: C.orange, background: "#120800",
                  border: `1px solid ${C.orange}22`, borderRadius: 3, padding: "4px 8px",
                }}>
                  ⚡ {a.señal_de_alerta}
                </div>
              )}
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── Mejor escenario destacado ─────────────────────────────────────────────────

function BestScenarioCard({ scenario }) {
  if (!scenario) return null;
  const returnPct = scenario.buy_at && scenario.sell_at
    ? Math.round((scenario.sell_at / scenario.buy_at - 1) * 100)
    : scenario.retorno_implicito_pct;

  return (
    <div style={{
      background: "linear-gradient(135deg, #010810 0%, #010508 100%)",
      border: `1px solid ${C.green}33`,
      borderRadius: 6, padding: "20px 24px",
      boxShadow: `0 0 20px ${C.green}08`,
      marginBottom: 20,
    }}>
      <div style={{ fontSize: 8, color: C.green, letterSpacing: "0.25em", marginBottom: 12 }}>
        ★ MEJOR ESCENARIO DETECTADO
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "#444", marginBottom: 4, letterSpacing: "0.1em" }}>COMPRAR A</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.green }}>
            {fmtOdds(scenario.compra_en ?? scenario.buy_at)}
          </div>
        </div>
        <div style={{ fontSize: 20, color: "#333" }}>→</div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "#444", marginBottom: 4, letterSpacing: "0.1em" }}>VENDER A</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.yellow }}>
            {fmtOdds(scenario.venta_en ?? scenario.sell_at)}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "#444", marginBottom: 4, letterSpacing: "0.1em" }}>RETORNO</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.blue }}>
            {returnPct != null ? `+${returnPct}%` : "—"}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "#444", marginBottom: 4, letterSpacing: "0.1em" }}>TASA ÉXITO</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: confColor(scenario.success_rate_pct) }}>
            {scenario.success_rate_pct}%
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "#888", lineHeight: 1.6 }}>
        {scenario.descripcion}
      </div>
      {scenario.ventanas_donde_aplica?.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 8, color: "#444" }}>VENTANAS:</span>
          {scenario.ventanas_donde_aplica.map(w => <WindowTag key={w} v={w} />)}
        </div>
      )}
      {scenario.advertencias && (
        <div style={{
          marginTop: 10, fontSize: 9, color: C.orange,
          background: "#120800", border: `1px solid ${C.orange}22`,
          borderRadius: 3, padding: "5px 10px",
        }}>
          ⚠ {scenario.advertencias}
        </div>
      )}
    </div>
  );
}

// ── Mejoras de correlación sugeridas ─────────────────────────────────────────

function CorrelationSuggestions({ suggestions }) {
  if (!suggestions?.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      {suggestions.map((s, i) => (
        <div key={i} style={{
          display: "flex", gap: 8, alignItems: "flex-start",
          padding: "6px 0", borderBottom: `1px solid #06060f`,
          fontSize: 10, color: "#666", lineHeight: 1.5,
        }}>
          <span style={{ color: C.purple, fontSize: 8, flexShrink: 0, marginTop: 1 }}>#{i + 1}</span>
          {s}
        </div>
      ))}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function PatternAnalysis() {
  const [simFilter,   setSimFilter]   = useState(null);
  const [minSessions, setMinSessions] = useState(3);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [result,      setResult]      = useState(null);
  const [activeTab,   setActiveTab]   = useState("patrones");

  const cacheKey = `${simFilter ?? "all"}_${minSessions}`;

  useEffect(() => {
    const cached = loadCache(cacheKey);
    if (cached) { setResult(cached); }
    else        { setResult(null);   }
  }, [cacheKey]);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/pattern-analysis?type=ai_insight&min_sessions=${minSessions}${simFilter ? `&simulated=${simFilter}` : ""}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      saveCache(data, cacheKey);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [simFilter, minSessions, cacheKey]);

  const { insight, stats, raw } = result ?? {};

  const TABS = [
    { key: "patrones",   label: "PARES CONDICIONALES" },
    { key: "bandas",     label: "BANDAS ÓPTIMAS"      },
    { key: "escenarios", label: "ESCENARIOS"           },
    { key: "sl",         label: "ALERTAS SL / TP"     },
    { key: "mejoras",    label: "CORRELACIÓN"          },
  ];

  return (
    <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>

      {/* ── CABECERA ──────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 24px", borderBottom: `1px solid ${C.border}`,
        background: "#000a0d",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, letterSpacing: "0.25em", color: C.green, fontWeight: 700 }}>
            ◈ ANÁLISIS DE PATRONES
          </span>
          {stats && (
            <span style={{ fontSize: 8, color: "#2a2a3a" }}>
              {stats.sessions_analyzed} sesiones · {stats.pairs_computed} pares · {stats.scenarios_computed} escenarios
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          {/* Filtro modo */}
          {[{ val: null, label: "TODOS" }, { val: "true", label: "SIM" }, { val: "false", label: "REAL" }]
            .map(({ val, label }) => (
              <button key={label} onClick={() => setSimFilter(val)} style={{
                background: simFilter === val ? `${C.green}15` : "none",
                border: `1px solid ${simFilter === val ? C.green : "#1a1a2e"}`,
                color: simFilter === val ? C.green : "#444",
                fontSize: 8, padding: "3px 8px", cursor: "pointer",
                fontFamily: "inherit", letterSpacing: "0.1em", borderRadius: 3,
              }}>{label}</button>
            ))
          }

          {/* Mínimo de sesiones */}
          <select
            value={minSessions}
            onChange={e => setMinSessions(Number(e.target.value))}
            style={{
              background: C.card, border: `1px solid ${C.border}`,
              color: "#888", fontSize: 8, padding: "3px 6px", fontFamily: "inherit",
            }}
          >
            <option value={2}>mín 2 ses.</option>
            <option value={3}>mín 3 ses.</option>
            <option value={5}>mín 5 ses.</option>
            <option value={10}>mín 10 ses.</option>
          </select>

          <button
            onClick={runAnalysis}
            disabled={loading}
            style={{
              background: loading ? "#0d0d1a" : `${C.green}15`,
              border: `1px solid ${loading ? "#222" : C.green}`,
              color: loading ? "#444" : C.green,
              fontSize: 9, padding: "4px 14px",
              cursor: loading ? "default" : "pointer",
              fontFamily: "inherit", letterSpacing: "0.15em", fontWeight: 700, borderRadius: 3,
            }}
          >
            {loading ? "CALCULANDO…" : insight ? "↻ RECALCULAR" : "◈ CALCULAR PATRONES"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "8px 24px", background: "#ff335508", borderBottom: `1px solid ${C.red}22` }}>
          <span style={{ fontSize: 9, color: C.red }}>✕ {error}</span>
        </div>
      )}

      {/* Loading */}
      {loading && <Spinner />}

      {/* Placeholder */}
      {!loading && !insight && !error && (
        <div style={{ padding: "24px 24px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.15em", marginBottom: 6 }}>
            SIN ANÁLISIS GENERADO
          </div>
          <div style={{ fontSize: 9, color: "#1a1a2a" }}>
            Pulsa "CALCULAR PATRONES" para analizar trayectorias de precio y generar reglas de trading
          </div>
        </div>
      )}

      {/* ── CONTENIDO ─────────────────────────────────────────────────────── */}
      {!loading && insight && (
        <>
          {/* Mejor escenario en cabecera si existe */}
          {insight.mejor_escenario && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <BestScenarioCard scenario={insight.mejor_escenario} />
            </div>
          )}

          {/* Sub-tabs */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: "#00060a", paddingLeft: 24 }}>
            {TABS.map(({ key, label }) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "7px 14px", fontSize: 8, letterSpacing: "0.13em",
                color: activeTab === key ? C.green : "#333",
                borderBottom: activeTab === key ? `2px solid ${C.green}` : "2px solid transparent",
                fontFamily: "inherit", whiteSpace: "nowrap",
              }}>{label}</button>
            ))}
          </div>

          {/* Tab: PARES CONDICIONALES */}
          {activeTab === "patrones" && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <SectionTitle accent={C.green}>
                PATRONES QUE SE CUMPLEN CONSISTENTEMENTE · por ventana
              </SectionTitle>
              <div style={{ fontSize: 9, color: "#333", marginBottom: 16 }}>
                Relaciones precio→precio entre ventanas con al menos {minSessions} sesiones de datos.
                Confianza = % de sesiones donde la transición ocurrió.
              </div>
              <PatternCards patterns={insight.patrones_fiables} />
            </div>
          )}

          {/* Tab: BANDAS ÓPTIMAS */}
          {activeTab === "bandas" && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <SectionTitle accent={C.yellow}>
                BANDAS DE ENTRADA Y SALIDA ÓPTIMAS · por ventana
              </SectionTitle>
              <div style={{ fontSize: 9, color: "#333", marginBottom: 16 }}>
                Rangos de precio donde el historial muestra mejor relación win_rate / retorno esperado.
                Basado en operaciones reales registradas.
              </div>
              <OptimalBandsTable bandas={insight.bandas_optimas_por_ventana} />
            </div>
          )}

          {/* Tab: ESCENARIOS */}
          {activeTab === "escenarios" && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <SectionTitle accent={C.blue}>
                ESCENARIOS COMPRA → VENTA · simulados sobre datos históricos
              </SectionTitle>
              <div style={{ fontSize: 9, color: "#333", marginBottom: 16 }}>
                Para cada par (precio_compra, precio_venta), el % de sesiones históricas donde
                el precio del token pasó por ambos valores. Solo se muestran escenarios con ≥80% de éxito.
              </div>
              <ScenarioTable scenarios={raw?.bands?.scenarios} />

              {/* Tabla estadística de pares */}
              {raw?.matrix?.bucket_stats?.length > 0 && (
                <>
                  <SectionTitle accent={C.dim} style={{ marginTop: 24 }}>
                    MÁXIMOS ALCANZADOS SEGÚN PRECIO DE ENTRADA
                  </SectionTitle>
                  <div style={{ overflowX: "auto", marginTop: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                      <thead>
                        <tr>
                          {["ENTRADA EN", "VENTANA", "SES.", "MÁX P25", "MÁX P50", "MÁX P75", "MÁX P90", "% > 85¢", "% > 70¢"].map(h => (
                            <th key={h} style={{ textAlign: "left", padding: "5px 9px", color: "#444", fontSize: 7, letterSpacing: "0.1em", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(raw?.matrix?.bucket_stats ?? []).map((b, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #05050f" }}>
                            <td style={{ padding: "5px 9px", color: C.yellow, fontWeight: 700 }}>{b.entry_bucket}</td>
                            <td style={{ padding: "5px 9px" }}><WindowTag v={b.entry_window} /></td>
                            <td style={{ padding: "5px 9px", color: "#666" }}>{b.sessions}</td>
                            <td style={{ padding: "5px 9px", color: "#888" }}>{fmtOdds(b.max_p25)}</td>
                            <td style={{ padding: "5px 9px", color: "#ccc", fontWeight: 600 }}>{fmtOdds(b.max_p50)}</td>
                            <td style={{ padding: "5px 9px", color: "#888" }}>{fmtOdds(b.max_p75)}</td>
                            <td style={{ padding: "5px 9px", color: C.green }}>{fmtOdds(b.max_p90)}</td>
                            <td style={{ padding: "5px 9px", color: confColor(b.pct_ever_above_85) }}>{fmtPct(b.pct_ever_above_85)}</td>
                            <td style={{ padding: "5px 9px", color: confColor(b.pct_ever_above_70) }}>{fmtPct(b.pct_ever_above_70)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab: SL / TP */}
          {activeTab === "sl" && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <TakeProfitRules
                rules={insight.reglas_takeprofit}
                alerts={insight.alertas_sl}
              />
            </div>
          )}

          {/* Tab: CORRELACIÓN */}
          {activeTab === "mejoras" && (
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
              <SectionTitle accent={C.purple}>
                MEJORAS DE CORRELACIÓN SUGERIDAS · para futuros análisis
              </SectionTitle>
              <div style={{ fontSize: 9, color: "#333", marginBottom: 12 }}>
                Campos y métricas adicionales que mejorarían la precisión del análisis con más datos.
              </div>
              <CorrelationSuggestions suggestions={insight.mejoras_correlacion_sugeridas} />

              {/* Estado de la migración SQL */}
              <div style={{ marginTop: 24 }}>
                <SectionTitle accent={C.dim}>VISTAS SQL DISPONIBLES</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[
                    { name: "v_price_path_with_outcome",  desc: "Trayectoria de precio + resultado por sesión/ventana" },
                    { name: "v_window_outcome_stats",     desc: "Estadísticas agregadas por ventana y resultado" },
                    { name: "v_session_price_matrix",     desc: "Precio YES en cada ventana en columnas (para pares)" },
                    { name: "v_sl_patterns",              desc: "Correlatos de STOP/LOSS por ventana y dirección" },
                    { name: "operation_snapshots",        desc: "Snapshot exacto del mercado en el momento de cada apuesta" },
                  ].map(({ name, desc }) => (
                    <div key={name} style={{
                      display: "flex", gap: 12, padding: "6px 0",
                      borderBottom: `1px solid #06060f`,
                    }}>
                      <code style={{ fontSize: 9, color: C.blue, minWidth: 220, flexShrink: 0 }}>{name}</code>
                      <span style={{ fontSize: 9, color: "#555" }}>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
