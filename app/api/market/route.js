// app/api/market/route.js
// Busca el mercado BTC Up/Down activo en Polymarket Gamma API

export const runtime = "edge";
export const revalidate = 0;

function buildSlug() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  // hora actual y siguiente
  const h = now.getUTCHours();
  const hStr = String(h).padStart(2, "0");
  const h1Str = String(h + 1).padStart(2, "0");
  return [
    `will-btc-be-higher-or-lower-${y}-${m}-${d}t${hStr}00-00-000z`,
    `will-btc-be-higher-or-lower-${y}-${m}-${d}t${h1Str}00-00-000z`,
  ];
}

export async function GET() {
  const slugs = buildSlug();
  const results = [];

  for (const slug of slugs) {
    try {
      const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.length > 0) {
        const market = data[0];
        results.push({
          slug,
          condition_id: market.conditionId || market.condition_id,
          question: market.question,
          end_date_iso: market.endDateIso || market.end_date_iso,
          tokens: market.tokens || [],
          active: true,
        });
      }
    } catch {
      // skip failed slugs
    }
  }

  if (results.length === 0) {
    return Response.json({ active: false, market: null, message: "No active BTC market found" });
  }

  // Retorna el más cercano al cierre
  const market = results[0];
  const endMs = market.end_date_iso ? new Date(market.end_date_iso).getTime() : null;
  const minsLeft = endMs ? (endMs - Date.now()) / 60000 : null;

  return Response.json({
    active: true,
    market,
    mins_to_close: minsLeft ? Math.max(0, minsLeft) : null,
    ts: Date.now(),
  });
}
