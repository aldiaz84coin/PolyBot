// app/api/bets/route.js
// Endpoint para registrar y consultar historial de apuestas
// En producción reemplazar con DB (Vercel KV, Supabase, etc.)

// Almacenamiento en memoria para demo (se resetea con cada deploy)
const betsStore = [];

export async function GET() {
  return Response.json({
    bets: betsStore.slice(-100), // últimas 100
    count: betsStore.length,
    ts: Date.now(),
  });
}

export async function POST(req) {
  try {
    const bet = await req.json();
    bet.server_ts = Date.now();
    betsStore.push(bet);
    return Response.json({ ok: true, id: bet.id });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 400 });
  }
}

export async function PATCH(req) {
  try {
    const { id, result, pnl } = await req.json();
    const idx = betsStore.findIndex((b) => b.id === id);
    if (idx >= 0) {
      betsStore[idx] = { ...betsStore[idx], result, pnl, closed_ts: Date.now() };
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 400 });
  }
}
