# Changes

## FORScan Console

- Added `/forscan/` — a static, multi-dimensional reference of FORScan-adjustable items for the Ford Focus Mk3.5 (2015-2018), covering comfort, instrument cluster, infotainment, and service functions.
- Each item is tagged by module, change method, verification confidence, and risk; values are observation references only and differ per car.
- Wired the page into the homepage entry nav, `sw.js` precache, the static-site contract, the frontend smoke test, and the Pages deploy artifact list.
- Expanded the reference after further cross-verification: added a 燈光·外部 (lighting) group and more items (Auto Start-Stop default off, rear-wiper-on-reverse via BCM DID 4155, power-folding mirror, DRL modes, one-touch indicator, follow-me-home, Video/Nav in motion 7D0-02-01, DAB enable, PowerShift TCM adaptive learning, injector IQA coding) — now 6 groups / 26 item cards, each still tagged by module / method / verification / risk.

## Current Public Surface

- Kept only the root entry page, `/stocks/`, `/weather/`, the legacy weather redirect, shared `assets/images` favicon assets, stock data fallback, and the two Worker projects.
- Moved the stock investment observation console to `/stocks/`, with AI supply-chain as the current observation theme.
- Moved the weather console to `/weather/`.
- Converted `bjkw_weather.html` into a query-preserving redirect to `/weather/`.
- Replaced the old themed Pages deployment with a static artifact deployment.
- Added `scripts/check-static-site.mjs` to guard against old site shells and credential leaks.

## AI Console

- Uses `/data/stock-risk-feed.json` as the same-origin static fallback from the `/stocks/` route.
- Keeps automated system observation prices, full TradingView chart links, market index quotes, EOD/MIS closing data, and 10Y yield context.
- Removes unused local observation log and compatibility helper surfaces.
- Removes material-announcement fallback data from the static feed and Worker surface.

## Weather Console

- Uses the weather proxy for both datastore and file API requests.
- Keeps weather credentials out of static HTML.
- Uses the shared `assets/images` favicon assets instead of root-level duplicates.

## Verification

- Backend, Worker, frontend smoke, observation-price, and static contract tests cover the retained surfaces.
