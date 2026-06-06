# Changes

- Added `index.html`, a plain HTML/CSS/JS Taiwan stock risk tracker with macro dashboard, positioning stats, valuation table, MOPS filings feed, per-panel status messages, and optional intraday refresh.
- Added `backend/src/worker.js`, a Cloudflare Worker proxy with `GET /eod`, `GET /quote`, `GET /filings`, `GET /yield10y`, CORS, short edge cache, upstream timeouts, and retry.
- Added `backend/src/normalizers.js` for TWSE EOD, TWSE MIS quote, MOPS filing, and FRED DGS10 payload parsing.
- Added `backend/test/normalizers.test.js`, `backend/test/worker-routes.test.js`, and `backend/test/frontend-smoke.test.js`.
- Added `backend/package.json` and `backend/wrangler.toml`.
- Added `README.md` with backend URL placeholder, env vars, endpoint list, deploy notes, and test command.
- Hardened Worker CORS handling, quote-code validation/cache canonicalization, bounded upstream body reads, MOPS URL validation, and public error messages after multi-agent review.
- Hardened frontend stale-data behavior so failed/disabled intraday quotes do not override EOD prices, proxy EOD failure falls back to direct TWSE, and backend-dependent panels distinguish missing backend from empty data.

## Source Choices

- TWSE OpenAPI `STOCK_DAY_ALL` was used for `/eod` because it is the official end-of-day full-market close feed and matches the requested fallback source.
- TWSE MIS `getStockInfo.jsp` was used for `/quote` because it provides poll-friendly public quote snapshots for `tse_*.tw` and `otc_*.tw` channels. The response is labeled as delayed/availability-dependent.
- MOPS `ajax_t05st01` was used for `/filings` because it is the query backing the material-information page requested by the prompt.
- FRED `fred/series/observations` with `DGS10` was used for `/yield10y` because it is the official FRED API path for the US 10Y Treasury yield series.

## Note

The repository did not contain the stock-tracker `index.html` described by the prompt when this work started, so a new `index.html` was added rather than modifying the unrelated existing weather page.
