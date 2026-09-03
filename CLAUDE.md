# blackjw1212.github.io — 專案事實

> 只寫「這個 repo 特有」的事。語言、四階段工作流、委派、驗證原則等**通用規則在全域
> `~/.claude/CLAUDE.md` 已生效，這裡不重抄**（重抄會分叉：全域改了專案層還留舊版）。

## 這是什麼

GitHub Pages 靜態站 + GitHub Actions ETL。**沒有建置步驟、沒有打包器、沒有 TypeScript。**
頁面是手寫 HTML + 行內 `<script>`，工具是原生 ESM `.mjs`。這是刻意的，不要引入工具鏈。

型別檢查的替代品是 **schema 測試**（`backend/test/etf-schema.test.js` 驗 `data/*.json` 的
結構與衍生欄位一致性）。加欄位就加斷言。

## 完成標準（DoD）

```
sh .claude/verify.sh
```

**`package.json` 只在 `backend/`，repo 根目錄沒有。** claude-verify-kit 的 `verify.py`
偵測 Node 專案時看的是根目錄，所以少了 `.claude/verify.sh` 這個 override，
Stop 閘門會**放行但什麼都沒驗**（實測過）。這個檔不可刪。

它跑三件事，與 CI 對齊：
1. `cd backend && npm test` — `node --test test/*.test.js`
2. `node scripts/check-static-site.mjs` — 靜態契約
3. `data/market-feed.json`、`data/etf-feed.json` 的 JSON 合法性與 `tradeDate` 格式

## 靜態契約 `scripts/check-static-site.mjs`

比一般 lint 嚴格很多，改頁面前先知道它管什麼，否則 CI 會紅：

- **首頁主要入口被釘死**為
  `stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/|flight:/flight/|dash:/dash/|coupon:/coupon/|subtitle:/subtitle/|convert:/convert/`，
  順序與 href 都要一致（**字面值在條件與錯誤訊息各出現一次，兩處都要改**）。
  卡片數量不是硬編碼，是 `cards.length !== primaryLinks.length`。
  `data-primary-entry` 必須寫在 `href` 之前，否則抓取的正則對不上。
  **同一份清單被釘在兩個地方**：這支腳本，以及 `backend/test/frontend-smoke.test.js`
  的 `assert.deepEqual(primaryLinks, ...)`。只改一邊會讓 `npm test` 紅而靜態契約綠。
- **各頁的 `<title>`、`canonical`、`theme-color` 逐字比對**。改標題要同步改這支腳本。
- **整張卡片就是連結，沒有 CTA 按鈕**：右上的路徑列（`.topnav`）與每張卡右下的
  「開啟 /xxx/」按鈕（`.entry-button`）講的是同一份清單，已整組移除，兩者都被
  `assertNoMatch` 釘成禁止項。可點範圍改成整張卡＝`<a class="entry …">`，
  **屬性順序固定為 `class → data-primary-entry → href → aria-label`**，兩條正則都靠它。
  **不可以改用 JS 做整卡可點**——首頁不得有 body 端 `<script>`（見下一條），
  而且真連結免費附贈鍵盤操作與中鍵開新分頁。
  釘的不變式是：`aria-label` 必須**以卡片 `<h2>` 開頭**（WCAG 2.5.3 Label in Name
  ——語音控制使用者說出畫面上看到的標題要叫得動這張卡），且必須另外帶上目的地路徑。
  舊版按鈕時代抄六次文案的寫法看不出這條規則，實測 `/weather/` 與 `/flight/`
  兩顆長期違規而六條字面值斷言全綠。
- **首頁是純靜態入口，不得有 body 端 `<script>`、不得在 runtime 抓任何東西**
  （`<head>` 的 service worker 註冊除外）。三張狀態卡已整組移除——那些數字在
  `/stocks/`、`/weather/` 內頁都講得更完整，而 10Y 沒有任何頁面拿它算東西。
  契約用 `assertNoMatch` 釘住 id、markup、兩個 endpoint 與 body script 四件事。
- **禁詞**：首頁與 `/market/` 不得出現 `保證`、`可放心`、`買進(訊號)`、`賣出(訊號)`、
  `投資建議`、`實領淨收益`。**註解也算**——曾因為程式碼註解寫了「保證」而 CI 紅。
