// app/api/price/route.js
// Proxy al feed de precios de Binance + CoinGecko como fallback

export const runtime = "edge";
export const revalidate = 0;

export async function GET() {
  try {
    // Primary: Binance
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      { next: { revalidate: 0 } }
    );
    if (res.ok) {
      const data = await res.json();
      return Response.json({
        price: parseFloat(data.price),
        source: "binance",
        ts: Date.now(),
      });
    }
    throw new Error("Binance unavailable");
  } catch {
    try {
      // Fallback: CoinGecko
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        { next: { revalidate: 0 } }
      );
      const data = await res.json();
      return Response.json({
        price: data.bitcoin.usd,
        source: "coingecko",
        ts: Date.now(),
      });
    } catch (e) {
      return Response.json(
        { error: "Price feed unavailable", detail: e.message },
        { status: 503 }
      );
    }
  }
}
