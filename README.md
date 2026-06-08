# Blackjw's Blog

Personal portfolio site for blackjw1212, built with Jekyll and the Minimal Mistakes theme.

## Focus

- Public portfolio articles
- Interface and dashboard projects
- Hardware-related project records
- Public resume and selected works

## Local Development

```bash
bundle install
bundle exec jekyll serve
```

The site is published at <https://blackjw1212.github.io/>.

## Taiwan Stock Portfolio Console

This repository also includes a plain static Taiwan stock portfolio console at `index.html` plus a Cloudflare Worker proxy in `backend/`. The current page is organized as a retail-friendly automated observation console:

- Today's automated entry / wait / exit-observation verdict
- Header market-index cards for TAIEX and TPEx, sourced through the Worker quote allowlist
- Auto-derived data, 10Y, breadth, core-health, and satellite-risk lights
- Stock-code links to allowlisted TradingView full chart pages
- Core / satellite / cash allocation
- Multi-dimension AI supply-chain scorecard

The page reads the backend URL from either:

- `window.PROXY_BASE`
- `window.TW_STOCK_PROXY_BASE`
- `?proxy=https://your-worker.example.workers.dev`
- the production default `https://taiwan-risk-tracker-proxy.a0926043323.workers.dev` when opened on `https://blackjw1212.github.io/`

Example:

```text
index.html?proxy=https://taiwan-risk-tracker-proxy.a0926043323.workers.dev
```

Only allowlisted proxy URLs are honored. An unapproved URL such as `?proxy=https://evil.example` is ignored.

If no backend is configured, the page enters fallback mode. The scorecard attempts the Worker `/quote?codes=...` route first and only accepts 13:30 MIS closing snapshots, then the Worker `/eod` route, then direct TWSE end-of-day OpenAPI, then same-origin `data/stock-risk-feed.json`, then the last usable localStorage cache. The 10Y yield attempts Worker `/yield10y` and then the same static feed. The first-screen verdict is computed automatically from existing data only: source coverage, 10Y pressure, tracked-stock breadth, core-stock health, and satellite/WAIT-list pressure. Delayed/EOD/static/cache data is never labeled as real-time, and missing or cache-only prices block an entry-observation verdict.

### Backend Routes

- `GET /eod` returns normalized TWSE end-of-day rows: `[{ code, name, close, change }]`.
- `GET /quote?codes=2330,2308` returns TWSE MIS public stock quote rows plus source and delay metadata.
- `GET /quote?indices=taiex,tpex` returns allowlisted TWSE MIS public market-index rows for 加權 and 櫃買. The frontend treats them as intraday public-feed snapshots, not guaranteed tick-level real-time data.
- `GET /filings?code=2330` returns latest normalized MOPS material announcements as an optional legacy fallback: `[{ date, title, url }]`.
- `GET /yield10y` returns the latest numeric 10Y yield, using FRED DGS10 first when configured and the US Treasury Daily Treasury Yield Curve fallback otherwise.
- `GET /health` returns a simple service health payload.

### Backend Environment

- `FRED_API_KEY` is optional for `/yield10y`. When it is present, the Worker uses FRED DGS10 first; otherwise it uses the US Treasury Daily Treasury Yield Curve fallback.
- `ALLOWED_ORIGINS` is optional. It defaults to `https://blackjw1212.github.io` in `backend/wrangler.toml`; use `*` for a public demo, or a comma-separated allowlist such as `https://blackjw1212.github.io,https://your-preview.example`.

Optionally set the FRED key as a Worker secret:

```bash
cd backend
npm install
npx wrangler secret put FRED_API_KEY
npx wrangler deploy
```

For production, set `ALLOWED_ORIGINS` in `backend/wrangler.toml` or with Cloudflare environment variables before deploying. Do not store `FRED_API_KEY` in `wrangler.toml`; keep it as a secret if you choose to use FRED.

### GitHub Actions Worker Deploy

`.github/workflows/deploy-stock-risk-worker.yml` deploys the stock risk Worker from `backend/` when these repository secrets are present:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`FRED_API_KEY` is optional. If it is missing, the deployed Worker still serves `/yield10y` from the US Treasury fallback.

After the Worker deploys, open the page with the Worker URL:

```text
https://blackjw1212.github.io/?proxy=https://taiwan-risk-tracker-proxy.a0926043323.workers.dev
```

The production page also uses this Worker automatically when opened at `https://blackjw1212.github.io/`. You can still use the query string or `window.TW_STOCK_PROXY_BASE` to override it for previews.

### Post-Deploy Check

After deploy, verify the Worker and connect the static frontend:

```bash
curl https://taiwan-risk-tracker-proxy.a0926043323.workers.dev/health
```

Then open:

```text
index.html?proxy=https://taiwan-risk-tracker-proxy.a0926043323.workers.dev
```

### Stock Tracker Tests

Run the dependency-free tests from the repository root:

```bash
node --test backend/test/*.test.js
```

The suite covers backend normalizers, Worker routes/CORS/error handling, and frontend smoke renders with mocked fetch for Worker-backed EOD/yield, no-backend static fallback, proxy allowlist enforcement, manual 10Y override, localStorage cache fallback, removed local-log UI guards, malformed/legacy localStorage state, verdict/EOD/yield helper logic, allowlisted TradingView full chart links, and the conservative `RetailConsole` retail-glance helper contract.

### Static Data Feed

`data/stock-risk-feed.json` is generated by `scripts/update-stock-risk-feed.mjs` and refreshed by `.github/workflows/update-stock-risk-feed.yml`. It gives GitHub Pages a same-origin fallback for tracked-stock EOD closes, material announcements, and the 10Y yield when browser CORS blocks upstream OpenAPI requests or no Worker proxy is configured.

## Maintenance Notes

- Keep navigation links backed by real pages.
- Do not commit local OS artifacts such as `.DS_Store`.
- Keep repo descriptions, profile links, and pinned projects aligned with the current portfolio focus.
- Keep public pages focused on project outcomes instead of private implementation details.
- Every push runs a GitHub Actions site check that builds Jekyll and verifies internal links.
