/**
 * app/api/claim/route.js — v1.0
 *
 * GET /api/claim
 *   Consulta Supabase por operaciones WIN recientes (7 días, no simuladas)
 *   y enriquece cada una con el estado de resolución de Gamma API.
 *   No requiere bot activo — todo inline desde Vercel.
 *
 * POST /api/claim  { condition_id, direction, market_slug, tokens, stake, op_id }
 *   Encola un comando manual_claim en bot_commands.
 *   El bot lo procesa con su private key y devuelve tx_hash.
 *   El cliente hace polling con GET /api/commands?id=xxx.
 */

import { NextResponse } from "next/server";
import { getSupabase }  from "../../../lib/supabase";

export const dynamic = "force-dynamic";

const GAMMA_API    = "https://gamma-api.polymarket.com/markets";
const DAYS_LOOKBACK = 7;

// ── GET /api/claim ──────────────────────────────────────────────────────────

export async function GET() {
  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { ok: false, error: "Supabase no disponible" },
      { status: 503 }
    );
  }

  // 1. Leer WIN ops recientes no simuladas
  const since = new Date(Date.now() - DAYS_LOOKBACK * 86_400_000).toISOString();
  const { data: ops, error: opsErr } = await sb
    .from("operations")
    .select("id, ts_entrada, ts_cierre, direccion, market_slug, stake_usd, tokens_comprados, pnl_usd")
    .eq("resultado", "WIN")
    .eq("simulado", false)
    .gte("ts_entrada", since)
    .order("ts_entrada", { ascending: false })
    .limit(20);

  if (opsErr) {
    return NextResponse.json(
      { ok: false, error: `Supabase error: ${opsErr.message}` },
      { status: 500 }
    );
  }

  if (!ops || ops.length === 0) {
    return NextResponse.json({
      ok:      true,
      claims:  [],
      message: `No hay operaciones WIN en los últimos ${DAYS_LOOKBACK} días.`,
    });
  }

  // 2. Enriquecer con Gamma API — una consulta por slug único
  const slugsSeen = new Set();
  const gammaCache = {};

  const uniqueSlugs = [...new Set(ops.map(o => o.market_slug).filter(Boolean))];

  await Promise.allSettled(
    uniqueSlugs.map(async (slug) => {
      try {
        const res = await fetch(
          `${GAMMA_API}?slug=${encodeURIComponent(slug)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const mkt  = Array.isArray(data) ? data[0] : data;
        if (!mkt) return;

        gammaCache[slug] = {
          condition_id: mkt.conditionId || mkt.condition_id || null,
          resolved:     Boolean(mkt.resolved),
          closed:       Boolean(mkt.closed || mkt.active === false),
          outcome:      mkt.outcome || mkt.resolution || null,
          question:     (mkt.question || "").slice(0, 80),
          end_date:     mkt.endDate || null,
          // tokens para extraer token_id ganador
          clob_token_ids: (() => {
            try {
              const raw = mkt.clobTokenIds;
              return typeof raw === "string" ? JSON.parse(raw) : (raw || []);
            } catch { return []; }
          })(),
          tokens: mkt.tokens || [],
        };
      } catch (e) {
        gammaCache[slug] = { error: e.message };
      }
    })
  );

  // 3. Construir lista de claims
  const claims = ops.map((op) => {
    const gamma       = gammaCache[op.market_slug] || {};
    const condId      = gamma.condition_id || null;
    const direction   = op.direccion; // UP | DOWN

    // Obtener winning token_id: índice 0 = YES/UP, 1 = NO/DOWN
    let winning_token_id = null;
    if (gamma.clob_token_ids?.length >= 2) {
      winning_token_id = direction === "UP"
        ? gamma.clob_token_ids[0]
        : gamma.clob_token_ids[1];
    } else if (Array.isArray(gamma.tokens)) {
      const target = direction === "UP" ? "yes" : "no";
      const tok    = gamma.tokens.find(t => (t.outcome || "").toLowerCase() === target);
      winning_token_id = tok?.token_id || null;
    }

    return {
      op_id:            op.id,
      ts_entrada:       op.ts_entrada,
      ts_cierre:        op.ts_cierre,
      direction,
      market_slug:      op.market_slug,
      stake_usd:        op.stake_usd,
      tokens:           op.tokens_comprados,
      pnl_usd:          op.pnl_usd,
      // Gamma data
      condition_id:     condId,
      resolved:         gamma.resolved  ?? null,
      closed:           gamma.closed    ?? null,
      outcome:          gamma.outcome   ?? null,
      question:         gamma.question  ?? op.market_slug,
      end_date:         gamma.end_date  ?? null,
      winning_token_id,
      gamma_error:      gamma.error     ?? null,
      // Estado para la UI
      // Reclamable si: resolved=True  O  (closed=True + outcome conocido)
      // Gamma tarda en marcar resolved aunque el mercado ya esté cerrado con outcome
      claimable: Boolean(
        condId && (
          gamma.resolved ||
          (gamma.closed && Boolean((gamma.outcome || "").trim()))
        )
      ),
    };
  });

  return NextResponse.json({
    ok:          true,
    claims,
    queried_at:  new Date().toISOString(),
  });
}

// ── POST /api/claim ─────────────────────────────────────────────────────────

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body JSON inválido" },
      { status: 400 }
    );
  }

  const { condition_id, direction, market_slug, tokens, stake, op_id } = body;

  if (!condition_id || !direction) {
    return NextResponse.json(
      { ok: false, error: "Se requieren condition_id y direction" },
      { status: 400 }
    );
  }
  if (!["UP", "DOWN"].includes(direction)) {
    return NextResponse.json(
      { ok: false, error: "direction debe ser UP o DOWN" },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { ok: false, error: "Supabase no disponible" },
      { status: 503 }
    );
  }

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("bot_commands")
    .insert({
      command:    "manual_claim",
      params: {
        condition_id,
        direction,
        market_slug: market_slug || "—",
        tokens:      tokens      || 0,
        stake:       stake       || 0,
        op_id:       op_id       || null,
      },
      status:     "pending",
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json(
      { ok: false, error: `Error al encolar claim: ${error.message}` },
      { status: 500 }
    );
  }

  console.log(`[claim POST] manual_claim encolado → id=${data.id}  slug=${market_slug}  dir=${direction}`);

  return NextResponse.json({
    ok:          true,
    id:          data.id,
    command:     "manual_claim",
    status:      "pending",
    condition_id,
    direction,
    market_slug,
  });
}
