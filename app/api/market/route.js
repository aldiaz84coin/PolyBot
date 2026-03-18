/**
 * app/api/market/route.js — v6.4
 *
 * CAMBIOS v6.4:
 *   - Toda la lógica de búsqueda extraída a lib/market-fetch.js.
 *     Este handler es ahora un wrapper de una línea.
 *     Ventaja: /api/commands puede importar fetchActiveMarket() directamente
 *     sin hacer un fetch HTTP interno (que Vercel bloquea con 401).
 *
 * CAMBIOS v6.3 (referencia):
 *   - Fuente primaria: /api/bot-state; fallback: Gamma + CLOB.
 *   - Fallback lista activa para mercados sin slug directo.
 *
 * GET /api/market
 * → { active: bool, market: {...} | null, error?: string, slugs_tried: [...] }
 */

export const runtime  = "edge";
export const revalidate = 0;

import { fetchActiveMarket } from "../../../lib/market-fetch";

export async function GET() {
  const result = await fetchActiveMarket();
  return Response.json(result);
}
