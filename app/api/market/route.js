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

function buildSlugs(now) {
  const slugs = [];
  for (const offset of [0, -1, 1]) {
    const utcDate = new Date(now.getTime() + offset * 3600 * 1000);
    const etDate  = toET(utcDate);
    const month = MONTHS[etDate.getUTCMonth()];
    const day   = etDate.getUTCDate();
    const hour  = formatHour12(etDate.getUTCHours());
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

async function bySlug(slugs) {
  for (const slug of slugs) {
    const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(data) && data.length > 0) return { market: data[0], slug };
  }
  return null;
}

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
    return aMs - bMs;
  });
  return candidates.length > 0 ? { market: candidates[0], slug: candidates[0].slug } : null;
}

// ── Parseo robusto de end date ──────────────────────────────────────────────
// La Gamma API devuelve el campo con nombres variados y a veces como unix timestamp
function parseEndMs(raw) {
  // Probar todos los campos posibles
  const candidate =
    raw.endDateIso   ||
    raw.end_date_iso ||
    raw.endDate      ||
    raw.end_date     ||
    raw.closeTime    ||
    raw.close_time   ||
    null;

  if (candidate) {
    // Puede ser ISO string o unix timestamp (segundos o ms)
    if (typeof candidate === "number") {
      // Si es menor que ~2e10, es segundos; si es mayor, milisegundos
      return candidate < 2e10 ? candidate * 1000 : candidate;
    }
    const ms = new Date(candidate).getTime();
    if (!isNaN(ms) && ms > Date.now()) return ms;
  }

  // Fallback: calcular el cierre de la hora UTC actual
  // El mercado horario siempre cierra al final de la hora en curso
  const now = new Date();
  const endOfHour = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0)
  );
  return endOfHour.getTime();
}

function normalizeMarket(raw) {
  const endMs   = parseEndMs(raw);
  const endIso  = new Date(endMs).toISOString();
  const minsLeft = Math.max(0, (endMs - Date.now()) / 60000);

  const tokens   = raw.tokens || [];
  const yesToken = tokens.find(t => t.outcome === "Yes") || tokens[0] || null;
  const noToken  = tokens.find(t => t.outcome === "No")  || tokens[1] || null;

  return {
    slug:          raw.slug || null,
    condition_id:  raw.conditionId || raw.condition_id || null,
    question:      raw.question || raw.title || null,
    description:   raw.description || null,
    end_date_iso:  endIso,
    end_ms:        endMs,               // ← siempre populado (fallback al fin de hora UTC)
    mins_to_close: minsLeft,
    price_to_beat: null,                // lo provee /api/target via Binance 1H open
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
    { name: "slug_et_format", fn: () => bySlug(slugs) },
    { name: "upcoming_btc",   fn: byUpcoming           },
    { name: "tag_bitcoin",    fn: byTag                },
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
      raw_end_fields: {
        endDateIso:   result.market.endDateIso   ?? null,
        end_date_iso: result.market.end_date_iso ?? null,
        endDate:      result.market.endDate      ?? null,
      },
    },
    ts: Date.now(),
  });
}
