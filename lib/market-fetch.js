// lib/market-fetch.js — v1.1
//
// CAMBIOS v1.1 — FIX 500 INTERNO:
//   - fetchActiveMarket() envuelto en try/catch global — nunca lanza.
//   - findInActiveList: elementos null/undefined en array de Gamma ya no crashean.
//     Antes: m.slug sobre elemento null → TypeError → excepción no capturada → 500.
//   - formatMarket: envuelto en try/catch individual; si falla devuelve un objeto
//     mínimo para que el mercado siga mostrándose aunque el parsing de fecha falle.
//   - enrichTokens: errores individuales de precio CLOB ya no propagan.
//
// CAMBIOS v1.0 (referencia):
//   Módulo compartido extraído de /api/market y /api/commands para evitar
//   llamadas HTTP internas que Vercel bloquea con 401.
//
// Exporta:
//   fetchActiveMarket()  → { active, market, error?, slugs_tried, dst_active, now_utc }
//   buildSlugs(now)      → string[]
//   isDST(utcDate)       → boolean

const GAMMA      = "https://gamma-api.polymarket.com";
const CLOB_MID   = "https://clob.polymarket.com/midpoint";
const TIMEOUT_MS = 7000;

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

// ── DST helpers ───────────────────────────────────────────────────────────────

