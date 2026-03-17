# Configuración de Supabase para PolyBot

## 1. Crear proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com) → **New Project**
2. Elige un nombre (ej. `polybot-db`) y región EU (West)
3. Guarda bien la **Database Password** — la necesitarás para acceso directo si quieres
4. Espera ~2 min a que el proyecto se aprovisione

## 2. Ejecutar el schema SQL

1. En el dashboard de Supabase → **SQL Editor** → **New query**
2. Pega el contenido de `supabase_schema.sql` (en la raíz del repo)
3. Pulsa **Run**
4. Verifica que se crearon:
   - Tablas: `operations`, `signal_log`, `price_snapshots`, `market_sessions`
   - Vistas: `v_rendimiento_por_ventana`, `v_rendimiento_por_direccion`, `v_pnl_diario`, `v_rendimiento_por_hora`

## 3. Obtener credenciales

Supabase Dashboard → **Settings → API**:

| Variable              | Valor                                      |
|-----------------------|--------------------------------------------|
| `SUPABASE_URL`        | Project URL (ej. `https://xxx.supabase.co`)|
| `SUPABASE_SERVICE_KEY`| `service_role` key (la larga, secreta)     |

⚠️ **NUNCA** uses la `anon` key en el bot ni en las API routes del servidor.
La `service_role` bypassa RLS y tiene acceso total — trátala como una contraseña.

## 4. Configurar Railway (bot)

En tu proyecto Railway → **Variables**:

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGc...
```

Redeploy el bot. Deberías ver en los logs:
```
[DB] ✅ Conectado a Supabase
[MONITOR] 🚀 Iniciando — ... db=✅
```

## 5. Configurar Vercel (dashboard)

En tu proyecto Vercel → **Settings → Environment Variables**:

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGc...
```

Redeploy el dashboard. Al abrir el historial cargará desde Supabase.

## 6. Instalar dependencia Python

```bash
cd bot
pip install supabase>=2.4.0
```

O simplemente redeploya en Railway — el `requirements.txt` ya incluye `supabase`.

## 7. Instalar dependencia npm

```bash
npm install @supabase/supabase-js
```

O añade al `package.json`:
```json
"dependencies": {
  "@supabase/supabase-js": "^2.43.0"
}
```

## 8. Parche Dashboard.jsx

Sustituir el bloque de persistencia localStorage en `components/Dashboard.jsx`
con el código de `DASHBOARD_PATCH.js`. Ver comentario en ese archivo con
instrucciones exactas de dónde reemplazar.

## 9. Verificar

- Bot corriendo → ve a Supabase → **Table Editor → operations**
  → deberías ver filas con `source = 'bot'`
- Dashboard → pestaña Historial → debe mostrar las operaciones del bot
- Redeploy del bot → el historial **persiste** en Supabase y sigue visible

## Vistas analíticas disponibles

| Vista                        | Acceso vía API                    |
|------------------------------|-----------------------------------|
| Rendimiento por ventana      | `GET /api/stats?type=by_window`   |
| Rendimiento por dirección    | `GET /api/stats?type=by_direction`|
| P&L diario                   | `GET /api/stats?type=by_day`      |
| Rendimiento por hora UTC     | `GET /api/stats?type=by_hour`     |
| Resumen global               | `GET /api/stats?type=overview`    |
| Señales accionables          | `GET /api/stats?type=signals`     |
| Sesiones horarias            | `GET /api/stats?type=sessions`    |

Parámetros opcionales:
- `?simulated=true` → solo simulado
- `?simulated=false` → solo real
- `?days=7` → últimos N días (default 30)

## Límites del plan gratuito (más que suficiente)

| Recurso         | Límite free      |
|-----------------|------------------|
| Filas           | Ilimitadas       |
| Storage DB      | 500 MB           |
| Bandwidth       | 5 GB/mes         |
| API requests    | Ilimitadas       |
| Proyectos       | 2 activos        |

Con ~10 operaciones/día y snapshots de precio cada 5 min,
tardarás años en alcanzar los 500 MB.
