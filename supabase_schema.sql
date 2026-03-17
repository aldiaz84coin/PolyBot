-- ============================================================
-- PolyBot — Supabase Schema v1.0
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ── 1. OPERACIONES ────────────────────────────────────────────
-- Una fila por cada trade ejecutado (real o simulado)
CREATE TABLE IF NOT EXISTS operations (
  id                   TEXT PRIMARY KEY,
  ts_entrada           TIMESTAMPTZ NOT NULL,
  ts_cierre            TIMESTAMPTZ,
  direccion            TEXT NOT NULL,         -- UP | DOWN
  ventana              TEXT NOT NULL,         -- T20 | T15 | T10 | T5
  entry_price          NUMERIC,               -- BTC spot al entrar
  target_price         NUMERIC,               -- apertura vela 1H Binance (Price-to-Beat)
  distancia            NUMERIC,               -- entry_price - target_price
  umbral               NUMERIC,               -- umbral usado en esa ventana
  odds_entrada         NUMERIC,               -- CLOB midpoint al entrar
  odds_salida          NUMERIC,               -- CLOB midpoint al salir (stop/cierre)
  real_exit_odds       NUMERIC,               -- precio real CLOB en resolución
  stake_usd            NUMERIC,               -- USDC invertidos
  tokens_comprados     NUMERIC,               -- tokens recibidos
  retorno_estimado_usd NUMERIC,               -- retorno teórico a odds_entrada
  retorno_real_usd     NUMERIC,               -- retorno efectivo cobrado
  pnl_usd              NUMERIC,               -- P&L neto en USD
  pnl_pct              NUMERIC,               -- P&L como % del stake
  resultado            TEXT DEFAULT 'PENDING', -- WIN | LOSS | STOP | PENDING
  market_slug          TEXT,
  simulado             BOOLEAN DEFAULT FALSE,
  source               TEXT DEFAULT 'bot',    -- bot | dashboard
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_operations_ts_entrada ON operations(ts_entrada DESC);
CREATE INDEX IF NOT EXISTS idx_operations_resultado   ON operations(resultado);
CREATE INDEX IF NOT EXISTS idx_operations_simulado    ON operations(simulado);
CREATE INDEX IF NOT EXISTS idx_operations_ventana     ON operations(ventana);
CREATE INDEX IF NOT EXISTS idx_operations_direccion   ON operations(direccion);

-- ── 2. SEÑALES EVALUADAS ───────────────────────────────────────
-- Registra cada señal accionable — útil para calibrar umbrales
-- (no registra WAIT para evitar ruido excesivo)
CREATE TABLE IF NOT EXISTS signal_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  btc_price    NUMERIC NOT NULL,
  target_price NUMERIC,
  distancia    NUMERIC,
  umbral       NUMERIC,
  ventana      TEXT,              -- T20 | T15 | T10 | T5
  direccion    TEXT,              -- UP | DOWN | WAIT
  accionable   BOOLEAN DEFAULT FALSE,
  market_slug  TEXT,
  hour_utc     SMALLINT,
  mins_left    NUMERIC,
  simulado     BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_signal_log_ts          ON signal_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_log_accionable  ON signal_log(accionable);
CREATE INDEX IF NOT EXISTS idx_signal_log_ventana     ON signal_log(ventana);

-- ── 3. SNAPSHOTS DE PRECIO BTC ────────────────────────────────
-- Muestreo cada ~5 min — permite reconstruir la curva de precios
CREATE TABLE IF NOT EXISTS price_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  btc_price    NUMERIC NOT NULL,
  target_price NUMERIC,
  market_slug  TEXT,
  hour_utc     SMALLINT,
  mins_left    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_ts ON price_snapshots(ts DESC);

-- ── 4. SESIONES DE MERCADO ────────────────────────────────────
-- Resumen por hora de mercado — permite análisis temporal
CREATE TABLE IF NOT EXISTS market_sessions (
  id           TEXT PRIMARY KEY,   -- formato: YYYY-MM-DD-HH (UTC)
  fecha        DATE NOT NULL,
  hour_utc     SMALLINT NOT NULL,
  market_slug  TEXT,
  ops          INTEGER DEFAULT 0,
  wins         INTEGER DEFAULT 0,
  losses       INTEGER DEFAULT 0,
  stops        INTEGER DEFAULT 0,
  pnl_usd      NUMERIC DEFAULT 0,
  stake_total  NUMERIC DEFAULT 0,
  simulado     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. VISTAS ANALÍTICAS ──────────────────────────────────────

-- Vista: rendimiento por ventana de entrada
CREATE OR REPLACE VIEW v_rendimiento_por_ventana AS
SELECT
  ventana,
  simulado,
  COUNT(*)                                                      AS total_ops,
  SUM(CASE WHEN resultado = 'WIN'  THEN 1 ELSE 0 END)          AS wins,
  SUM(CASE WHEN resultado IN ('LOSS','STOP') THEN 1 ELSE 0 END) AS losses,
  ROUND(
    SUM(CASE WHEN resultado = 'WIN' THEN 1 ELSE 0 END)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE resultado != 'PENDING'), 0) * 100, 1
  )                                                             AS win_rate_pct,
  ROUND(SUM(pnl_usd)::NUMERIC, 2)                               AS pnl_total_usd,
  ROUND(AVG(pnl_usd)::NUMERIC, 2)                               AS pnl_medio_usd,
  ROUND(AVG(odds_entrada)::NUMERIC, 4)                          AS odds_media
