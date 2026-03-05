// app/api/market/route.js
// Busca el mercado BTC Up/Down Hourly activo en Polymarket
// Usa múltiples estrategias para encontrarlo

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

// Genera TODOS los posibles formatos de slug para las próximas 2 horas
function buildSlugs() {
  const now = new Date();
  const slugs = [];

  for (let offset = 0; offset <= 1; offset++) {
    const d  = new Date(now.getTime() + offset * 3600 * 1000);
    const y  = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(d.getUTCDate()).padStart(2, "0");
    const h  = String(d.getUTCHours()).padStart(2, "0");

    // Todos los formatos que Polymarket ha usado históricamente
    slugs.push(
      `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
      `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00-00-000z`,
      `will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00z`,
      `will-bitcoin-be-higher-or-lower-${y}-${mo}-${dy}t${h}0000000z`,
      `will-bitcoin-be-higher-or-lower-${y}-${mo}-${dy}t${h}00-00-000z`,
      `btc-higher-lower-${y}-${mo}-${dy}-${h}00`,
      `bitcoin-up-or-down-${y}-${mo}-${dy}-${h}`,
    );
  }
  return [...new Set(slugs)]; // deduplicate
}

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    return data;
  } catch {
    return null;
  }
}

// Estrategia 1: slug exacto
async function searchBySlugs(slugs) {
  for (const slug of slugs) {
    const data = await tryFetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(data) && data.length > 0) return data[0];
  }
  return null;
}

// Estrategia 2: búsqueda por tag bitcoin + filtro texto
async function searchByTag() {
  const data = await tryFetch(`${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=50`);
  const list = Array.isArray(data) ? data : (data?.markets ?? []);
  return list.find(m =>
    (m.question?.toLowerCase().includes("higher or lower") ||
     m.question?.toLowerCase().includes("up or down")) &&
    m.question?.toLowerCase().includes("btc") || m.question?.toLowerCase().includes("bitcoin")
  ) ?? null;
}

// Estrategia 3: búsqueda full-text
async function searchByKeyword() {
  const data = await tryFetch(`${GAMMA}/markets?search=bitcoin+higher+lower&active=true&closed=false&limit=20`);
  const list = Array.isArray(data) ? data : (data?.markets ?? []);
  return list.find(m =>
    m.question?.toLowerCase().includes("higher or lower") ||
    m.question?.toLowerCase().includes("up or down")
  ) ?? null;
}

// Estrategia 4: buscar eventos activos de BTC
async function searchByEvents() {
  const data = await tryFetch(`${GAMMA}/events?tag=bitcoin&active=true&closed=false&limit=20`);
  const events = Array.isArray(data) ? data : (data?.events ?? []);
  for (const ev of events) {
    if (ev.slug?.includes("higher-or-lower") || ev.slug?.includes("up-or-down")) {
      // Buscar el mercado de ese evento
      const mdata = await tryFetch(`${GAMMA}/markets?event_slug=${encodeURIComponent(ev.slug)}`);
      const mlist = Array.isArray(mdata) ? mdata : [];
      if (mlist.length > 0) return mlist[0];
    }
  }
  return null;
}

// Estrategia 5: listar todos los mercados activos y filtrar por cierre en < 70min
async function searchByUpcoming() {
  const now = Date.now();
  const data = await tryFetch(`${GAMMA}/markets?active=true&closed=false&limit=100&order=endDate&ascending=true`);
  const list = Array.isArray(data) ? data : (data?.markets ?? []);
  return list.find(m => {
    const endIso = m.endDateIso || m.end_date_iso || m.endDate;
    if (!endIso) return false;
    const endMs = new Date(endIso).getTime();
    const minsLeft = (endMs - now) / 60000;
    const q = (m.question || m.title || "").toLowerCase();
    return minsLeft > 0 && minsLeft < 70 &&
      (q.includes("bitcoin") || q.includes("btc")) &&
      (q.includes("higher") || q.includes("lower") || q.includes("up") || q.includes("down"));
  }) ?? null;
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

export async function GET() {
  const slugs = buildSlugs();
  const debugLog = [];

  // Run all strategies in order
  const strategies = [
    { name: "slug_exact",  fn: () => searchBySlugs(slugs) },
    { name: "tag_bitcoin", fn: searchByTag },
    { name: "keyword",     fn: searchByKeyword },
    { name: "events",      fn: searchByEvents },
    { name: "upcoming",    fn: searchByUpcoming },
  ];

  let raw = null;
  for (const s of strategies) {
    try {
      raw = await s.fn();
      debugLog.push({ strategy: s.name, found: !!raw });
      if (raw) break;
    } catch (e) {
      debugLog.push({ strategy: s.name, found: false, error: e.message });
    }
  }

  if (!raw) {
    return Response.json({
      active: false,
      market: null,
      error: "No se encontró ningún mercado BTC Up/Down activo",
      debug: { slugs_tried: slugs, strategies: debugLog },
      ts: Date.now(),
    });
  }

  const market = normalizeMarket(raw);

  return Response.json({
    active: true,
    market,
    debug: { strategy_used: debugLog.find(d => d.found)?.strategy, log: debugLog },
    ts: Date.now(),
  });
}