- **所有 `/` 開頭的 href/src/srcset/url() 必須指向真實存在的檔案**。
- **天氣頁呼叫的每個 endpoint 都必須在 `weather-proxy/src/index.js` 的白名單裡**，
  且頁面不得出現 CWA API key。

## 部署：`pages-deploy.yml` 的 allowlist

```
cp -R index.html bjkw_weather.html 404.html sw.js esp32 forscan stocks market weather flight dash coupon subtitle convert data assets dist/
```

**新增頂層頁面目錄一定要加進這行**，並同步加進 `sw.js` 的 `PRECACHE`（順手 bump `VERSION`，
不然 cache key 沒變、舊使用者拿不到新清單）。否則 Site check 會過、Pages deploy 會失敗 ——
兩個 workflow 檢查的東西不同，綠燈不代表上線成功。

## 前端測試的硬性前提

`backend/test/market-page.test.js` / `frontend-smoke.test.js` 是用 `vm` 載入頁面的
**行內 `<script>`** 來測的，抓法是這個正則：

```js
html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)
```

所以 **`market/index.html` 的主 script 必須是最後一個、且緊貼 `</body>`**。
在它後面插任何東西，測試會抓不到 script 而整批失敗。
函式要能被測到就掛進 `MarketApp.helpers`。

## 資料管線：踩過的坑

工具在 `scripts/`，由 `update-market-feed.yml`（每日四班）與 `update-stock-risk-feed.yml` 驅動。

- **上市收盤用 `MI_INDEX`，不要用 `openapi` 的 `STOCK_DAY_ALL`。**
  後者當日不發佈（實測收盤後 8 小時仍是前一日），會讓頁面價比券商帳面舊一天。
  `STOCK_DAY_ALL` 保留為 fallback，因為 TWSE 曾對 GitHub runner IP 回 HTML 錯誤頁。
- **MI_INDEX 的漲跌方向藏在 HTML 顏色裡**（`color:red>+` 漲、`color:green>-` 跌），
  「漲跌價差」欄是**絕對值**——只讀該欄會讓當日近千檔下跌股全變上漲。除權息（`X`）記 `null`。
- **`tradeDate` 不可取「全體列的最大日期」。** 兩市場發佈時間不同步時，會讓一千多檔
  上市股掛著它們沒有的日期。取最小值，並輸出 `marketDates:{twse,tpex}`。
- **TPEX 回 10,000+ 列、耗時近 1 秒，runner 上常被中斷（undici `"terminated"`）。**
  兩個引擎都有 3 次指數退避重試（4xx 不重試）。
- **上游失敗絕不可歸零**：`preserveMarketRows` / `preserveEtfMarketRows` **逐市場**保留，
  `applyValuation` 逐欄保留。保留時要寫進 `errors[]`，讓畫面說得出來。
- **成分股是解析 MoneyDJ 的 HTML**（官方無此資料），每週一跑。成功率約 202/347，
  失敗大多是債券型（結構上沒有股票成分股頁），不是解析壞掉。
  `isDegraded()` 會在成功數掉到前次 70% 以下時**拒絕覆寫**。
- **配息來源要三條併用，因為沒有一條涵蓋全市場**（實測 2026-07-30）：
  `etfDiv` 只有 95 檔上市、上櫃 0 檔，連 00888 這種有配息的上市 ETF 都不在內；
  **除權除息預告表**（掛 tpex 網域但實際跨市場）補得到那些孤兒，但沒有發放日欄位；
  剩下的靠 `seed-etf-div-history.mjs --incremental`（Yahoo）。
  三條之間以 **±7 天去重 + 可信度分級**（官方金額+官方發放日 3 ＞ 官方金額+推估 2 ＞
  第三方 1）。**沒有分級時新接的官方來源會被先到的 Yahoo 事件永久擋住**（15 筆只進 1 筆）。
- **Yahoo 增量刷新必須留在 workflow 裡**（每日 22:00 那班，排在 ETF feed 之前）。
  它曾經只是手動工具，導致 112 檔 ETF 的配息凍結在最後一次手動執行、
  並隨 13 個月窗剪枝逐筆消失 —— 畫面上就是「殖利率沒更新」。
  增量模式用 `range=6mo`（3mo 對季配標的會剛好落空），且**不可標記 `seeded`**，
  否則新上市 ETF 會以 6 個月歷史被判定已回填而永遠拿不到完整兩年。
