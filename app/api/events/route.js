// app/api/events/route.js — v2.0
//
// CAMBIOS v2.0:
//   - MIGRADO de globalThis (memoria volátil) a Supabase.
//   - En Vercel serverless cada request puede caer en una instancia distinta:
//     el bot hacía POST en instancia A y el dashboard leía instancia B (vacía).
//   - Ahora persiste en tabla `bot_events` de Supabase, igual que bets/bot-state.
//   - Fallback in-memory conservado para entornos sin Supabase.
//
// Requiere tabla en Supabase:
//   create table bot_events (
//     id         bigserial   primary key,
//     text       text        not null,
//     raw        text,
//     ts         bigint      not null,
//     ts_iso     timestamptz not null,
//     created_at timestamptz default now()
//   );
//   create index bot_events_ts_idx on bot_events (ts desc);
//
// Bot       → POST /api/events  { text: "<html>…</html>", ts: 1234567890 }
// Dashboard → GET  /api/events  → { events: [...], count: N }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSupabase } from "../../../lib/supabase";

const MAX_EVENTS = 60;
const BOT_SECRET = process.env.BOT_SECRET ?? null;

// ── Fallback in-memory (entornos sin Supabase) ────────────────────────────────
if (!globalThis._botEventsFallback) {
  globalThis._botEventsFallback = [];
}

function checkAuth(req) {
  if (!BOT_SECRET) return true;
  const auth = req.headers.get("x-bot-secret") ?? req.headers.get("authorization");
  return auth === BOT_SECRET || auth === `Bearer ${BOT_SECRET}`;
}

/** Elimina tags HTML del texto de Telegram para mostrarlo limpio */
function stripHtml(html) {
  return html
    .replace(/<b>(.*?)<\/b>/gi,      "$1")
    .replace(/<i>(.*?)<\/i>/gi,      "$1")
    .replace(/<code>(.*?)<\/code>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// ── GET /api/events ───────────────────────────────────────────────────────────

export async function GET() {
  const sb = getSupabase();

  if (sb) {
    try {
      const { data, error } = await sb
        .from("bot_events")
        .select("id, text, raw, ts, ts_iso, created_at")
        .order("ts", { ascending: false })
        .limit(MAX_EVENTS);

      if (error) throw error;

      // Normaliza el formato al que espera el dashboard
      const events = (data || []).map(row => ({
        id:     row.id,
        text:   row.text,
        raw:    row.raw ?? row.text,
        ts:     row.ts,
        ts_iso: row.ts_iso,
      }));

      return Response.json(
        { events, count: events.length, source: "supabase" },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (e) {
      console.error("[events/GET] Supabase error:", e.message);
      // cae al fallback
    }
  }

  // Fallback memoria
  return Response.json(
    {
      events: globalThis._botEventsFallback,
      count:  globalThis._botEventsFallback.length,
      source: "memory",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// ── POST /api/events ──────────────────────────────────────────────────────────

export async function POST(req) {
  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const raw  = body.text ?? "";
    if (!raw) return Response.json({ ok: true, skipped: true });

    const ts     = body.ts ?? Date.now();
    const ts_iso = new Date(ts).toISOString();
    const text   = stripHtml(raw);

    const sb = getSupabase();

    if (sb) {
      try {
        const { data, error } = await sb
          .from("bot_events")
          .insert({ text, raw, ts, ts_iso })
          .select("id")
          .single();

        if (error) throw error;

        // Limpieza: mantener solo los últimos MAX_EVENTS
        // (asíncrono, no bloqueante para el bot)
        sb.from("bot_events")
          .select("id", { count: "exact", head: true })
          .then(({ count }) => {
            if (count && count > MAX_EVENTS) {
              sb.from("bot_events")
                .select("id")
                .order("ts", { ascending: true })
                .limit(count - MAX_EVENTS)
                .then(({ data: old }) => {
                  if (old?.length) {
                    const ids = old.map(r => r.id);
                    sb.from("bot_events").delete().in("id", ids).then(() => {});
                  }
                });
            }
          });

        return Response.json({ ok: true, id: data.id, source: "supabase" });
      } catch (e) {
        console.error("[events/POST] Supabase error:", e.message);
        // cae al fallback
      }
    }

    // Fallback memoria
    const event = {
      id:     Date.now() + Math.random(),
      text,
      raw,
      ts,
      ts_iso,
    };
    globalThis._botEventsFallback.unshift(event);
    if (globalThis._botEventsFallback.length > MAX_EVENTS) {
      globalThis._botEventsFallback = globalThis._botEventsFallback.slice(0, MAX_EVENTS);
    }

    return Response.json({ ok: true, id: event.id, source: "memory" });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
