/**
 * app/api/bot-state/route.js — v2.1
 *
 * CAMBIOS v2.1:
 *   - POST: añade simulate_mode al payload que se persiste en Supabase.
 *     Antes, el campo era ignorado aunque state_reporter.py lo enviara,
 *     porque la construcción del payload tenía una lista de campos hardcodeada.
 *     Ahora: simulate_mode: body.simulate_mode ?? null se guarda y el GET
 *     lo devuelve via { ...stored } → llega a useBotState() en el dashboard.
 *
 * CAMBIOS v2.0 (referencia):
 *   1. PATH CORREGIDO — app/api/bot-state/route.js (URL /api/bot-state)
 *   2. STORE → SUPABASE (bot_config) en lugar de globalThis.
 *
 * Bot   → POST /api/bot-state  { market, target, price, slug, simulate_mode, ... }
 * Front → GET  /api/bot-state  → { status, market, target, price, slug, simulate_mode, stale, age_ms, ... }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSupabase } from "../../../lib/supabase";

const BOT_SECRET = process.env.BOT_SECRET ?? null;
const STALE_MS   = 90_000;   // 90s sin update → bot considerado caído

const STATE_KEY = "botstate_v2";

function checkAuth(req) {
  if (!BOT_SECRET) return true;
  const auth = req.headers.get("x-bot-secret") ?? req.headers.get("authorization");
  return auth === BOT_SECRET || auth === `Bearer ${BOT_SECRET}`;
}

// ── GET /api/bot-state ────────────────────────────────────────────────────────

export async function GET() {
  const sb = getSupabase();

  if (!sb) {
    return Response.json({
      status:        "offline",
      market:        null,
      target:        null,
      price:         null,
      slug:          null,
      simulate_mode: null,
      stale:         true,
      age_ms:        null,
      ts_read:       Date.now(),
      _source:       "no-supabase",
    });
  }

  try {
    const { data, error } = await sb
      .from("bot_config")
      .select("value, updated_at")
      .eq("key", STATE_KEY)
      .maybeSingle();

    if (error || !data) {
      return Response.json({
        status:        "offline",
        market:        null,
        target:        null,
        price:         null,
        slug:          null,
        simulate_mode: null,
        stale:         true,
        age_ms:        null,
        ts_read:       Date.now(),
        _source:       "empty",
      });
    }

    const stored = JSON.parse(data.value);
    const ageMs  = stored.ts ? Date.now() - stored.ts : null;
    const stale  = ageMs === null || ageMs > STALE_MS;

    return Response.json({
      ...stored,           // incluye simulate_mode si está en el JSON guardado
      age_ms:  ageMs,
      stale,
      ts_read: Date.now(),
      _source: "supabase",
    });

  } catch (e) {
    console.error("[bot-state GET]", e.message);
    return Response.json({
      status:        "offline",
      market:        null,
      target:        null,
      price:         null,
      slug:          null,
      simulate_mode: null,
      stale:         true,
      age_ms:        null,
      ts_read:       Date.now(),
      _error:        e.message,
    });
  }
}

// ── POST /api/bot-state ───────────────────────────────────────────────────────

export async function POST(req) {
  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sb = getSupabase();
  if (!sb) {
    return Response.json({ error: "Supabase no disponible" }, { status: 503 });
  }

  const payload = {
    status:        body.status        ?? "running",
    market:        body.market        ?? null,
    target:        body.target        ?? null,
    price:         body.price         ?? null,
    slug:          body.slug          ?? body.market?.slug ?? null,
    direction:     body.direction     ?? null,
    window:        body.window        ?? null,
    ops_today:     body.ops_today     ?? null,
    bet_active:    body.bet_active    ?? null,
    simulate_mode: body.simulate_mode ?? null,   // v2.1 — modo activo en runtime
    last_seen:     new Date().toISOString(),
    ts:            Date.now(),
  };

  try {
    const { error } = await sb
      .from("bot_config")
      .upsert(
        { key: STATE_KEY, value: JSON.stringify(payload), updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );

    if (error) throw error;

    return Response.json({ ok: true, ts: payload.ts });

  } catch (e) {
    console.error("[bot-state POST]", e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