export function isDST(utcDate) {
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

// ── Slug generation ───────────────────────────────────────────────────────────

export function buildSlugs(now) {
  const candleOpenNow = new Date(now);
  candleOpenNow.setUTCMinutes(0, 0, 0);

  const slugs = [];
  for (const offset of [0, -1, 1]) {
    const candleOpen = new Date(candleOpenNow.getTime() + offset * 3600 * 1000);
    const et         = toET(candleOpen);
    const slug = [
      "bitcoin-up-or-down",
      MONTHS[et.getUTCMonth()],
      et.getUTCDate(),
      et.getUTCFullYear(),
      formatHour12(et.getUTCHours()),
      "et",
    ].join("-");
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

// ── CLOB midpoint price ───────────────────────────────────────────────────────

async function fetchClobPrice(tokenId) {
  try {
    const res = await fetch(`${CLOB_MID}?token_id=${tokenId}`, {
      cache:  "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const mid  = data?.mid;
    return mid != null ? parseFloat(mid) : null;
  } catch {
    return null;
  }
}

// ── Token reconstruction from clobTokenIds ────────────────────────────────────

function rebuildTokens(raw) {
  const ids = raw?.clobTokenIds ?? raw?.clob_token_ids ?? [];
  if (!ids.length) return [];
  return [
    { outcome: "Yes", token_id: ids[0], price: null, price_source: "none" },
    ...(ids[1] ? [{ outcome: "No", token_id: ids[1], price: null, price_source: "none" }] : []),
  ];
}

// ── Enrich tokens with live CLOB prices ───────────────────────────────────────

async function enrichTokens(tokens) {
  return Promise.all(
    tokens.map(async (t) => {
      if (!t.token_id) return t;
      try {
        const live = await fetchClobPrice(t.token_id);
        return live != null
          ? { ...t, price: live,    price_source: "clob"  }
          : { ...t, price_source: "gamma" };
      } catch {
        return { ...t, price_source: "gamma" };
      }
    })
  );
}

// ── Parse end timestamp ───────────────────────────────────────────────────────

function parseEndMs(raw) {
  const candidate =
    raw?.endDateIso ?? raw?.end_date_iso ?? raw?.endDate ?? raw?.end_date ??
    raw?.closeTime  ?? raw?.close_time   ?? null;
  if (!candidate) return null;
  if (typeof candidate === "number") {
    return candidate < 2e10 ? candidate * 1000 : candidate;
  }
  try { return new Date(candidate).getTime(); } catch { return null; }
}

// ── Format final market object ────────────────────────────────────────────────

function formatMarket(raw, tokens, slugsTried, now) {
  // FIX v1.1: envuelto en try/catch — si el parsing falla, devuelve objeto mínimo
  try {
    const yes = tokens.find(t => t.outcome === "Yes");
    const no  = tokens.find(t => t.outcome === "No");

    let end_ms = parseEndMs(raw);

    // Fallback: deriva end_ms desde el slug si Gamma no lo incluye
    if (!end_ms && raw.slug) {
      const parts      = raw.slug.split("-");
      const monthPartI = parts.findIndex(p => MONTHS.includes(p));
      if (monthPartI !== -1) {
        const monthIdx    = MONTHS.indexOf(parts[monthPartI]);
        const day         = parseInt(parts[monthPartI + 1], 10);
        const year        = parseInt(parts[monthPartI + 2], 10);
        const hourStr     = parts[monthPartI + 3] ?? "";
        let   openHourET  = 0;
        if      (hourStr === "12am")          openHourET = 0;
        else if (hourStr === "12pm")          openHourET = 12;
        else if (hourStr.endsWith("am"))      openHourET = parseInt(hourStr, 10);
        else if (hourStr.endsWith("pm"))      openHourET = parseInt(hourStr, 10) + 12;
        const closeHourET = (openHourET + 1) % 24;
        const closeDay    = openHourET === 23 ? day + 1 : day;
        const etOff       = isDST(new Date(Date.UTC(year, monthIdx, closeDay, 12, 0, 0))) ? 4 : 5;
        end_ms = new Date(Date.UTC(year, monthIdx, closeDay, closeHourET + etOff, 0, 0)).getTime();
      }
    }

    const minsLeft = end_ms ? Math.max(0, (end_ms - now.getTime()) / 60000) : null;

    return {
      slug:          raw.slug          ?? null,
      question:      raw.question      ?? raw.title ?? null,
      condition_id:  raw.conditionId   ?? raw.condition_id ?? null,
      end_date_iso:  raw.endDateIso    ?? raw.end_date_iso ?? raw.endDate ?? null,
      end_ms:        end_ms            ?? null,
      mins_to_close: minsLeft != null  ? Math.round(minsLeft * 100) / 100 : null,
      volume:        raw.volume        != null ? parseFloat(raw.volume)    : null,
      liquidity:     raw.liquidity     != null ? parseFloat(raw.liquidity) : null,
      neg_risk:      raw.neg_risk      ?? false,
      tokens: {
        yes: yes ? { token_id: yes.token_id, price: yes.price, price_source: yes.price_source } : null,
        no:  no  ? { token_id: no.token_id,  price: no.price,  price_source: no.price_source  } : null,
      },
      _debug: {
        slugs_tried,
        found_slug:    raw.slug ?? null,
        price_sources: { yes: yes?.price_source, no: no?.price_source },
        enriched:      tokens.some(t => t.price_source === "clob"),
      },
    };
  } catch (err) {
    // Objeto mínimo para que el mercado siga visible aunque el parsing falle
    return {
      slug:          raw?.slug     ?? null,
      question:      raw?.question ?? raw?.title ?? null,
      condition_id:  null,
      end_date_iso:  null,
      end_ms:        null,
      mins_to_close: null,
      volume:        null,
      liquidity:     null,
      neg_risk:      raw?.neg_risk ?? false,
      tokens:        { yes: null, no: null },
      _debug: {
        slugs_tried,
        found_slug:   raw?.slug ?? null,
        format_error: err?.message ?? "formatMarket falló",
      },
    };
  }
}

// ── Fallback: busca en listas activas ─────────────────────────────────────────

async function findInActiveList(slugSet) {
  const urls = [
    `${GAMMA}/markets?active=true&closed=false&limit=50&order=endDate&ascending=true`,
    `${GAMMA}/markets?active=true&closed=false&limit=50&tag=bitcoin`,
    `${GAMMA}/markets?active=true&closed=false&limit=100`,
    `${GAMMA}/markets?active=true&closed=false&limit=300`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data?.markets ?? []);

      // FIX v1.1: filtrar elementos null/undefined antes de acceder a propiedades
      const validList = list.filter(m => m != null && typeof m === "object");

      for (const m of validList) {
        if (slugSet.has(m.slug)) return m;
      }

      // Fallback adicional: cualquier mercado BTC up-or-down activo
      for (const m of validList) {
        const q = (m.question ?? m.title ?? m.slug ?? "").toLowerCase();
        if (q.includes("bitcoin") && q.includes("up-or-down") && m.active !== false) {
          return m;
        }
      }
    } catch {
      // continuar con la siguiente URL
    }
  }
  return null;
}

// ── Función principal exportada ───────────────────────────────────────────────

/**
 * Busca el mercado BTC activo en Polymarket (Gamma + CLOB).
 * Llama directamente a las APIs externas sin pasar por rutas HTTP internas.
 * NUNCA lanza — siempre devuelve un objeto bien formado.
 *
 * @returns {{ active: boolean, market: object|null, error?: string,
 *             slugs_tried: string[], dst_active: boolean, now_utc: string }}
 */
export async function fetchActiveMarket() {
  // FIX v1.1: try/catch global — fetchActiveMarket nunca lanza
  let now;
  let slugs = [];
  try {
    now    = new Date();
    slugs  = buildSlugs(now);
    const errors = [];
    let   raw    = null;

    // ── Intento 1: búsqueda directa por slug ───────────────────────────────
    for (const slug of slugs) {
      try {
        const res = await fetch(
          `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`,
          { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }
        );
        if (!res.ok) { errors.push({ slug, error: `HTTP ${res.status}` }); continue; }
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) { raw = data[0]; break; }
        if (data && !Array.isArray(data) && data.slug) { raw = data; break; }
      } catch (e) {
        errors.push({ slug, error: e?.message ?? "timeout" });
      }
    }

    // ── Intento 2: fallback por lista activa ───────────────────────────────
    if (!raw) {
      raw = await findInActiveList(new Set(slugs));
    }

    // ── No encontrado ──────────────────────────────────────────────────────
    if (!raw) {
      return {
        active:      false,
        market:      null,
        error:       "Mercado BTC no encontrado en Gamma API",
        slugs_tried: slugs,
        errors,
        dst_active:  isDST(now),
        now_utc:     now.toISOString(),
      };
    }

    // ── Procesar tokens ────────────────────────────────────────────────────
    let tokens = Array.isArray(raw.tokens) ? [...raw.tokens] : [];
    if (!tokens.length) tokens = rebuildTokens(raw);
    tokens = tokens.map(t => ({
      ...t,
      token_id: t.token_id ?? t.tokenId ?? null,
    }));
    tokens = await enrichTokens(tokens);

    const market = formatMarket(raw, tokens, slugs, now);

    return {
      active:      true,
      market,
      dst_active:  isDST(now),
      now_utc:     now.toISOString(),
      slugs_tried: slugs,
    };

  } catch (err) {
    // Captura cualquier excepción que se haya colado
    const message = err?.message ?? String(err) ?? "Error desconocido";
    return {
      active:      false,
      market:      null,
      error:       `fetchActiveMarket excepción: ${message}`,
      slugs_tried: slugs,
      errors:      [{ slug: "top-level", error: message }],
      dst_active:  now ? isDST(now) : null,
      now_utc:     now ? now.toISOString() : new Date().toISOString(),
    };
  }
}
