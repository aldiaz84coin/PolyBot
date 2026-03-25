// app/api/pattern-analysis/route.js
// Módulo 2 — Análisis estadístico de patrones de precio en ventanas
//
// Arquitectura: JS computa los patrones estadísticos, Claude interpreta.
// No se envían datos crudos a Claude — solo resúmenes ya calculados.
//
// GET /api/pattern-analysis?type=...&simulated=true|false&min_sessions=5
//
//   type=price_matrix   → transiciones de precio entre ventanas (pares condicionales)
//   type=entry_bands    → bandas de entrada óptimas por ventana (escenarios)
//   type=sl_patterns    → qué correlaciona con STOP/LOSS
//   type=ai_insight     → Claude interpreta todos los patrones
//
// v1.0

import { NextResponse } from "next/server";

export const runtime     = "nodejs";
export const maxDuration = 45;

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const WINDOW_ORDER = ["T-20", "T-15", "T-10", "T-5"];

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
  return Math.round((numerator / denominator) * 1000) / 10; // 1 decimal
}

function round4(v) {
  return v != null ? Math.round(v * 10000) / 10000 : null;
}

function round2(v) {
  return v != null ? Math.round(v * 100) / 100 : null;
}

// Calcula percentiles de un array numérico (p ∈ [0,1])
function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = Math.floor(sorted.length * p);
  return round4(sorted[Math.min(idx, sorted.length - 1)]);
}

// Bucketing: agrupa valores numéricos en buckets de ancho `width`
function bucket(value, width = 0.05) {
  if (value == null) return null;
  const lo = Math.floor(value / width) * width;
  return `${lo.toFixed(2)}-${(lo + width).toFixed(2)}`;
}

// ── 1. PRICE MATRIX: transiciones de precio entre ventanas ────────────────────
//
// Para cada sesión donde tenemos datos en ≥2 ventanas, rastrea la evolución
// del precio YES. Calcula probabilidades condicionales:
//   "Si YES estaba en rango [0.40,0.45] en T-20 → ¿en qué rango está en T-10?"