- **殖利率是「滾動 12 個月 ÷ 當日收盤」，他站多為「年度配息 ÷ 年均價」。**
  年中對照時本站必然偏高（實測 00888 13.47% vs 11.80%，差距 100% 來自時間窗、
  分母只差 0.1pp）。**兩處表頭都要寫「近12月」** —— 曾因配置產生器結果表只寫
  「殖利率%」而被誤判為算錯。
- **驗資料正確性用 TWSE MIS**（`mis.twse.com.tw/stock/api/getStockInfo.jsp`，
  `z`=今收、`y`=昨收）當獨立來源，它與券商帳面一致。**盤前 `z` 是 `-`，要改讀 `y`。**

## 稅務估算：級距自動抓，其餘人工

**課稅級距是自動的。** 來源是**台北國稅局「適用稅率」頁**
（`ntbt.gov.tw/multiplehtml/1b82b380e1a34de9afd204d39b007db2`），那是**真正的 HTML
表格**，逐年列出級距／稅率／累進差額，年度標籤就在表格前（`► 115年度累進稅率：`）。
不要再去解財政部公告的 PDF 附件——當初就是誤以為只有 PDF 才留成人工。

**寫入前必須通過定義性驗證**（`validateBrackets`）：在每個級距交界處，
`qd[i] === qd[i-1] + upTo[i-1] × (rate[i] − rate[i-1])` 必須成立。
累進差額抄錯一位肉眼看不出來、稅卻全錯，這條是自動寫入的唯一許可證。

決策順序（`update-tax-params.mjs`）：
- 現存與線上一致 → 不寫入（避免每天產生無意義 diff）
- 現存未通過驗證 → **用線上值修好它**（早期版本會「保護」壞存檔並 exit 0，是錯的）
- 兩份都通過驗證卻不一致 → 不猜，exit 1 交人裁決
- 修不好 → exit 1 大聲失敗

**仍為人工**：股利抵減率與上限、分開計稅率、免稅額／扣除額、二代健保、最低稅負。
這些不在該表格裡，各自附出處人工維護。

頁面內建 `TAX_FALLBACK` 備援（載不到 JSON 仍要能算）。
**兩份各改一邊就會給出不同稅額**，測試逐欄位鎖住一致，分叉會當場失敗。

其他要記得的事：
- **對居住者，國內 ETF 配息發放時不扣繳所得稅**，只扣二代健保；真正的稅是隔年 5 月
  申報的綜所稅。這兩件事不能混為一談。
- **ETF 配息組成（54C 國內股利／5A 國內利息／71 海外／76W 平準金）沒有任何可自動
  取得的來源**：TWSE `etfDiv` 與 TPEX 除權息預告表都只有金額，SITCA 公告頁是
  postback-only ASP.NET（有 `__VIEWSTATE`、初始載入 0 個 `<tr>`）。
  因此應稅比例只能**依標的性質推定**，每列都要標明理由。
- **名稱推定抓不到的標的靠 `etf-static.json` 的 `domesticRatio` 人工建表**，
  每筆必附 `domicileBasis`（判定依據）與 `domicileAsOf`。典型是 **00712 復華富時不動產**：
  前十大 78% 是美國 REITs，但中文譯名（安納利資本管理公司、AGNC投資公司…）
  讓名稱推定完全失效。**沒建表的標的不可寫入這個欄位**——前端靠 `null` 才會回退到
  推定，誤填 0 等於讓全市場配息變免稅。
- 有一條測試會**自動抓出「該建表卻沒建」**的標的（成分股 >70% 看起來是外國、
  名稱看不出來、且**真的有配息**）。不配息的標的產生不出應稅所得，不納入要求——
  否則會養出一張沒人維護得動的表（實測不加這個條件會一次要求建 20 檔）。
- **二代健保改革（年度結算制）已暫緩、尚未上路**（查證於 2026-07-30），
  現行仍是單筆 ≥ 2 萬 × 2.11%。
- 累進差額最容易抄錯且肉眼看不出來 → schema 測試用「在每個級距交界處兩式必須相等」
  的定義性檢查擋住。

## /coupon/：data/ 裡唯一人工維護的 feed

`data/coupons.json` **不由 CI 寫入**，是這個 repo 唯一一份人工維護的 feed。
沒有 workflow 碰它，改它就是改 repo 內容。

**為什麼是人工的**（查證於 2026-09-03，不要再研究一次）：

