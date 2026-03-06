// app/api/market/route.js
// Obtiene el mercado BTC Up/Down activo en Polymarket Gamma API
//
// FIX v3 (BUG SLUG HORA):
//   Polymarket usa la hora de APERTURA de la vela 1H (ET) en el slug.
//   Ejemplo a las 7:30am ET (vela 7am–8am ET):
//     Slug correcto: "bitcoin-up-or-down-march-6-7am-et"  ← hora APERTURA ✓
//     Bug anterior:  "bitcoin-up-or-down-march-6-8am-et"  ← hora CIERRE ❌
//
//   La corrección es doble:
//     1. Truncar `now` a la hora UTC actual (candle open boundary).
//     2. Convertir ese instante a ET → usar su hora para el slug.
//   El código anterior añadía +1h y luego convertía a ET, cogiendo la hora de cierre.

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
 *
 * ⚠️ CLAVE: Polymarket usa la hora de APERTURA de la vela 1H en ET para el slug.
 * Algoritmo:
 *   1. Truncar now al inicio de la vela (floor a la hora UTC).
 *   2. Convertir ese candle-open UTC a ET → usar esa hora para el slug.
 *   3. Generar también ±1h como candidatos de respaldo.
 */
function buildSlugs(now) {
  // Truncar al inicio de la vela actual (candle open boundary)
  const candleOpenNow = new Date(now);
  candleOpenNow.setUTCMinutes(0, 0, 0);

  const slugs = [];
  for (const offset of [0, -1, 1]) {
    const candleOpen = new Date(candleOpenNow.getTime() + offset * 3600 * 1000);
    const etOpen     = toET(candleOpen);
    const slug = `bitcoin-up-or-down-${MONTHS[etOpen.getUTCMonth()]}-${etOpen.getUTCDate()}-${formatHour12(etOpen.getUTCHours())}-et`;
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
 * Fallback: deriva end_ms del slug cuando Polymarket no devuelve fecha parseable.
 *
 * ⚠️ El slug contiene la hora de APERTURA en ET.
 * Hora de cierre = hora de apertura + 1h.
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

    // La hora del slug = hora de APERTURA en ET
    let openHourET;
    if (hourStr === "12am")          openHourET = 0;
    else if (hourStr === "12pm")     openHourET = 12;
    else if (hourStr.endsWith("am")) openHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) openHourET = parseInt(hourStr, 10) + 12;
    else return null;

    // Cierre = apertura + 1h
    const closeHourET = (openHourET + 1) % 24;
    const closeDay    = openHourET === 23 ? day + 1 : day; // cruce medianoche

    const year          = now.getUTCFullYear();
    const candidateUtc  = new Date(Date.UTC(year, monthIdx, closeDay, 12, 0, 0));
    const etOffsetHours = isDST(candidateUtc) ? 4 : 5;

    const closeUtcMs = Date.UTC(year, monthIdx, closeDay, closeHourET + etOffsetHours, 0, 0, 0);

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
