// app/api/target/route.js
// Obtiene el precio OPEN de la vela 1H ACTUAL de Binance (= Price to Beat)
// ⚠️  IMPORTANTE: con limit=2 los klines llegan en orden ASCENDENTE:
//     klines[0] = vela ANTERIOR (ya cerrada)
//     klines[1] = vela ACTUAL   (en curso)  ← esta es la correcta
// Usamos limit=1 para evitar ambigüedad: siempre devuelve solo la vela actual.

export const runtime   = "edge";
export const revalidate = 0;

const BINANCE_KLINES =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1";

// Cabeceras anti-caché que se añaden a TODAS las respuestas
const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma":        "no-cache",
};

export async function GET() {
  try {
    const res = await fetch(BINANCE_KLINES, {
      cache: "no-store",            // evita caché de fetch en edge runtime
      next:  { revalidate: 0 },
    });

    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

    const klines = await res.json();

    // Con limit=1 solo hay una entrada: la vela en curso
    const candle    = klines[0];
    const open      = parseFloat(candle[1]);
    const high      = parseFloat(candle[2]);
    const low       = parseFloat(candle[3]);
    const close     = parseFloat(candle[4]);
    const openTime  = new Date(candle[0]);   // inicio de la vela (= hh:00:00 UTC)
    const closeTime = new Date(candle[6]);   // cierre teórico (= hh+1:00:00 UTC)

    const minsToClose = (closeTime.getTime() - Date.now()) / 60_000;

    // Hora UTC del OPEN de la vela (debe coincidir con la hora UTC actual)
    const candleHourUtc = openTime.getUTCHours();

    return Response.json(
      {
        target:           open,     // ← OPEN real de la vela 1H actual = Price to Beat
        open,
        high,
        low,
        close,
        open_time:        openTime.toISOString(),
        close_time:       closeTime.toISOString(),
        candle_hour_utc:  candleHourUtc,   // ← para que el cliente valide que es la hora correcta
        mins_to_close:    Math.max(0, minsToClose),
        source:           "binance_klines",
        ts:               Date.now(),
      },
      { headers: NO_CACHE }
    );

  } catch (err) {
    // Fallback: el target es null, el cliente debe mostrar advertencia
    const now       = new Date();
    const openTime  = new Date(now);
    openTime.setMinutes(0, 0, 0);
    const closeTime    = new Date(openTime.getTime() + 3_600_000);
    const minsToClose  = (closeTime.getTime() - now.getTime()) / 60_000;

    return Response.json(
      {
        target:          null,
        error:           err.message,
        open_time:       openTime.toISOString(),
        close_time:      closeTime.toISOString(),
        candle_hour_utc: openTime.getUTCHours(),
        mins_to_close:   Math.max(0, minsToClose),
        source:          "fallback_clock",
        ts:              Date.now(),
      },
      { status: 200, headers: NO_CACHE }
    );
  }
}
