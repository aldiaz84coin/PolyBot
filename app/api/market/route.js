// app/api/market/route.js
// Obtiene el mercado BTC Up/Down activo en Polymarket Gamma API
// FIX: El slug usa la hora de CIERRE de la vela 1H (ET), no la de apertura.
// FIX: end_ms tiene fallback derivado del slug si Polymarket no devuelve endDateIso.

export const runtime = "edge";
export const revalidate = 0;

const GAMMA = "https://gamma-api.polymarket.com";

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

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
 * ⚠️ CLAVE: Polymarket usa la hora de CIERRE de la vela 1H en ET, no la apertura.
 * Ejemplo a las 10:30 UTC (vela 10:00–11:00 UTC = 5am–6am ET):
 *   Slug correcto: "bitcoin-up-or-down-march-6-6am-et"  (hora CIERRE = 6am ET)
 *   Bug anterior:  "bitcoin-up-or-down-march-6-5am-et"  (hora apertura ❌)
 */
function buildSlugs(now) {
  const slugs = [];
  for (const offset of [0, -1, 1]) {
    const candleOpenUtc  = new Date(now.getTime() + offset * 3600 * 1000);
    const candleCloseUtc = new Date(candleOpenUtc.getTime() + 3600 * 1000);
    const etClose        = toET(candleCloseUtc);
    const slug = `bitcoin-up-or-down-${MONTHS[etClose.getUTCMonth()]}-${etClose.getUTCDate()}-${formatHour12(etClose.getUTCHours())}-et`;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/**
 * Parsea el campo de fecha de cierre de la respuesta de Polymarket.
 */
function parseEndMs(m) {
  const raw = m.endDateIso || m.end_date_iso || m.endDate || m.end_date || null;
  if (!raw) return null;
  if (typeof raw === "number") return raw < 2e10 ? raw * 1000 : raw;
  try { return new Date(raw).getTime(); } catch { return null; }
}

/**
 * Fallback: deriva end_ms directamente del slug cuando Polymarket no devuelve
 * un campo de fecha parseable.
 *
 * Slug: "bitcoin-up-or-down-{month}-{day}-{closeHour}-et"
 * La hora en el slug es la HORA DE CIERRE de la vela (= cierre del mercado) en ET.
 * Convertimos esa hora ET a UTC timestamp.
 */
function slugToEndMs(slug, now) {
  try {
    const parts = slug.split("-");
    let monthIdx = -1;
    let monthPartIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const m = MONTHS.indexOf(parts[i]);
      if (m !== -1) { monthIdx = m; monthPartIdx = i; break; }
    }
    if (monthIdx === -1) return null;

    const day     = parseInt(parts[monthPartIdx + 1], 10);
    const hourStr = parts[monthPartIdx + 2];
    if (!day || !hourStr) return null;

    let closeHourET;
    if (hourStr === "12am")          closeHourET = 0;
    else if (hourStr === "12pm")     closeHourET = 12;
    else if (hourStr.endsWith("am")) closeHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) closeHourET = parseInt(hourStr, 10) + 12;
    else return null;

    const year = now.getUTCFullYear();
    // Calculamos el UTC del cierre: hora ET cierre + |offset|
    const candidateUtc  = new Date(Date.UTC(year, monthIdx, day, 12, 0, 0));
    const etOffsetHours = isDST(candidateUtc) ? 4 : 5;
    const closeUtcMs    = Date.UTC(year, monthIdx, day, closeHourET + etOffsetHours, 0, 0, 0);

    // Sanity: debe estar en un rango razonable (±2h de ahora)
    const diff = closeUtcMs - now.getTime();
    if (diff < -7_200_000 || diff > 7_200_000) return null;

    return closeUtcMs;
  } catch {
    return null;
  }
}

export async function GET() {
  const now    = new Date();
  const slugs  = buildSlugs(now);
  const tried  = [];
  const errors = [];

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

      const m      = data[0];
      const tokens = m.tokens || [];
      const yesT   = tokens.find(t => t.outcome === "Yes");
      const noT    = tokens.find(t => t.outcome === "No");

      // end_ms: primero intentamos parsear el campo de Polymarket,
      // si falla usamos el slug como fuente de verdad (más robusto)
      let endMs  = parseEndMs(m);
      const endIso = m.endDateIso || m.end_date_iso || m.endDate || null;
      if (!endMs) {
        endMs = slugToEndMs(slug, now);
      }

      const market = {
        question:     m.question || m.title || slug,
        condition_id: m.conditionId || m.condition_id || null,
        slug,
        end_ms:       endMs,
        end_date_iso: endIso,
        tokens: {
          yes: yesT ? { price: parseFloat(yesT.price), token_id: yesT.token_id } : null,
          no:  noT  ? { price: parseFloat(noT.price),  token_id: noT.token_id  } : null,
        },
        volume:    m.volume    ?? null,
        liquidity: m.liquidity ?? null,
        url:       `https://polymarket.com/event/${slug}`,
        _debug: {
          slugs_tried:      tried,
          slugs_all:        slugs,
          found_slug:       slug,
          end_ms_source:    endMs && !parseEndMs(m) ? "slug_fallback" : "polymarket",
          now_utc:          now.toISOString(),
          dst_active:       isDST(now),
          et_offset:        isDST(now) ? "UTC-4 (EDT)" : "UTC-5 (EST)",
        },
      };

      return Response.json({ active: true, market, ts: Date.now() });

    } catch (e) {
      errors.push({ slug, error: e.message });
    }
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
