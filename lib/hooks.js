// lib/hooks.js
"use client";
/**
 * hooks.js — v3.2
 *
 * CAMBIOS v3.2:
 *   - useBalance: eliminados `balance` y `pnlDay` del return público.
 *     El "balance" hardcodeado a 500 no tenía relación con config.stake_usdc
 *     y creaba confusión en la stats bar.
 *     pnlDay ahora se calcula en Dashboard.jsx directamente desde el array
 *     `bets` (fuente canónica: Supabase), lo que garantiza persistencia
 *     entre recargas y correcta sincronización.
 *   - applyResult en LOSS corregido: ya no usaba stopLossPct/100 para
 *     actualizar el P&L interno (ese % es umbral de salida, no pérdida real).
 *   - useBalance sigue exportando applyBet / applyResult para que el
 *     ciclo auto-bet / auto-resolve de Dashboard.jsx siga funcionando
 *     sin cambios en esa lógica.
 */

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

// ── Mercado Polymarket activo ──────────────────────────────────────────────
// Devuelve end_ms (timestamp ms del cierre) para que el Dashboard
// calcule minsLeft en tiempo real con useClock().
// apiResponse expone la respuesta completa para diagnóstico en UI.
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

  const market      = data?.market ?? null;
  const endMs       = market?.end_ms ?? null;
  const priceToBeat = market?.price_to_beat ?? null;

  return {
    market,
    endMs,
    priceToBeat,
    active:      data?.active ?? false,
    loading,
    error,
    apiResponse: data,   // ← respuesta completa para diagnóstico
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

// ── Gestión interna de apuesta activa ─────────────────────────────────────
/**
 * useBalance — v3.2
 *
 * Mantiene un balance de sesión para animar la posición activa en tiempo
 * real (cuándo se "aparta" el stake al entrar, cuándo vuelve al salir).
 *
 * YA NO expone `balance` ni `pnlDay` en el return:
 *   - `balance` era un número ficticio hardcodeado a 500 sin relación
 *     con config.stake_usdc, lo que producía la stat bar incorrecta.
 *   - `pnlDay` se calcula ahora en Dashboard.jsx desde el array `bets`
 *     para que persista entre recargas y sea siempre coherente con Supabase.
 *
 * Solo se exportan applyBet / applyResult para el ciclo auto-bet.
 */
export function useBalance() {
  const [_balance, setBalance] = useState(0);  // solo uso interno de sesión

  const applyBet = useCallback((stake) => {
    setBalance(b => b - stake);
  }, []);

  // v3.2: en LOSS la pérdida real es el stake completo (ya descontado por
  // applyBet). stopLossPct es el umbral de salida anticipada, no el % de
  // pérdida final → ya no se usa aquí para evitar el cálculo incorrecto.
  const applyResult = useCallback((stake, won) => {
    if (won) {
      setBalance(b => b + stake * 1.9);
    }
    // LOSS: el stake ya fue descontado en applyBet, no hay ajuste adicional.
  }, []);

  return { applyBet, applyResult };
}
