# 🤖 Polymarket BTC Bot

Dashboard de trading automatizado para el mercado **Bitcoin Up or Down · Hourly** en [Polymarket](https://polymarket.com).

**Dashboard** → Next.js desplegado en **Vercel**  
**Bot de ejecución** → Python desplegado en **Railway**

---

## 🏗 Arquitectura

```
polymarket-btc-bot/
├── app/                        ← Next.js App Router (Vercel)
│   ├── layout.jsx
│   ├── page.jsx
│   ├── globals.css
│   └── api/
│       ├── price/route.js      ← Proxy precio BTC (Binance/CoinGecko)
│       ├── market/route.js     ← Mercado activo Polymarket Gamma API
│       ├── analysis/route.js   ← Análisis IA vía Anthropic Claude
│       └── bets/route.js       ← Historial de apuestas
├── components/
│   ├── Dashboard.jsx           ← Dashboard principal
│   ├── PriceChart.jsx          ← Gráfico de precio
│   ├── WindowBar.jsx           ← Barra visual de ventanas T-20/15/10/5
│   ├── BetsTable.jsx           ← Historial de operaciones
│   └── ConfigPanel.jsx         ← Panel de configuración
├── lib/
│   ├── constants.js            ← Constantes compartidas + helpers
│   └── hooks.js                ← Custom React hooks
├── bot/                        ← Bot Python (Railway)
│   ├── main.py                 ← Punto de entrada
│   ├── requirements.txt
│   ├── config.example.yaml
│   └── modules/
│       ├── config_manager.py   ← Carga config + overrides env vars
│       ├── market_scanner.py   ← Detección mercado activo Polymarket
│       ├── price_feed.py       ← Feed BTC Binance (fallback CoinGecko)
│       ├── strategy.py         ← Lógica T-20/15/10/5, UP/DOWN, CLOB
│       ├── monitor.py          ← Loop principal + stop loss + claim
│       ├── claimer.py          ← Redención on-chain (Polygon CTF)
│       └── notifier.py         ← Alertas Telegram
├── package.json
├── next.config.js
├── .env.example
└── .gitignore
```

---

## 📊 Estrategia

| Ventana | Min antes del cierre | Umbral por defecto |
|---------|---------------------|-------------------|
| T‑20    | 17 – 22 min         | $500              |
| T‑15    | 12 – 17 min         | $300              |
| T‑10    | 7 – 12 min          | $200              |
| T‑5     | 2 – 7 min           | $150              |

```
Si precio > Target + Umbral  →  apostar UP
Si precio < Target - Umbral  →  apostar DOWN
Si |precio - Target| < Umbral  →  no entrar
```

---

## 🚀 Despliegue en GitHub + Vercel

### 1. Subir a GitHub

```bash
# Clona o descarga este repositorio
cd polymarket-btc-bot

# Inicializa git (si aún no lo está)
git init
git add .
git commit -m "feat: initial commit — Polymarket BTC Bot"

# Crea un repo en github.com y conecta
git remote add origin https://github.com/TU_USUARIO/polymarket-btc-bot.git
git branch -M main
git push -u origin main
```

> ⚠️ Verifica que `config.yaml` y `.env.local` **no** están en el commit (están en `.gitignore`)

---

### 2. Desplegar el Dashboard en Vercel

#### Opción A — Desde la web (recomendado)

1. Ve a [vercel.com](https://vercel.com) → **New Project**
2. Importa tu repositorio de GitHub `polymarket-btc-bot`
3. Vercel detecta Next.js automáticamente
4. En **Environment Variables** añade:

   | Variable              | Valor         | Entorno     |
   |-----------------------|---------------|-------------|
   | `ANTHROPIC_API_KEY`   | `sk-ant-...`  | Production  |

5. Click **Deploy** → en ~2 minutos tendrás tu dashboard en `https://tu-proyecto.vercel.app`

#### Opción B — Desde CLI

```bash
# Instala Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel

# Para producción
vercel --prod
```

#### Variables de entorno en Vercel

```bash
vercel env add ANTHROPIC_API_KEY production
# Pega tu API key cuando te la pida
```

---

### 3. Desplegar el Bot Python en Railway

El bot Python necesita ejecutarse **24/7** — Railway es ideal para esto.

#### Setup Railway

1. Ve a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Selecciona tu repositorio `polymarket-btc-bot`
3. En **Settings → Source** cambia el **Root Directory** a `bot/`
4. En **Settings → Deploy** cambia el **Start Command** a:
   ```
   python main.py
   ```
5. En **Variables** añade todas las variables de entorno:

   | Variable                | Valor                    |
   |-------------------------|--------------------------|
   | `POLYMARKET_PRIVATE_KEY`| `0x...`                  |
   | `POLYMARKET_FUNDER`     | `0x...`                  |
   | `TELEGRAM_BOT_TOKEN`    | `tu_token`               |
   | `TELEGRAM_CHAT_ID`      | `tu_chat_id`             |
   | `STAKE_USDC`            | `50`                     |
   | `T20_UMBRAL_USD`        | `500`                    |
   | `T15_UMBRAL_USD`        | `300`                    |
   | `T10_UMBRAL_USD`        | `200`                    |
   | `T5_UMBRAL_USD`         | `150`                    |
   | `STOP_LOSS_PCT`         | `0.50`                   |

6. Railway hace **auto-deploy** en cada push a `main` → el bot siempre está actualizado.

---

## ⚙️ Desarrollo local

### Dashboard (Next.js)

```bash
# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env.local
# Edita .env.local con tu ANTHROPIC_API_KEY

# Servidor de desarrollo
npm run dev
# → http://localhost:3000
```

### Bot Python

```bash
cd bot

# Crear entorno virtual (recomendado)
python -m venv .venv
source .venv/bin/activate      # Linux/Mac
# .venv\Scripts\activate       # Windows

# Instalar dependencias
pip install -r requirements.txt

# Configurar
cp config.example.yaml config.yaml
# Edita config.yaml con tu private_key, funder y telegram

# Ejecutar
python main.py
```

#### Test rápido de módulos

```bash
cd bot

# Precio BTC actual
python -m modules.price_feed

# Mercado activo + target 1H
python -m modules.market_scanner
```

---

## 🔐 Configuración de Polymarket (primera vez)

Antes de que el bot pueda operar, necesitas configurar los **allowances** de USDC en Polygon:

1. Ve a [polymarket.com](https://polymarket.com) e inicia sesión con tu wallet
2. Deposita USDC en Polygon en tu wallet
3. En Polymarket, aprueba el contrato CLOB para gastar USDC
4. Asegúrate de tener al menos **0.01 POL** para pagar gas en los claims

O ejecuta el script de setup:

```bash
cd bot
python setup_allowances.py
```

---

## 📬 Notificaciones Telegram

### Crear el bot

1. Abre [@BotFather](https://t.me/BotFather) en Telegram
2. Escribe `/newbot` y sigue las instrucciones
3. Copia el **token** que te da BotFather → `TELEGRAM_BOT_TOKEN`
4. Inicia una conversación con tu bot y manda cualquier mensaje
5. Ve a `https://api.telegram.org/bot<TOKEN>/getUpdates` → copia el `chat.id` → `TELEGRAM_CHAT_ID`

### Eventos notificados

| Evento       | Cuándo                              |
|--------------|-------------------------------------|
| 🤖 Iniciado  | Al arrancar el bot                  |
| 🟢/🔴 Apuesta| Al ejecutar una orden               |
| 🛑 Stop Loss | Al activarse el límite de pérdida   |
| ✅ WIN + Claim| Al ganar y cobrar automáticamente  |
| ❌ LOSS      | Al perder el evento                 |
| 🚨 Error     | En caso de fallo crítico            |

---

## 📈 Tecnologías

| Componente  | Tecnología                       |
|-------------|----------------------------------|
| Dashboard   | Next.js 14, React, Recharts      |
| API Routes  | Next.js Edge Runtime             |
| IA          | Anthropic Claude (claude-sonnet) |
| Bot         | Python 3.11+                     |
| Polymarket  | CLOB API + Gamma API             |
| Precio BTC  | Binance API (fallback CoinGecko) |
| Claim       | web3.py + CTF Polygon            |
| Alertas     | python-telegram-bot              |
| Frontend    | Vercel                           |
| Bot hosting | Railway                          |

---

## 🔐 Seguridad

- `config.yaml` y `.env.local` están en `.gitignore` — **nunca** se suben a GitHub
- El repo debe ser **privado** en GitHub
- Las claves privadas solo viven como variables de entorno en Railway/Vercel
- Nunca compartas tu `POLYMARKET_PRIVATE_KEY`

---

## 🗺 Roadmap

- [x] Dashboard Next.js con precio en tiempo real
- [x] API routes (precio, mercado, análisis IA, bets)
- [x] Lógica de ventanas T-20/15/10/5
- [x] Bot Python completo (strategy, monitor, claimer, notifier)
- [x] Deploy Vercel + Railway
- [ ] Historial CSV descargable desde el dashboard
- [ ] Resumen diario automático por Telegram
- [ ] Backtesting histórico de umbrales
- [ ] Base de datos persistente (Vercel KV / Supabase)
