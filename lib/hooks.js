// lib/hooks.js
"use client";
/**
 * hooks.js — v3.6
 *
 * CAMBIOS v3.6:
 *   - useMarket() ya exponía apiResponse pero Dashboard no lo usaba.
 *     Documentado explícitamente. Sin cambios de lógica — la fuente
 *     primaria sigue siendo /api/bot-state, fallback /api/market.
 *   - useLog: sin cambios. La alimentación con eventos reales del bot
 *     (botState changes + carga histórica de /api/events) se hace en
 *     Dashboard.jsx para no mezclar lógica de UI con hooks genéricos.
 *
 * CAMBIOS v3.5 — FIX "Buscando mercado activo..." permanente
 * ─────────────────────────────────────────────────────────────
 *  PROBLEMA:
 *    Cuando la Gamma API devuelve { active: false, error: "" } (string vacío),
 *    el operador ?? no lo capturaba → setError("") → error="" que es FALSY
 *    en JS → MarketInfo: if(error) === false → muestra "Buscando..." en vez
 *    del panel de error.
 *
 *  FIXES:
 *    1. Cambiado ?? por || en todos los fallbacks de strings de error.
 *    2. Añadido caso explícito: active=true pero market=null → fuerza error.
 *    3. setData(null) cuando ambas fuentes fallan para no dejar datos stale.
 *    4. setData(null) también en el catch, misma razón.
 *
 * CAMBIOS v3.4 (referencia):
 *   - useMarket() usa /api/bot-state como fuente PRIMARIA cuando el bot está
 *     fresco (age_ms < 90s). Fallback a /api/market si bot-state no tiene
 *     mercado o el bot está inactivo.
 *
 * CAMBIOS v3.3:
 *   - useBalance ELIMINADO. El bot es la ÚNICA fuente de escritura en Supabase.
 *
 * EXPORTS:
 *   useBTCPrice(enabled?)  → { price, prev, source, error, loading }
 *   useMarket()            → { market, endMs, active, loading, error, apiResponse }
 *   useClock()             → Date (actualizado cada segundo)
 *   useLog(maxItems?)      → { log, add, clear }
 */

import { useState, useEffect, useCallback } from "react";
import { POLL_INTERVAL_MS } from "./constants";

// ── Precio BTC ─────────────────────────────────────────────────────────────
export function useBTCPrice(enabled = true) {
  const [price, setPrice]     = useState(null);
  const [prev, setPrev]       = useState(null);
  const [source, setSource]   = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchPrice = useCallback(async () => {
    try {
      const res  = await fetch("/api/price");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPrice(cur => { setPrev(cur); return data.price; });
      setSource(data.source);
      setError(null);
    } catch (e) {
      setError(e.message || "Error al obtener precio BTC");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchPrice();
    const id = setInterval(fetchPrice, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, fetchPrice]);

  return { price, prev, source, error, loading };
}

// ── Mercado Polymarket activo ──────────────────────────────────────────────
//
// Estrategia de fuentes (v3.4 / v3.5 / v3.6):
//   1. /api/bot-state   → el bot (Railway) ya resolvió el mercado;
//                         lo usamos directamente si tiene age_ms < 90s.
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
        const bm  = botState.market;
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
            tokens: bm.tokens ?? {
              yes: bm.yes_price != null
                ? { price: bm.yes_price, token_id: bm.yes_token_id ?? null, price_source: "bot" }
                : null,
              no: bm.no_price != null
                ? { price: bm.no_price,  token_id: bm.no_token_id  ?? null, price_source: "bot" }
                : null,
            },
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
//   2. useEffect al montar que carga /api/events (historial de Supabase).
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
