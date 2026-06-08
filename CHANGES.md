# Changes

## Current Public Surface

- Kept only the root entry page, `/ai/`, `/weather/`, the legacy weather redirect, shared `assets/images` favicon assets, stock data fallback, and the two Worker projects.
- Moved the AI supply-chain console to `/ai/`.
- Moved the weather console to `/weather/`.
- Converted `bjkw_weather.html` into a query-preserving redirect to `/weather/`.
- Replaced the old themed Pages deployment with a static artifact deployment.
- Added `scripts/check-static-site.mjs` to guard against old site shells and credential leaks.

## AI Console

- Uses `/data/stock-risk-feed.json` as the same-origin static fallback from the `/ai/` route.
- Keeps automated system observation prices, full TradingView chart links, market index quotes, EOD/MIS closing data, and 10Y yield context.
- Removes unused local observation log and compatibility helper surfaces.
- Removes material-announcement fallback data from the static feed and Worker surface.

## Weather Console

- Uses the weather proxy for both datastore and file API requests.
- Keeps weather credentials out of static HTML.
- Uses the shared `assets/images` favicon assets instead of root-level duplicates.

## Verification

- Backend, Worker, frontend smoke, observation-price, and static contract tests cover the retained surfaces.
