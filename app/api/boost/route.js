/**
 * app/api/boost/route.js — v1.1
 *
 * CAMBIOS v1.1:
 *   - Fetch directo al endpoint de Crypto Detector (BOOST_POWER_URL) desde
 *     el servidor de Vercel, sin depender de que el bot haya escrito en
 *     bot_config. Así el panel siempre muestra un valor live.
 *   - bot_config readings se añaden si existen (lecturas históricas
 *     del bot en cada ventana T-xx).
 *
 * Variables de entorno necesarias en Vercel:
 *   BOOST_POWER_URL   = https://tu-dominio.com
 *   BOOST_POWER_MODE  = normal  (opcional, default "normal")
 */

import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "../../../lib/supabase";

const BOOST_KEYS = [
  { key: "boost_new_market", label: "NUEVO MERCADO" },
  { key: "boost_midpoint",   label: "MITAD HORA"   },
  { key: "boost_t_20",       label: "T-20"          },
  { key: "boost_t_15",       label: "T-15"          },
  { key: "boost_t_10",       label: "T-10"          },
  { key: "boost_t_5",        label: "T-5"           },
];

async function fetchLiveBP() {
  const baseUrl = process.env.BOOST_POWER_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;
  const mode = process.env.BOOST_POWER_MODE || "normal";
  try {
    const res = await fetch(
      `${baseUrl}/api/btc/boost-power?mode=${mode}`,
      { next: { revalidate: 0 }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success) return null;
    return {
      value:           data.analysis.boostPower,
      pct:             data.analysis.boostPowerPercent,
      classification:  data.analysis.classification,
      predictedChange: data.analysis.predictedChange,
      price:           data.asset.price,
      change24h:       data.asset.change24h,
      cached:          data.cached,
      ts:              data.calculatedAt,
      mode:            data.mode,
    };
  } catch {
    return null;
  }
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
  const [live, botReadings] = await Promise.all([
    fetchLiveBP(),
    fetchBotReadings(),
  ]);
  return NextResponse.json({ ok: true, live, readings: botReadings });
}
