// app/api/market/debug/route.js
// Diagnóstico: muestra qué devuelve realmente la Gamma API de Polymarket
// Acceder en: /api/market/debug

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();
    return { url, status: r.status, data };
  } catch (e) {
    return { url, error: e.message };
  }
}

export async function GET() {
  const now = new Date();

  // Hora de cierre = próxima hora en punto UTC
  const closing = new Date(now);
  closing.setUTCMinutes(0, 0, 0);
  closing.setUTCHours(closing.getUTCHours() + 1);

  const y  = closing.getUTCFullYear();
  const mo = String(closing.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(closing.getUTCDate()).padStart(2, "0");
  const h  = String(closing.getUTCHours()).padStart(2, "0");

  // Consultas en paralelo
  const [tagResult, activeResult, slugResult] = await Promise.all([
    tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=20`),
    tryFetch(`${GAMMA}/markets?active=true&closed=false&limit=30&order=endDate&ascending=true`),
    tryFetch(`${GAMMA}/markets?slug=will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`),
  ]);

  // Extrae todos los mercados BTC con tiempo restante
  const allBTC = [];
  for (const r of [tagResult, activeResult]) {
    if (!r.data) continue;
    const list = Array.isArray(r.data) ? r.data : (r.data?.markets ?? []);
    for (const m of list) {
      const q = (m.question || m.title || "").toLowerCase();
      if (!q.includes("btc") && !q.includes("bitcoin")) continue;
      const endIso   = m.endDateIso || m.end_date_iso || m.endDate;
      const minsLeft = endIso ? (new Date(endIso).getTime() - now.getTime()) / 60000 : null;
      if (allBTC.find(x => x.slug === m.slug)) continue; // deduplica
      allBTC.push({
        slug:          m.slug,
        question:      m.question || m.title,
        end_utc:       endIso,
        mins_to_close: minsLeft?.toFixed(1),
        active:        m.active,
        closed:        m.closed,
        tokens:        (m.tokens||[]).map(t => ({ outcome: t.outcome, price: t.price })),
      });
    }
  }

  // Ordena por tiempo restante
  allBTC.sort((a, b) => parseFloat(a.mins_to_close ?? 999) - parseFloat(b.mins_to_close ?? 999));

  return Response.json({
    now_utc:         now.toISOString(),
    closing_utc:     closing.toISOString(),
    mins_to_closing: ((closing.getTime() - now.getTime()) / 60000).toFixed(1),
    slug_we_need:    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
    slug_exact_result: {
      status: slugResult.status,
      found:  Array.isArray(slugResult.data) && slugResult.data.length > 0,
      data:   slugResult.data,
    },
    btc_markets_found: allBTC,
    hourly_candidate:  allBTC.find(m =>
      parseFloat(m.mins_to_close) > 0 && parseFloat(m.mins_to_close) <= 62 &&
      ((m.question||"").toLowerCase().includes("higher") ||
       (m.question||"").toLowerCase().includes("lower") ||
       (m.question||"").toLowerCase().includes("up") ||
       (m.question||"").toLowerCase().includes("down"))
    ) ?? null,
  });
}
