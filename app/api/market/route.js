/**
 * app/api/market/route.js — v6.5
 *
 * CAMBIOS v6.5:
 *   - FIX CRÍTICO: envuelto en try/catch global para evitar 500 opaco.
 *     Antes: cualquier excepción no capturada en fetchActiveMarket() → HTTP 500
 *     sin body JSON → hook recibe null → dashboard muestra error genérico.
 *     Ahora: siempre devuelve JSON con { active: false, error: "..." } y HTTP 200,
 *     lo que permite al dashboard mostrar información de diagnóstico útil.
 *
 * CAMBIOS v6.4 (referencia):
 *   - Toda la lógica de búsqueda extraída a lib/market-fetch.js.
 *
 * GET /api/market
 * → { active: bool, market: {...} | null, error?: string, slugs_tried: [...] }
 */

export const runtime   = "edge";
export const revalidate = 0;

import { fetchActiveMarket } from "../../../lib/market-fetch";

export async function GET() {
  try {
    const result = await fetchActiveMarket();
    return Response.json(result);
  } catch (err) {
    // Nunca devolver 500 — siempre JSON para que el dashboard pueda mostrarlo
    const message = err?.message ?? String(err) ?? "Error desconocido en fetchActiveMarket";
    console.error("[/api/market] Excepción no controlada:", message, err?.stack ?? "");
    return Response.json({
      active:      false,
      market:      null,
      error:       `Error interno: ${message}`,
      slugs_tried: [],
      errors:      [{ slug: "route-level", error: message }],
      dst_active:  null,
      now_utc:     new Date().toISOString(),
    });
  }
}
