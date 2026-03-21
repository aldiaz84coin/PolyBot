// app/api/datalab/route.js
// DataLab API — series temporales de precios de tokens y datos de velas BTC
//
// Endpoints:
//   GET ?type=token_prices&slug=...&hour=...&fecha=YYYY-MM-DD&limit=N
//   GET ?type=candle_data&limit=N&fecha_desde=YYYY-MM-DD
//   GET ?type=window_stats    → odds medias por ventana
//   GET ?type=hours_heatmap   → volumen y rango por hora del día

export const runtime = "edge";
export const revalidate = 0;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(table, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "token_prices";

  try {
    if (type === "token_prices") {
      // Serie temporal de precios YES/NO
      const slug   = searchParams.get("slug")  ?? "";
      const hour   = searchParams.get("hour")  ?? "";
      const fecha  = searchParams.get("fecha") ?? "";
      const limit  = parseInt(searchParams.get("limit") ?? "500");

      let params = `?order=ts.asc&limit=${limit}&select=ts,hour_utc,yes_price,no_price,ventana,mins_left,btc_price,btc_target,simulado`;
      if (slug)  params += `&market_slug=eq.${encodeURIComponent(slug)}`;
      if (hour)  params += `&hour_utc=eq.${hour}`;
      if (fecha) {
        params += `&ts=gte.${fecha}T00:00:00Z&ts=lte.${fecha}T23:59:59Z`;
      }

      const data = await supabase("token_price_log", params);
      return Response.json({ data, count: data.length });
    }

    if (type === "candle_data") {
      // Historial de velas 1H
      const limit      = parseInt(searchParams.get("limit") ?? "168"); // 7 días
      const fechaDesde = searchParams.get("fecha_desde") ?? "";

      let params = `?order=fecha.desc&order=hour_utc.desc&limit=${limit}&select=*`;
      if (fechaDesde) params += `&fecha=gte.${fechaDesde}`;

      const data = await supabase("btc_candle_data", params);
      return Response.json({ data, count: data.length });
    }

    if (type === "window_stats") {
      // Odds medias por ventana — desde la vista
      const params = "?order=ventana.asc&select=ventana,simulado,muestras,avg_yes_price,avg_no_price,min_yes_price,max_yes_price,std_yes_price";
      const data = await supabase("v_token_odds_by_window", params);
      return Response.json({ data });
    }

    if (type === "hours_heatmap") {
      // Volumen y rango por hora del día — desde la vista
      const params = "?order=hour_utc.asc&select=hour_utc,velas,avg_volume_btc,avg_volume_usdt,avg_trades,avg_range_usd,avg_range_pct";
      const data = await supabase("v_candle_stats_by_hour", params);
      return Response.json({ data });
    }

    if (type === "available_dates") {
      // Fechas disponibles en token_price_log para el selector
      const data = await supabase(
        "token_price_log",
        "?select=ts&order=ts.desc&limit=1000"
      );
      // Extraer fechas únicas
      const dates = [...new Set(data.map(r => r.ts.slice(0, 10)))].sort().reverse();
      return Response.json({ dates });
    }

    return Response.json({ error: `type desconocido: ${type}` }, { status: 400 });

  } catch (e) {
    console.error("[datalab]", e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
