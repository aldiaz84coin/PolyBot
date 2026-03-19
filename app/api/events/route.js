// app/api/events/route.js — v1.0
//
// Endpoint de eventos del bot: recibe los mismos mensajes que se envían
// por Telegram y los almacena en memoria para mostrarlos en el dashboard.
//
// Bot   → POST /api/events  { text: "<html>...</html>", ts: 1234567890 }
// Dashboard → GET /api/events → [ { id, text, ts }, ... ] (últimos 60)
//
// Seguridad: mismo BOT_SECRET que /api/bot-state.

export const runtime = "nodejs";

const MAX_EVENTS = 60;

if (!globalThis._botEvents) {
  globalThis._botEvents = [];
}

const BOT_SECRET = process.env.BOT_SECRET ?? null;

function checkAuth(req) {
  if (!BOT_SECRET) return true;
  const auth = req.headers.get("x-bot-secret") ?? req.headers.get("authorization");
  return auth === BOT_SECRET || auth === `Bearer ${BOT_SECRET}`;
}

/** Elimina tags HTML del texto de Telegram para mostrarlo limpio */
function stripHtml(html) {
  return html
    .replace(/<b>(.*?)<\/b>/gi,    "$1")
    .replace(/<i>(.*?)<\/i>/gi,    "$1")
    .replace(/<code>(.*?)<\/code>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export async function GET() {
  return Response.json({
    events: globalThis._botEvents,
    count:  globalThis._botEvents.length,
  });
}

export async function POST(req) {
  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const raw  = body.text ?? "";
    if (!raw) return Response.json({ ok: true, skipped: true });

    const event = {
      id:      Date.now() + Math.random(),
      text:    stripHtml(raw),   // texto limpio para el dashboard
      raw:     raw,              // HTML original (reservado)
      ts:      body.ts ?? Date.now(),
      ts_iso:  new Date(body.ts ?? Date.now()).toISOString(),
    };

    globalThis._botEvents.unshift(event);             // más reciente primero
    if (globalThis._botEvents.length > MAX_EVENTS) {
      globalThis._botEvents = globalThis._botEvents.slice(0, MAX_EVENTS);
    }

    return Response.json({ ok: true, id: event.id });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
