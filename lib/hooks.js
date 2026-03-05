// lib/hooks.js
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { POLL_INTERVAL_MS } from "./constants";

// ── Precio BTC desde /api/price ────────────────────────────────────────────
export function useBTCPrice(enabled = true) {
  const [price, setPrice]     = useState(null);
  const [prev, setPrev]       = useState(null);
  const [source, setSource]   = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch("/api/price");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPrev(p => (p !== data.price ? p : p));
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
export function useMarket(enabled = true) {
  const [market, setMarket]     = useState(null);
  const [minsLeft, setMinsLeft] = useState(null);
  const [error, setError]       = useState(null);

  const fetchMarket = useCallback(async () => {
    try {
      const res = await fetch("/api/market");
      const data = await res.json();
      setMarket(data.market);
      setMinsLeft(data.mins_to_close);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchMarket();
    const id = setInterval(fetchMarket, 30_000); // cada 30s es suficiente
    return () => clearInterval(id);
  }, [enabled, fetchMarket]);

  return { market, minsLeft, error };
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

// ── Balance simulado (persiste en sessionStorage) ──────────────────────────
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
