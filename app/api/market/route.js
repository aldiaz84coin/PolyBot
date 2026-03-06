// app/api/market/route.js
// Busca el mercado "Bitcoin Up or Down" que cierra al final de la hora UTC actual
// Extrae el "Price to Beat" directamente del mercado de Polymarket

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

function getClosingHourUTC() {
  const now = new Date();
  const closing = new Date(now);
  closing.setUTCMinutes(0, 0, 0);
  closing.setUTCHours(closing.getUTCHours() + 1);
  return closing;
}

function buildSlugsForClosing(closing) {
  const y  = closing.getUTCFullYear();
  const mo = String(closing.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(closing.getUTCDate()).padStart(2, "0");
  const h  = String(closing.getUTCHours()).padStart(2, "0");
  return [
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00-00-000z`,
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00z`,
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}-${h}00`,
    `bitcoin-up-or-down-${y}-${mo}-${dy}-${h}00`,
    `bitcoin-up-or-down-${y}-${mo}-${dy}t${h}0000000z`,
    `will-bitcoin-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
  ];
}

// Extrae el "Price to Beat" del mercado de Polymarket
// Polymarket lo incluye en description, question o en outcomePrices
function extractPriceToBeat(raw) {
  // 1. Campo dedicado (algunos mercados lo tienen)
  if (raw.startPrice)    return parseFloat(raw.startPrice);
  if (raw.price_to_beat) return parseFloat(raw.price_to_beat);

  // 2. Buscar en description: "Price to Beat: $84,500" o "price to beat is $84500"
  const text = `${raw.description || ""} ${raw.question || ""}`;
  const patterns = [
    /price\s+to\s+beat[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
    /opening\s+price[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
    /open(?:ing)?\s+price\s+(?:of\s+)?\$?([\d,]+(?:\.\d+)?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)\s+(?:at\s+)?open/i,
    /higher\s+(?:or\s+lower\s+)?than\s+\$?([\d,]+(?:\.\d+)?)/i,
    /lower\s+(?:or\s+higher\s+)?than\s+\$?([\d,]+(?:\.\d+)?)/i,
    /target[:\s]+\$?([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 1000) return val; // sanity check: BTC > $1000
    }
  }

  // 3. outcomePrices a veces tiene el strike
  if (Array.isArray(raw.outcomePrices) && raw.outcomePrices.length > 0) {
    const val = parseFloat(raw.outcomePrices[0]);
    if (val > 1000) return val;
  }

  return null;
}

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function bySlug(slugs) {
  for (const slug of slugs) {
    const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(data) && data.length > 0) return { market: data[0], slug };
  }
  return null;
}

async function byExactClosingTime(closing) {
  const closingMs   = closing.getTime();
  const toleranceMs = 90 * 1000;
  for (const limit of [50, 100]) {
    const data = await tryFetch(
      `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=endDate&ascending=true`
    );
    const list = Array.isArray(data) ? data : (data?.markets ?? []);
    const match = list.find(m => {
      const endIso = m.endDateIso || m.end_date_iso || m.endDate;
      if (!endIso) return false;
      const diff = Math.abs(new Date(endIso).getTime() - closingMs);
      const q    = (m.question || m.title || "").toLowerCase();
      return diff <= toleranceMs &&
        (q.includes("bitcoin") || q.includes("btc")) &&
        (q.includes("higher") || q.includes("lower") || q.includes("up") || q.includes("down"));
    });
    if (match) return { market: match, slug: match.slug };
  }
  return null;
}

async function byTagAndTime(closing) {
  const now       = Date.now();
  const closingMs = closing.getTime();
  const data = await tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=50`);
  const list = Array.isArray(data) ? data : (data?.markets ?? []);
  const candidates = list
    .filter(m => {
      const endIso = m.endDateIso || m.end_date_iso || m.endDate;
      if (!endIso) return false;
      const minsLeft = (new Date(endIso).getTime() - now) / 60000;
      const q        = (m.question || m.title || "").toLowerCase();
      return minsLeft > 0 && minsLeft <= 62 &&
        (q.includes("bitcoin") || q.includes("btc")) &&
        (q.includes("higher") || q.includes("lower") || q.includes("up") || q.includes("down"));
    })
    .sort((a, b) => {
      const aEnd = new Date(a.endDateIso || a.end_date_iso || a.endDate).getTime();
      const bEnd = new Date(b.endDateIso || b.end_date_iso || b.endDate).getTime();
      return Math.abs(aEnd - closingMs) - Math.abs(bEnd - closingMs);
    });
  return candidates.length > 0 ? { market: candidates[0], slug: candidates[0].slug } : null;
}

async function bySearch() {
  const now = Date.now();
  for (const q of ["bitcoin higher lower", "btc up down hourly", "bitcoin up or down"]) {
    const data = await tryFetch(
      `${GAMMA}/markets?search=${encodeURIComponent(q)}&active=true&closed=false&limit=10`
    );
    const list = Array.isArray(data) ? data : (data?.markets ?? []);
    const match = list.find(m => {
      const endIso = m.endDateIso || m.end_date_iso || m.endDate;
      if (!endIso) return false;
      const minsLeft = (new Date(endIso).getTime() - now) / 60000;
      return minsLeft > 0 && minsLeft <= 62;
    });
    if (match) return { market: match, slug: match.slug };
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

  const priceToBeat = extractPriceToBeat(raw);

  return {
    slug:           raw.slug || null,
    condition_id:   raw.conditionId || raw.condition_id || null,
    question:       raw.question || raw.title || null,
    description:    raw.description || null,
    end_date_iso:   endIso,
    end_ms:         endMs,   // ← en ms, para que el cliente calcule minsLeft en tiempo real
    mins_to_close:  minsLeft != null ? Math.max(0, minsLeft) : null,
    price_to_beat:  priceToBeat,   // ← "Price to Beat" extraído del mercado
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
  const now     = new Date();
  const closing = getClosingHourUTC();
  const slugs   = buildSlugsForClosing(closing);
  const debugLog = [];

  const strategies = [
    { name: "slug_exact",         fn: () => bySlug(slugs)              },
    { name: "exact_closing_time", fn: () => byExactClosingTime(closing) },
    { name: "tag_and_time",       fn: () => byTagAndTime(closing)       },
    { name: "search_keyword",     fn: bySearch                          },
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
      error:   "No se encontró mercado Bitcoin Up or Down para esta hora UTC",
      debug: {
        current_utc:   now.toISOString(),
        closing_utc:   closing.toISOString(),
        slugs_tried:   slugs,
        strategies:    debugLog,
      },
      ts: Date.now(),
    });
  }

  const market = normalizeMarket(result.market);

  return Response.json({
    active: true,
    market,
    debug: {
      strategy_used:  debugLog.find(d => d.found)?.strategy,
      closing_utc:    closing.toISOString(),
      slug_found:     result.slug,
      raw_description: result.market.description?.slice(0, 300) ?? null,
    },
    ts: Date.now(),
  });
}
