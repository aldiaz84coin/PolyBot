// app/api/target/route.js
// Obtiene el precio OPEN de la vela 1H actual de Binance
// Esto es el "Price to Beat" / Target de Polymarket

export const runtime = "edge";
export const revalidate = 0;

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2";

export async function GET() {
  try {
    const res = await fetch(BINANCE_KLINES, { next: { revalidate: 0 } });

    if (!res.ok) {
      throw new Error(`Binance HTTP ${res.status}`);
    }

    const klines = await res.json();

    // klines[0] = vela actual (en curso)
    // Formato: [openTime, open, high, low, close, volume, closeTime, ...]
    const currentCandle = klines[0];
    const open      = parseFloat(currentCandle[1]);
    const high      = parseFloat(currentCandle[2]);
    const low       = parseFloat(currentCandle[3]);
    const close     = parseFloat(currentCandle[4]);
    const openTime  = new Date(currentCandle[0]);
    const closeTime = new Date(currentCandle[6]);

    // Cuántos minutos quedan para cerrar la vela (= cierre del evento Polymarket)
    const minsToClose = (closeTime.getTime() - Date.now()) / 60000;

    return Response.json({
      target:        open,           // ← OPEN real de la vela 1H = Price to Beat
      open,
      high,
      low,
      close,
      open_time:     openTime.toISOString(),
      close_time:    closeTime.toISOString(),
      mins_to_close: Math.max(0, minsToClose),
      source:        "binance_klines",
      ts:            Date.now(),
    });

  } catch (err) {
    // Fallback: calcula el open time de la hora actual como aproximación
    const now       = new Date();
    const openTime  = new Date(now);
    openTime.setMinutes(0, 0, 0);
    const closeTime = new Date(openTime.getTime() + 3600_000);
    const minsToClose = (closeTime.getTime() - now.getTime()) / 60000;

    return Response.json(
      {
        target:        null,
        error:         err.message,
        open_time:     openTime.toISOString(),
        close_time:    closeTime.toISOString(),
        mins_to_close: Math.max(0, minsToClose),
        source:        "fallback_clock",
        ts:            Date.now(),
      },
      { status: 200 } // 200 para que el cliente maneje el error gracefully
    );
  }
}