- **政府開放資料這條路不存在**。實抓 data.gov.tw 全平台資料集清單（112,171 列），
  以 `優惠|折扣|振興|抵用|消費券|好禮` 掃描得 121 筆，**全部**是租稅優惠、優惠貸款、
  振興預算執行、公教特約商店——零筆零售折扣碼。
- **本地聯盟平台都沒有公開 API**：通路王 iChannels、AFFILIATES.one、蝦皮分潤計畫
  皆查無開發者文件。
- **國際聯盟平台有，但要帳號**：Rakuten Coupon Feed 端點是活的
  （`couponfeed.linksynergy.com/coupon`，無 token 實測回 `Access Denied Token ID Is
  Invalid or Not Approved`）、Awin 有 `POST /publisher/{id}/promotions` 文件。
  兩者都需通過廣告主逐一核准，且**台灣本地商家覆蓋率差**（momo、PChome 拿不到）。

**不可以爬的站**（robots.txt 實抓，這條是紅線）：

- `xincoupon.com` 明文 `Disallow` **`anthropic-ai`、`GPTBot`、`CCBot`、`Google-Extended`**
- `cardu.com.tw` 明文 `Disallow` **`ClaudeBot`**、`GPTBot`
- `momo` 禁 `/event/*` `/activity/*`；`foodpanda` 禁 `*/campaign/*`；Uber Eats 回 Cloudflare 403

**優惠碼一律不寫進資料檔，除非在官方頁上親眼看到。** foodpanda 官方 deals 頁的內容
停在 2026 年 1 月，網路上流傳的當月優惠碼**只存在於聯盟行銷站**。編一個看起來合理的碼
不會讓任何測試變紅，只會讓使用者到結帳頁才發現是假的——`coupon-schema.test.js`
因此要求每筆都有 `sourceUrl`（https）與 `verifiedAt`。

**誠實性是機器判準，不是自律**：來源連結夾帶聯盟追蹤參數會紅（頁面自稱不收推廣報酬）；
回饋型優惠必須明寫 `rebateBase`（折扣前/後）與 `capVerified`，查不到就填 `null`，
頁面會標成「未查證，以折後估算」；有 `cap` 就必須註明 `capPeriod`——
月上限拿來當單筆上限等於假設本月沒刷過，這件事要說出來。

**複查節奏**：信用卡回饋每季，且 6/30 與 12/31 前後強制複查（銀行權益換檔集中在這兩點）；
支付加碼每月 1 日；平台優惠碼週為單位、基本上維護不起所以不收。
`reviewedAt` 超過 21 天頁面轉警示色、60 天轉紅。

## data/ 是 CI 寫的

`data/*.json` 由 Actions 自動 commit。本機重跑工具後要 push 之前先 `git pull --rebase`，
CI 的 commit 只動 `data/`，通常不衝突。feed 是 minified（`market-52w.json` 640KB），
壞掉時肉眼看不出來——靠 schema 測試擋。

## Cloudflare Workers

`weather-proxy/`（天氣）與 `backend/`（stock-risk）各是一個 Worker，
由 `deploy-weather-proxy.yml` / `deploy-stock-risk-worker.yml` 部署。
**API key 走 Worker secret，永遠不進頁面、不進 repo。** 靜態契約會檢查這件事。

## `/subtitle/`：全站唯一帶第三方函式庫的頁面

瀏覽器端 Whisper，影音檔全程留在本機。這一頁打破了「頁面是自足的單一 index.html」的慣例，
理由都寫在下面，**不要憑直覺把它改回去**。

- **`subtitle/vendor/` 是 36.67 MB 的自帶二進位檔**（transformers.min.js 0.53 + opencc-full.js 1.14
  + ORT 的 `asyncify.wasm` 22.48 + `simd-threaded.wasm` 12.34）。為什麼不用 CDN：transformers.js
  預設把 ORT 的 wasm 指向 **jsDelivr 上的 `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`**
  ——一個 dev 版號。釘在那上面等於把整頁的存亡交給別人的 npm tag，而且斷網就沒了。
  兩支 wasm 的分支條件（Safari 走非 asyncify 版）是照抄 transformers.js 自己的判斷。
