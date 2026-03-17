// lib/hooks.js
"use client";
/**
 * hooks.js — v3.3
 *
 * CAMBIOS v3.3:
 *   - useBalance ELIMINADO por completo.
 *     El dashboard ya no crea ni resuelve operaciones localmente.
 *     El bot (Railway) es la ÚNICA fuente de escritura en Supabase.
 *     El dashboard solo lee desde /api/bets cada 10s.
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
      setError(e.message);
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
export function useMarket() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchMarket = useCallback(async () => {
    try {
      const res  = await fetch("/api/market");
      const json = await res.json();
      setData(json);
      if (json.active === false) {
        setError(json.error || "Mercado no encontrado");
      } else {
        setError(null);
      }
    } catch (e) {
      setError(e.message);
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
export function useLog(maxItems = 100) {
  const [log, setLog] = useState([]);
  const add = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
    setLog(l => [{ ts, msg, type, id: Math.random() }, ...l.slice(0, maxItems - 1)]);
  }, [maxItems]);
  const clear = useCallback(() => setLog([]), []);
  return { log, add, clear };
}
