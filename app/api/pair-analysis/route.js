// app/api/pair-analysis/route.js
// Motor de Análisis por Pares — PolyBot DataLab
// Identifica condiciones multi-variable que SIEMPRE generan beneficio dentro de un ciclo.
//
// Arquitectura:
//   JS pre-computa todas las combinaciones estadísticas (ventana × precio × boost × distancia × dirección × hora)
//   Claude interpreta los hallazgos y produce el resumen ejecutivo + recomendaciones accionables.
//   NUNCA se envían datos crudos a Claude — sólo resúmenes ya calculados.
//
// GET /api/pair-analysis?simulated=true|false
//
// v1.0 — Análisis multivariable completo con correlación cruzada de todas las fuentes de datos

import { NextResponse } from "next/server";

export const runtime     = "nodejs";
export const maxDuration = 60;
export const dynamic     = "force-dynamic";

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Supabase helper ────────────────────────────────────────────────────────────

async function sb(table, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`[${table}] ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Utilidades ─────────────────────────────────────────────────────────────────

const r2  = v => v != null ? Math.round(v * 100) / 100 : null;
const pct = (n, d) => d > 0 ? Math.round(n / d * 1000) / 10 : null;

function priceLabel(p) {
  if (p == null) return null;
  if (p < 0.30) return "<0.30";
  if (p < 0.35) return "0.30–0.35";
  if (p < 0.40) return "0.35–0.40";
  if (p < 0.45) return "0.40–0.45";
  if (p < 0.50) return "0.45–0.50";
  if (p < 0.55) return "0.50–0.55";
  if (p < 0.60) return "0.55–0.60";
  if (p < 0.65) return "0.60–0.65";
  if (p < 0.70) return "0.65–0.70";
  if (p < 0.80) return "0.70–0.80";
  return "≥0.80";
}

function boostLabel(b) {
  if (b == null) return null;
  if (b < 0.30) return "<0.30";
  if (b < 0.50) return "0.30–0.50";
  if (b < 0.70) return "0.50–0.70";
  if (b < 0.85) return "0.70–0.85";
  return "≥0.85";
}

function distLabel(d) {
  if (d == null) return null;
  if (d < -300) return "<-300";
  if (d < -100) return "-300–-100";
  if (d < -50)  return "-100–-50";
  if (d < 0)    return "-50–0";
  if (d < 50)   return "0–50";
  if (d < 100)  return "50–100";
  if (d < 300)  return "100–300";
  return "≥300";
}

function hourBlock(h) {
  if (h == null) return null;
  const b = Math.floor(h / 6) * 6;
  return `${String(b).padStart(2, "0")}–${String(b + 6).padStart(2, "0")}h`;
}

// ── Unir sesiones de v_session_price_matrix con boost de operations ────────────

function joinWithOps(sessions, ops) {
  // Indexar ops por market_slug → tomar la última op (ventana más cercana al cierre)
  const opsIdx = {};
  const WINDOW_PRIORITY = { T5: 0, T10: 1, T15: 2, T20: 3 };
  for (const op of ops) {
    if (!op.market_slug) continue;
    const prev = opsIdx[op.market_slug];
    if (!prev || (WINDOW_PRIORITY[op.ventana] ?? 9) < (WINDOW_PRIORITY[prev.ventana] ?? 9)) {
      opsIdx[op.market_slug] = op;
    }
  }

  const enriched = [];
  for (const s of sessions) {
    if (!s.resultado || s.resultado === "PENDING") continue;
    const op = opsIdx[s.market_slug];

    enriched.push({
      market_slug: s.market_slug,
      fecha:       s.fecha,
      hour_utc:    s.hour_utc,
      resultado:   s.resultado,
      direccion:   s.direccion,
      pnl_usd:     parseFloat(s.pnl_usd)      || 0,
      // YES prices por ventana (precio del token al entrar en esa ventana)
      yes_t20: s.yes_t20 != null ? parseFloat(s.yes_t20) : null,
      yes_t15: s.yes_t15 != null ? parseFloat(s.yes_t15) : null,
      yes_t10: s.yes_t10 != null ? parseFloat(s.yes_t10) : null,
      yes_t5:  s.yes_t5  != null ? parseFloat(s.yes_t5)  : null,
      // Boost (del motor Crypto Detector) de la operación en ese ciclo
      boost_t20: op?.boost_t20 ?? null,
      boost_t15: op?.boost_t15 ?? null,
      boost_t10: op?.boost_t10 ?? null,
      boost_t5:  op?.boost_t5  ?? null,
      // Distancia BTC vs target al momento de entrada
      distancia: op?.distancia ?? null,
      // Odds de entrada reales
      odds_entrada: op?.odds_entrada ? parseFloat(op.odds_entrada) : (s.odds_entrada ? parseFloat(s.odds_entrada) : null),
    });
  }

  return enriched;
}

// ── Análisis multivariable: todas las combinaciones de variables ───────────────

function buildCombos(enriched) {
  const WINDOWS = ["T20", "T15", "T10", "T5"];
  const store   = {}; // key → { wins, losses, total, pnl }

  function record(key, isWin, pnl) {
    if (!store[key]) store[key] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    store[key].total++;
    if (isWin) store[key].wins++;
    else       store[key].losses++;
    store[key].pnl += pnl;
  }

  for (const s of enriched) {
    const isWin = s.resultado === "WIN";
    const pnl   = s.pnl_usd;

    for (const w of WINDOWS) {
      const wl   = w.toLowerCase();
      const price = s[`yes_${wl}`];
      const boost = s[`boost_${wl}`];
      const dist  = s.distancia;
      const dir   = s.direccion;
      const hb    = hourBlock(s.hour_utc);

      if (price == null) continue;

      const PB = priceLabel(price);
      const BB = boost != null ? boostLabel(boost)  : null;
      const DB = dist  != null ? distLabel(dist)    : null;

      // ── 1 variable ──
      record(`${w}|P:${PB}`,            isWin, pnl);

      // ── 2 variables ──
      record(`${w}|P:${PB}|D:${dir}`,   isWin, pnl);
      if (BB) record(`${w}|P:${PB}|B:${BB}`,      isWin, pnl);
      if (DB) record(`${w}|P:${PB}|Di:${DB}`,     isWin, pnl);
      if (hb) record(`${w}|P:${PB}|H:${hb}`,      isWin, pnl);

      // ── 3 variables ──
      if (BB) record(`${w}|P:${PB}|B:${BB}|D:${dir}`,  isWin, pnl);
      if (DB) record(`${w}|P:${PB}|Di:${DB}|D:${dir}`, isWin, pnl);
      if (hb) record(`${w}|P:${PB}|H:${hb}|D:${dir}`,  isWin, pnl);
      if (BB && DB) record(`${w}|P:${PB}|B:${BB}|Di:${DB}`,         isWin, pnl);
      if (BB && hb) record(`${w}|P:${PB}|B:${BB}|H:${hb}`,          isWin, pnl);

      // ── 4 variables (combo completo) ──
      if (BB && DB) record(`${w}|P:${PB}|B:${BB}|Di:${DB}|D:${dir}`,         isWin, pnl);
      if (BB && hb) record(`${w}|P:${PB}|B:${BB}|H:${hb}|D:${dir}`,          isWin, pnl);
      if (BB && DB && hb) record(`${w}|P:${PB}|B:${BB}|Di:${DB}|H:${hb}|D:${dir}`, isWin, pnl);
    }
  }

  // Convertir a array con métricas
  return Object.entries(store)
    .filter(([, v]) => v.total >= 3)
    .map(([key, v]) => {
      const wr = pct(v.wins, v.total);
      // Desglosar la clave
      const parts   = key.split("|");
      const ventana = parts[0]; // T20|T15|T10|T5
      const vars    = Object.fromEntries(
        parts.slice(1).map(p => { const [k, ...rest] = p.split(":"); return [k, rest.join(":")]; })
      );
      return {
        key, ventana,
        vars,
        win_rate:     wr,
        wins:         v.wins,
        total:        v.total,
        pnl_total:    r2(v.pnl),
        pnl_por_op:   r2(v.pnl / v.total),
        n_vars:       parts.length - 1,
        is_perfect:   v.wins === v.total,
        is_excellent: wr >= 90 && v.total >= 5,
      };
    })
    .sort((a, b) => {
      // Ordena: 100% > 90%+; luego más ciclos; luego más variables (más específico)
      if (b.win_rate !== a.win_rate) return b.win_rate - a.win_rate;
      if (b.total   !== a.total)    return b.total   - a.total;
      return b.n_vars - a.n_vars;
    });
}

// ── Pares buy/sell intra-ciclo desde v_session_price_matrix ───────────────────
// "Si compro YES en ventana A al precio P1 y vendo (o resuelve) en ventana B al precio P2"

function computePairScenarios(sessions) {
  // Pares de ventanas posibles (entrada → salida)
  const PAIRS = [
    ["yes_t20", "yes_t10", "T-20→T-10"],
    ["yes_t20", "yes_t5",  "T-20→T-5"],
    ["yes_t15", "yes_t5",  "T-15→T-5"],
    ["yes_t10", "yes_t5",  "T-10→T-5"],
  ];

  const BUY_THRESHOLDS  = [0.30, 0.35, 0.40, 0.45, 0.50];
  const SELL_THRESHOLDS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

  const results = [];

  for (const [buyKey, sellKey, label] of PAIRS) {
    for (const buyAt of BUY_THRESHOLDS) {
      for (const sellAt of SELL_THRESHOLDS) {
        if (sellAt <= buyAt + 0.10) continue;

        let eligible = 0;
        let success  = 0;
        let totalReturn = 0;

        for (const s of sessions) {
          const pBuy  = s[buyKey]  != null ? parseFloat(s[buyKey])  : null;
          const pSell = s[sellKey] != null ? parseFloat(s[sellKey]) : null;

          if (pBuy == null || pSell == null) continue;
          if (pBuy > buyAt) continue; // no se puede comprar tan barato

          eligible++;
          if (pSell >= sellAt) {
            success++;
            totalReturn += (sellAt / buyAt - 1) * 100;
          }
        }

        if (eligible < 3) continue;
        const sr = pct(success, eligible);
        if (sr == null || sr < 75) continue;

        results.push({
          pair:              label,
          buy_at:            buyAt,
          sell_at:           sellAt,
          eligible_cycles:   eligible,
          success_cycles:    success,
          success_rate:      sr,
          implied_return_pct: r2(totalReturn / Math.max(success, 1)),
          is_high:           sr >= 90,
        });
      }
    }
  }

  return results
    .sort((a, b) => {
      if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
      return b.implied_return_pct - a.implied_return_pct;
    })
    .slice(0, 30);
}

// ── Prompt para Claude ────────────────────────────────────────────────────────

function buildPrompt({ meta, perfectCombos, excellentCombos, windowSummary, pairScenarios, candleSummary }) {
  return `
Eres un analista cuantitativo especializado en prediction markets. Analiza el MOTOR DE PARES de PolyBot.

ARQUITECTURA:
- Bot opera mercados Polymarket BTC UP/DOWN en velas 1H de Binance
- 4 ventanas de entrada por ciclo: T20 (20 min antes cierre), T15, T10, T5
- yes_price = precio CLOB del token YES en Polymarket (0.0–1.0). Si gana UP: token YES → 1.0. Si gana DOWN: token YES → 0.0.
- boost = Crypto Detector v4 (0.0=sin señal, 1.0=señal máxima de movimiento BTC)
- distancia = entry_price_BTC - target_price (positivo = BTC por encima del precio objetivo)
- Un "par" rentable = condición observable al entrar en una ventana que predice con fiabilidad el resultado al cierre

DATOS GLOBALES:
Ciclos analizados: ${meta.totalCycles} | Ops resueltas: ${meta.totalOps} | WR global: ${meta.globalWR}% | P&L total: $${meta.totalPnl} | Modo: ${meta.mode}
Condiciones 100% WR (n≥3): ${meta.perfect_count} | Condiciones ≥90% WR (n≥5): ${meta.excellent_count}

CONDICIONES CON 100% WIN RATE (≥3 ciclos) — TOP 20:
${JSON.stringify(
  perfectCombos.slice(0, 20).map(c => ({
    ventana: c.ventana, wr: `${c.win_rate}%`, n: c.total,
    pnl_medio: c.pnl_por_op, vars: c.vars
  })),
  null, 2
)}

CONDICIONES CON ≥90% WIN RATE (≥5 ciclos) — TOP 20:
${JSON.stringify(
  excellentCombos.slice(0, 20).map(c => ({
    ventana: c.ventana, wr: `${c.win_rate}%`, n: c.total,
    pnl_medio: c.pnl_por_op, vars: c.vars
  })),
  null, 2
)}

RESUMEN POR VENTANA:
${JSON.stringify(windowSummary, null, 2)}

ESCENARIOS BUY/SELL INTRA-CICLO (comprar en ventana A, vender antes del cierre en ventana B):
${JSON.stringify(pairScenarios.slice(0, 15), null, 2)}

CONTEXTO VELAS BTC RECIENTES (últimas 24h):
${JSON.stringify(candleSummary, null, 2)}

INSTRUCCIONES:
1. Identifica las condiciones multi-variable más sólidas (alta frecuencia + alta tasa + buen P&L)
2. Para cada condición: ¿es estadísticamente robusta o puede ser ruido? ¿Cuántos ciclos son suficientes?
3. ¿Qué combinación de (ventana + precio + boost + distancia + dirección + hora) maximiza el edge?
4. ¿Qué umbrales específicos de configuración del algoritmo deberían cambiarse y a qué valores?
5. ¿Hay suficiente muestra para operar real con estas condiciones o aún es simulación?

Responde EXCLUSIVAMENTE con este JSON sin ningún texto adicional:
{
  "ciclos_analizados": number,
  "ops_analizadas": number,
  "win_rate_global": number,
  "pnl_total": number,
  "condiciones_perfectas_encontradas": number,
  "score_oportunidad": number,
  "resumen_ejecutivo": "string (4–6 frases clave con datos concretos, en español)",
  "condiciones_ganadoras": [
    {
      "id": "COND-01",
      "descripcion": "string legible en español",
      "ventana": "T20|T15|T10|T5",
      "win_rate": number,
      "ciclos_muestra": number,
      "pnl_esperado_por_ciclo": number,
      "filtros": {
        "yes_price_max": number_or_null,
        "yes_price_min": number_or_null,
        "boost_min": number_or_null,
        "distancia_direccion": "UP|DOWN|AMBAS",
        "horas_utc": "string_or_null"
      },
      "confianza": "ALTA|MEDIA|BAJA",
      "robustez": "string breve (¿es sólido estadísticamente?)",
      "accion": "IMPLEMENTAR|MONITORIZAR|DESCARTAR"
    }
  ],
  "mejores_pares_intra_ciclo": [
    {
      "descripcion": "string legible",
      "par": "string (ej: T-20→T-5)",
      "comprar_en": number,
      "vender_en": number,
      "tasa_exito": number,
      "retorno_implicito_pct": number,
      "ciclos_muestra": number
    }
  ],
  "optimizaciones_algoritmo": [
    {
      "parametro": "string",
      "descripcion": "string",
      "valor_recomendado": "string",
      "impacto_esperado": "string",
      "prioridad": "CRÍTICA|ALTA|MEDIA|BAJA"
    }
  ],
  "alertas": [
    {
      "mensaje": "string",
      "severidad": "ALTA|MEDIA|BAJA"
    }
  ],
  "siguiente_accion": "string (la acción más prioritaria y concreta)"
}
`;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const simFilter = searchParams.get("simulated"); // "true" | "false" | null

  try {
    // ── 1. Cargar datos en paralelo ────────────────────────────────────────────
    let sessionParams =
      "?select=market_slug,fecha,hour_utc,simulado,resultado,direccion,pnl_usd,odds_entrada,real_exit_odds," +
      "yes_t20,yes_t15,yes_t10,yes_t5" +
      "&limit=1500&resultado=neq.PENDING";
    if (simFilter === "true")  sessionParams += "&simulado=eq.true";
    if (simFilter === "false") sessionParams += "&simulado=eq.false";

    let opsParams =
      "?select=market_slug,ventana,direccion,odds_entrada,distancia,resultado,pnl_usd,simulado," +
      "boost_t20,boost_t15,boost_t10,boost_t5" +
      "&resultado=neq.PENDING&limit=1500";
    if (simFilter === "true")  opsParams += "&simulado=eq.true";
    if (simFilter === "false") opsParams += "&simulado=eq.false";

    const [rawSessions, rawOps, rawCandles] = await Promise.all([
      sb("v_session_price_matrix", sessionParams).catch(() => []),
      sb("operations", opsParams),
      sb("btc_candle_data",
        "?select=fecha,hour_utc,open_price,close_price,high_price,low_price,volume_btc" +
        "&order=fecha.desc&order=hour_utc.desc&limit=24"
      ).catch(() => []),
    ]);

    // ── 2. Enriquecer sesiones con boost de operations ─────────────────────────
    const enriched = joinWithOps(rawSessions, rawOps);

    // ── 3. Análisis multivariable de combos ────────────────────────────────────
    const allCombos    = buildCombos(enriched);
    const perfectCombos    = allCombos.filter(c => c.is_perfect);
    const excellentCombos  = allCombos.filter(c => c.is_excellent && !c.is_perfect);

    // ── 4. Pares buy/sell intra-ciclo ─────────────────────────────────────────
    const pairScenarios = computePairScenarios(rawSessions);

    // ── 5. Resumen por ventana ─────────────────────────────────────────────────
    const windowSummary = ["T20", "T15", "T10", "T5"].map(w => {
      const wCombos = allCombos.filter(c => c.ventana === w);
      return {
        ventana:          w,
        combos_100pct:    wCombos.filter(c => c.is_perfect).length,
        combos_90pct:     wCombos.filter(c => c.is_excellent).length,
        total_combos:     wCombos.length,
        mejor_wr:         wCombos[0]?.win_rate ?? null,
        mejor_combo_vars: wCombos[0]?.vars     ?? null,
      };
    });

    // ── 6. Resumen de velas ────────────────────────────────────────────────────
    const candleSummary = rawCandles.slice(0, 12).map(c => ({
      h:         c.hour_utc,
      dir:       parseFloat(c.close_price) > parseFloat(c.open_price) ? "UP" : "DOWN",
      range_usd: c.high_price && c.low_price
        ? r2(parseFloat(c.high_price) - parseFloat(c.low_price))
        : null,
      vol_btc: c.volume_btc ? r2(parseFloat(c.volume_btc)) : null,
    }));

    // ── 7. Meta global ─────────────────────────────────────────────────────────
    const totalWins = enriched.filter(s => s.resultado === "WIN").length;
    const totalLoss = enriched.filter(s => ["LOSS","STOP"].includes(s.resultado)).length;
    const totalPnl  = enriched.reduce((s, r) => s + r.pnl_usd, 0);
    const meta = {
      totalCycles:    enriched.length,
      totalOps:       rawOps.length,
      globalWR:       pct(totalWins, totalWins + totalLoss),
      totalPnl:       r2(totalPnl),
      mode:           simFilter === "true" ? "SIMULADO" : simFilter === "false" ? "REAL" : "TODOS",
      perfect_count:  perfectCombos.length,
      excellent_count: excellentCombos.length,
    };

    // ── 8. Llamar a Claude ─────────────────────────────────────────────────────
    if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY no configurado");

    const prompt = buildPrompt({
      meta, perfectCombos, excellentCombos, windowSummary, pairScenarios, candleSummary,
    });

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 3500,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      throw new Error(`Claude API ${aiRes.status}: ${errTxt.slice(0, 300)}`);
    }

    const aiData  = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "";

    let analysis;
    try {
      const clean = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      analysis = JSON.parse(clean);
    } catch {
      analysis = {
        resumen_ejecutivo:            rawText.slice(0, 600),
        error_parse:                  true,
        condiciones_ganadoras:        [],
        mejores_pares_intra_ciclo:    [],
        optimizaciones_algoritmo:     [],
        alertas:                      [],
        score_oportunidad:            50,
      };
    }

    // ── 9. Responder ──────────────────────────────────────────────────────────
    return NextResponse.json({
      ok:     true,
      analysis,
      meta: {
        ...meta,
        generated_at:        new Date().toISOString(),
        simulated:           simFilter ?? "all",
        top_pair_scenarios:  pairScenarios.length,
        total_combos_found:  allCombos.length,
      },
      // Datos crudos de combos para que el cliente pueda explorarlos
      raw: {
        perfect_combos:   perfectCombos.slice(0, 50),
        excellent_combos: excellentCombos.slice(0, 50),
        pair_scenarios:   pairScenarios.slice(0, 20),
      },
    }, { headers: { "Cache-Control": "no-store" } });

  } catch (err) {
    console.error("[pair-analysis]", err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
