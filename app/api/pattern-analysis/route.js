// app/api/pattern-analisys/route.js
// Módulo 2 — Análisis estadístico de patrones de precio en ventanas
//
// Arquitectura: JS computa los patrones estadísticos, Claude interpreta.
// No se envían datos crudos a Claude — solo resúmenes ya calculados.
//
// GET /api/pattern-analisys?type=...&simulated=true|false&min_sessions=5
//
//   type=price_matrix   → transiciones de precio entre ventanas (pares condicionales)
//   type=entry_bands    → bandas de entrada óptimas por ventana (escenarios)
//   type=sl_patterns    → qué correlaciona con STOP/LOSS
//   type=ai_insight     → Claude interpreta todos los patrones
//
// v1.1 — FIX: SELECT expandido a las 8 ventanas (T-50,T-40,T-30,T-25,T-20,T-15,T-10,T-5)
//             Prompt AI actualizado para reflejar cobertura completa de ventanas.

import { NextResponse } from "next/server";

export const runtime     = "nodejs";
export const maxDuration = 45;

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const WINDOW_ORDER = ["T-50", "T-40", "T-30", "T-25", "T-20", "T-15", "T-10", "T-5"];

// ── Helper Supabase REST ───────────────────────────────────────────────────────

async function sb(table, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

// ── Utilidades estadísticas ────────────────────────────────────────────────────

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function round4(v) {
  return v != null ? Math.round(v * 10000) / 10000 : null;
}

function round2(v) {
  return v != null ? Math.round(v * 100) / 100 : null;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = Math.floor(sorted.length * p);
  return round4(sorted[Math.min(idx, sorted.length - 1)]);
}

function bucket(value, width = 0.05) {
  if (value == null) return null;
  const lo = Math.floor(value / width) * width;
  return `${lo.toFixed(2)}-${(lo + width).toFixed(2)}`;
}

// ── 1. PRICE MATRIX: transiciones de precio entre ventanas ────────────────────
//
// Para cada sesión donde tenemos datos en ≥2 ventanas, rastrea la evolución
// del precio YES. Calcula probabilidades condicionales:
//   "Si YES estaba en rango [0.40,0.50] en T-50 → ¿en qué rango está en T-5?"

async function getPriceMatrix(simFilter, minSessions) {
  // FIX v1.1: SELECT expandido para incluir las 8 ventanas completas
  let params =
    "?select=fecha,hour_utc,market_slug,simulado," +
    "yes_t50,yes_t40,yes_t30,yes_t25,yes_t20,yes_t15,yes_t10,yes_t5," +
    "max_yes_t50,max_yes_t40,max_yes_t30,max_yes_t25,max_yes_t20,max_yes_t15,max_yes_t10,max_yes_t5," +
    "min_yes_t50,min_yes_t40,min_yes_t30,min_yes_t25,min_yes_t20,min_yes_t15,min_yes_t10,min_yes_t5," +
    "resultado,direccion,odds_entrada,real_exit_odds,pnl_usd&limit=2000";
  if (simFilter === "true")  params += "&simulado=eq.true";
  if (simFilter === "false") params += "&simulado=eq.false";

  const rows = await sb("v_session_price_matrix", params);

  if (!rows.length) return { sessions: 0, pairs: [], bucket_stats: [] };

  // ── Pares condicionales: para cada par de ventanas (A→B) ──────────────────
  const pairs = [];

  const windowPairs = [
    ["yes_t50", "yes_t20", "T-50", "T-20"],
    ["yes_t50", "yes_t5",  "T-50", "T-5"],
    ["yes_t40", "yes_t20", "T-40", "T-20"],
    ["yes_t40", "yes_t5",  "T-40", "T-5"],
    ["yes_t30", "yes_t20", "T-30", "T-20"],
    ["yes_t30", "yes_t10", "T-30", "T-10"],
    ["yes_t30", "yes_t5",  "T-30", "T-5"],
    ["yes_t25", "yes_t20", "T-25", "T-20"],
    ["yes_t25", "yes_t10", "T-25", "T-10"],
    ["yes_t25", "yes_t5",  "T-25", "T-5"],
    ["yes_t20", "yes_t10", "T-20", "T-10"],
    ["yes_t20", "yes_t5",  "T-20", "T-5"],
    ["yes_t15", "yes_t5",  "T-15", "T-5"],
    ["yes_t10", "yes_t5",  "T-10", "T-5"],
  ];

  for (const [srcKey, dstKey, srcLabel, dstLabel] of windowPairs) {
    const valid = rows.filter(r => r[srcKey] != null && r[dstKey] != null);
    if (valid.length < minSessions) continue;

    const byBucket = {};
    for (const row of valid) {
      const b = bucket(parseFloat(row[srcKey]), 0.10);
      if (!byBucket[b]) byBucket[b] = [];
      byBucket[b].push(parseFloat(row[dstKey]));
    }

    for (const [srcBucket, dstPrices] of Object.entries(byBucket)) {
      if (dstPrices.length < minSessions) continue;

      const above85 = dstPrices.filter(p => p >= 0.85).length;
      const above70 = dstPrices.filter(p => p >= 0.70).length;
      const below30 = dstPrices.filter(p => p <= 0.30).length;
      const below15 = dstPrices.filter(p => p <= 0.15).length;

      pairs.push({
        from_window:  srcLabel,
        to_window:    dstLabel,
        entry_bucket: srcBucket,
        sessions:     dstPrices.length,
        dst_p10:      percentile(dstPrices, 0.10),
        dst_p50:      percentile(dstPrices, 0.50),
        dst_p90:      percentile(dstPrices, 0.90),
        dst_mean:     round4(dstPrices.reduce((a, b) => a + b, 0) / dstPrices.length),
        pct_above_85: pct(above85, dstPrices.length),
        pct_above_70: pct(above70, dstPrices.length),
        pct_below_30: pct(below30, dstPrices.length),
        pct_below_15: pct(below15, dstPrices.length),
      });
    }
  }

  pairs.sort((a, b) => {
    const wA = WINDOW_ORDER.indexOf(a.from_window);
    const wB = WINDOW_ORDER.indexOf(b.from_window);
    if (wA !== wB) return wA - wB;
    return a.entry_bucket.localeCompare(b.entry_bucket);
  });

  // ── Estadísticas de máximos alcanzados por ventana de entrada ──────────────
  const bucketStats = [];
  const entryWindows = [
    { srcKey: "yes_t50", maxKeys: ["max_yes_t40","max_yes_t30","max_yes_t25","max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"], label: "T-50" },
    { srcKey: "yes_t40", maxKeys: ["max_yes_t30","max_yes_t25","max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"], label: "T-40" },
    { srcKey: "yes_t30", maxKeys: ["max_yes_t25","max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"], label: "T-30" },
    { srcKey: "yes_t25", maxKeys: ["max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"], label: "T-25" },
    { srcKey: "yes_t20", maxKeys: ["max_yes_t15","max_yes_t10","max_yes_t5"], label: "T-20" },
    { srcKey: "yes_t15", maxKeys: ["max_yes_t10","max_yes_t5"],               label: "T-15" },
    { srcKey: "yes_t10", maxKeys: ["max_yes_t5"],                             label: "T-10" },
  ];

  for (const { srcKey, maxKeys, label } of entryWindows) {
    const valid = rows.filter(r => r[srcKey] != null && maxKeys.some(k => r[k] != null));
    if (valid.length < minSessions) continue;

    const byBucket = {};
    for (const row of valid) {
      const b = bucket(parseFloat(row[srcKey]), 0.10);
      if (!byBucket[b]) byBucket[b] = { rows: [], label };
      byBucket[b].rows.push(row);
    }

    for (const [srcBucket, { rows: bRows, label: wLabel }] of Object.entries(byBucket)) {
      if (bRows.length < minSessions) continue;

      const maxReached = bRows.map(r => {
        const vals = maxKeys.map(k => r[k]).filter(v => v != null).map(Number);
        return vals.length ? Math.max(...vals) : null;
      }).filter(v => v != null);

      if (!maxReached.length) continue;

      const above85 = maxReached.filter(p => p >= 0.85).length;
      const above70 = maxReached.filter(p => p >= 0.70).length;

      bucketStats.push({
        entry_window: wLabel,
        entry_bucket: srcBucket,
        sessions:     bRows.length,
        max_p25:      percentile(maxReached, 0.25),
        max_p50:      percentile(maxReached, 0.50),
        max_p75:      percentile(maxReached, 0.75),
        max_p90:      percentile(maxReached, 0.90),
        pct_ever_85:  pct(above85, maxReached.length),
        pct_ever_70:  pct(above70, maxReached.length),
      });
    }
  }

  return {
    sessions:     rows.length,
    pairs,
    bucket_stats: bucketStats,
  };
}

// ── 2. ENTRY BANDS: bandas óptimas de entrada/salida por ventana ──────────────

async function getEntryBands(simFilter, minSessions) {
  let params = "?select=ventana,direccion,odds_entrada,real_exit_odds,odds_salida,resultado,pnl_usd,pnl_pct,simulado&resultado=neq.PENDING&limit=2000";
  if (simFilter === "true")  params += "&simulado=eq.true";
  if (simFilter === "false") params += "&simulado=eq.false";

  const ops = await sb("operations", params);
  if (!ops.length) return { windows: [], scenarios: [], total_sessions_analyzed: 0 };

  const windows = {};

  for (const op of ops) {
    const w = op.ventana;
    if (!w) continue;
    if (!windows[w]) windows[w] = {};

    const entryOdds = parseFloat(op.odds_entrada);
    if (!entryOdds || isNaN(entryOdds)) continue;

    const b = bucket(entryOdds, 0.05);
    if (!windows[w][b]) windows[w][b] = { ops: [], wins: 0, losses: 0, stops: 0, pnl: [] };

    const result = windows[w][b];
    result.ops.push(op);
    result.pnl.push(parseFloat(op.pnl_usd) || 0);

    if (op.resultado === "WIN")  result.wins++;
    if (op.resultado === "LOSS") result.losses++;
    if (op.resultado === "STOP") result.stops++;
  }

  const formattedWindows = [];
  for (const [wKey, buckets] of Object.entries(windows)) {
    const bands = [];
    for (const [entryBucket, data] of Object.entries(buckets)) {
      const total = data.wins + data.losses + data.stops;
      if (total < minSessions) continue;

      const winRate       = pct(data.wins, total);
      const avgPnl        = round2(data.pnl.reduce((a, b) => a + b, 0) / data.pnl.length);
      const avgEntry      = round4(data.ops.map(o => parseFloat(o.odds_entrada)).reduce((a, b) => a + b, 0) / data.ops.length);
      const exitOps       = data.ops.filter(o => o.real_exit_odds);
      const avgExit       = exitOps.length
        ? round4(exitOps.map(o => parseFloat(o.real_exit_odds)).reduce((a, b) => a + b, 0) / exitOps.length)
        : null;
      const impliedReturn = avgEntry > 0 ? round2((1 / avgEntry - 1) * 100) : null;

      bands.push({
        entry_bucket:       entryBucket,
        sessions:           total,
        wins:               data.wins,
        losses:             data.losses,
        stops:              data.stops,
        win_rate:           winRate,
        avg_entry_odds:     avgEntry,
        avg_exit_odds:      avgExit,
        avg_pnl_usd:        avgPnl,
        implied_return_pct: impliedReturn,
        is_safe_band:       winRate != null && winRate >= 80,
        is_optimal_band:    winRate != null && winRate >= 60 && impliedReturn != null && impliedReturn >= 20,
      });
    }

    bands.sort((a, b) => a.entry_bucket.localeCompare(b.entry_bucket));

    formattedWindows.push({
      window:    wKey,
      total_ops: Object.values(buckets).reduce((s, d) => s + d.wins + d.losses + d.stops, 0),
      bands,
    });
  }

  formattedWindows.sort((a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window));

  // ── Escenarios buy/sell desde datos históricos ────────────────────────────
  // FIX v1.1: SELECT expandido a las 8 ventanas
  const scenarioParams =
    "?select=yes_t50,yes_t40,yes_t30,yes_t25,yes_t20,yes_t15,yes_t10,yes_t5," +
    "max_yes_t50,max_yes_t40,max_yes_t30,max_yes_t25,max_yes_t20,max_yes_t15,max_yes_t10,max_yes_t5," +
    "resultado&limit=1000";
  let sessionRows = [];
  try {
    sessionRows = await sb("v_session_price_matrix", scenarioParams);
  } catch (_) { /* no hay datos suficientes */ }

  const scenarios = [];
  const BUY_THRESHOLDS  = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
  const SELL_THRESHOLDS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99];

  const ALL_PRICE_KEYS = ["yes_t50","yes_t40","yes_t30","yes_t25","yes_t20","yes_t15","yes_t10","yes_t5"];
  const ALL_MAX_KEYS   = ["max_yes_t50","max_yes_t40","max_yes_t30","max_yes_t25","max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"];

  if (sessionRows.length >= minSessions) {
    for (const buyAt of BUY_THRESHOLDS) {
      for (const sellAt of SELL_THRESHOLDS) {
        if (sellAt <= buyAt + 0.10) continue;

        let couldBuy  = 0;
        let couldSell = 0;

        for (const row of sessionRows) {
          const maxVals = ALL_MAX_KEYS.map(k => row[k]).filter(v => v != null).map(Number);
          const minVals = ALL_PRICE_KEYS.map(k => row[k]).filter(v => v != null).map(Number);

          if (!maxVals.length || !minVals.length) continue;

          const minSeen = Math.min(...minVals);
          const maxSeen = Math.max(...maxVals);

          if (minSeen <= buyAt) {
            couldBuy++;
            if (maxSeen >= sellAt) couldSell++;
          }
        }

        if (couldBuy < minSessions) continue;
        const successRate = pct(couldSell, couldBuy);
        if (successRate == null || successRate < 80) continue;

        const impliedReturnPct = round2((sellAt / buyAt - 1) * 100);

        scenarios.push({
          buy_at:                  buyAt,
          sell_at:                 sellAt,
          sessions_eligible:       couldBuy,
          sessions_success:        couldSell,
          success_rate_pct:        successRate,
          implied_return_pct:      impliedReturnPct,
          is_high_confidence:      successRate >= 90,
          is_very_high_confidence: successRate >= 95,
        });
      }
    }

    scenarios.sort((a, b) => {
      if (b.success_rate_pct !== a.success_rate_pct) return b.success_rate_pct - a.success_rate_pct;
      return b.implied_return_pct - a.implied_return_pct;
    });
  }

  return {
    windows:                 formattedWindows,
    scenarios:               scenarios.slice(0, 30),
    total_sessions_analyzed: sessionRows.length,
  };
}

