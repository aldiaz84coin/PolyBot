// app/api/market/debug/route.js
// Llama directamente a la Gamma API y devuelve la respuesta raw
// Útil para diagnosticar el formato exacto de los slugs
// Acceder en: /api/market/debug

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

async function fetchRaw(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { url, status: r.status, ok: r.ok, data: json, raw: text.slice(0, 500) };
  } catch (e) {
    return { url, error: e.message };
  }
}

export async function GET() {
  const now = new Date();
  const y   = now.getUTCFullYear();
  const mo  = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dy  = String(now.getUTCDate()).padStart(2, "0");
  const h   = String(now.getUTCHours()).padStart(2, "0");

  const results = await Promise.all([
    // Muestra mercados BTC activos con sus slugs REALES
    fetchRaw(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=10`),
    // Intenta el slug más probable
    fetchRaw(`${GAMMA}/markets?slug=will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`),
    // Busca por keyword
    fetchRaw(`${GAMMA}/markets?search=btc+higher+lower&active=true&limit=5`),
    // Lista eventos BTC
    fetchRaw(`${GAMMA}/events?tag=bitcoin&active=true&limit=5`),
  ]);

  // Extrae solo los slugs y preguntas de los mercados encontrados
  const btcMarkets = [];
  for (const r of results) {
    if (!r.data) continue;
    const list = Array.isArray(r.data) ? r.data : (r.data.markets ?? r.data.events ?? []);
    for (const m of list) {
      if (!m.slug && !m.question) continue;
      const q = (m.question || m.title || "").toLowerCase();
      if (q.includes("btc") || q.includes("bitcoin") || q.includes("higher") || q.includes("lower")) {
        btcMarkets.push({
          slug:     m.slug,
          question: m.question || m.title,
          endDate:  m.endDateIso || m.end_date_iso || m.endDate,
          active:   m.active,
          closed:   m.closed,
        });
      }
    }
  }

  return Response.json({
    timestamp_utc: now.toISOString(),
    current_hour_utc: `${h}:00`,
    btc_markets_found: btcMarkets,
    raw_responses: results.map(r => ({
      url: r.url,
      status: r.status,
      count: Array.isArray(r.data) ? r.data.length : (r.data?.markets?.length ?? r.data?.events?.length ?? 0),
    })),
  });
}
