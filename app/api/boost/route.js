/**
 * app/api/boost/route.js — v1.2
 * Expone error de diagnóstico cuando live falla.
 */

import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "../../../lib/supabase";

const BOOST_KEYS = [
  { key: "boost_new_market", label: "NUEVO MERCADO" },
  { key: "boost_midpoint",   label: "MITAD HORA"   },
  { key: "boost_t_50",       label: "T-50"          },
  { key: "boost_t_40",       label: "T-40"          },
  { key: "boost_t_30",       label: "T-30"          },
  { key: "boost_t_25",       label: "T-25"          },
  { key: "boost_t_20",       label: "T-20"          },
  { key: "boost_t_15",       label: "T-15"          },
  { key: "boost_t_10",       label: "T-10"          },
  { key: "boost_t_5",        label: "T-5"           },
];

async function fetchLiveBP() {
  const baseUrl = process.env.BOOST_POWER_URL?.replace(/\/$/, "");
  if (!baseUrl) return { data: null, error: "BOOST_POWER_URL no definida en Vercel" };

  const mode = process.env.BOOST_POWER_MODE || "normal";
  const url  = `${baseUrl}/api/btc/boost-power?mode=${mode}`;

  let res;
  try {
    res = await fetch(url, {
      next:   { revalidate: 0 },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { data: null, error: `fetch error: ${e.message}` };
  }

  if (!res.ok) {
    return { data: null, error: `HTTP ${res.status} desde ${url}` };
  }

  let json;
  try { json = await res.json(); }
  catch (e) { return { data: null, error: `JSON parse error: ${e.message}` }; }

  if (!json?.success) {
    return { data: null, error: `API error: ${json?.error ?? "success=false"}` };
  }

  return {
    data: {
      value:           json.analysis.boostPower,
      pct:             json.analysis.boostPowerPercent,
      classification:  json.analysis.classification,
      predictedChange: json.analysis.predictedChange,
      price:           json.asset.price,
      change24h:       json.asset.change24h,
      cached:          json.cached,
      ts:              json.calculatedAt,
      mode:            json.mode,
    },
    error: null,
  };
}

async function fetchBotReadings() {
  if (!isConfigured()) return [];
  try {
    const supabase = getSupabase();
    const keys     = BOOST_KEYS.map(b => b.key);
    const { data, error } = await supabase
      .from("bot_config")
      .select("key, value")
      .in("key", keys);
    if (error) return [];
    const map = {};
    for (const row of (data || [])) {
      try { map[row.key] = JSON.parse(row.value); }
      catch { map[row.key] = { value: null }; }
    }
    return BOOST_KEYS.map(({ key, label }) => ({
      key, label, ...(map[key] ?? { value: null, ts: null }),
    }));
  } catch {
    return [];
  }
}

export async function GET() {
  const [liveResult, botReadings] = await Promise.all([
    fetchLiveBP(),
    fetchBotReadings(),
  ]);

  return NextResponse.json({
    ok:         true,
    live:       liveResult.data,
    liveError:  liveResult.error,   // ← visible en Network tab
    readings:   botReadings,
    debug: {
      boostUrlSet: !!process.env.BOOST_POWER_URL,
      boostUrl:    process.env.BOOST_POWER_URL?.slice(0, 30) + "…",  // parcial por seguridad
    },
  });
}