async function getPriceMatrix(simFilter, minSessions) {
  // Leer la vista de matriz de precios por sesión
  let params = "?select=fecha,hour_utc,market_slug,simulado,yes_t20,yes_t15,yes_t10,yes_t5,max_yes_t20,max_yes_t15,max_yes_t10,max_yes_t5,min_yes_t20,min_yes_t15,min_yes_t10,min_yes_t5,resultado,direccion,odds_entrada,real_exit_odds,pnl_usd&limit=2000";
  if (simFilter === "true")  params += "&simulado=eq.true";
  if (simFilter === "false") params += "&simulado=eq.false";

  const rows = await sb("v_session_price_matrix", params);

  if (!rows.length) return { sessions: 0, pairs: [], buckets: [] };

  // ── Pares condicionales: para cada par de ventanas (A→B), ──────────────────
  // agrupar sesiones por bucket de precio en ventana A y ver distribución en B
  const pairs = [];

  const windowPairs = [
    ["yes_t20", "yes_t10", "T-20", "T-10"],
    ["yes_t20", "yes_t5",  "T-20", "T-5"],
    ["yes_t15", "yes_t5",  "T-15", "T-5"],
    ["yes_t10", "yes_t5",  "T-10", "T-5"],
  ];

  for (const [srcKey, dstKey, srcLabel, dstLabel] of windowPairs) {
    const valid = rows.filter(r => r[srcKey] != null && r[dstKey] != null);
    if (valid.length < minSessions) continue;

    // Agrupar por bucket de precio en ventana origen
    const byBucket = {};
    for (const row of valid) {
      const b = bucket(parseFloat(row[srcKey]), 0.10); // buckets de 0.10
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
        from_window:   srcLabel,
        to_window:     dstLabel,
        entry_bucket:  srcBucket,
        sessions:      dstPrices.length,
        dst_p10:       percentile(dstPrices, 0.10),
        dst_p50:       percentile(dstPrices, 0.50),
        dst_p90:       percentile(dstPrices, 0.90),
        dst_mean:      round4(dstPrices.reduce((a, b) => a + b, 0) / dstPrices.length),
        pct_above_85:  pct(above85, dstPrices.length), // % llegó a zona WIN
        pct_above_70:  pct(above70, dstPrices.length), // % llegó a zona rentable
        pct_below_30:  pct(below30, dstPrices.length), // % entró en zona de riesgo
        pct_below_15:  pct(below15, dstPrices.length), // % zona SL crítica
      });
    }
  }

  // Ordenar por par de ventanas y bucket
  pairs.sort((a, b) => {
    const wA = WINDOW_ORDER.indexOf(a.from_window);
    const wB = WINDOW_ORDER.indexOf(b.from_window);
    if (wA !== wB) return wA - wB;
    return a.entry_bucket.localeCompare(b.entry_bucket);
  });

  // ── Estadísticas de máximos alcanzados por ventana de entrada ──────────────
  // "Compré en T-20 con YES=0.45, ¿a qué máximo llegó en algún momento posterior?"
  const bucketStats = [];
  const entryWindows = [
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

      // Máximo precio YES alcanzado en ventanas posteriores (mejor escenario de venta)
      const maxReached = bRows.map(r => {
        const vals = maxKeys.map(k => r[k]).filter(v => v != null).map(Number);
        return vals.length ? Math.max(...vals) : null;
      }).filter(v => v != null);

      if (!maxReached.length) continue;

      bucketStats.push({
        entry_window:  wLabel,
        entry_bucket:  srcBucket,
        sessions:      bRows.length,
        max_p25:       percentile(maxReached, 0.25),
        max_p50:       percentile(maxReached, 0.50),
        max_p75:       percentile(maxReached, 0.75),
        max_p90:       percentile(maxReached, 0.90),
        // ¿Qué % de sesiones alguna vez superaron el 85%? (zona de cobro)
        pct_ever_above_85:  pct(maxReached.filter(v => v >= 0.85).length, maxReached.length),
        pct_ever_above_70:  pct(maxReached.filter(v => v >= 0.70).length, maxReached.length),
        pct_ever_above_60:  pct(maxReached.filter(v => v >= 0.60).length, maxReached.length),
        avg_entry:     round4(bRows.map(r => r[srcKey]).reduce((a, b) => a + parseFloat(b), 0) / bRows.length),
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
//
// Para cada ventana, calcula win_rate y retorno esperado según el precio de entrada.
// Encuentra las bandas donde win_rate > umbral (95% por defecto).

async function getEntryBands(simFilter, minSessions) {
  // Datos: operaciones con odds de entrada y resultado
  let params = "?select=ventana,direccion,odds_entrada,real_exit_odds,odds_salida,resultado,pnl_usd,pnl_pct,simulado&resultado=neq.PENDING&limit=2000";
  if (simFilter === "true")  params += "&simulado=eq.true";
  if (simFilter === "false") params += "&simulado=eq.false";

  const ops = await sb("operations", params);
  if (!ops.length) return { windows: [] };

  const windows = {};

  for (const op of ops) {
    const w = op.ventana;
    if (!w) continue;
    if (!windows[w]) windows[w] = {};

    const entryOdds = parseFloat(op.odds_entrada);
    if (!entryOdds || isNaN(entryOdds)) continue;

    // Bucket de entrada: cada 0.05
    const b = bucket(entryOdds, 0.05);
    if (!windows[w][b]) windows[w][b] = { ops: [], wins: 0, losses: 0, stops: 0, pnl: [] };

    const result = windows[w][b];
    result.ops.push(op);
    result.pnl.push(parseFloat(op.pnl_usd) || 0);

    if (op.resultado === "WIN")  result.wins++;
    if (op.resultado === "LOSS") result.losses++;
    if (op.resultado === "STOP") result.stops++;
  }

  // Formatear resultado por ventana
  const formattedWindows = [];
  for (const [wKey, buckets] of Object.entries(windows)) {
    const bands = [];
    for (const [entryBucket, data] of Object.entries(buckets)) {
      const total = data.wins + data.losses + data.stops;
      if (total < minSessions) continue;

      const winRate      = pct(data.wins, total);
      const avgPnl       = round2(data.pnl.reduce((a, b) => a + b, 0) / data.pnl.length);
      const avgEntry     = round4(data.ops.map(o => parseFloat(o.odds_entrada)).reduce((a, b) => a + b, 0) / data.ops.length);
      const avgExit      = round4(data.ops.filter(o => o.real_exit_odds).map(o => parseFloat(o.real_exit_odds)).reduce((a, b) => a + b, 0) / (data.ops.filter(o => o.real_exit_odds).length || 1));
      // Retorno implícito: si gana, cobra ~1/entry en tokens → retorno = (1/entry - 1)*100
      const impliedReturn = avgEntry > 0 ? round2((1 / avgEntry - 1) * 100) : null;

      bands.push({
        entry_bucket:     entryBucket,
        sessions:         total,
        wins:             data.wins,
        losses:           data.losses,
        stops:            data.stops,
        win_rate:         winRate,
        avg_entry_odds:   avgEntry,
        avg_exit_odds:    avgExit,
        avg_pnl_usd:      avgPnl,
        implied_return_pct: impliedReturn,
        // Marcar banda como "segura" si winRate ≥ 80%
        is_safe_band:     winRate != null && winRate >= 80,
        is_optimal_band:  winRate != null && winRate >= 60 && impliedReturn != null && impliedReturn >= 20,
      });
    }

    bands.sort((a, b) => a.entry_bucket.localeCompare(b.entry_bucket));

    formattedWindows.push({
      window:     wKey,
      total_ops:  Object.values(buckets).reduce((s, d) => s + d.wins + d.losses + d.stops, 0),
      bands,
    });
  }

  formattedWindows.sort((a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window));

  // ── Escenarios buy/sell simulados desde datos históricos ─────────────────
  // Para sesiones con datos de precio en ventanas, calcula:
  // "Si compré a precio X, ¿a qué precio de venta habría obtenido beneficio en >90% de sesiones?"
  const scenarioParams = "?select=yes_t20,yes_t15,yes_t10,yes_t5,max_yes_t20,max_yes_t15,max_yes_t10,max_yes_t5,resultado&limit=1000";
  let sessionRows = [];
  try {
    sessionRows = await sb("v_session_price_matrix", scenarioParams);
  } catch (_) { /* no hay datos suficientes */ }

  const scenarios = [];
  const BUY_THRESHOLDS  = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
  const SELL_THRESHOLDS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99];

  if (sessionRows.length >= minSessions) {
    for (const buyAt of BUY_THRESHOLDS) {
      for (const sellAt of SELL_THRESHOLDS) {
        if (sellAt <= buyAt + 0.10) continue; // margen mínimo del 10%

        // Sesiones donde el precio estuvo alguna vez por debajo de buyAt (podría comprar)
        // Y luego llegó a sellAt (podría vender con beneficio)
        let couldBuy  = 0;
        let couldSell = 0;

        for (const row of sessionRows) {
          const maxVals = ["max_yes_t20","max_yes_t15","max_yes_t10","max_yes_t5"]
            .map(k => row[k]).filter(v => v != null).map(Number);
          const minVals = ["yes_t20","yes_t15","yes_t10","yes_t5"]
            .map(k => row[k]).filter(v => v != null).map(Number);

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
          buy_at:           buyAt,
          sell_at:          sellAt,
          sessions_eligible: couldBuy,
          sessions_success:  couldSell,
          success_rate_pct:  successRate,
          implied_return_pct: impliedReturnPct,
          is_high_confidence: successRate >= 90,
          is_very_high_confidence: successRate >= 95,
        });
      }
    }

    // Ordenar por rentabilidad entre los de alta confianza
    scenarios.sort((a, b) => {
      if (b.success_rate_pct !== a.success_rate_pct) return b.success_rate_pct - a.success_rate_pct;
      return b.implied_return_pct - a.implied_return_pct;
    });
  }

  return {
    windows:   formattedWindows,
    scenarios: scenarios.slice(0, 30),  // top 30
    total_sessions_analyzed: sessionRows.length,
  };
}

// ── 3. SL PATTERNS: correlatos de STOP / LOSS ─────────────────────────────────

async function getSlPatterns(simFilter, minSessions) {
  // Vista preagregada de SL
  let slParams = "?select=*";
  if (simFilter === "true")  slParams += "&simulado=eq.true";
  if (simFilter === "false") slParams += "&simulado=eq.false";

  let slStats = [];
  try {
    slStats = await sb("v_sl_patterns", slParams);
  } catch (_) { /* vista puede no existir aún */ }

  // Operaciones detalladas con resultado STOP o LOSS
  let opsParams = "?select=ventana,direccion,odds_entrada,odds_salida,real_exit_odds,pnl_usd,pnl_pct,distancia,umbral,simulado&in.resultado=(STOP,LOSS)&limit=500";
  if (simFilter === "true")  opsParams += "&simulado=eq.true";
  if (simFilter === "false") opsParams += "&simulado=eq.false";

  const badOps = await sb("operations", opsParams);

  // ¿A qué odds de entrada se dieron más pérdidas?
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
      entry_bucket:  b,
      bad_ops:       data.count,
      avg_pnl:       round2(data.pnl.reduce((a, v) => a + v, 0) / data.pnl.length),
      worst_pnl:     round2(Math.min(...data.pnl)),
      top_window:    Object.entries(data.windows).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—",
    }))
    .filter(r => r.bad_ops >= 1)
    .sort((a, b) => b.bad_ops - a.bad_ops);

  // Takeprofit sugerido: dado un precio de entrada, ¿a qué precio de venta
  // se habría evitado pérdida en la mayoría de casos?
  //
  // Lógica: si la operación habría valido ≥ stake al vender (sin pérdida),
  // el precio de venta mínimo es: sell ≥ entry (break-even exacto)
  // Para asegurar +5% de retorno: sell ≥ entry * 1.05
  const takeProfitSuggestions = [];
  for (const op of badOps.slice(0, 50)) {
    const entry = parseFloat(op.odds_entrada);
    if (!entry || isNaN(entry)) continue;
    const breakEven = round4(entry);            // vender ≥ entry → no pierde
    const tp5       = round4(Math.min(entry * 1.05, 0.99));  // +5% retorno
    const tp10      = round4(Math.min(entry * 1.10, 0.99));  // +10% retorno
    takeProfitSuggestions.push({
      window:           op.ventana,
      entry_odds:       entry,
      break_even_sell:  breakEven,
      tp_5pct:          tp5,
      tp_10pct:         tp10,
      actual_exit:      parseFloat(op.real_exit_odds) || parseFloat(op.odds_salida) || null,
      actual_pnl:       round2(parseFloat(op.pnl_usd)),
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

  // Cargar los tres análisis en paralelo
  const [matrix, bands, sl] = await Promise.all([
    getPriceMatrix(simFilter, minSessions),
    getEntryBands(simFilter, minSessions),
    getSlPatterns(simFilter, minSessions),
  ]);

  // Solo los patrones más informativos para el prompt (limitar tokens)
  const topPairs    = matrix.pairs.filter(p => p.sessions >= minSessions).slice(0, 30);
  const topBuckets  = matrix.bucket_stats.filter(b => b.sessions >= minSessions).slice(0, 20);
  const topScenarios = bands.scenarios.filter(s => s.is_high_confidence).slice(0, 15);
  const safeBands   = bands.windows.flatMap(w =>
    w.bands.filter(b => b.is_safe_band || b.is_optimal_band).map(b => ({ ...b, window: w.window }))
  ).slice(0, 20);

  const prompt = `
Eres un analista cuantitativo de prediction markets. Analiza los siguientes patrones estadísticos extraídos de datos históricos reales de un bot que opera en mercados BTC UP/DOWN de 1H en Polymarket.

CONTEXTO:
- Las ventanas son periodos antes del cierre de la vela 1H: T-20 (20min antes), T-15, T-10, T-5
- "odds" = precio del token en Polymarket (0.0 a 1.0). Token YES gana si BTC sube, NO si baja.
- Un token comprado a 0.45 y resuelto ganador paga ~0.99 → retorno de +120%
- Stop Loss se activa si el token cae un % definido respecto al precio de entrada
- Sesiones analizadas: ${matrix.sessions} | Operaciones con pérdida/SL: ${sl.total_bad_ops}

═══ BLOQUE 1: PARES CONDICIONALES (transición de precio entre ventanas) ═══
${JSON.stringify(topPairs, null, 1)}

═══ BLOQUE 2: MÁXIMOS ALCANZADOS EN VENTANAS POSTERIORES (escenarios de venta) ═══
${JSON.stringify(topBuckets, null, 1)}

═══ BLOQUE 3: BANDAS DE ENTRADA SEGURAS Y ÓPTIMAS (por historial de win_rate) ═══
${JSON.stringify(safeBands, null, 1)}

═══ BLOQUE 4: ESCENARIOS COMPRA→VENTA CON ALTA PROBABILIDAD ═══
(buy_at: precio de compra simulado, sell_at: objetivo de venta, success_rate: % de sesiones donde el precio llegó a ese nivel)
${JSON.stringify(topScenarios, null, 1)}

═══ BLOQUE 5: PATRONES EN OPERACIONES CON PÉRDIDA / STOP ═══
${JSON.stringify(sl.entry_risk_buckets.slice(0, 10), null, 1)}

INSTRUCCIONES:
Basándote EXCLUSIVAMENTE en los datos estadísticos anteriores (no en suposiciones generales de mercado):

1. Identifica los 3-5 pares condicionales más fiables (siempre o >90% de veces)
2. Determina la banda de entrada más segura por ventana, con ejemplo concreto de precio de compra y venta óptimos
3. Analiza qué tienen en común las operaciones que acaban en pérdida/SL (precio de entrada, ventana, tendencia)
4. Propón reglas concretas de Take Profit y Stop Loss por ventana basadas en los datos
5. Identifica la estrategia de compra/venta más prometedora de los escenarios

Responde SOLO con JSON válido, sin markdown:
{
  "patrones_fiables": [
    {
      "descripcion": "texto en español",
      "ventana_inicio": "T-20|T-15|T-10|T-5",
      "ventana_fin": "T-20|T-15|T-10|T-5",
      "condicion_entrada": "descripción del rango de precio",
      "comportamiento_esperado": "qué ocurre el X% de las veces",
      "confianza_pct": 90,
      "sesiones_base": 15
    }
  ],
  "bandas_optimas_por_ventana": {
    "T-20": { "compra_rango": "0.40-0.50", "venta_objetivo": 0.75, "win_rate_historico": 72, "nota": "..." },
    "T-15": { "compra_rango": "...", "venta_objetivo": 0.80, "win_rate_historico": 65, "nota": "..." },
    "T-10": { "compra_rango": "...", "venta_objetivo": 0.85, "win_rate_historico": 60, "nota": "..." },
    "T-5":  { "compra_rango": "...", "venta_objetivo": 0.90, "win_rate_historico": 55, "nota": "..." }
  },
  "reglas_takeprofit": [
    {
      "ventana": "T-20|T-15|T-10|T-5",
      "si_compra_en_rango": "0.40-0.50",
      "tp_recomendado": 0.75,
      "razon": "el precio llega a 0.75+ en el X% de sesiones con entrada en ese rango",
      "sl_sugerido": 0.35
    }
  ],
  "alertas_sl": [
    {
      "patron": "descripción de qué correlaciona con SL",
      "ventana_mas_afectada": "T-20|T-15|T-10|T-5",
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
    "ventanas_donde_aplica": ["T-20", "T-15"],
    "advertencias": "limitaciones o condiciones necesarias"
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
      model:      "claude-3-5-sonnet-20241022",
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
      sessions_analyzed:    matrix.sessions,
      pairs_computed:       matrix.pairs.length,
      scenarios_computed:   bands.scenarios.length,
      bad_ops_analyzed:     sl.total_bad_ops,
      generated_at:         new Date().toISOString(),
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
    console.error(`[pattern-analysis] type=${type}`, err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
