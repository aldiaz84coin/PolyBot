// app/api/target/route.js
// Obtiene el precio OPEN de la vela 1H de Binance correspondiente al mercado activo.
//
// v6.2 — FIX SLUG AÑO:
//   Polymarket cambió el formato del slug para incluir el año:
//     Antes : bitcoin-up-or-down-march-16-12pm-et
//     Ahora : bitcoin-up-or-down-march-16-2026-12pm-et
//   parseCandleStartFromSlug(): monthPart+1=día, monthPart+2=año, monthPart+3=hora
//
// v3 — La hora del slug = hora de APERTURA en ET (no el cierre).

export const runtime = "edge";
export const revalidate = 0;

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";

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

/**
 * Parsea el slug para obtener el startTime UTC (ms) de la vela 1H.
 *
 * FIX v6.2: nuevo formato incluye año
 *   Slug: "bitcoin-up-or-down-{month}-{day}-{year}-{hour}-et"
 *   → monthPart+1 = día
 *   → monthPart+2 = año  (NUEVO — era la hora)
 *   → monthPart+3 = hora (NUEVO — era +2)
 *
 * La hora del slug = hora de APERTURA de la vela en ET (directamente).
 *   openHourUTC = openHourET + etOffset (4 con EDT, 5 con EST)
 *
 * Ejemplo: "bitcoin-up-or-down-march-16-2026-12pm-et"
 *   openHourET = 12
 *   Con EDT (UTC-4): openHourUTC = 16 → startTime = 2026-03-16T16:00:00Z
 */
function parseCandleStartFromSlug(slug) {
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
    const year    = parseInt(parts[monthPartIdx + 2], 10); // ← FIX v6.2
    const hourStr = parts[monthPartIdx + 3];               // ← FIX v6.2 (era +2)
    if (!day || !year || !hourStr) return null;

    // La hora del slug = hora de APERTURA en ET (directamente)
    let openHourET;
    if (hourStr === "12am")          openHourET = 0;
    else if (hourStr === "12pm")     openHourET = 12;
    else if (hourStr.endsWith("am")) openHourET = parseInt(hourStr, 10);
    else if (hourStr.endsWith("pm")) openHourET = parseInt(hourStr, 10) + 12;
    else return null;

    const candidateUtc  = new Date(Date.UTC(year, monthIdx, day, 12, 0, 0));
    const etOffsetHours = isDST(candidateUtc) ? 4 : 5;

    const startTimeUtc = new Date(Date.UTC(year, monthIdx, day, openHourET + etOffsetHours, 0, 0, 0));
    return startTimeUtc.getTime();
  } catch {
    return null;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug") ?? null;

  const params = new URLSearchParams({
    symbol:   "BTCUSDT",
    interval: "1h",
    limit:    "1",
  });

  let startTimeMs   = null;
  let startTimeUsed = false;

  if (slug) {
    startTimeMs = parseCandleStartFromSlug(slug);
    if (startTimeMs) {
      params.set("startTime", String(startTimeMs));
      startTimeUsed = true;
    }
  }

  try {
    const url = `${BINANCE_KLINES}?${params}`;
    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
      return Response.json(
        { error: `Binance HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const klines = await res.json();
    if (!klines || klines.length === 0) {
      return Response.json({ error: "No klines returned" }, { status: 502 });
    }

    const kline = klines[0];
    const openPrice  = parseFloat(kline[1]);
    const high       = parseFloat(kline[2]);
    const low        = parseFloat(kline[3]);
    const close      = parseFloat(kline[4]);
    const openTimeMs = kline[0];

    return Response.json({
      target:          openPrice,
      open:            openPrice,
      high,
      low,
      close,
      open_time_utc:   new Date(openTimeMs).toISOString(),
      close_time_utc:  new Date(kline[6]).toISOString(),
      slug_used:       slug ?? null,
      start_time_used: startTimeUsed,
      start_time_ms:   startTimeMs,
      ts:              Date.now(),
    });
  } catch (e) {
    return Response.json(
      { error: "Binance unavailable", detail: e.message },
      { status: 503 }
    );
  }
}
