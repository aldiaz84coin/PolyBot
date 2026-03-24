// app/api/ai-analysis/route.js
// Módulo 1 — Diagnóstico Inteligente PolyBot AI Analytics
// Carga todas las vistas analíticas de Supabase y genera diagnóstico con Claude
//
// GET /api/ai-analysis?simulated=true|false|all
//
// v1.0 — Diagnóstico por ventana, dirección, tendencia, alertas y recomendaciones

import { NextResponse } from "next/server";

export const runtime    = "nodejs";
export const maxDuration = 45;

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Helper Supabase ────────────────────────────────────────────────────────────

async function fetchView(view, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${view}${params}`, {
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${view}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

// ── Construye prompt para Claude ───────────────────────────────────────────────

function buildPrompt({ byWindow, byDirection, byDay, byHour, recentOps, meta }) {
  return `
Eres un analista cuantitativo especializado en prediction markets. Analiza el rendimiento de un bot de trading en Polymarket (mercados UP/DOWN de BTC en velas 1H).

CONTEXTO DEL SISTEMA:
- El bot detecta señales en 4 ventanas antes del cierre de cada vela 1H: T20 (20min antes), T15, T10, T5
- "Price to Beat" = precio de apertura de la vela 1H en Binance
- WIN si BTC supera (UP) o queda bajo (DOWN) ese precio al cierre de la vela
- Los odds son probabilidad implícita del mercado (0.0–1.0). Una estrategia es rentable si: win_rate > 1/(1+odds_entrada)
- El bot opera en modo SIMULADO (sin capital real) o REAL

RESUMEN GLOBAL:
- Total operaciones: ${meta.totalOps}
- P&L acumulado: $${meta.totalPnl}
- Win rate global: ${meta.globalWR}%
- Wins: ${meta.totalWins} | Losses: ${meta.totalLoss} | Pendientes: ${meta.totalPending}
- Modo analizado: ${meta.mode}

RENDIMIENTO POR VENTANA DE ENTRADA:
${JSON.stringify(byWindow, null, 2)}

RENDIMIENTO POR DIRECCIÓN (UP vs DOWN):
${JSON.stringify(byDirection, null, 2)}

P&L DIARIO (hasta 30 días recientes):
${JSON.stringify(byDay.slice(0, 30), null, 2)}

RENDIMIENTO POR HORA UTC DEL DÍA:
${JSON.stringify(byHour, null, 2)}

ÚLTIMAS 25 OPERACIONES (orden cronológico inverso):
${JSON.stringify(recentOps.slice(0, 25), null, 2)}

INSTRUCCIONES DE ANÁLISIS:
1. Evalúa si la estrategia es matemáticamente rentable a largo plazo (edge positivo)
2. Identifica qué ventanas y horas tienen mayor edge real
3. Detecta sesgos de dirección que podrían indicar sobreajuste o condición de mercado
4. Analiza la tendencia reciente vs histórico (¿hay degradación?)
5. Calcula si el win rate justifica los odds medios de entrada
6. Propón mejoras concretas y accionables

Responde ÚNICAMENTE con un JSON válido, sin markdown ni texto extra:
{
  "resumen": "diagnóstico ejecutivo en 2-3 frases claras en español",
  "estado": "ÓPTIMO|BUENO|NEUTRO|PRECAUCIÓN|CRÍTICO",
  "score": <número 0-100 que representa la salud global de la estrategia>,
  "ventanas": {
    "mejor": "T20|T15|T10|T5",
    "peor": "T20|T15|T10|T5",
    "ranking": ["T20","T15","T10","T5"],
    "analisis": "análisis de 2-3 frases sobre comportamiento por ventana"
  },
  "direccion": {
    "sesgo": "UP|DOWN|EQUILIBRADO",
    "confianza": "ALTA|MEDIA|BAJA",
    "analisis": "análisis de 1-2 frases sobre sesgo direccional y si es explotable"
  },
  "tendencia": {
    "direccion": "MEJORANDO|ESTABLE|DETERIORANDO",
    "analisis": "análisis de 1-2 frases sobre evolución temporal de los resultados"
  },
  "edge": {
    "tiene_edge": true|false,
    "explicacion": "explicación de si el win rate cubre los odds medios de entrada"
  },
  "alertas": [
    { "nivel": "ALTA|MEDIA|BAJA", "mensaje": "descripción de la alerta" }
  ],
  "oportunidades": [
    { "impacto": "ALTO|MEDIO|BAJO", "mensaje": "descripción de la oportunidad" }
  ],
  "recomendaciones": [
    { "prioridad": 1, "accion": "título corto", "detalle": "explicación con datos concretos" },
    { "prioridad": 2, "accion": "título corto", "detalle": "explicación con datos concretos" },
    { "prioridad": 3, "accion": "título corto", "detalle": "explicación con datos concretos" }
  ],
  "horas_optimas": [lista de números 0-23 con mejor rendimiento histórico],
  "horas_evitar": [lista de números 0-23 con peor rendimiento histórico],
  "proximos_pasos": "una frase concisa sobre la acción más importante a tomar ahora mismo"
}
`.trim();
}

// ── GET /api/ai-analysis ───────────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const simFilter = searchParams.get("simulated"); // "true" | "false" | null/omitted = todos

  // ── Validar configuración ──────────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json(
      { error: "Supabase no configurado — verifica SUPABASE_URL y SUPABASE_SERVICE_KEY" },
      { status: 503 }
    );
  }
  if (!ANTHROPIC_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY no configurada — añádela en Vercel → Settings → Environment Variables" },
      { status: 503 }
    );
  }

  try {
    // ── 1. Cargar todas las vistas analíticas en paralelo ──────────────────
    const [rawWindow, rawDirection, rawDay, rawHour, rawOps] = await Promise.all([
      fetchView("v_rendimiento_por_ventana",  "?select=*"),
      fetchView("v_rendimiento_por_direccion","?select=*"),
      fetchView("v_pnl_diario",               "?select=*&order=fecha.desc&limit=30"),
      fetchView("v_rendimiento_por_hora",     "?select=*"),
      fetchView("operations",
        "?select=ts_entrada,direccion,ventana,odds_entrada,odds_salida,pnl_usd,resultado,simulado,distancia,umbral" +
        "&order=ts_entrada.desc&limit=50"
      ),
    ]);

    // ── 2. Filtrar por modo simulado/real ──────────────────────────────────
    const boolFilter = (arr) => {
      if (simFilter === "true")  return arr.filter(r => r.simulado === true);
      if (simFilter === "false") return arr.filter(r => r.simulado === false);
      return arr;
    };

    const byWindow    = boolFilter(rawWindow);
    const byDirection = boolFilter(rawDirection);
    const byDay       = boolFilter(rawDay);
    const byHour      = boolFilter(rawHour);
    const recentOps   = simFilter
      ? rawOps.filter(r => simFilter === "true" ? r.simulado : !r.simulado)
      : rawOps;

    // ── 3. Calcular métricas globales ──────────────────────────────────────
    const totalOps     = byDay.reduce((s, d) => s + (d.ops     || 0), 0);
    const totalWins    = byDay.reduce((s, d) => s + (d.wins    || 0), 0);
    const totalLoss    = byDay.reduce((s, d) => s + (d.losses  || 0), 0);
    const totalPending = totalOps - totalWins - totalLoss;
    const totalPnl     = byDay.reduce((s, d) => s + (parseFloat(d.pnl_usd) || 0), 0);
    const globalWR     = (totalWins + totalLoss) > 0
      ? ((totalWins / (totalWins + totalLoss)) * 100).toFixed(1)
      : "N/A";

    const meta = {
      totalOps,
      totalWins,
      totalLoss,
      totalPending,
      totalPnl:  parseFloat(totalPnl.toFixed(2)),
      globalWR,
      mode: simFilter === "true" ? "SIMULADO" : simFilter === "false" ? "REAL" : "TODOS (simulado + real)",
    };

    // ── 4. Construir prompt y llamar a Claude ──────────────────────────────
    const prompt = buildPrompt({ byWindow, byDirection, byDay, byHour, recentOps, meta });

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 2500,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Claude API ${aiRes.status}: ${errText.slice(0, 300)}`);
    }

    const aiData  = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "";

    // ── 5. Parsear respuesta JSON ──────────────────────────────────────────
    let analysis;
    try {
      const clean = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      analysis = JSON.parse(clean);
    } catch {
      // Fallback si Claude no responde JSON puro
      analysis = {
        resumen:       rawText.slice(0, 500),
        estado:        "NEUTRO",
        score:         50,
        raw:           true,
        error_parse:   "La respuesta de IA no pudo parsearse como JSON",
      };
    }

    // ── 6. Responder ───────────────────────────────────────────────────────
    return NextResponse.json({
      ok:       true,
      analysis,
      meta: {
        ...meta,
        generated_at: new Date().toISOString(),
        simulated:    simFilter ?? "all",
      },
    });

  } catch (err) {
    console.error("[ai-analysis]", err.message);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
