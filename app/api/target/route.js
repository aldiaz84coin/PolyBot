// app/api/target/route.js
// Obtiene el precio OPEN de la vela 1H de Binance correspondiente al mercado activo.
// El "Price to Beat" en Polymarket es el OPEN de la vela 1H cuya HORA DE CIERRE
// aparece en el slug (p.ej. "bitcoin-up-or-down-march-6-6am-et" → cierre 6am ET,
// apertura 5am ET = 9:00 UTC con EDT).
//
// ⚠️ REGRESIÓN CORREGIDA:
//    El código anterior usaba limit=2 con klines[0].
//    Con limit=2, Binance devuelve en orden ASCENDENTE:
//      klines[0] = vela ANTERIOR ya cerrada  → precio INCORRECTO ❌
//      klines[1] = vela ACTUAL en curso      → precio correcto
//    Con limit=1:
//      klines[0] = vela ACTUAL en curso      → precio correcto ✓
//    Además, si se pasa ?slug= podemos pedir la vela exacta por startTime.

export const runtime = "edge";
export const revalidate = 0;

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

// ── DST helper (mismo que en market/route.js) ─────────────────────────────
function isDST(utcDate) {
  const year     = utcDate.getUTCFullYear();
  const march    = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));
  const nov      = new Date(Date.UTC(year, 10, 1));
  const dstEnd   = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7));
  return utcDate >= dstStart && utcDate < dstEnd;
}

/**
 * Parsea el slug para obtener el startTime UTC (ms) de la vela 1H.
 *
 * Slug: "bitcoin-up-or-down-{month}-{day}-{hour}-et"
 * La hora en el slug es la HORA DE CIERRE de la vela en ET.
 *   → Hora apertura ET  = hora cierre ET - 1
 *   → Hora apertura UTC = hora apertura ET + |ET offset| (4 con EDT, 5 con EST)
 *
 * Ejemplo: "bitcoin-up-or-down-march-6-6am-et" (6 Marzo 2025)
 *   closeHourET = 6  → openHourET = 5
 *   Con EDT (UTC-4): openHourUTC = 5 + 4 = 9 → startTime = 2025-03-06T09:00:00Z
 */
function parseCandleStartFromSlug(slug) {
  try {
    // Ejemplo: ["bitcoin","up","or","down","march","6","6am","et"]
    const parts = slug.split("-");

    // Buscar el mes en los tokens
    let monthIdx = -1;
    let monthPartIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const m = MONTHS.indexOf(parts[i]);
      if (m !== -1) { monthIdx = m; monthPartIdx = i; break; }
    }
    if (monthIdx === -1) return null;

    const day     = parseInt(parts[monthPartIdx + 1], 10);
    const hourStr = parts[monthPartIdx + 2]; // "6am", "12pm", "12am", ...
    if (!day || !hourStr) return null;

    // Parsear hora 12h → 24h
    let closeHourET;
    if (hourStr === "12am")        closeHourET = 0;
    else if (hourStr === "12pm")   closeHourET = 12;
    else if (hourStr.endsWith("am")) closeHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) closeHourET = parseInt(hourStr, 10) + 12;
    else return null;

    // Apertura = cierre - 1h
    const openHourET = (closeHourET - 1 + 24) % 24;

    // Construir la fecha UTC de apertura de la vela:
    // Si openHourET < closeHourET (caso normal), el día es el mismo.
    // Si openHourET > closeHourET (medianoche: cierre=0am → apertura=23h del día anterior)
    const now  = new Date();
    const year = now.getUTCFullYear();

    // Estimamos el día: si openHourET wraps al día anterior, restamos 1
    let dayForOpen = day;
    if (openHourET > closeHourET) dayForOpen -= 1; // cruce de medianoche

    // Calculamos el UTC de apertura usando offset DST del momento candidato
    // Primero probamos con DST del año actual
    const candidateUtc = new Date(Date.UTC(year, monthIdx, dayForOpen, 12, 0, 0));
    const etOffsetHours = isDST(candidateUtc) ? 4 : 5; // |UTC offset| de ET

    const startTimeUtc = new Date(Date.UTC(year, monthIdx, dayForOpen, openHourET + etOffsetHours, 0, 0, 0));
    return startTimeUtc.getTime();
  } catch {
    return null;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug") ?? null;

  try {
    let fetchUrl;
    let candleStartMs = null;

    if (slug) {
      candleStartMs = parseCandleStartFromSlug(slug);
    }

    if (candleStartMs) {
      // Pedimos la vela exacta de esa hora por startTime (más robusto)
      fetchUrl = `${BINANCE_KLINES}?symbol=BTCUSDT&interval=1h&startTime=${candleStartMs}&limit=1`;
    } else {
      // Sin slug: limit=1 devuelve SOLO la vela actual (no limit=2 que devuelve la anterior primero)
      fetchUrl = `${BINANCE_KLINES}?symbol=BTCUSDT&interval=1h&limit=1`;
    }

    const res = await fetch(fetchUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

    const klines = await res.json();
    if (!klines || klines.length === 0) throw new Error("Binance: sin datos de vela");

    // Con limit=1 o startTime+limit=1: klines[0] = siempre la vela correcta
    const candle    = klines[0];
    const open      = parseFloat(candle[1]);
    const high      = parseFloat(candle[2]);
    const low       = parseFloat(candle[3]);
    const close     = parseFloat(candle[4]);
    const openTime  = new Date(candle[0]);
    const closeTime = new Date(candle[6]);
    const minsToClose = (closeTime.getTime() - Date.now()) / 60000;

    return Response.json({
      target:          open,           // ← OPEN de la vela 1H = Price to Beat
      open,
      high,
      low,
      close,
      candle_hour_utc: openTime.getUTCHours(),   // ← necesario para staleness check
      open_time:       openTime.toISOString(),
      close_time:      closeTime.toISOString(),
      mins_to_close:   Math.max(0, minsToClose),
      source:          candleStartMs ? "binance_klines_slug" : "binance_klines",
      slug_used:       slug,
      ts:              Date.now(),
    });

  } catch (err) {
    // Fallback: calcula el open time de la hora actual como aproximación
    const now      = new Date();
    const openTime = new Date(now);
    openTime.setUTCMinutes(0, 0, 0);
    const closeTime   = new Date(openTime.getTime() + 3600_000);
    const minsToClose = (closeTime.getTime() - now.getTime()) / 60000;

    return Response.json(
      {
        target:          null,
        error:           err.message,
        candle_hour_utc: openTime.getUTCHours(),
        open_time:       openTime.toISOString(),
        close_time:      closeTime.toISOString(),
        mins_to_close:   Math.max(0, minsToClose),
        source:          "fallback_clock",
        slug_used:       slug,
        ts:              Date.now(),
      },
      { status: 200 },
    );
  }
}
