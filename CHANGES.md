# Changes

## FORScan Console

- Added `/forscan/` — a static, multi-dimensional reference of FORScan-adjustable items for the Ford Focus Mk3.5 (2015-2018), covering comfort, instrument cluster, infotainment, and service functions.
- Each item is tagged by module, change method, verification confidence, and risk; values are observation references only and differ per car.
- Wired the page into the homepage entry nav, `sw.js` precache, the static-site contract, the frontend smoke test, and the Pages deploy artifact list.
- Expanded the reference after further cross-verification: added a 燈光·外部 (lighting) group and more items (Auto Start-Stop default off, rear-wiper-on-reverse via BCM DID 4155, power-folding mirror, DRL modes, one-touch indicator, follow-me-home, Video/Nav in motion 7D0-02-01, DAB enable, PowerShift TCM adaptive learning, injector IQA coding) — now 6 groups / 28 item cards, each still tagged by module / method / verification / risk.
- Added a 保養套餐 · 更換件料號 (maintenance package / part numbers) section for the 1.5 EcoBoost M8DB: oil spec (WSS-M2C948-B 5W-20, 4.1L, TW 10,000km/6-month interval), oil filter (Ford 1751529 / 2468342, Bosch F026407078), engine air filter (1848220), cabin filter (1709013), spark plug (40,000km), brake fluid, coolant, and 6-speed SelectShift ATF — each tagged with interval and verification confidence, with a "confirm by VIN with Ford" caveat.
- Added a SYNC 3 影音 DIY section: reverse-camera enable/troubleshoot (APIM menu or 7D0-01-01 first char 3=camera / A=camera+PDC, checksum auto, optional 7D0-01-02 xx8x→xx9x, wiring to APIM pin 14/15, VIN firmware update + master reset fallback; noted this trim has the camera from factory) and Nav/Video in Motion (7D0-02-01 region code 5753, record original value first) — all with a back-up-first and legal/safety caveat.
- Added a DIY 換油步驟 section with step-by-step cards for engine oil (drain, spin-on filter 3/4 turn, ~28 Nm plug with new washer, refill 4.1L, reset oil life) and 6F35 transmission fluid (MERCON LV drain & fill ~4L via 10mm-hex side level plug at the correct fluid temperature, gear cycling), full-width ordered lists.
- Confirmed the 1.5 EcoBoost spark plug OE number: Ford DS7G-12405-BA (1802090), distinct from the 1.0 EcoBoost CM5G-12405-CE; card upgraded from "confirm by VIN" to confirmed.
- Completed the transmission fluid spec: this car's SelectShift auto is the 6F35; fluid is Motorcraft MERCON LV only (WSS-M2C938-A, XT-10-QLVC), total ~8.6 L, drain & fill ~4 L, no dipstick — checked via the 10mm-hex side level plug with engine running at the specified temperature.
- Added DIY torque / fastener data to that section: sump plug ~28 Nm (26-38 Nm, confirm in manual) with new washer, spin-on oil filter (seat by hand then 3/4 turn), spark plug 15 Nm / 14mm thin-wall socket / gap ~0.7mm, wheel bolt 133 Nm / 19mm star pattern, all right-hand thread. Safety-critical values flagged to confirm against the Ford service manual.
- Added a 本車設定檔 (vehicle profile) block for the 2017 Focus 1.5T EcoBoost 180 (SYNC 3): spec chips (1,499cc 180PS@6000 / 24.5kgm, 6-speed SelectShift conventional automatic — NOT PowerShift, weights 1,428kg 5-door Sport / 1,360kg 4-door) plus an applicability map — directly applicable items, N/A items (DPF regen and injector IQA coding are diesel-only; PowerShift clutch adaptation is N/A because this car is a torque-converter SelectShift auto), and items to confirm against the actual vehicle.

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
