-- ============================================================
-- PolyBot — Supabase Migration v2.0
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- Prerequisito: supabase_schema.sql (v1.0) ya ejecutado
-- ============================================================

-- ── 5. BOT CONFIG ─────────────────────────────────────────────
-- Configuración compartida en tiempo real entre bot y dashboard.
-- Ambos leen/escriben aquí; el bot recarga cada 60s.
CREATE TABLE IF NOT EXISTS bot_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed: modo por defecto = simulado
INSERT INTO bot_config (key, value) VALUES
  ('trading_mode',      'simulate'),
  ('mode_changed_by',   'system'),
  ('mode_changed_at',   NOW()::TEXT)
ON CONFLICT (key) DO NOTHING;

-- ── 6. BOT COMMANDS ───────────────────────────────────────────
-- Canal de comunicación dashboard → bot.
-- El dashboard inserta un comando (status=pending).
-- El bot lo detecta, lo ejecuta y actualiza status+result.
-- El dashboard hace polling del status hasta done|error.
CREATE TABLE IF NOT EXISTS bot_commands (
  id         BIGSERIAL PRIMARY KEY,
  command    TEXT NOT NULL,           -- check_clob | check_balance | test_order
  params     JSONB DEFAULT '{}',      -- {direction:'UP', stake:1.0} para test_order
  status     TEXT DEFAULT 'pending',  -- pending | running | done | error
  result     JSONB DEFAULT '{}',      -- resultado estructurado del bot
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_commands_status     ON bot_commands(status);
CREATE INDEX IF NOT EXISTS idx_bot_commands_created    ON bot_commands(created_at DESC);

-- Limpieza automática de comandos > 24h (opcional, ejecutar manualmente si quieres)
-- DELETE FROM bot_commands WHERE created_at < NOW() - INTERVAL '24 hours';