- **推 `vendor/` 會被 GitHub Push Protection 擋下，那是誤判，不要去改 vendor 檔。**
  `transformers.min.js` 裡有一句錯誤訊息寫著
  `word-level timestamps not available. See https://gist.github.com/hollance/<32 位 hex>`
  ——**Gist ID 與 Mistral API key 都是 32 位英數，格式撞車**，secret scanning 因此把它
  判成「Mistral AI API Key」，push 被 GH013 拒絕。查證方法：那個字串出現在 URL 的
  **路徑位置**，而且 HEAD 那個 gist 回 200（真的存在，內容就是 Whisper word-level
  timestamps 的說明）。解法是在被拒訊息裡附的 unblock 連結上放行一次；改檔案把字串
  拿掉的話，這份 vendor 就不再等同上游發行版，下次更新對不起來。
- **`.gitignore` 的 `vendor` 一度把整個 `subtitle/vendor/` 擋掉**，而靜態契約 `mustExist`
  那 6 個檔——commit 上去 Site check 必紅。已改成 `/vendor/` 只擋 repo 根目錄。
  注意這種情況**救不回來**：父目錄被 ignore 時 git 不會走進去，`!subtitle/vendor/**`
  無效。另外 `.gitattributes` 標了 `subtitle/vendor/** binary`，因為本機
  `core.autocrlf=true`，沒有理由賭 git 的啟發式會判對 22 MB 的 wasm 不該做行尾轉換。
- **模型不可能自帶**：turbo 的 `encoder_model_q4.onnx` 單檔 405 MB > GitHub 單檔 100 MB 上限。
  模型固定從 HF CDN 首次下載（q4 合計約 724 MiB），之後由 transformers.js 存進 Cache Storage。
  **所以「離線」的正確說法是「第一次之後可離線」**，頁面上必須講清楚，靜態契約有釘。
- **不要引入 `coi-serviceworker`。** WebGPU **不需要**跨來源隔離（W3C 規格、MDN WebGPU、
  MDN COEP 的依賴清單、ORT 的 WebGPU EP 文件、transformers.js 的 `'gpu' in navigator` 判斷，
  五方一致）。需要 COOP/COEP 的只有 WASM 後端的多執行緒，GitHub Pages 給不了，所以沒有
  WebGPU 的機器就是單執行緒、就是慢。網路上宣稱「WebGPU 也需要 SharedArrayBuffer」的
  部落格是錯的。
- **改了 `subtitle/worker.js` 或 `vendor/` 就必須 bump `sw.js` 的 `VERSION`。** 這兩者走
  service worker 的 **cache-first** 分支，回訪使用者會拿到舊檔且沒有任何徵兆。
  **本機開發也一樣**——實測改完 worker 重新整理，端出來的仍是舊版，連
  `fetch(url, { cache: 'reload' })` 都繞不過（SW 的 fetch handler 一律攔截）。
  本機要驗新版就先 `getRegistrations()` 逐一 `unregister()` 並 `caches.delete('bjkw-<VERSION>')`。
  這個坑會讓你以為「改了沒效果」而去改錯地方。
- **`vendor/` 刻意不進 `sw.js` 的 `PRECACHE`**：那會讓每個只想看 `/stocks/` 的訪客先吞 36 MB。
  它走既有的 cache-first 靜態資產分支，真的開這頁時才進快取。
- **主 script 是 classic、緊貼 `</body>`**，ESM 全部關在 `subtitle/worker.js`。這不是風格問題：
  `backend/test/*.test.js` 用 `<script>` 那條正則抽行內程式進 `vm`，改成 `type="module"`
  整批測試會抓不到。純函式掛 `window.SubtitleApp.helpers`，`__SUBTITLE_SKIP_AUTO_INIT__` 擋自動初始化。
- **這頁只能聽寫，不能翻譯。** 這是 Whisper 的能力邊界，不是實作沒做完。
  實測（2026-09-03，同一段 7 秒日文音檔、turbo）：

  | 設定 | 輸出 |
  |---|---|
  | 指定中文 | 森永的美味牛乳是濃烈青色的牛乳瓶 **和尚在一切的泡河** |
  | 指定日文 | 森永のおいしい牛乳は濃い青色に…（正確） |
  | 不指定（自動偵測） | The delicious牛乳 is a very dark green green wine… |
  | `task:'translate'` | 仍是日文——連官方說的「只翻成英文」都沒發生 |

  對非該語言的音檔硬指定語言，Whisper 會逐音硬套成目標語言的字；長音檔（尤其唱歌）
  還會漂回原語言。**要真的做日文→繁中，得再串一個翻譯模型**（NLLB-200-distilled-600M
  原生支援 `zho_Hant`，q8 約 853 MB；`Xenova/opus-mt-ja-zh` 不存在，只有 `opus-mt-en-zh`）。
