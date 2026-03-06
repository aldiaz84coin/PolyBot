// app/api/market/route.js
// Busca el mercado "Bitcoin Up or Down" horario de Polymarket
// Slug real: "bitcoin-up-or-down-march-6-3am-et"
// Hora en ET (Eastern Time): UTC-5 EST (nov-mar) / UTC-4 EDT (mar-nov)

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

// ── Helpers de fecha ────────────────────────────────────────────────────────

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december"
];

// DST en EEUU: empieza 2º domingo de marzo, termina 1º domingo de noviembre
function isDST(utcDate) {
  const year = utcDate.getUTCFullYear();

  // 2º domingo de marzo
  const march = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));

  // 1º domingo de noviembre
  const nov = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7));

  return utcDate >= dstStart && utcDate < dstEnd;
}

// Convierte fecha UTC a hora ET (Eastern Time)
function toET(utcDate) {
  const offset = isDST(utcDate) ? -4 : -5; // horas
  return new Date(utcDate.getTime() + offset * 3600 * 1000);
}

// Formatea hora en 12h: "3am", "12pm", "11am"
function formatHour12(h24) {
  if (h24 === 0)  return "12am";
  if (h24 === 12) return "12pm";
  return h24 < 12 ? `${h24}am` : `${h24 - 12}pm`;
}

// Genera el slug para la hora de INICIO del mercado (hora ET actual, no la de cierre)
// El mercado de las 9:00-10:00 UTC se llama por la hora de inicio en ET
function buildSlugs(now) {
  const slugs = [];

  // Probamos la hora actual UTC y la hora anterior (por si el mercado ya empezó)
  for (const offset of [0, -1, 1]) {
    const utcDate = new Date(now.getTime() + offset * 3600 * 1000);
    const etDate  = toET(utcDate);

    const month = MONTHS[etDate.getUTCMonth()];
    const day   = etDate.getUTCDate();                  // sin leading zero
    const hour  = formatHour12(etDate.getUTCHours());   // "3am", "12pm"

    slugs.push(`bitcoin-up-or-down-${month}-${day}-${hour}-et`);
  }

  return [...new Set(slugs)];
}

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Estrategia 1: slug exacto por hora ET
async function bySlug(slugs) {
  for (const slug of slugs) {
    const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(data) && data.length > 0) return { market: data[0], slug };
  }
  return null;
}

// Estrategia 2: mercados activos BTC que cierran en <= 62 min
async function byUpcoming() {
  const now = Date.now();
  for (const limit of [50, 100]) {
    const data = await tryFetch(
      `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=endDate&ascending=true`
    );
    const list = Array.isArray(data) ? data : (data?.markets ?? []);
    const match = list.find(m => {
      const endIso = m.endDateIso || m.end_date_iso || m.endDate;
      if (!endIso) return false;
      const minsLeft = (new Date(endIso).getTime() - now) / 60000;
      const q = (m.question || m.title || m.slug || "").toLowerCase();
      return minsLeft > 0 && minsLeft <= 62 &&
        (q.includes("bitcoin") || q.includes("btc")) &&
        (q.includes("higher") || q.includes("lower") || q.includes("up") || q.includes("down"));
    });
    if (match) return { market: match, slug: match.slug };
  }
  return null;
}

