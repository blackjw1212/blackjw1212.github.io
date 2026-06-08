# BJKW Weather Proxy

Cloudflare Worker proxy for the `/weather/` page.

The browser calls this Worker without a weather API key. The Worker reads `CWA_API_KEY` from Cloudflare secrets, adds it to the upstream Central Weather Administration request, and returns JSON to the GitHub Pages weather console.

## Routes

- `GET /health`
- `GET /api/:endpoint`
- `GET /file/:endpoint`

The allowlist is intentionally narrow and only covers the endpoints used by the weather page.

## Local Setup

```bash
cd weather-proxy
npx wrangler login
npx wrangler secret put CWA_API_KEY
npx wrangler deploy
```

Default public URL:

```text
https://bjkw-weather-proxy.a0926043323.workers.dev
```

If a different Worker URL is used, update `WEATHER_PROXY_BASE` in `../weather/index.html`.

## Required GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CWA_API_KEY`

The deploy workflow intentionally skips deployment if those secrets are absent.
