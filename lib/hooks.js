// lib/hooks.js
"use client";
/**
 * hooks.js — v3.7
 *
 * CAMBIOS v3.7 — FIX tokens array vs objeto
 * ─────────────────────────────────────────────────────────────────────
 *  PROBLEMA:
 *    Cuando el mercado viene de bot-state, bm.tokens llega como ARRAY de
 *    Python: [{outcome:"Yes", price:0.55, token_id:"...", price_source:"clob"},
 *             {outcome:"No",  price:0.45, ...}].
 *    MarketInfo.jsx lee tokens.yes y tokens.no → undefined (arrays no tienen
 *    esas propiedades), por lo que los precios YES/NO siempre muestran "—".
 *
 *  FIX:
 *    Nueva función normalizeTokens() convierte cualquier formato al objeto
 *    canónico { yes: {...}, no: {...} } que espera MarketInfo.
 *    Soporta: array Python, objeto {yes,no}, o fallback a yes_price/no_price.
 *
 * CAMBIOS v3.6 (referencia):
 *   - useMarket() expone apiResponse.
 *   - useLog: genérico in-memory, alimentado desde Dashboard.jsx.
 *
 * EXPORTS:
 *   useBTCPrice(enabled?)  → { price, prev, source, error, loading }
 *   useMarket()            → { market, endMs, active, loading, error, apiResponse }
 *   useClock()             → Date (actualizado cada segundo)
 *   useLog(maxItems?)      → { log, add, clear }
 */

import { useState, useEffect, useCallback } from "react";

// ── useBTCPrice ───────────────────────────────────────────────────────────────

