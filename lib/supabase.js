/**
 * lib/supabase.js — v1.0
 * Cliente Supabase para Next.js (server-side API routes).
 *
 * Usar SOLO en API Routes (app/api/), nunca importar desde componentes
 * del lado cliente — la SERVICE_KEY no debe exponerse al browser.
 *
 * Variables de entorno requeridas (Vercel):
 *   SUPABASE_URL          → https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY  → service_role key (Settings → API)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let _client = null;

/**
 * Devuelve el cliente Supabase singleton.
 * Si las variables de entorno no están configuradas, devuelve null.
 */
export function getSupabase() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[Supabase] SUPABASE_URL / SUPABASE_SERVICE_KEY no configuradas");
    return null;
  }
  try {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
    return _client;
  } catch (e) {
    console.error("[Supabase] Error creando cliente:", e.message);
    return null;
  }
}

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);