- **夾雜語言的行為不穩定，這是設計「輸出→翻譯」那個選項的理由。** 實測同樣是「指定中文
  的中英夾雜錄音」：31.8 秒那段拿到 11 句、英文段照實轉成英文；換一段 18.4 秒的素材重跑，
  英文整段消失。頁面上不可以寫成「夾雜英文不必特別處理」——那是單次結果推出來的錯結論。
- **翻譯是第二個模型，預設關閉。** `Xenova/nllb-200-distilled-600M`（q8，encoder 399.7 MB
  ＋ decoder 453.5 MB），目標語言直接用 `zho_Hant`，不必先出簡體再轉。
  - **兩個模型不能同時常駐**：實測在同一個分頁先後建立 Whisper 與 NLLB 的推論工作階段會
    `std::bad_alloc`。所以 `ensureTranslator()` 先 `dispose()` 辨識器、`ensureTranscriber()`
    也要反向 `dispose()` 翻譯器，缺一邊第二次跑就爆。
  - **要逐句翻，不能整段翻**：長句會掉半句（`"Mr. Quilter is the apostle of the middle
    classes, and we are glad to welcome his gospel."` 只回「我們很高興迎接他的福音」，
    放寬 `max_new_tokens` 沒有用）。Whisper 切出的字幕句夠短，逐句翻反而完整。
  - **src_lang 要逐句用字形判斷**（`nllbSourceLanguage()`），不能整批套使用者選的語音語言
    ——同一批 cue 本來就可能混著兩種語言。已經是中文的句子回 `null`，交給 opencc 就好。
  - 實測成本：翻譯模型載入 81 秒、每句約 5 秒；7 秒的日文檔跑完整條（辨識＋換模型＋翻譯）
    共 2 分 10 秒。品質是 NLLB-600M q8 的水準：意思大致對、用詞生硬。
- **語言預設是中文，不是自動偵測。** 實測同一段中文音檔不指定語言時，Whisper 會自行
  把任務判成翻譯、輸出英文（`"If he doesn't want to give a date,"`）——主要用途當場壞掉。
  自動偵測留在選單裡供人選，但**不可以當預設**，靜態契約與測試都釘住了這件事。
- **Whisper 的中文輸出是簡繁混雜的**，不是設定 `language` 就會出繁體。一定要用
  `opencc-js` 的 `{ from: 'cn', to: 'twp' }` 事後轉（twp 連詞彙一起換：视频→影片、鼠标→滑鼠）。
  實測 `language: 'zh'` 這個兩字母代碼**會**被接受（官方文件只示範過 `'french'` 這種全名）。
- **簡繁轉換不可以無條件套，而且刻意放在主執行緒。** 日文有自己的漢字體系，
  `cn→twp` 會把日文句子裡的漢字換成台灣用語，得到既不是日文也不是中文的東西；韓文同理。
  判準是 `needsTraditionalConversion()`：有漢字、且沒有假名或諺文。它放在頁面的行內
  script 而不是 worker，是因為 worker 匯入 ESM、`vm` 測不到，而這條判斷值得被測試釘住。
  opencc 的字典 1.14 MB，改成只在真的需要轉時才 `import()`。
- **`return_timestamps: true` 回來的 `timestamp[1]` 可能是 `null`**，而且模型會給出超過音檔長度
  的時間、零長度區間、甚至回頭比前一句還早的 start。`normalizeChunks` 專門處理這四種髒資料，
  改它之前先看 `backend/test/subtitle-page.test.js`。
- **實測數字**（2026-09-03，AMD RDNA-2 桌機、WebGPU、turbo q4）：首次下載到「模型就緒」
  **51 秒**；**第一次辨識會多花約 20 秒做 WebGPU shader 編譯**——同一個 8.21 秒音檔冷跑 27 秒、
  暖跑 3.4 秒。暖機後 37.1 秒的中文音檔跑 9.9 秒（約 3.7 倍即時）。冷跑那 20 秒沒有任何進度
  提示，看起來就像當掉，之後要動這頁的話這是第一個該補的東西。
