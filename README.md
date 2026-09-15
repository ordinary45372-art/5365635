# RBXFORGE Web (Render)

Web port of the Roblox Account Manager with **background account generation**.

## How generation works

1. Put your Bloxgen API keys in **Render environment variables** (never in the browser).
2. The server fills a **pool** of accounts in the background.
3. When you click **Generate Account**, it claims the next account from the pool and saves it to your account list.

## Render environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOXGEN_API_KEYS` | **Yes** | Comma-separated Bloxgen keys, e.g. `key1,key2,key3` |
| `KEEP_ALIVE_URL` | Recommended | `https://YOUR-APP.onrender.com/health` (ping every 60s) |
| `POOL_MIN` | No | Keep at least this many accounts ready (default `5`) |
| `POOL_TYPES` | No | Comma-separated types to generate, e.g. `aged,fresh` (default `aged`) |
| `POOL_REGION` | No | Region code or empty for auto |
| `POOL_INTERVAL_MS` | No | How often to check/refill pool (default `45000`) |
| `PORT` | Auto | Set by Render |

## Deploy

1. Connect this repo to a Render **Web Service**
2. Build: `npm install`
3. Start: `npm start`
4. Set env vars above
5. After deploy, wait ~1 minute for the pool to start filling

Check pool: open `https://YOUR-APP.onrender.com/api/pool/status`

## Storage note

Accounts and the pool are stored in `data/` on the server disk.

On **Render free tier** the filesystem is **ephemeral** (wiped on redeploy/sleep).
For permanent storage, attach a **persistent disk** on Render, or use free Postgres (Neon/Supabase).

## Required index.html fix

Bottom of `index.html` must load both scripts:

```html
<script src="api.js"></script>
<script src="renderer2.js"></script>
```
