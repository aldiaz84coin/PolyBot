/**
 * app/api/boost/route.js — v1.0
 * Devuelve las lecturas de BoostPower almacenadas por el bot en bot_config.
 *
 * Claves leídas de Supabase bot_config:
 *   boost_new_market  — lectura al detectar nuevo mercado
 *   boost_midpoint    — lectura a mitad de hora (mins_left ≤ 30)
 *   boost_t_20        — lectura al entrar en T-20
 *   boost_t_15        — lectura al entrar en T-15
 *   boost_t_10        — lectura al entrar en T-10
 *   boost_t_5         — lectura al entrar en T-5
 *
 * Cada valor es JSON: { value: 0.38, ts: "2026-...", mins_left?: 28.3, slug?: "..." }
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

export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 });
  }

  try {
    const supabase = getSupabase();
    const keys     = BOOST_KEYS.map(b => b.key);

    const { data, error } = await supabase
      .from("bot_config")
      .select("key, value")
      .in("key", keys);

    if (error) throw error;

    const map = {};
    for (const row of (data || [])) {
      try { map[row.key] = JSON.parse(row.value); }
      catch { map[row.key] = { value: null }; }
    }

    const readings = BOOST_KEYS.map(({ key, label }) => ({
      key,
      label,
      ...(map[key] ?? { value: null, ts: null }),
    }));

    return NextResponse.json({ ok: true, readings });

  } catch (err) {
    console.error("[boost/GET]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
