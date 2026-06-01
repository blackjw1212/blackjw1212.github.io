# BJKW Weather Proxy

Cloudflare Worker proxy for `bjkw_weather.html`.

The browser calls this Worker without a CWA API key. The Worker reads `CWA_API_KEY` from Cloudflare secrets, adds it to the upstream Central Weather Administration Open Data request, and returns JSON to the GitHub Pages weather dashboard.

## Why

- No API key in GitHub Pages HTML.
- No need to type the key on every device.
- CORS is limited to `https://blackjw1212.github.io`.
- The proxy only allows the weather endpoints used by the page.
- Successful upstream responses are cached at the Worker for 60 seconds.

## Local setup

```bash
cd weather-proxy
npx wrangler login
npx wrangler secret put CWA_API_KEY
npx wrangler deploy
```

The public URL should be:

```text
https://bjkw-weather-proxy.blackjw1212.workers.dev
```

If a different Worker URL is used, update `WEATHER_PROXY_BASE` in `../bjkw_weather.html`.

## Required GitHub Actions secrets

To deploy from GitHub Actions, add these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CWA_API_KEY`

The workflow intentionally skips deployment if those secrets are absent.
