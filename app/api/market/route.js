// app/api/market/route.js
// Busca el mercado BTC Up/Down activo en Polymarket Gamma API
// Selecciona el evento horario cuyo cierre sea el más próximo (< 60 min)

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

// Genera los slugs de las próximas 2 horas en UTC
function buildSlugs() {
  const now = new Date();
  const slugs = [];
  for (let offset = 0; offset <= 1; offset++) {
    const d = new Date(now.getTime() + offset * 3600 * 1000);
    const y  = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(d.getUTCDate()).padStart(2, "0");
    const h  = String(d.getUTCHours()).padStart(2, "0");
    slugs.push(`will-btc-be-higher-or-lower-${y}-${mo}-${dy}t${h}00-00-000z`);
  }
  return slugs;
}

// Intenta buscar mercados por slug exacto
async function fetchBySlug(slug) {
  const url = `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// Fallback: busca por texto en mercados BTC activos
async function fetchBySearch() {
  const url = `${GAMMA}/markets?tag=bitcoin&active=true&closed=false&limit=20`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  // Filtra solo los "Up or Down Hourly"
  return (Array.isArray(data) ? data : data.markets ?? []).filter(m =>
    m.question?.toLowerCase().includes("higher or lower") ||
    m.question?.toLowerCase().includes("up or down")
  );
}

function normalizeMarket(raw) {
  const endIso  = raw.endDateIso || raw.end_date_iso || raw.endDate || null;
  const endMs   = endIso ? new Date(endIso).getTime() : null;
  const minsLeft = endMs ? (endMs - Date.now()) / 60000 : null;

  const tokens  = raw.tokens || [];
  const yesToken = tokens.find(t => t.outcome === "Yes") || tokens[0] || null;
  const noToken  = tokens.find(t => t.outcome === "No")  || tokens[1] || null;

  return {
    slug:         raw.slug        || null,
    condition_id: raw.conditionId || raw.condition_id || null,
    question:     raw.question    || null,
    end_date_iso: endIso,
    end_ms:       endMs,
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
    url: raw.slug ? `https://polymarket.com/event/${raw.slug}` : null,
    volume:       raw.volume      ? parseFloat(raw.volume)      : null,
    liquidity:    raw.liquidity   ? parseFloat(raw.liquidity)   : null,
  };
}

export async function GET() {
  const now = Date.now();
  const candidates = [];

  // 1. Buscar por slugs exactos
  for (const slug of buildSlugs()) {
    try {
      const raw = await fetchBySlug(slug);
      if (raw) candidates.push(normalizeMarket(raw));
    } catch { /* skip */ }
  }

  // 2. Si no encontramos nada, fallback por búsqueda
  if (candidates.length === 0) {
    try {
      const results = await fetchBySearch();
      for (const raw of results) candidates.push(normalizeMarket(raw));
    } catch { /* skip */ }
  }

  if (candidates.length === 0) {
    return Response.json({
      active: false,
      market: null,
      error: "No se encontró ningún mercado BTC Up/Down activo",
      slugs_tried: buildSlugs(),
      ts: now,
    });
  }

  // Seleccionar el mercado cuyo cierre sea más próximo Y dentro de 60 min
  const valid = candidates
    .filter(m => m.mins_to_close != null && m.mins_to_close > 0 && m.mins_to_close <= 65)
    .sort((a, b) => a.mins_to_close - b.mins_to_close);

  const market = valid[0] ?? candidates.sort((a, b) => (a.mins_to_close ?? 999) - (b.mins_to_close ?? 999))[0];

  return Response.json({
    active: true,
    market,
    ts: now,
    // Debug: todos los candidatos encontrados
    all_candidates: candidates.map(c => ({
      slug: c.slug,
      question: c.question,
      mins_to_close: c.mins_to_close,
    })),
  });
}
