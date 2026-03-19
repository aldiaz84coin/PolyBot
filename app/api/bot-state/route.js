/**
 * app/api/bot-state/route.js — v2.0
 *
 * FIXES v2.0:
 *   1. PATH CORREGIDO — El archivo estaba en app/api/bot/bot-state/route.js,
 *      lo que generaba la URL /api/bot/bot-state. Tanto state_reporter.py como
 *      useBotState() llaman a /api/bot-state → 404 silencioso en ambos sentidos.
 *      Ahora el archivo vive en app/api/bot-state/route.js → URL correcta.
 *
 *   2. STORE → SUPABASE (bot_config) en lugar de globalThis.
 *      globalThis solo persiste dentro de una instancia serverless. Vercel puede
 *      despachar el GET a una instancia diferente a la que recibió el POST → el
 *      estado nunca llegaba al dashboard aunque el POST tuviese éxito.
 *      Ahora se usan claves prefijadas con "botstate_" en la tabla bot_config,
 *      que ya existe y es compartida entre todas las instancias y entre bot y dashboard.
 *
 * Bot   → POST /api/bot-state  { market, target, price, slug, direction, ... }
 * Front → GET  /api/bot-state  → { status, market, target, price, slug, stale, age_ms, ... }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSupabase } from "../../../lib/supabase";

const BOT_SECRET = process.env.BOT_SECRET ?? null;
const STALE_MS   = 90_000;   // 90s sin update → bot considerado caído

// ── Clave compuesta de almacenamiento ─────────────────────────────────────────
// Guardamos todo el estado en UNA sola fila JSON para minimizar lecturas/escrituras.
const STATE_KEY = "botstate_v2";

function checkAuth(req) {
  if (!BOT_SECRET) return true;
  const auth = req.headers.get("x-bot-secret") ?? req.headers.get("authorization");
  return auth === BOT_SECRET || auth === `Bearer ${BOT_SECRET}`;
}

// ── GET /api/bot-state ────────────────────────────────────────────────────────

export async function GET() {
  const sb = getSupabase();

  // Sin Supabase: devolver offline sin romper
  if (!sb) {
    return Response.json({
      status:    "offline",
      market:    null,
      target:    null,
      price:     null,
      slug:      null,
      stale:     true,
      age_ms:    null,
      ts_read:   Date.now(),
      _source:   "no-supabase",
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
        status:  "offline",
        market:  null,
        target:  null,
        price:   null,
        slug:    null,
        stale:   true,
        age_ms:  null,
        ts_read: Date.now(),
        _source: "empty",
      });
    }

    const stored  = JSON.parse(data.value);
    const ageMs   = stored.ts ? Date.now() - stored.ts : null;
    const stale   = ageMs === null || ageMs > STALE_MS;

    return Response.json({
      ...stored,
      age_ms:  ageMs,
      stale,
      ts_read: Date.now(),
      _source: "supabase",
    });

  } catch (e) {
    console.error("[bot-state GET]", e.message);
    return Response.json({
      status:  "offline",
      market:  null,
      target:  null,
      price:   null,
      slug:    null,
      stale:   true,
      age_ms:  null,
      ts_read: Date.now(),
      _error:  e.message,
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
    status:     body.status     ?? "running",
    market:     body.market     ?? null,
    target:     body.target     ?? null,
    price:      body.price      ?? null,
    slug:       body.slug       ?? body.market?.slug ?? null,
    direction:  body.direction  ?? null,
    window:     body.window     ?? null,
    ops_today:  body.ops_today  ?? null,
    bet_active: body.bet_active ?? null,
    last_seen:  new Date().toISOString(),
    ts:         Date.now(),
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
