// lib/hooks.js
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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

// ── Mercado Polymarket activo ───────────────────────────────────────────────
// Devuelve end_ms (timestamp ms del cierre) para que el Dashboard
// calcule minsLeft en tiempo real con useClock(), en vez de usar
// el valor estático de la API (que queda desactualizado).
// También expone price_to_beat: el "Price to Beat" del mercado.
export function useMarket() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchMarket = useCallback(async () => {
    try {
      const res  = await fetch("/api/market");
      const json = await res.json();
      setData(json);
      setError(json.active === false ? (json.error || "Mercado no encontrado") : null);
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

  const market      = data?.market ?? null;
  const endMs       = market?.end_ms ?? null;
  const priceToBeat = market?.price_to_beat ?? null;

  return {
    market,
    endMs,          // ← usar con useClock() para minsLeft en tiempo real
    priceToBeat,    // ← "Price to Beat" extraído del mercado de Polymarket
    active:  data?.active ?? false,
    loading,
    error,
  };
}

// ── Reloj local (actualiza cada segundo) ───────────────────────────────────
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

// ── Balance simulado ───────────────────────────────────────────────────────
export function useBalance(initial = 500) {
  const [balance, setBalance] = useState(initial);
  const [pnlDay, setPnlDay]   = useState(0);

  const applyBet = useCallback((stake) => {
    setBalance(b => b - stake);
  }, []);

  const applyResult = useCallback((stake, won, stopLossPct) => {
    if (won) {
      setBalance(b => b + stake * 1.9);
      setPnlDay(d => d + stake * 0.9);
    } else {
      setPnlDay(d => d - stake * (stopLossPct / 100));
    }
  }, []);

  return { balance, pnlDay, applyBet, applyResult };
}