// ── 3. SL PATTERNS: correlatos de STOP / LOSS ─────────────────────────────────

async function getSlPatterns(simFilter, minSessions) {
  let slParams = "?select=*";
  if (simFilter === "true")  slParams += "&simulado=eq.true";
  if (simFilter === "false") slParams += "&simulado=eq.false";

  let slStats = [];
  try {
    slStats = await sb("v_sl_patterns", slParams);
  } catch (_) { /* vista puede no existir aún */ }

  let opsParams = "?select=ventana,direccion,odds_entrada,odds_salida,real_exit_odds,pnl_usd,pnl_pct,distancia,umbral,simulado&resultado=in.(STOP,LOSS)&limit=500";
  if (simFilter === "true")  opsParams += "&simulado=eq.true";
  if (simFilter === "false") opsParams += "&simulado=eq.false";

  const badOps = await sb("operations", opsParams);

  const byEntryBucket = {};
  for (const op of badOps) {
    const e = parseFloat(op.odds_entrada);
    if (!e || isNaN(e)) continue;
    const b = bucket(e, 0.05);
    if (!byEntryBucket[b]) byEntryBucket[b] = { count: 0, pnl: [], windows: {} };
    byEntryBucket[b].count++;
    byEntryBucket[b].pnl.push(parseFloat(op.pnl_usd) || 0);
    const w = op.ventana;
    if (w) byEntryBucket[b].windows[w] = (byEntryBucket[b].windows[w] || 0) + 1;
  }

  const entryRisks = Object.entries(byEntryBucket)
    .map(([b, data]) => ({
      entry_bucket: b,
      bad_ops:      data.count,
      avg_pnl:      round2(data.pnl.reduce((a, v) => a + v, 0) / data.pnl.length),
      worst_pnl:    round2(Math.min(...data.pnl)),
      top_window:   Object.entries(data.windows).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—",
    }))
    .filter(r => r.bad_ops >= 1)
    .sort((a, b) => b.bad_ops - a.bad_ops);

  const takeProfitSuggestions = [];
  for (const op of badOps.slice(0, 50)) {
    const entry = parseFloat(op.odds_entrada);
    if (!entry || isNaN(entry)) continue;
    const breakEven = round4(entry);
    const tp5       = round4(Math.min(entry * 1.05, 0.99));
    const tp10      = round4(Math.min(entry * 1.10, 0.99));
    takeProfitSuggestions.push({
      window:          op.ventana,
      entry_odds:      entry,
      break_even_sell: breakEven,
      tp_5pct:         tp5,
      tp_10pct:        tp10,
      actual_exit:     parseFloat(op.real_exit_odds) || parseFloat(op.odds_salida) || null,
      actual_pnl:      round2(parseFloat(op.pnl_usd)),
    });
  }

  return {
    sl_by_window:       slStats,
    entry_risk_buckets: entryRisks,
    takeprofit_cases:   takeProfitSuggestions.slice(0, 20),
    total_bad_ops:      badOps.length,
  };
}

