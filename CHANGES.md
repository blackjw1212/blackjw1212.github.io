# Changes

- Rebuilt the stock page again as a retail-friendly observation-threshold console: first-screen observation verdict, checklist-style red/yellow/green conditions, desktop score table, mobile stock cards, and browser-local observation logs.
- Reworded the UI away from direct trading language, keeping the page framed as observation support rather than personalized investment advice.
- Added per-row source/manual labels, 10Y source date display, explicit non-real-time wording, and proxy rejection messaging while preserving the allowlist and existing fallback order.
- Expanded frontend smoke coverage to assert static DOM ids, helper exports, observation-threshold verdict copy, checklist/card rendering, manual 10Y override, localStorage EOD cache fallback, and observation-log interaction.
- Replaced the stock page with the restructured long-hold staged-entry portfolio console: Entry Green-Light verdict, core/satellite/cash allocation, multi-dimension scorecard, and browser-local tranche tracker.
- Ported the robust EOD data path into the new page: Worker `/eod` first, then direct TWSE `STOCK_DAY_ALL`, same-origin `data/stock-risk-feed.json`, and finally localStorage last-good cache. Per-source failures preserve the existing display instead of blanking the table.
- Wired the 10Y Green-Light signal to Worker `/yield10y` with `{ value }`, `{ body: { value } }`, `{ data: { value } }`, and static-feed shapes, while preserving user manual override.
- Kept AI/SOX, margin-pressure, and FedWatch conditions manual because no cheap reliable same-origin source was added for them; the UI labels those controls as manual.
- Preserved the conservative verdict rule: `2+ red` or `red with no green` means cash, `all green` means first tranche, and all other mixes mean small core only.
- Hardened tranche localStorage loading, malformed JSON handling, plan-count changes, deletion, and HTML escaping for user-entered tranche notes.
- Updated `scripts/update-stock-risk-feed.mjs` so the scheduled feed now attempts tracked-stock EOD closes in addition to material announcements and the 10Y yield.
- Replaced the committed static feed with valid JSON for the new tracked-stock list. It keeps the known static 10Y fallback and leaves EOD empty until the scheduled Action refreshes it, avoiding fabricated prices.
- Updated frontend smoke/unit tests for the new page helpers, verdict aggregation, EOD/yield normalizers, proxy allowlist behavior, static fallback rendering, Worker default behavior, and malformed localStorage state.
- Updated `README.md` for the portfolio-console restructure, fallback order, manual-vs-auto labels, and static feed coverage.
- Added `index.html`, a plain HTML/CSS/JS Taiwan stock risk tracker with macro dashboard, positioning stats, valuation table, TWSE/TPEx OpenAPI material-announcement feed, per-panel status messages, and optional intraday refresh.
- Added `backend/src/worker.js`, a Cloudflare Worker proxy with `GET /eod`, `GET /quote`, optional fallback `GET /filings`, `GET /yield10y`, CORS, short edge cache, upstream timeouts, and retry.
- Added `backend/src/normalizers.js` for TWSE EOD, TWSE MIS quote, MOPS filing, and FRED DGS10 payload parsing.
- Added `backend/test/normalizers.test.js`, `backend/test/worker-routes.test.js`, and `backend/test/frontend-smoke.test.js`.
- Added `backend/package.json` and `backend/wrangler.toml`.
- Added `README.md` with backend URL placeholder, env vars, endpoint list, deploy notes, and test command.
- Added `scripts/update-stock-risk-feed.mjs`, `data/stock-risk-feed.json`, and a GitHub Actions updater so the static site has same-origin material-announcement and 10Y-yield fallback data.
- Added a stock-risk Cloudflare Worker deployment workflow and tightened the default Worker CORS origin to the GitHub Pages site.
- Added a Worker-side US Treasury 10Y yield fallback so `/yield10y` can work even when `FRED_API_KEY` is not configured or FRED is temporarily unavailable.
- Connected the production GitHub Pages tracker to the deployed `taiwan-risk-tracker-proxy.a0926043323.workers.dev` Worker by default, while keeping query-string and global overrides.
- Hardened Worker CORS handling, quote-code validation/cache canonicalization, bounded upstream body reads, MOPS URL validation, and public error messages after multi-agent review.
- Hardened frontend stale-data behavior so failed/disabled intraday quotes do not override EOD prices, proxy EOD failure falls back to direct TWSE, backend-dependent panels distinguish missing backend from empty data, and material announcements can fall back to local last-good cache.

## Source Choices

- TWSE OpenAPI `STOCK_DAY_ALL` was used for `/eod` because it is the official end-of-day full-market close feed and matches the requested fallback source.
- TWSE MIS `getStockInfo.jsp` was used for `/quote` because it provides poll-friendly public quote snapshots for `tse_*.tw` and `otc_*.tw` channels. The response is labeled as delayed/availability-dependent.
- TWSE OpenAPI `t187ap04_L` and TPEx OpenAPI `mopsfin_t187ap04_O` are attempted first for the material-announcement panel because they provide official daily JSON feeds for the static page path.
- MOPS `ajax_t05st01` remains available through backend `/filings` as a compatibility fallback when direct OpenAPI is blocked or unavailable and no fresher browser cache is usable.
- FRED `fred/series/observations` with `DGS10` was used for Worker `/yield10y` because it is the official FRED API path for the US 10Y Treasury yield series. The static feed uses FRED CSV first and the US Treasury daily yield curve XML as a no-key fallback.

## Note

The repository did not contain the stock-tracker `index.html` described by the prompt when this work started, so a new `index.html` was added rather than modifying the unrelated existing weather page.
