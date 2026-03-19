"use client";
/**
 * lib/hooks.js — v4.0
 *
 * CAMBIOS v4.0
 * ─────────────────────────────────────────────────────────────────────
 * 1. useBotState() — nuevo hook dedicado que encapsula TODO el polling
 *    de /api/bot-state. Expone: status, running, stale, target, slug,
 *    window, ops_today, bet_active, age_ms.
 *    → Elimina el useEffect inline en Dashboard.jsx para botState.
 *
 * 2. useMarket() — ya no hace su propio fetch de /api/bot-state.
 *    Ahora acepta botState como parámetro opcional para usarlo como
 *    fuente prioritaria (sin duplicar la petición HTTP).
 *    Si botState no se pasa, sigue haciendo fetch independiente (backward compat).
 *
 * 3. normalizeTokens() — sin cambios, v3.7.
 *
 * EXPORTS:
 *   useBotState()              → { status, running, stale, target, slug, market, ... }
 *   useBTCPrice(enabled?)      → { price, prev, source, error, loading }
 *   useMarket(botState?)       → { market, endMs, active, loading, error, apiResponse }
 *   useClock()                 → Date (actualizado cada segundo)
 *   useLog(maxItems?)          → { log, add, clear }
 */

import { useState, useEffect, useCallback } from "react";

// ── useBotState ───────────────────────────────────────────────────────────────
//
// Fuente única de verdad para el estado del bot.
// Polling cada 5s. Retorna todo lo que publica /api/bot-state.

const BOTSTATE_MS = 5_000;

export function useBotState() {
  const [state, setState] = useState(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/bot-state", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState(data);
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, BOTSTATE_MS);
    return () => clearInterval(id);
  }, [fetch_]);

  const running = state?.status === "running" && !state?.stale;
  const stale   = state?.stale  ?? false;

  return {
    raw:        state,
    status:     state?.status     ?? "offline",
    running,
    stale,
    target:     state?.target     ?? null,
    slug:       state?.slug       ?? null,
    market:     state?.market     ?? null,   // mercado completo del bot
    window:     state?.window     ?? null,
    ops_today:  state?.ops_today  ?? null,
    bet_active: state?.bet_active ?? null,
    age_ms:     state?.age_ms     ?? null,
  };
}

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

  // Caso 1: array Python
  if (Array.isArray(bm.tokens) && bm.tokens.length > 0) {
    const yesRaw = bm.tokens.find(t =>
      t.outcome === "Yes" || t.outcome === "yes" || t.outcome === "UP"
    ) ?? null;
    const noRaw = bm.tokens.find(t =>
      t.outcome === "No"  || t.outcome === "no"  || t.outcome === "DOWN"
    ) ?? null;
    return {
      yes: yesRaw
        ? { price: yesRaw.price, token_id: yesRaw.token_id ?? null, price_source: yesRaw.price_source ?? "bot" }
        : (bm.yes_price != null ? { price: bm.yes_price, token_id: bm.yes_token_id ?? null, price_source: "bot" } : null),
      no: noRaw
        ? { price: noRaw.price, token_id: noRaw.token_id ?? null, price_source: noRaw.price_source ?? "bot" }
        : (bm.no_price  != null ? { price: bm.no_price,  token_id: bm.no_token_id  ?? null, price_source: "bot" } : null),
    };
  }

  // Caso 2: ya es objeto {yes, no}
  if (bm.tokens && !Array.isArray(bm.tokens) &&
      (bm.tokens.yes !== undefined || bm.tokens.no !== undefined)) {
    return bm.tokens;
  }

  // Caso 3: campos planos
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
// Acepta botState (del useBotState hook) como fuente 1.
// Si botState es fresco y tiene market, lo usa directamente (0 HTTP calls extra).
// Fallback a /api/market si bot está stale o no tiene mercado.
//
// IMPORTANTE: el parámetro botState es OPCIONAL para compatibilidad.

export function useMarket(botState = null) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const fetchMarket = useCallback(async (externalBotState) => {
    try {
      // ── Fuente 1: botState externo (ya fetcheado, 0 HTTP calls) ─────────
      const bs       = externalBotState;
      const botFresh = bs && !bs.stale && bs.market;

      if (botFresh) {
        const bm = bs.market;
        const tokens = normalizeTokens(bm);
        setData({
          active: true,
          market: {
            slug:          bm.slug          ?? bs.slug ?? null,
            question:      bm.question      ?? null,
            condition_id:  bm.condition_id  ?? null,
            end_date_iso:  bm.end_date_iso  ?? null,
            end_ms:        bm.end_ms        ?? null,
            mins_to_close: bm.mins_to_close ?? null,
            volume:        bm.volume        ?? null,
            liquidity:     bm.liquidity     ?? null,
            neg_risk:      bm.neg_risk      ?? false,
            tokens,
            _debug: { source: "bot-state", bot_age_ms: bs.age_ms },
          },
          _source: "bot-state",
        });
        setError(null);
        setLoading(false);
        return;
      }

      // ── Fuente 2: /api/market (Gamma + CLOB desde Vercel) ───────────────
      const res = await fetch("/api/market", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const marketApi = await res.json();

      setData(marketApi);
      if (marketApi.active === false) {
        setError(marketApi.error || "Mercado BTC no encontrado");
      } else if (!marketApi.market) {
        setError("API respondió active=true pero sin datos de mercado");
      } else {
        setError(null);
      }
      setLoading(false);

    } catch (e) {
      setError(e.message || "Error al cargar el mercado");
      setData(null);
      setLoading(false);
    }
  }, []);

  // Si recibimos botState desde fuera, reaccionar a sus cambios
  useEffect(() => {
    if (botState !== null) {
      fetchMarket(botState);
    }
  }, [botState, fetchMarket]);

  // Polling independiente solo si no hay botState externo
  useEffect(() => {
    if (botState !== null) return; // ya manejado arriba
    fetchMarket(null);
    const id = setInterval(() => fetchMarket(null), 20_000);
    return () => clearInterval(id);
  }, [botState, fetchMarket]);

  const market = data?.market ?? null;
  const endMs  = market?.end_ms ?? null;

  return {
    market,
    endMs,
    active:      data?.active      ?? false,
    loading,
    error,
    apiResponse: data,
  };
}

// ── Reloj local ───────────────────────────────────────────────────────────────
export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── useLog ────────────────────────────────────────────────────────────────────
export function useLog(maxItems = 100) {
  const [log, setLog] = useState([]);
  const add   = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
    setLog(l => [{ ts, msg, type, id: Math.random() }, ...l.slice(0, maxItems - 1)]);
  }, [maxItems]);
  const clear = useCallback(() => setLog([]), []);
  return { log, add, clear };
}