FROM operations
WHERE resultado != 'PENDING'
GROUP BY ventana, simulado
ORDER BY ventana, simulado;

-- Vista: rendimiento por dirección (UP/DOWN)
CREATE OR REPLACE VIEW v_rendimiento_por_direccion AS
SELECT
  direccion,
  simulado,
  COUNT(*)                                                      AS total_ops,
  SUM(CASE WHEN resultado = 'WIN'  THEN 1 ELSE 0 END)          AS wins,
  SUM(CASE WHEN resultado IN ('LOSS','STOP') THEN 1 ELSE 0 END) AS losses,
  ROUND(
    SUM(CASE WHEN resultado = 'WIN' THEN 1 ELSE 0 END)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE resultado != 'PENDING'), 0) * 100, 1
  )                                                             AS win_rate_pct,
  ROUND(SUM(pnl_usd)::NUMERIC, 2)                               AS pnl_total_usd
FROM operations
WHERE resultado != 'PENDING'
GROUP BY direccion, simulado
ORDER BY direccion, simulado;

-- Vista: P&L diario
CREATE OR REPLACE VIEW v_pnl_diario AS
SELECT
  DATE(ts_entrada AT TIME ZONE 'UTC') AS fecha,
  simulado,
  COUNT(*)                            AS ops,
  SUM(CASE WHEN resultado = 'WIN'  THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN resultado IN ('LOSS','STOP') THEN 1 ELSE 0 END) AS losses,
  ROUND(SUM(pnl_usd)::NUMERIC, 2)    AS pnl_usd,
  ROUND(SUM(stake_usd)::NUMERIC, 2)  AS invertido_usd
FROM operations
WHERE resultado != 'PENDING'
GROUP BY DATE(ts_entrada AT TIME ZONE 'UTC'), simulado
ORDER BY fecha DESC;

-- Vista: rendimiento por hora UTC del día
CREATE OR REPLACE VIEW v_rendimiento_por_hora AS
SELECT
  EXTRACT(HOUR FROM ts_entrada AT TIME ZONE 'UTC')::SMALLINT AS hour_utc,
  simulado,
  COUNT(*)                            AS ops,
  SUM(CASE WHEN resultado = 'WIN'  THEN 1 ELSE 0 END) AS wins,
  ROUND(
    SUM(CASE WHEN resultado = 'WIN' THEN 1 ELSE 0 END)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE resultado != 'PENDING'), 0) * 100, 1
  ) AS win_rate_pct,
  ROUND(SUM(pnl_usd)::NUMERIC, 2)    AS pnl_usd
FROM operations
WHERE resultado != 'PENDING'
GROUP BY EXTRACT(HOUR FROM ts_entrada AT TIME ZONE 'UTC'), simulado
ORDER BY hour_utc;

-- ── 6. ROW LEVEL SECURITY (opcional pero recomendado) ─────────
-- Descomenta si quieres restringir acceso con anon key.
-- Con service_role key el bot siempre puede escribir sin RLS.
--
-- ALTER TABLE operations      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE signal_log      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE price_snapshots ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE market_sessions ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "Allow service role full access" ON operations
--   USING (auth.role() = 'service_role');

-- ── LISTO ─────────────────────────────────────────────────────
-- Tras ejecutar este script ve a:
--   Supabase → Settings → API → copia:
--     - Project URL        → SUPABASE_URL
--     - service_role key   → SUPABASE_SERVICE_KEY
-- Añade esas variables en Railway (bot) y Vercel (dashboard).
