// app/api/market/debug/route.js
// Diagnóstico: muestra qué devuelve la Gamma API y los slugs ET generados
// Acceder en: /api/market/debug

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december"
];

function isDST(utcDate) {
  const year = utcDate.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));
  const nov = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7));
  return utcDate >= dstStart && utcDate < dstEnd;
}

function toET(utcDate) {
  const offset = isDST(utcDate) ? -4 : -5;
  return new Date(utcDate.getTime() + offset * 3600 * 1000);
}

function formatHour12(h24) {
  if (h24 === 0)  return "12am";
  if (h24 === 12) return "12pm";
  return h24 < 12 ? `${h24}am` : `${h24 - 12}pm`;
}

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
  const now   = new Date();
  const etNow = toET(now);

  /**
   * FIX: Polymarket usa la hora de CIERRE de la vela 1H (ET) en el slug,
   * NO la hora de apertura.
   *
   * Ejemplo a las 10:30 UTC (5:30am ET, vela activa 5am–6am ET):
   *   · Candle open  UTC: 10:00  → ET: 5am
   *   · Candle close UTC: 11:00  → ET: 6am
   *   · Slug correcto: "bitcoin-up-or-down-march-6-6am-et"  ← hora CIERRE
   *   · Bug anterior: "bitcoin-up-or-down-march-6-5am-et"  ← hora apertura ❌
   *
   * Para obtener la hora de cierre: añadir 1h a la hora de apertura UTC,
   * luego convertir ESA hora a ET.
   */
  const slugs = [];
  for (const offset of [-1, 0, 1]) {
    // Hora de apertura de la vela (offset desde ahora)
    const candleOpenUtc  = new Date(now.getTime() + offset * 3600 * 1000);
    // Hora de CIERRE = apertura + 1h → esto es lo que aparece en el slug
    const candleCloseUtc = new Date(candleOpenUtc.getTime() + 3600 * 1000);
    const etClose        = toET(candleCloseUtc);

    slugs.push({
      offset,
      candle_open_utc:  candleOpenUtc.toISOString(),
      candle_close_utc: candleCloseUtc.toISOString(),
      et_close:         etClose.toISOString(),
      slug: `bitcoin-up-or-down-${MONTHS[etClose.getUTCMonth()]}-${etClose.getUTCDate()}-${formatHour12(etClose.getUTCHours())}-et`,
    });
  }

  // Slug primario = offset 0 (mercado actual)
  const primarySlug = slugs[1].slug; // offset=0 está en índice 1

  // Consultas en paralelo
  const [tagResult, upcomingResult, slugExactResult] = await Promise.all([
    tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=20`),
    tryFetch(`${GAMMA}/markets?active=true&closed=false&limit=30&order=endDate&ascending=true`),
    tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(primarySlug)}`),
  ]);

  // Todos los mercados BTC encontrados
  const allBTC = [];
  for (const r of [tagResult, upcomingResult]) {
    if (!r.data) continue;
    const list = Array.isArray(r.data) ? r.data : (r.data?.markets ?? []);
    for (const m of list) {
      const q = (m.question || m.title || m.slug || "").toLowerCase();
      if (!q.includes("btc") && !q.includes("bitcoin") && !q.includes("up-or-down")) continue;
      if (allBTC.find(x => x.slug === m.slug)) continue;
      const endIso   = m.endDateIso || m.end_date_iso || m.endDate;
      const minsLeft = endIso ? (new Date(endIso).getTime() - now.getTime()) / 60000 : null;
      allBTC.push({
        slug:          m.slug,
        question:      m.question || m.title,
        end_utc:       endIso,
        mins_to_close: minsLeft?.toFixed(1),
        tokens:        (m.tokens||[]).map(t => ({ outcome: t.outcome, price: t.price })),
      });
    }
  }
  allBTC.sort((a, b) => parseFloat(a.mins_to_close ?? 999) - parseFloat(b.mins_to_close ?? 999));

  return Response.json({
    now_utc:         now.toISOString(),
    now_et:          etNow.toISOString(),
    dst_active:      isDST(now),
    et_offset:       isDST(now) ? "UTC-4 (EDT)" : "UTC-5 (EST)",
    // Explicación del fix incluida en la respuesta de diagnóstico
    slug_logic:      "slug uses candle CLOSE hour in ET (open+1h), not open hour",
    slugs_generated: slugs,
    slug_exact_test: {
      slug:  primarySlug,
      found: Array.isArray(slugExactResult.data) && slugExactResult.data.length > 0,
      data:  slugExactResult.data,
    },
    btc_markets_found:  allBTC,
    hourly_candidate:   allBTC.find(m =>
      parseFloat(m.mins_to_close) > 0 && parseFloat(m.mins_to_close) <= 62
    ) ?? null,
  });
}
