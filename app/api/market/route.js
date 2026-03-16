// app/api/market/route.js
// Descubrimiento del mercado BTC Up/Down activo en Polymarket.
//
// v6.2 — FIX SLUG AÑO:
//   Polymarket cambió el formato del slug para incluir el año:
//     Antes : bitcoin-up-or-down-march-16-12pm-et
//     Ahora : bitcoin-up-or-down-march-16-2026-12pm-et
//   - buildSlugs()   → añade year entre día y hora
//   - slugToEndMs()  → lee año del slug (monthPart+2), hora en monthPart+3
//
// v6.1 — Fallback lista activa cuando slug search devuelve []
// v6.0 — Precios live siempre desde CLOB midpoint
// v5.0 — Rebuild tokens desde clobTokenIds si tokens[] vacío

export const runtime = "edge";
export const revalidate = 0;

const GAMMA        = "https://gamma-api.polymarket.com";
const CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint";

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

// ── DST helper ────────────────────────────────────────────────────────────────
function isDST(utcDate) {
  const year     = utcDate.getUTCFullYear();
  const march    = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));
  const nov      = new Date(Date.UTC(year, 10, 1));
  const dstEnd   = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7));
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

/**
 * Genera slugs candidatos.
 * FIX v6.2: incluye año → bitcoin-up-or-down-{month}-{day}-{year}-{hour}-et
 */
function buildSlugs(now) {
  const candleOpenNow = new Date(now);
  candleOpenNow.setUTCMinutes(0, 0, 0);

  const slugs = [];
  for (const offset of [0, -1, 1]) {
    const candleOpen = new Date(candleOpenNow.getTime() + offset * 3600 * 1000);
    const etOpen     = toET(candleOpen);
    const slug = `bitcoin-up-or-down-${MONTHS[etOpen.getUTCMonth()]}-${etOpen.getUTCDate()}-${etOpen.getUTCFullYear()}-${formatHour12(etOpen.getUTCHours())}-et`; // ← FIX v6.2
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/**
 * Parsea el campo de fecha de cierre de la respuesta de Polymarket.
 * Si endMs ya está en el pasado, devuelve null para usar slugToEndMs().
 */
function parseEndMs(m, now) {
  const raw = m.endDateIso || m.end_date_iso || m.endDate || m.end_date || null;
  if (!raw) return null;

  let ms;
  if (typeof raw === "number") {
    ms = raw < 2e10 ? raw * 1000 : raw;
  } else {
    try { ms = new Date(raw).getTime(); } catch { return null; }
  }

  if (!ms || isNaN(ms)) return null;
  if (ms <= now.getTime()) return null;             // expirado → ignorar
  if (ms - now.getTime() > 7_200_000) return null; // > 2h → sospechoso

  return ms;
}

/**
 * Fallback: deriva end_ms del slug cuando Polymarket no devuelve fecha parseable.
 * FIX v6.2: monthPart+1=día, monthPart+2=año, monthPart+3=hora
 */
function slugToEndMs(slug, now) {
  try {
    const parts = slug.split("-");
    let monthIdx = -1, monthPartIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const m = MONTHS.indexOf(parts[i]);
      if (m !== -1) { monthIdx = m; monthPartIdx = i; break; }
    }
    if (monthIdx === -1) return null;

    const day     = parseInt(parts[monthPartIdx + 1], 10);
    const year    = parseInt(parts[monthPartIdx + 2], 10); // ← FIX v6.2
    const hourStr = parts[monthPartIdx + 3];               // ← FIX v6.2 (era +2)
    if (!day || !year || !hourStr) return null;

    let openHourET;
    if (hourStr === "12am")          openHourET = 0;
    else if (hourStr === "12pm")     openHourET = 12;
    else if (hourStr.endsWith("am")) openHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) openHourET = parseInt(hourStr, 10) + 12;
    else return null;

    const closeHourET = (openHourET + 1) % 24;
    const closeDay    = openHourET === 23 ? day + 1 : day;

    const candidateUtc = new Date(Date.UTC(year, monthIdx, closeDay, 12, 0, 0));
    const etOffset     = isDST(candidateUtc) ? 4 : 5;
    const closeUtcMs   = Date.UTC(year, monthIdx, closeDay, closeHourET + etOffset, 0, 0, 0);

    const diff = closeUtcMs - now.getTime();
    if (diff < -300_000 || diff > 3_900_000) return null;

    return closeUtcMs;
  } catch {
    return null;
  }
}

/**
 * Reconstruye tokens desde clobTokenIds cuando Gamma devuelve tokens:[].
 * Índice 0 = YES (UP), índice 1 = NO (DOWN).
 */
function rebuildTokensFromClobIds(m) {
  const clobRaw = m.clobTokenIds;
  if (!clobRaw) return [];

  try {
    const clobIds = typeof clobRaw === "string" ? JSON.parse(clobRaw) : clobRaw;
    if (!Array.isArray(clobIds) || clobIds.length < 2) return [];

    return [
      { outcome: "Yes", token_id: clobIds[0], price: null },
      { outcome: "No",  token_id: clobIds[1], price: null },
    ];
  } catch {
    return [];
  }
}

/**
 * Obtiene el precio live del token desde el CLOB (midpoint).
 * No requiere autenticación.
 */