// Estrategia 3: tag bitcoin
async function byTag() {
  const now = Date.now();
  const data = await tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=50`);
  const list = Array.isArray(data) ? data : (data?.markets ?? []);
  const candidates = list.filter(m => {
    const endIso = m.endDateIso || m.end_date_iso || m.endDate;
    if (!endIso) return false;
    const minsLeft = (new Date(endIso).getTime() - now) / 60000;
    const q = (m.question || m.title || m.slug || "").toLowerCase();
    return minsLeft > 0 && minsLeft <= 62 &&
      (q.includes("higher") || q.includes("lower") || q.includes("up") || q.includes("down"));
  }).sort((a, b) => {
    const aMs = new Date(a.endDateIso || a.end_date_iso || a.endDate).getTime();
    const bMs = new Date(b.endDateIso || b.end_date_iso || b.endDate).getTime();
    return aMs - bMs; // el que cierra antes
  });
  return candidates.length > 0 ? { market: candidates[0], slug: candidates[0].slug } : null;
}

// Extrae el "Price to Beat" del texto del mercado
function extractPriceToBeat(raw) {
  if (raw.startPrice)    return parseFloat(raw.startPrice);
  if (raw.price_to_beat) return parseFloat(raw.price_to_beat);

  const text = `${raw.description || ""} ${raw.question || ""}`;
  const patterns = [
    /price\s+to\s+beat[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
    /opening\s+price[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
    /higher\s+(?:or\s+lower\s+)?than\s+\$?([\d,]+(?:\.\d+)?)/i,
    /lower\s+(?:or\s+higher\s+)?than\s+\$?([\d,]+(?:\.\d+)?)/i,
    /open(?:ing)?\s+(?:price\s+)?(?:of\s+)?\$?([\d,]+(?:\.\d+)?)/i,
    /target[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 1000) return val;
    }
  }
  return null;
}

function normalizeMarket(raw) {
  const endIso   = raw.endDateIso || raw.end_date_iso || raw.endDate || null;
  const endMs    = endIso ? new Date(endIso).getTime() : null;
  const minsLeft = endMs ? (endMs - Date.now()) / 60000 : null;
  const tokens   = raw.tokens || [];
  const yesToken = tokens.find(t => t.outcome === "Yes") || tokens[0] || null;
  const noToken  = tokens.find(t => t.outcome === "No")  || tokens[1] || null;

  return {
    slug:          raw.slug || null,
    condition_id:  raw.conditionId || raw.condition_id || null,
    question:      raw.question || raw.title || null,
    description:   raw.description || null,
    end_date_iso:  endIso,
    end_ms:        endMs,
    mins_to_close: minsLeft != null ? Math.max(0, minsLeft) : null,
    price_to_beat: extractPriceToBeat(raw),
    tokens: {
      yes: yesToken ? {
        token_id: yesToken.token_id || yesToken.tokenId,
        outcome:  "Yes (UP)",
        price:    yesToken.price != null ? parseFloat(yesToken.price) : null,
      } : null,
      no: noToken ? {
        token_id: noToken.token_id || noToken.tokenId,
        outcome:  "No (DOWN)",
        price:    noToken.price != null ? parseFloat(noToken.price) : null,
      } : null,
    },
    url:       raw.slug ? `https://polymarket.com/event/${raw.slug}` : null,
    volume:    raw.volume    ? parseFloat(raw.volume)    : null,
    liquidity: raw.liquidity ? parseFloat(raw.liquidity) : null,
  };
}

export async function GET() {
  const now    = new Date();
  const slugs  = buildSlugs(now);
  const debugLog = [];

  const strategies = [
    { name: "slug_et_format", fn: () => bySlug(slugs)   },
    { name: "upcoming_btc",   fn: byUpcoming             },
    { name: "tag_bitcoin",    fn: byTag                  },
  ];

  let result = null;
  for (const s of strategies) {
    try {
      result = await s.fn();
      debugLog.push({ strategy: s.name, found: !!result, slug: result?.slug ?? null });
      if (result) break;
    } catch (e) {
      debugLog.push({ strategy: s.name, found: false, error: e.message });
    }
  }

  if (!result) {
    return Response.json({
      active:  false,
      market:  null,
      error:   "No se encontró mercado Bitcoin Up or Down para esta hora",
      debug: {
        now_utc:     now.toISOString(),
        now_et:      toET(now).toISOString(),
        slugs_tried: slugs,
        strategies:  debugLog,
      },
      ts: Date.now(),
    });
  }

  return Response.json({
    active: true,
    market: normalizeMarket(result.market),
    debug: {
      strategy_used:   debugLog.find(d => d.found)?.strategy,
      slug_found:      result.slug,
      now_et:          toET(now).toISOString(),
      slugs_tried:     slugs,
      raw_description: result.market.description?.slice(0, 400) ?? null,
    },
    ts: Date.now(),
  });
}
