// app/api/market/debug/route.js
// Diagnóstico: muestra qué devuelve la Gamma API y qué slug ET se está generando
// Acceder en: /api/market/debug

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

// ── Conversión UTC → ET (copia de route.js) ───────────────────────────────────

function getDSTStart(year) {
  const march1 = new Date(Date.UTC(year, 2, 1));
  const day = march1.getUTCDay();
  const daysToFirstSunday = (7 - day) % 7;
  const firstSunday = new Date(march1.getTime() + daysToFirstSunday * 86400000);
  const secondSunday = new Date(firstSunday.getTime() + 7 * 86400000);
  secondSunday.setUTCHours(7, 0, 0, 0);
  return secondSunday;
}

function getDSTEnd(year) {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const day = nov1.getUTCDay();
  const daysToFirstSunday = (7 - day) % 7;
  const firstSunday = new Date(nov1.getTime() + daysToFirstSunday * 86400000);
  firstSunday.setUTCHours(6, 0, 0, 0);
  return firstSunday;
}

function toET(dateUTC) {
  const year = dateUTC.getUTCFullYear();
  const isEDT = dateUTC >= getDSTStart(year) && dateUTC < getDSTEnd(year);
  const offsetHours = isEDT ? -4 : -5;
  const et = new Date(dateUTC.getTime() + offsetHours * 3600000);
  return {
    year: et.getUTCFullYear(), month: et.getUTCMonth(),
    day: et.getUTCDate(), hours: et.getUTCHours(), minutes: et.getUTCMinutes(),
    timezone: isEDT ? "EDT (UTC-4)" : "EST (UTC-5)",
  };
}

const MONTHS_EN = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

function buildETSlug(closingUTC) {
  const et    = toET(closingUTC);
  const month = MONTHS_EN[et.month];
  const day   = et.day;
  const h12   = et.hours % 12 || 12;
  const ampm  = et.hours < 12 ? "am" : "pm";
  return `bitcoin-up-or-down-${month}-${day}-${h12}${ampm}-et`;
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
  const now = new Date();

  const closing = new Date(now);
  closing.setUTCMinutes(0, 0, 0);
  closing.setUTCHours(closing.getUTCHours() + 1);

  const etInfo  = toET(closing);
  const etSlug  = buildETSlug(closing);

  const y  = closing.getUTCFullYear();
  const mo = String(closing.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(closing.getUTCDate()).padStart(2, "0");
  const h  = String(closing.getUTCHours()).padStart(2, "0");

  // Consultas en paralelo: slug ET canónico + tag + activos
  const [etSlugResult, tagResult, activeResult] = await Promise.all([
    tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(etSlug)}`),
    tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=20`),
    tryFetch(`${GAMMA}/markets?active=true&closed=false&limit=30&order=endDate&ascending=true`),
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
      if (allBTC.find(x => x.slug === m.slug)) continue;
      allBTC.push({
        slug:          m.slug,
        question:      m.question || m.title,
        end_utc:       endIso,
        mins_to_close: minsLeft?.toFixed(1),
        active:        m.active,
        closed:        m.closed,
        tokens:        (m.tokens || []).map(t => ({ outcome: t.outcome, price: t.price })),
      });
    }
  }

  allBTC.sort((a, b) => parseFloat(a.mins_to_close ?? 999) - parseFloat(b.mins_to_close ?? 999));

  return Response.json({
    now_utc:     now.toISOString(),
    closing_utc: closing.toISOString(),

    // ← Lo más importante: qué slug ET se genera y si se encuentra
    et_slug_generated: etSlug,
    et_info: {
      closing_in_et: `${MONTHS_EN[etInfo.month]} ${etInfo.day}, ${etInfo.hours % 12 || 12}${etInfo.hours < 12 ? "am" : "pm"} ${etInfo.timezone}`,
    },
    et_slug_result: {
      status: etSlugResult.status,
      found:  Array.isArray(etSlugResult.data) && etSlugResult.data.length > 0,
      market: Array.isArray(etSlugResult.data) ? etSlugResult.data[0] : null,
    },

    legacy_slug_example: `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
    mins_to_closing: ((closing.getTime() - now.getTime()) / 60000).toFixed(1),
    btc_markets_found: allBTC,
    hourly_candidate: allBTC.find(m =>
      parseFloat(m.mins_to_close) > 0 && parseFloat(m.mins_to_close) <= 62 &&
      ((m.question || "").toLowerCase().includes("higher") ||
       (m.question || "").toLowerCase().includes("lower") ||
       (m.question || "").toLowerCase().includes("up") ||
       (m.question || "").toLowerCase().includes("down"))
    ) ?? null,
  });
}
