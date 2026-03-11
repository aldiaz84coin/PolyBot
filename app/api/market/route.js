// app/api/market/route.js
// Obtiene el mercado BTC Up/Down activo en Polymarket Gamma API
//
// FIX v5 (PRECIOS LIVE DESDE CLOB):
//   La Gamma API devuelve tokens[].price con precios cacheados, no en tiempo real.
//   Los precios que ve el usuario en polymarket.com vienen del CLOB (orderbook).
//   Ahora se enriquecen SIEMPRE desde el CLOB tras obtener los token IDs:
//     GET https://clob.polymarket.com/midpoint?token_id={id} → {"mid": "0.73"}
//   Fallback: precio de Gamma si el CLOB no responde para ese token.
//
// FIX v4 (BUG TIEMPO RESTANTE 00:00):
//   parseEndMs() podía devolver un timestamp del mercado ANTERIOR (ya expirado).
//   Solución: si endMs < now, ignorarlo y usar slugToEndMs() como fuente de verdad.
//
// FIX v3 (BUG SLUG HORA):
//   La hora del slug es la APERTURA de la vela 1H en ET (no el cierre).

export const runtime = "edge";
export const revalidate = 0;

const GAMMA         = "https://gamma-api.polymarket.com";
const CLOB_MIDPOINT = "https://clob.polymarket.com/midpoint";

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
 * Polymarket usa la hora de APERTURA de la vela 1H en ET para el slug.
 */
function buildSlugs(now) {
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
 * FIX v4: si endMs ya está en el pasado, devuelve null para usar slugToEndMs().
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
    const hourStr = parts[monthPartIdx + 2];
    if (!day || !hourStr) return null;

    let openHourET;
    if (hourStr === "12am")          openHourET = 0;
    else if (hourStr === "12pm")     openHourET = 12;
    else if (hourStr.endsWith("am")) openHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) openHourET = parseInt(hourStr, 10) + 12;
    else return null;

    const closeHourET = (openHourET + 1) % 24;
    const closeDay    = openHourET === 23 ? day + 1 : day;

    const year         = now.getUTCFullYear();
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
 * FIX v5: Obtiene el precio live del token desde el CLOB (midpoint).
 * El midpoint es el precio real que Polymarket muestra en su UI.
 * No requiere autenticación.
 * Devuelve null si el CLOB no responde o falla.
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

      // ── FIX v5: precios live desde CLOB ───────────────────────────────
      // Fetch en paralelo para ambos tokens (más rápido que secuencial)
      const [yesLivePrice, noLivePrice] = await Promise.all([
        fetchLivePrice(yesT?.token_id ?? null),
        fetchLivePrice(noT?.token_id  ?? null),
      ]);

      // Precio final: CLOB live si disponible, Gamma como fallback
      const yesPrice  = yesLivePrice  ?? (yesT ? parseFloat(yesT.price) : null);
      const noPrice   = noLivePrice   ?? (noT  ? parseFloat(noT.price)  : null);
      const yesSrc    = yesLivePrice  != null ? "clob" : "gamma";
      const noSrc     = noLivePrice   != null ? "clob" : "gamma";
      // ── ────────────────────────────────────────────────────────────────

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
          price_sources:    { yes: yesSrc, no: noSrc },
          gamma_prices:     {
            yes: yesT ? parseFloat(yesT.price) : null,
            no:  noT  ? parseFloat(noT.price)  : null,
          },
          clob_prices:      { yes: yesLivePrice, no: noLivePrice },
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