- **匯出時 `URL.revokeObjectURL` 不能緊接在 `link.click()` 後面**同步呼叫——會安靜地取消掉
  自己剛觸發的下載，按了沒反應而且主控台沒有任何訊息。
- 本機預覽用 `.claude/launch.json` 的 `static-site`（`node -e` 的極簡靜態伺服器，
  有 `.wasm` / `.mjs` 的 MIME 對應；用 `python -m http.server` 之類的東西發不對 wasm 型別）。

## `/convert/`：萬用轉檔台

瀏覽器端轉檔，檔案全程留在本機。骨架照抄 `/subtitle/`（classic 行內 script 緊貼
`</body>`、純函式掛 `window.ConvertApp.helpers`、`__CONVERT_SKIP_AUTO_INIT__` 擋自動初始化、
vendor 自帶且不進 `sw.js` 的 `PRECACHE`）。下面只記這一頁**額外**踩到的坑。

- **`convert/vendor/` 是 11 MB，且全部按需 `import()`／`<script src>`**，所以
  `check-static-site.mjs` 掃 href/src 的迴圈一個都看不到——已在 `mustExist` 逐檔點名。
  加新函式庫要同步加，否則 pages-deploy 漏檔時 Site check 仍會綠。
- **pdf.js 的 `page.render()` 預設用 requestAnimationFrame 分批畫。使用者一切到別的
  分頁，rAF 就不再觸發，render 的 promise 永遠不 resolve**——畫面停在「第 1 頁 0/N」，
  主控台一個字都沒有。實測 pdf.js 6.3.289 在 `document.hidden` 時 display intent 逾時、
  `intent: "print"` 14 ms 完成。這頁固定用 `intent: "print"`（語意上也對：要的就是列印結果）。
  `useRequestAnimationFrame: false` **沒有用**，實測照樣卡死。
- **pdf.js 6 的 `PDFDocumentProxy` 沒有 `destroy()`**，要關的是 `pdf.loadingTask.destroy()`。
  照舊版寫 `pdf.destroy()` 會在**每一批的最後一步**丟 `is not a function`，把整批已經
  轉好的結果一起吃掉。
- **vendor 的載入順序有兩條硬相依**：`docx-preview.min.js` 前要先有全域 `JSZip`；
  `UTIF.js` 在自己的 IIFE 執行期就讀 `self.pako`，`pako.min.js` 一定要先載。
  兩者失敗時都不報錯，只是 `undefined`。
- **`docx-preview` 的全域名稱是 `docx`**，跟 dolanmiu 的 `docx` 套件撞名。目前不衝突是
  因為後者走 `import()` 不掛全域；把它換成 UMD 版就會對撞。
- **`canvas.toBlob` 對不支援的 type 會安靜地退回 PNG**（給你一個 `.webp` 副檔名配
  PNG 內容）。`canvasToBlob()` 因此比對 `blob.type`，對不上就丟錯。
- **AVIF 只能讀不能寫**：至今沒有瀏覽器能用 canvas 編碼 AVIF。頁面明講，靜態契約釘住。
- **DOCX→PDF 是 docx-preview 排版 → html2canvas 拍照 → pdf-lib 拼頁，輸出是圖片頁。**
  實測產出的 A4 頁 `getTextContent()` 回 0 個 item——「文字不可選取」是事實不是免責。
  要可選取的 PDF 只能走 DOCX→HTML 再讓使用者自己列印。
- **CSV 沒有自述編碼**，台灣的 Big5 檔用 UTF-8 讀會整片亂碼。頁面給編碼選單
  （`TextDecoder('big5')` 瀏覽器原生支援），輸出的 CSV 一律補 UTF-8 BOM。
- **`<input type=file>` 的 change 是「改選」不是「加選」**，拖放才是加選。
  兩者共用 `addFiles(list, replace)`。
- **一批只處理同一種來源格式**：混合時直接停下來說「無法決定輸出」，不猜。
- **不做影音**：`@ffmpeg/core` 單執行緒版 unpacked 61.69 MB，而 GitHub Pages 送不出
  COOP/COEP，多執行緒在這裡開不起來。UI 上沒有假裝支援。
- vendor 的版本與來源網址記在 `convert/vendor/SOURCES.md`。

## 計劃審查閘門

`.claude/plan.md` 一存在就會觸發 `plan-review.py`，要求 Codex 跨模型審核通過才放行。
不需要審查時**刪掉該檔**解除，不要偽造 marker。
