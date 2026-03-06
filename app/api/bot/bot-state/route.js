// app/api/bot-state/route.js
// Endpoint de persistencia: el bot Python (Railway) hace POST aquí cada ciclo.
// El frontend lee de aquí como fuente autoritativa del mercado activo.
//
// Almacenamiento: globalThis (in-memory en Vercel, persiste entre requests
// en la misma instancia). Para persistencia total usar Vercel KV o Supabase.
//
// Seguridad: el bot debe enviar BOT_SECRET (variable de entorno compartida).
//
// Bot → POST /api/bot-state  { market, target, price, ... }
// Frontend → GET /api/bot-state

export const runtime = "nodejs"; // necesita globalThis persistente

// Inicializar store en globalThis para sobrevivir entre requests en la misma instancia
if (!globalThis._botState) {
  globalThis._botState = {
    market:    null,
    target:    null,
    price:     null,
    slug:      null,
    status:    "offline",
    last_seen: null,
    ts:        null,
  };
}

const BOT_SECRET = process.env.BOT_SECRET ?? null;

function checkAuth(req) {
  if (!BOT_SECRET) return true; // si no hay secret configurado, permitir todo
  const auth = req.headers.get("x-bot-secret") ?? req.headers.get("authorization");
  return auth === BOT_SECRET || auth === `Bearer ${BOT_SECRET}`;
}

export async function GET() {
  const state   = globalThis._botState;
  const ageMs   = state.ts ? Date.now() - state.ts : null;
  const stale   = ageMs !== null && ageMs > 90_000; // > 90s = bot posiblemente caído

  return Response.json({
    ...state,
    age_ms:  ageMs,
    stale,
    ts_read: Date.now(),
  });
}

export async function POST(req) {
  if (!checkAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    globalThis._botState = {
      market:    body.market    ?? null,
      target:    body.target    ?? null,
      price:     body.price     ?? null,
      slug:      body.slug      ?? body.market?.slug ?? null,
      status:    body.status    ?? "running",
      last_seen: new Date().toISOString(),
      ts:        Date.now(),
      // campos extra opcionales del bot
      direction:  body.direction  ?? null,
      window:     body.window     ?? null,
      ops_today:  body.ops_today  ?? null,
      bet_active: body.bet_active ?? null,
    };

    return Response.json({ ok: true, ts: globalThis._botState.ts });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