// ── 4. AI INSIGHT: Claude interpreta todos los patrones ───────────────────────

async function getAiInsight(simFilter, minSessions) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY no configurada");

  const [matrix, bands, sl] = await Promise.all([
    getPriceMatrix(simFilter, minSessions),
    getEntryBands(simFilter, minSessions),
    getSlPatterns(simFilter, minSessions),
  ]);

  const topPairs     = (matrix?.pairs        ?? []).filter(p => p.sessions >= minSessions).slice(0, 30);
  const topBuckets   = (matrix?.bucket_stats ?? []).filter(b => b.sessions >= minSessions).slice(0, 20);
  const topScenarios = (bands?.scenarios     ?? []).filter(s => s.is_high_confidence).slice(0, 15);
  const safeBands    = (bands?.windows       ?? []).flatMap(w =>
    (w.bands ?? []).filter(b => b.is_safe_band || b.is_optimal_band).map(b => ({ ...b, window: w.window }))
  ).slice(0, 20);

  // FIX v1.1: contexto del prompt actualizado a las 8 ventanas
  const prompt = `
Eres un analista cuantitativo de prediction markets. Analiza los siguientes patrones estadísticos extraídos de datos históricos reales de un bot que opera en mercados BTC UP/DOWN de 1H en Polymarket.

CONTEXTO:
- Las ventanas cubren toda la vela 1H antes del cierre: T-50 (50min antes), T-40, T-30, T-25, T-20, T-15, T-10, T-5
- "odds" = precio del token YES en Polymarket (0.0 a 1.0). Token YES gana si BTC sube, NO si baja.
- Los datos incluyen el precio YES observado en cada ventana, el máximo alcanzado en ventanas posteriores, y el resultado final de las operaciones ejecutadas.

DATOS:
PARES CONDICIONALES (evolución de precio entre ventanas):
${JSON.stringify(topPairs, null, 2)}

ESTADÍSTICAS DE MÁXIMOS ALCANZADOS (por ventana de entrada):
${JSON.stringify(topBuckets, null, 2)}

BANDAS SEGURAS/ÓPTIMAS POR VENTANA (winRate ≥ 60-80%):
${JSON.stringify(safeBands, null, 2)}

ESCENARIOS BUY/SELL CON ALTA CONFIANZA (>90% de éxito histórico):
${JSON.stringify(topScenarios, null, 2)}

CORRELATOS DE STOP/LOSS:
${JSON.stringify(sl.entry_risk_buckets?.slice(0, 10), null, 2)}
SUGERENCIAS TAKEPROFIT (casos de pérdida analizados):
${JSON.stringify(sl.takeprofit_cases?.slice(0, 10), null, 2)}

TAREAS:
1. Identifica los 3-5 pares condicionales más fiables (>90% de veces)
2. Determina la banda de entrada más segura por ventana con precio de compra y venta óptimos
3. Analiza qué tienen en común las operaciones que acaban en pérdida/SL (precio de entrada, ventana, tendencia)
4. Propón reglas concretas de Take Profit y Stop Loss por ventana
5. Identifica la estrategia compra/venta más prometedora de los escenarios
6. Señala si las ventanas tempranas (T-50, T-40, T-30, T-25) aportan señales predictivas útiles respecto a las clásicas (T-20…T-5)

Responde SOLO con JSON válido, sin markdown:
{
  "patrones_fiables": [
    {
      "descripcion": "texto en español",
      "ventana_inicio": "T-50|T-40|T-30|T-25|T-20|T-15|T-10|T-5",
      "ventana_fin": "T-50|T-40|T-30|T-25|T-20|T-15|T-10|T-5",
      "condicion_entrada": "descripción del rango de precio",
      "comportamiento_esperado": "qué ocurre el X% de las veces",
      "confianza_pct": 90,
      "sesiones_base": 15
    }
  ],
  "bandas_optimas_por_ventana": {
    "T-50": { "compra_rango": "0.40-0.50", "venta_objetivo": 0.75, "win_rate_historico": 72, "nota": "..." },
    "T-40": { "compra_rango": "...", "venta_objetivo": 0.75, "win_rate_historico": 70, "nota": "..." },
    "T-30": { "compra_rango": "...", "venta_objetivo": 0.78, "win_rate_historico": 68, "nota": "..." },
    "T-25": { "compra_rango": "...", "venta_objetivo": 0.80, "win_rate_historico": 65, "nota": "..." },
    "T-20": { "compra_rango": "...", "venta_objetivo": 0.80, "win_rate_historico": 65, "nota": "..." },
    "T-15": { "compra_rango": "...", "venta_objetivo": 0.85, "win_rate_historico": 62, "nota": "..." },
    "T-10": { "compra_rango": "...", "venta_objetivo": 0.88, "win_rate_historico": 60, "nota": "..." },
    "T-5":  { "compra_rango": "...", "venta_objetivo": 0.92, "win_rate_historico": 55, "nota": "..." }
  },
  "reglas_takeprofit": [
    {
      "ventana": "T-50|T-40|T-30|T-25|T-20|T-15|T-10|T-5",
      "si_compra_en_rango": "0.40-0.50",
      "tp_recomendado": 0.75,
      "razon": "el precio llega a 0.75+ en el X% de sesiones con entrada en ese rango",
      "sl_sugerido": 0.35
    }
  ],
  "alertas_sl": [
    {
      "patron": "descripción de qué correlaciona con SL",
      "ventana_mas_afectada": "T-50|T-40|T-30|T-25|T-20|T-15|T-10|T-5",
      "precio_entrada_riesgo": "rango de precio donde más SL ocurren",
      "señal_de_alerta": "qué observar para salir antes del SL automático"
    }
  ],
  "mejor_escenario": {
    "descripcion": "el escenario compra/venta más prometedor basado en los datos",
    "compra_en": 0.45,
    "venta_en": 0.85,
    "success_rate_pct": 88,
    "retorno_implicito_pct": 88,
    "ventanas_donde_aplica": ["T-40", "T-30", "T-20", "T-15"],
    "advertencias": "limitaciones o condiciones necesarias"
  },
  "valor_ventanas_tempranas": {
    "son_utiles": true,
    "descripcion": "análisis de si T-50/T-40/T-30/T-25 aportan señal predictiva adicional útil",
    "recomendacion": "usar como filtro previo | usar como señal de entrada | ignorar por ruido"
  },
  "mejoras_correlacion_sugeridas": [
    "campo o métrica adicional que mejoraría el análisis futuro"
  ]
}
`.trim();

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 3000,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    throw new Error(`Claude API ${aiRes.status}: ${errText.slice(0, 300)}`);
  }

  const aiData  = await aiRes.json();
  const rawText = aiData.content?.[0]?.text ?? "";

  let insight;
  try {
    const clean = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    insight = JSON.parse(clean);
  } catch {
    insight = { raw: rawText, error_parse: "Respuesta no parseada como JSON" };
  }

  return {
    insight,
    stats: {
      sessions_analyzed:  matrix.sessions,
      pairs_computed:     matrix.pairs.length,
      scenarios_computed: bands.scenarios.length,
      bad_ops_analyzed:   sl.total_bad_ops,
      generated_at:       new Date().toISOString(),
    },
    raw: { matrix, bands, sl },
  };
}

// ── GET handler ────────────────────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const type        = searchParams.get("type") ?? "ai_insight";
  const simFilter   = searchParams.get("simulated");
  const minSessions = parseInt(searchParams.get("min_sessions") ?? "3", 10);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ error: "Supabase no configurado" }, { status: 503 });
  }

  try {
    let result;
    switch (type) {
      case "price_matrix":
        result = await getPriceMatrix(simFilter, minSessions);
        break;
      case "entry_bands":
        result = await getEntryBands(simFilter, minSessions);
        break;
      case "sl_patterns":
        result = await getSlPatterns(simFilter, minSessions);
        break;
      case "ai_insight":
        result = await getAiInsight(simFilter, minSessions);
        break;
      default:
        return NextResponse.json({ error: `type desconocido: ${type}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, type, ...result }, {
      headers: { "Cache-Control": "no-store" },
    });

  } catch (err) {
    console.error(`[pattern-analisys] type=${type}`, err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