async function fetchLivePrice(tokenId) {
  if (!tokenId) return null;
  try {
    const url = `${CLOB_MIDPOINT}?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const mid  = parseFloat(data?.mid);
    return isNaN(mid) ? null : mid;
  } catch {
    return null;
  }
}

/**
 * Fallback cuando slug search devuelve [] — busca en lista activa.
 */
async function findMarketInActiveList(slugs) {
  const slugSet = new Set(slugs);
  const urls = [
    `${GAMMA}/markets?active=true&closed=false&limit=50&order=endDate&ascending=true`,
    `${GAMMA}/markets?active=true&closed=false&limit=50&tag=bitcoin`,
    `${GAMMA}/markets?active=true&closed=false&limit=100`,
    `${GAMMA}/markets?active=true&closed=false&limit=300`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      let markets = await res.json();
      if (!Array.isArray(markets)) markets = markets?.markets ?? [];

      for (const m of markets) {
        const mSlug = m.slug || "";
        if (slugSet.has(mSlug)) return m;
      }
    } catch (_) { /* continúa */ }
  }
  return null;
}

/**
 * Procesa un mercado raw (de Gamma) y devuelve el objeto de respuesta final.
 */
async function processMarket(m, slug, now, tried, slugs) {
  let tokens = m.tokens || [];
  let tokensRebuilt = false;
  if (tokens.length === 0) {
    tokens = rebuildTokensFromClobIds(m);
    tokensRebuilt = tokens.length > 0;
  }

  const yesT = tokens.find(t => t.outcome === "Yes");
  const noT  = tokens.find(t => t.outcome === "No");

  const [yesLivePrice, noLivePrice] = await Promise.all([
    fetchLivePrice(yesT?.token_id ?? null),
    fetchLivePrice(noT?.token_id  ?? null),
  ]);

  const yesGammaPrice = yesT?.price != null ? parseFloat(yesT.price) : null;
  const noGammaPrice  = noT?.price  != null ? parseFloat(noT.price)  : null;
  const yesPrice = yesLivePrice ?? (yesGammaPrice != null && !isNaN(yesGammaPrice) ? yesGammaPrice : null);
  const noPrice  = noLivePrice  ?? (noGammaPrice  != null && !isNaN(noGammaPrice)  ? noGammaPrice  : null);
  const yesSrc   = yesLivePrice != null ? "clob" : (yesGammaPrice != null ? "gamma" : "unavailable");
  const noSrc    = noLivePrice  != null ? "clob" : (noGammaPrice  != null ? "gamma" : "unavailable");

  let endMs = parseEndMs(m, now);
  const endIso      = m.endDateIso || m.end_date_iso || m.endDate || null;
  const endMsSource = endMs ? "polymarket" : "slug_fallback";
  if (!endMs) endMs = slugToEndMs(slug, now);

  const market = {
    question:     m.question || m.title || slug,
    condition_id: m.conditionId || m.condition_id || null,
    slug,
    end_ms:       endMs,
    end_date_iso: endIso,
    tokens: {
      yes: yesT ? { price: yesPrice, token_id: yesT.token_id, price_source: yesSrc } : null,
      no:  noT  ? { price: noPrice,  token_id: noT.token_id,  price_source: noSrc  } : null,
    },
    volume:    m.volume    ?? null,
    liquidity: m.liquidity ?? null,
    url:       `https://polymarket.com/event/${slug}`,
    _debug: {
      slugs_tried:      tried,
      slugs_all:        slugs,
      found_slug:       slug,
      end_ms_source:    endMsSource,
      now_utc:          now.toISOString(),
      dst_active:       isDST(now),
      et_offset:        isDST(now) ? "UTC-4 (EDT)" : "UTC-5 (EST)",
      tokens_rebuilt:   tokensRebuilt,
      price_sources:    { yes: yesSrc, no: noSrc },
      gamma_prices:     { yes: yesGammaPrice, no: noGammaPrice },
      clob_prices:      { yes: yesLivePrice, no: noLivePrice },
    },
  };

  return Response.json(
    { active: true, market, ts: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  const now    = new Date();
  const slugs  = buildSlugs(now);
  const tried  = [];
  const errors = [];

  // ── Intento 1: búsqueda directa por slug ─────────────────────────────────
  for (const slug of slugs) {
    tried.push(slug);
    try {
      const url = `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { cache: "no-store" });

      if (!res.ok) {
        errors.push({ slug, error: `HTTP ${res.status}` });
        continue;
      }

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        errors.push({ slug, error: "empty response" });
        continue;
      }

      return await processMarket(data[0], slug, now, tried, slugs);

    } catch (e) {
      errors.push({ slug, error: e.message });
    }
  }

  // ── Intento 2: fallback por lista activa ──────────────────────────────────
  try {
    const fallbackMarket = await findMarketInActiveList(slugs);
    if (fallbackMarket) {
      const fallbackSlug = fallbackMarket.slug ?? slugs[0];
      return await processMarket(fallbackMarket, fallbackSlug, now, tried, slugs);
    }
  } catch (e) {
    errors.push({ slug: "fallback_list", error: e.message });
  }

  return Response.json({
    active: false,
    error:  "Mercado no encontrado",
    slugs_tried: tried,
    errors,
    now_utc:    now.toISOString(),
    dst_active: isDST(now),
    et_offset:  isDST(now) ? "UTC-4 (EDT)" : "UTC-5 (EST)",
    ts: Date.now(),
  });
}
