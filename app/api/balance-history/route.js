/**
 * app/api/balance-history/route.js — v1.0
 *
 * Persistencia del historial de portfolio en Supabase.
 *
 * GET  /api/balance-history?limit=500
 *   → { ok: true, data: [{ ts, usdc, total }, ...] }
 *   Devuelve los últimos N snapshots ordenados ASC (para el gráfico).
 *
 * POST /api/balance-history  { ts, usdc, total }
 *   → { ok: true }
 *   Inserta un nuevo snapshot. El caller es responsable de no llamar
 *   si el delta es insignificante (lógica SNAPSHOT_MIN_DELTA en el widget).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSupabase } from "../../../lib/supabase";

const DEFAULT_LIMIT = 500;

// ── GET /api/balance-history ──────────────────────────────────────────────────

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? DEFAULT_LIMIT, 10), 2000);

  const sb = getSupabase();
  if (!sb) {
    return Response.json(
      { ok: false, error: "Supabase no configurado", data: [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // Traemos los últimos `limit` puntos en DESC y luego invertimos para ASC
    const { data, error } = await sb
      .from("balance_history")
      .select("ts, usdc, total")
      .order("ts", { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Invertir para que el gráfico los reciba cronológicamente
    const sorted = (data ?? []).reverse();

    return Response.json(
      { ok: true, data: sorted },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[balance-history/GET]", e.message);
    return Response.json(
      { ok: false, error: e.message, data: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// ── POST /api/balance-history ─────────────────────────────────────────────────

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Body JSON inválido" }, { status: 400 });
  }

  const { ts, usdc, total } = body;

  if (ts == null || usdc == null || total == null) {
    return Response.json(
      { ok: false, error: "Faltan campos: ts, usdc, total" },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb) {
    // Sin Supabase: aceptar silenciosamente (el widget ya guardó en localStorage)
    return Response.json({ ok: true, source: "noop-no-supabase" });
  }

  try {
    const { error } = await sb
      .from("balance_history")
      .insert({ ts, usdc, total });

    if (error) throw error;

    return Response.json({ ok: true });
  } catch (e) {
    console.error("[balance-history/POST]", e.message);
    return Response.json(
      { ok: false, error: e.message },
      { status: 500 }
    );
  }
}