export function useBTCPrice(enabled = true) {
  const [price,   setPrice]   = useState(null);
  const [prev,    setPrev]    = useState(null);
  const [source,  setSource]  = useState(null);
  const [error,   setError]   = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchPrice = useCallback(async () => {
    if (!enabled) return;
    try {
      const res  = await fetch("/api/price", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.price) {
        setPrev(p => p ?? data.price);
        setPrice(old => { setPrev(old ?? data.price); return data.price; });
        setSource(data.source ?? null);
        setError(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    fetchPrice();
    const id = setInterval(fetchPrice, 5_000);
    return () => clearInterval(id);
  }, [fetchPrice, enabled]);

  return { price, prev, source, error, loading };
}

// ── Helpers internos ──────────────────────────────────────────────────────────

/**
 * normalizeTokens — convierte bm.tokens de cualquier formato al objeto
 * canónico { yes: { price, token_id, price_source }, no: { ... } }.
 *
 * Acepta:
 *   1. Array Python: [{outcome:"Yes",...},{outcome:"No",...}]
 *   2. Objeto {yes:{...}, no:{...}}   (ya normalizado)
 *   3. null/undefined                 (fallback a yes_price / no_price)
 */
function normalizeTokens(bm) {
  if (!bm) return { yes: null, no: null };

  // Caso 1: array Python (viene de market_scanner.py serializado como JSON array)
  if (Array.isArray(bm.tokens) && bm.tokens.length > 0) {
    const yesRaw = bm.tokens.find(t => t.outcome === "Yes") ?? null;
    const noRaw  = bm.tokens.find(t => t.outcome === "No")  ?? null;
    return {
      yes: yesRaw
        ? { price: yesRaw.price, token_id: yesRaw.token_id ?? null, price_source: yesRaw.price_source ?? "bot" }
        : (bm.yes_price != null ? { price: bm.yes_price, token_id: bm.yes_token_id ?? null, price_source: "bot" } : null),
      no: noRaw
        ? { price: noRaw.price, token_id: noRaw.token_id ?? null, price_source: noRaw.price_source ?? "bot" }
        : (bm.no_price  != null ? { price: bm.no_price,  token_id: bm.no_token_id  ?? null, price_source: "bot" } : null),
    };
  }

  // Caso 2: ya es objeto {yes, no} (formato normalizado)
  if (bm.tokens && !Array.isArray(bm.tokens) && (bm.tokens.yes !== undefined || bm.tokens.no !== undefined)) {
    return bm.tokens;
  }

  // Caso 3: tokens ausente — usar campos planos del bot-state
  return {
    yes: bm.yes_price != null
      ? { price: bm.yes_price, token_id: bm.yes_token_id ?? null, price_source: "bot" }
      : null,
    no: bm.no_price != null
      ? { price: bm.no_price, token_id: bm.no_token_id ?? null, price_source: "bot" }
      : null,
  };
}

// ── useMarket ─────────────────────────────────────────────────────────────────
//
// Fuentes (en orden de prioridad):
//   1. /api/bot-state   → mercado + target + precio tal como los ve el bot.
//   2. /api/market      → búsqueda independiente desde Vercel (fallback).
//
// Ambas fuentes se consultan en paralelo. El bot-state tiene prioridad
// cuando está fresco.
//
// IMPORTANTE: siempre se setea un error explícito si market es null,
// nunca se deja el par (market=null, error=null/falsy) que causa
// "Buscando mercado activo..." permanente en MarketInfo.
//
// Retorna apiResponse para que el caller pueda pasar datos de diagnóstico
// (slugs_tried, errors, dst_active) a <MarketInfo>.
// ─────────────────────────────────────────────────────────────────────────────
export function useMarket() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchMarket = useCallback(async () => {
    try {
      // ── Consultar ambas fuentes en paralelo ──────────────────────────────
      const [botStateRes, marketRes] = await Promise.allSettled([
        fetch("/api/bot-state").then(r => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/market").then(r  => r.ok ? r.json() : null).catch(() => null),
      ]);

      const botState  = botStateRes.status === "fulfilled" ? botStateRes.value : null;
      const marketApi = marketRes.status   === "fulfilled" ? marketRes.value   : null;

      // ── Fuente 1: bot-state (si bot fresco y tiene mercado) ─────────────
      const botFresh = botState && !botState.stale && botState.market;

      if (botFresh) {
        const bm = botState.market;

        // FIX v3.7: normalizar tokens independientemente del formato que mande Python
        const tokens = normalizeTokens(bm);

        const normalized = {
          active: true,
          market: {
            slug:          bm.slug          ?? botState.slug ?? null,
            question:      bm.question      ?? null,
            condition_id:  bm.condition_id  ?? null,
            end_date_iso:  bm.end_date_iso  ?? null,
            end_ms:        bm.end_ms        ?? null,
            mins_to_close: bm.mins_to_close ?? null,
            volume:        bm.volume        ?? null,
            liquidity:     bm.liquidity     ?? null,
            neg_risk:      bm.neg_risk      ?? false,
            tokens,
            _debug: { source: "bot-state", bot_age_ms: botState.age_ms },
          },
          _source: "bot-state",
        };
        setData(normalized);
        setError(null);
        setLoading(false);
        return;
      }

      // ── Fuente 2: /api/market (Gamma + CLOB desde Vercel) ───────────────
      if (marketApi) {
        setData(marketApi);

        if (marketApi.active === false) {
          // || en vez de ?? — captura string vacío además de null/undefined
          setError(marketApi.error || "Mercado BTC no encontrado");
        } else if (!marketApi.market) {
          // active=true pero market=null → fuerza error para evitar "Buscando..."
          setError("API respondió active=true pero sin datos de mercado");
        } else {
          setError(null);
        }
        setLoading(false);
        return;
      }

      // ── Ambas fuentes fallaron ───────────────────────────────────────────
      setData(null);
      setError("No se pudo obtener el mercado activo");

    } catch (e) {
      setError(e.message || "Error al cargar el mercado");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMarket();
    const id = setInterval(fetchMarket, 20_000);
    return () => clearInterval(id);
  }, [fetchMarket]);

  const market = data?.market ?? null;
  const endMs  = market?.end_ms ?? null;

  return {
    market,
    endMs,
    active:      data?.active ?? false,
    loading,
    error,
    // apiResponse: datos crudos de la fuente (incluye slugs_tried, errors,
    // dst_active) — pasar a <MarketInfo> para diagnóstico en el panel de error.
    apiResponse: data,
  };
}

// ── Reloj local (actualiza cada segundo) ──────────────────────────────────
export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── Log de eventos del bot ─────────────────────────────────────────────────
//
// Hook genérico in-memory. La alimentación con eventos reales del bot
// ocurre en Dashboard.jsx vía dos mecanismos:
//   1. useEffect sobre botState (eventos en tiempo real mientras el
//      dashboard está abierto).
//   2. useEffect al montar que carga /api/events (historial desde Vercel).
//
export function useLog(maxItems = 100) {
  const [log, setLog] = useState([]);

  const add = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
    setLog(l => [{ ts, msg, type, id: Math.random() }, ...l.slice(0, maxItems - 1)]);
  }, [maxItems]);

  const clear = useCallback(() => setLog([]), []);

  return { log, add, clear };
}
