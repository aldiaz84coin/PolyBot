// app/api/bets/route.js
// Historial de operaciones — almacenamiento en módulo (persiste mientras el
// proceso Railway / Vercel esté activo). El frontend complementa con
// localStorage para persistencia entre sesiones del navegador.
//
// Campos extendidos v2.5:
//   odds, retorno_est, pnl_usd, pnl_est_pct, market_slug, simulated

import { NextResponse } from "next/server";

/** @type {Map<string, object>} */
const store = new Map();     // clave: bet.id → datos completos
const MAX   = 1000;          // máximo de ops en memoria

// ── GET — devuelve historial completo o filtrado ──────────────────────────
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const date   = searchParams.get("date");    // filtro YYYY-MM-DD
  const result = searchParams.get("result");  // WIN | LOSS | STOP | PENDING
  const limit  = parseInt(searchParams.get("limit") || "200", 10);

  let list = Array.from(store.values()).reverse(); // más recientes primero

  if (date)   list = list.filter(b => b.ts?.startsWith(date));
  if (result) list = list.filter(b => b.result === result);

  // Resumen de P&L
  const closed  = list.filter(b => b.result !== "PENDING");
  const pnl_usd = closed.reduce((s, b) => s + (b.pnl_usd ?? 0), 0);
  const wins    = closed.filter(b => b.result === "WIN").length;
  const losses  = closed.filter(b => ["LOSS", "STOP"].includes(b.result)).length;

  return NextResponse.json({
    bets:     list.slice(0, limit),
    count:    store.size,
    summary: {
      total:   closed.length,
      wins,
      losses,
      win_rate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null,
      pnl_usd:  +pnl_usd.toFixed(2),
    },
    ts: Date.now(),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

// ── POST — registra una operación nueva ──────────────────────────────────
export async function POST(req) {
  try {
    const bet      = await req.json();
    bet.server_ts  = Date.now();
    bet.result     = bet.result ?? "PENDING";
    bet.pnl_usd    = bet.pnl_usd ?? null;

    // Evitar duplicados por id
    if (bet.id && store.has(bet.id)) {
      return NextResponse.json({ ok: true, id: bet.id, duplicate: true });
    }

    // Límite de tamaño: borrar las más antiguas
    if (store.size >= MAX) {
      const oldest = Array.from(store.keys()).slice(0, 50);
      oldest.forEach(k => store.delete(k));
    }

    store.set(bet.id || Date.now().toString(36), bet);
    return NextResponse.json({ ok: true, id: bet.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}

// ── PATCH — actualiza resultado y P&L de una operación existente ─────────
export async function PATCH(req) {
  try {
    const { id, result, pnl, pnl_usd } = await req.json();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id requerido" }, { status: 400 });
    }

    if (store.has(id)) {
      const existing = store.get(id);
      store.set(id, {
        ...existing,
        result,
        pnl:       pnl    ?? existing.pnl,
        pnl_usd:   pnl_usd ?? existing.pnl_usd,
        closed_ts: Date.now(),
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}

// ── DELETE — limpia el historial (útil para testing) ─────────────────────
export async function DELETE() {
  store.clear();
  return NextResponse.json({ ok: true, cleared: true });
}
