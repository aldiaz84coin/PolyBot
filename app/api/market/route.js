// app/api/market/route.js
// Busca el mercado "Bitcoin Up or Down" que cierra al final de la hora ET actual
// Formato real de Polymarket: bitcoin-up-or-down-march-5-3pm-et

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

// ── Conversión UTC → ET (con DST automático) ─────────────────────────────────

function getDSTStart(year) {
  // 2º domingo de marzo a las 2:00 ET = 07:00 UTC (EST) o 06:00 UTC (EDT)
  const march1 = new Date(Date.UTC(year, 2, 1));
  const day = march1.getUTCDay(); // 0 = domingo
  const daysToFirstSunday = (7 - day) % 7;
  const firstSunday = new Date(march1.getTime() + daysToFirstSunday * 86400000);
  const secondSunday = new Date(firstSunday.getTime() + 7 * 86400000);
  // 2:00 AM EST = 07:00 UTC
  secondSunday.setUTCHours(7, 0, 0, 0);
  return secondSunday;
}

function getDSTEnd(year) {
  // 1er domingo de noviembre a las 2:00 ET = 06:00 UTC (EDT)
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const day = nov1.getUTCDay();
  const daysToFirstSunday = (7 - day) % 7;
  const firstSunday = new Date(nov1.getTime() + daysToFirstSunday * 86400000);
  // 2:00 AM EDT = 06:00 UTC
  firstSunday.setUTCHours(6, 0, 0, 0);
  return firstSunday;
}

function isEDT(dateUTC) {
  const year = dateUTC.getUTCFullYear();
  return dateUTC >= getDSTStart(year) && dateUTC < getDSTEnd(year);
}

// Convierte un Date UTC a un objeto con los campos de hora ET
function toET(dateUTC) {
  const offsetHours = isEDT(dateUTC) ? -4 : -5;
  const et = new Date(dateUTC.getTime() + offsetHours * 3600000);
  return {
    year:    et.getUTCFullYear(),
    month:   et.getUTCMonth(),      // 0-indexed
    day:     et.getUTCDate(),       // sin cero
    hours:   et.getUTCHours(),      // 0-23
    minutes: et.getUTCMinutes(),
  };
}

// ── Generador de slug ET (formato real de Polymarket) ────────────────────────

const MONTHS_EN = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

/**
 * Genera el slug canónico que usa Polymarket.
 * Ejemplo: bitcoin-up-or-down-march-5-3pm-et
 *
 * @param {Date} closingUTC  - Momento de cierre en UTC (siempre :00 de alguna hora)
 */
function buildETSlug(closingUTC) {
  const et    = toET(closingUTC);
  const month = MONTHS_EN[et.month];
  const day   = et.day;                       // sin cero: 5, no 05
  const h12   = et.hours % 12 || 12;          // 0 → 12, 13 → 1, etc.
  const ampm  = et.hours < 12 ? "am" : "pm";
  return `bitcoin-up-or-down-${month}-${day}-${h12}${ampm}-et`;
}

// ── Hora de cierre UTC ────────────────────────────────────────────────────────

function getClosingHourUTC() {
  const now = new Date();
  const closing = new Date(now);
  closing.setUTCMinutes(0, 0, 0);
  closing.setUTCHours(closing.getUTCHours() + 1);
  return closing;
}

// ── Slugs legacy (formatos ISO anteriores, por si acaso) ─────────────────────

function buildLegacySlugs(closing) {
  const y  = closing.getUTCFullYear();
  const mo = String(closing.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(closing.getUTCDate()).padStart(2, "0");
  const h  = String(closing.getUTCHours()).padStart(2, "0");
  return [
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00-00-000z`,
    `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00z`,
    `bitcoin-up-or-down-${y}-${mo}-${dy}-${h}00`,
    `will-bitcoin-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
  ];
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Estrategias de búsqueda ───────────────────────────────────────────────────

// Estrategia 1 (PRIORITARIA): slug ET canónico real de Polymarket
// Ej: bitcoin-up-or-down-march-5-3pm-et
async function byETSlug(etSlug) {
  const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(etSlug)}`);
  if (Array.isArray(data) && data.length > 0) return { market: data[0], slug: etSlug };
  return null;
}

// Estrategia 2: slugs legacy ISO
async function byLegacySlugs(slugs) {
  for (const slug of slugs) {
    const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(data) && data.length > 0) return { market: data[0], slug };
  }
  return null;
}

// Estrategia 3: mercados activos filtrados por tiempo de cierre ±90s
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

// Estrategia 4: tag bitcoin, filtrar <= 62 min al cierre
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

// Estrategia 5: keyword search
async function bySearch() {
  const now = Date.now();
  for (const q of ["bitcoin up or down", "bitcoin higher lower hourly", "btc up down"]) {
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

// ── Normalización de la respuesta ─────────────────────────────────────────────

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
    end_date_iso:  endIso,
    end_ms:        endMs,
    mins_to_close: minsLeft != null ? Math.max(0, minsLeft) : null,
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

// ── Handler principal ─────────────────────────────────────────────────────────

export async function GET() {
  const now      = new Date();
  const closing  = getClosingHourUTC();
  const etSlug   = buildETSlug(closing);
  const legacySlugs = buildLegacySlugs(closing);
  const debugLog = [];

  const strategies = [
    { name: "et_slug_canonical",  fn: () => byETSlug(etSlug)              },
    { name: "legacy_slugs_iso",   fn: () => byLegacySlugs(legacySlugs)    },
    { name: "exact_closing_time", fn: () => byExactClosingTime(closing)    },
    { name: "tag_and_time",       fn: () => byTagAndTime(closing)          },
    { name: "search_keyword",     fn: bySearch                             },
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
        current_utc:      now.toISOString(),
        closing_utc:      closing.toISOString(),
        et_slug_tried:    etSlug,
        legacy_slugs:     legacySlugs,
        mins_to_close:    (closing.getTime() - now.getTime()) / 60000,
        strategies:       debugLog,
      },
      ts: Date.now(),
    });
  }

  return Response.json({
    active: true,
    market: normalizeMarket(result.market),
    debug: {
      strategy_used: debugLog.find(d => d.found)?.strategy,
      closing_utc:   closing.toISOString(),
      et_slug_tried: etSlug,
      slug_found:    result.slug,
    },
    ts: Date.now(),
  });
}
