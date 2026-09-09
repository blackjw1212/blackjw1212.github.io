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

## 手機版量測 `scripts/mobile-audit.html`

改版面之後手動跑。起 `.claude/launch.json` 的 `static-site`，開
`http://localhost:4173/scripts/mobile-audit.html`，按「開始量測」。
它把每頁塞進 375×812 與 320×720 的 iframe 量真實版面，回報橫向溢出、
觸控目標 < 44px、頁高。`scripts/` 不在 pages-deploy 的 cp allowlist，不會上線。

**它刻意不進 `verify.sh`，不要「順手塞進去」。** 這件事在 2026-09-03 評估過並否決：
那不是多跑一支 script，是把整個驗證基礎設施從 Node-only 升級成 browser-dependent。
量的是真實排版（`getBoundingClientRect` ＋ 媒體查詢），jsdom 沒有排版引擎、回傳全是 0，
所以一定得接一個真的瀏覽器。當時查到的三個成本：

1. **`backend/` 沒有 lockfile。** 加任何 devDependency（連 `puppeteer-core` 這種只有
   幾百 KB、不自帶瀏覽器的也一樣）都得先補一份並開始維護它。
2. **CI 的測試 job 完全沒有 `npm install`。** `site-check.yml` 直接跑 `npm test`，
   因為 `node --test` 只用內建模組。要用相依就得在 CI 加一段安裝，那一步現在不存在。
3. **CI 不該假設執行環境。** 本機有系統 Chrome 不代表 runner 有；要嘛下載瀏覽器
   （慢、肥），要嘛賭 runner image 的內容。

邊界因此劃在：`verify.sh` ＝ 快速、確定性、無瀏覽器依賴的 Stop gate；
`mobile-audit.html` ＝ 改 responsive／版面時的人工瀏覽器驗證。
真的要重開這個決定，先確認上面三條是不是還成立。

**一定要用行動裝置模擬（或真手機）跑，否則結果不算數。** `/weather/` 與 `/dash/`
的觸控目標是用 `@media (pointer: coarse)` 撐開的，桌機的 pointer 是 fine、那些規則
不生效，量到的是沒撐開的值——實測就這樣誤報過 `#coastSelect` 只有 30px。工具會自己
檢查跑在哪種 pointer 底下，fine 就把整份報告標成不可信，並逐列點名哪幾頁有 coarse
規則沒被套用。Claude 的瀏覽器窗格切 mobile preset 就會給 `pointer:coarse`。

**但模擬綠燈不等於真機綠燈——最後一定要用真手機跑一次。** 桌機的行動裝置模擬給得出
`pointer:coarse`、給得出視窗尺寸，**給不出原生表單控制項的度量**。實測 2026-09-03：
模擬下 13 頁全綠，同一版在真手機上冒出 18 個違規，而且**全部是 `<select>`**
（29–38px）——那是模擬結構上看不到的一類差異，不是我漏跑。
真機用的網址是 `http://<區網 IP>:4173/...`（Node 的靜態伺服器預設就綁全介面），
那不是 secure context，所以報告的「複製」鈕會退回「選起來長按複製」。

其他寫進判準裡的事：

- 頁面清單**跟著首頁的 `data-primary-entry` 走**，不重抄第四份（那份清單已經釘在
  靜態契約與 `frontend-smoke.test.js` 兩個地方）。首頁沒連出去的 `/market/`、
  `/forscan/service/`、`/forscan/sync3/` 列在 `EXTRA_ROUTES`。
- 載入後固定等 900ms 再量。`/weather/` 的 `.ext-link`（沿海預報 CTA）要等 fetch
  回來才渲染，太早量會漏。
- **有分頁的頁面會逐一切過去量**（`/market/` 3 個、`/flight/` 6 個，選擇器
  `.tabbar .tab, nav .tabbtn`）。**這是實測踩過的洞**：先前回報「13 頁全綠」時，
  `/market/` 的「ETF」與「全股票」分頁根本沒被走到——切過去之前那些控制項是
  `display:none`，整批被當成不可見而跳過。走訪之後一次冒出 6 個不足 44px 的目標。
  只量預設分頁＝只量了一部分。
- 三條刻意的豁免：勾選框量的是包住它的 `<label>`（命中區在那裡）、`.skip` 不算
  觸控目標（螢幕外的鍵盤 affordance）、句子裡的行內文字連結不算（WCAG 2.5.8 明文
  豁免，硬撐 44px 會把行高撐開）。改判準前先看原始碼裡那段註解。

## 補觸控目標的作法（44px）

2026-09-03 全站 13 頁在 375 與 320 都已歸零。要再補時照下面幾條，不要每頁自己發明。
（`/float/` 與 `/sky/` 都是那次之後才加的頁，不在那 13 頁裡。`/sky/` **從未量過**：
它只有 range 與 button、刻意沒有 `<select>`——那是真機上唯一冒出 18 個違規的元素——
但那不能取代實測。）
最多的一頁是 `/market/`（一次 21 個），下面每條都有它的實例。

- **撐 `<label>`，不要撐方塊。** 勾選框／單選鈕包在 label 裡時，命中區是 label
  （點文字也會勾）。`/market/` 的 `.fld`、`/coupon/` 的 `.check`、`/flight/` 的 `.chk`
  都是撐 label 到 44px，方塊只從 17–19px 加到 20–22px。把方塊本身撐成 44px 只會變醜，
  而且沒解決問題。
- **`<select>` 要先 `appearance:none`，`min-height` 才有用。** 這條在桌機模擬上看不出來：
  模擬會乖乖套用 `min-height`，但真手機對 `appearance:menulist` 的 select 用的是 UA 的
  原生控制項度量，`min-height` 整條被忽略。實測 2026-09-03 真機上五頁共 18 個 select
  停在 29–38px，而同一版在模擬下全綠。改法是 `appearance:none` ＋ 自己補下拉箭頭，
  **箭頭用兩道 `linear-gradient` 畫，不要用 SVG data URI**——SVG 需要
  `xmlns="http://www.w3.org/2000/svg"`，那個 `http://` 會撞到 `/subtitle/` 的
  「不得出現非 huggingface 的外部網址」（實測紅過一次）。
- **特異度要對得上。** `/coupon/` 實測 `select{min-height:44px}`（0,0,1）打不贏既有的
  `.field select{min-height:40px}`（0,1,1），改完量出來仍是 40px。寫規則前先找同名的
  既有規則，跟著它的選擇器層級寫。同一個坑的另外兩種形狀：`subtitle`／`convert` 的
  `.picker select`（0,1,1）蓋掉了 `select{padding-right:30px}`，箭頭壓在文字上；
  `flight` 的 media block 原本插在 `<style>` 中段，被更後面、同特異度的
  `input,select,textarea` 蓋回去——**media query 一律收在 `<style>` 最後**。
- **句中的行內文字連結不要強拉**（WCAG 2.5.8 明文豁免，硬撐會把行高撐開）。
  **但單獨佔一行的 CTA 不算行內**——`/forscan/` 通往兩個子頁的那兩顆只有 19px，
  它們是那頁的主要導覽，補了 class 撐到 44px；同頁 footer 句子裡那顆 14px 的維持原樣。
- **`<summary>` 只有沒掛 class 的會漏。** `/market/` 的 `.fold>summary` 本來就有
  `padding:12px 14px`（實測 46px），但另外四個裸的摺疊標題只有 18–21px。
  補 `padding` ＋ `min-height`，**不要改 `display`**——改成 flex 會讓預設的三角形箭頭消失。
- **`pointer:coarse` 還是 `max-width`，看那頁有沒有斷點。** 頁面已有 max-width 斷點就
  寫進去。`/dash/` 一個 max-width 斷點都沒有（只有 `min-width:760px`），直接改基準規則
  會連桌機 topbar 一起從 32px 長到 44px，所以照 `/weather/` 的做法用
  `@media (pointer:coarse)`——只有真的用手指點的裝置才撐開。
- **密集資料表的每列連結取 24px，不是 44px。** `/market/` 的 ETF 與全股票分頁各 100 列、
  每列一個 `a.tvlink`，全撐到 44px 會讓那張表多出 2,000px——密度本身就是那種畫面的功能。
  這類連結用 WCAG 2.5.8 AA 的 24px 下限（量測工具的 `DENSE_MIN`，判法是「`<a>` 在 `td` 裡
  且那張表在橫捲容器內」）。**其餘一律 44px**，別拿這條當通則。
- **寬表在手機上黏住第一欄。** ETF 18 欄 1,380px、全股票 9 欄 900px，而容器只有 345px——
  橫捲到第五欄就不知道自己在看哪一檔。`position:sticky;left:0` 釘住代碼欄，
  **黏住的格子一定要自己上底色**（`td`/`th` 本身透明，會透出下面的內容），
  用 `var(--panel)`——那正是 `.table-scroll` 的底色，才不會有接縫。
- **行內 CTA 可以用 padding ＋ 負 margin 而不動行高。** `/weather/` 的 `.radar-link` 用
  `padding-block:15px` + `margin-block:-15px` 把熱區撐到 45px、標題列高度不變，
  那個做法比 `min-height` 好。

規則寫在哪：`esp32`／`forscan`／`forscan/service`／`forscan/sync3`／`subtitle`／`convert`
是**同一套骨架**，共用的那段在六頁裡逐字相同（方便 diff 比對），各自寫在自己的
`@media (max-width:640px)` 裡；只有 `forscan` 在後面多一條 `.subpage-cta`。
`market`／`stocks` 用 `@media (max-width:760px)`。
**改 `/stocks/` 那個區塊要小心**：`.header-shell{flex-direction:column` 與
`.row-del{min-height:44px}` 兩行被 `frontend-smoke.test.js` 逐字釘住，動到就紅。

## 靜態契約 `scripts/check-static-site.mjs`

比一般 lint 嚴格很多，改頁面前先知道它管什麼，否則 CI 會紅：

- **首頁主要入口被釘死**為
  `stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/|flight:/flight/|dash:/dash/|coupon:/coupon/|subtitle:/subtitle/|convert:/convert/|bait:/bait/|float:/float/|sky:/sky/`，
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
  `投資建議`、`實領淨收益`。**註解也算**——見下面「註解也算」那一節。
- **所有 `/` 開頭的 href/src/srcset/url() 必須指向真實存在的檔案**。
- **天氣頁呼叫的每個 endpoint 都必須在 `weather-proxy/src/index.js` 的白名單裡**，
  且頁面不得出現 CWA API key。

## 部署：`pages-deploy.yml` 的 allowlist

```
cp -R index.html bjkw_weather.html 404.html sw.js esp32 forscan stocks market weather flight dash coupon subtitle convert bait float sky data assets dist/
```

**新增頂層頁面目錄一定要加進這行**，並同步加進 `sw.js` 的 `PRECACHE`（順手 bump `VERSION`，
不然 cache key 沒變、舊使用者拿不到新清單）。否則 Site check 會過、Pages deploy 會失敗 ——
兩個 workflow 檢查的東西不同，綠燈不代表上線成功。

**推之前可以先驗這一步**：照上面那行 `cp -R` 複製到一個暫存目錄，再對它跑
`node scripts/check-static-site.mjs <該目錄>` —— 那正是 workflow 做的事，
漏掉的目錄當場就會現形，不必等 Actions 紅了才知道。

**平行分支會讓 `VERSION` 撞號，而且不會有任何徵兆**（實測 2026-09-09）：
兩條分支各自從 `v8` bump 到 `v9`，git 看到兩邊文字相同、**不判成衝突**，
合併結果就是 `v9` —— 跟已經部署的那個 `v9` 一模一樣，cache key 等於沒變，
而所有測試全綠、Pages deploy 也成功。**合併 main 之後要比對的不是
「我有沒有 bump」，而是「合併結果的 VERSION 是否不同於 `origin/main` 上的 VERSION」**：

```
git show origin/main:sw.js | grep 'VERSION ='   # 已部署的
grep 'VERSION =' sw.js                          # 合併結果
```

相同就再往上推一格。

**但撞號不會造成「新頁上線後首頁還是舊的」——那條因果是錯的，我判斷錯過一次。**
`sw.js` 的導覽從 `v7` 起就是 **network-first**（`req.mode === "navigate"` → `fetch(req)`，
只有網路失敗才回快取），所以 service worker 端不出舊的 `/`；而且即使 VERSION 相同，
`sw.js` 的檔案內容變了就會觸發更新，`cache.add("/")` 會覆蓋同名快取裡的那一份。
撞號真正的代價是「舊 cache 不會被 `activate` 的清理刪掉」，不是首頁變舊。

**「新卡片沒出現」的判別順序——第一步是看 HTML 本身，不是快取。**
實測 2026-09-09：症狀是**桌機看得到、手機直式看不到、轉成橫向又出現**，
病因是 `index.html` 的浮標卡結尾少了 `</div>` 與 `</a>`（前一次合併衝突把共用的
結尾連帶吃掉）。瀏覽器遇到未關閉的 `<a>` 會自動收掉它，把後面那張星空卡重新掛進
浮標卡的 `.entry-foot` 裡，而手機版斷點正好把 `.entry-foot` 隱藏起來；橫式寬度
超過斷點，隱藏規則不生效，卡片就「轉個方向就出現」。

**「靜態契約綠燈」不代表 artifact 裡的 HTML 是對的**——這句我寫錯過一次。
契約的每一條都是**字面值比對**：`primaryLinks` 抓的是**開始標籤**、`cards` 的正則是
非貪婪的，所以壞掉的那版照樣數得出 12 個入口，`npm test` 也全綠。
現在補了 `assertWellNested()`（堆疊比對開關標籤，套在 `<nav class="entries">` 上），
但它只保護那一段；別的區塊壞掉一樣不會有人告訴你。

所以順序是：

1. **先看渲染後的 DOM 結構**，不是原始碼的字面值。「只在某個斷點消失」幾乎一定是
   結構被瀏覽器重新掛載，不是快取——快取不會挑寬度。
2. 真的要排除快取才用**不同的 cache key** 試同一份檔案：正常模式開 `/index.html`。
   它與 `/` 內容相同、快取項目不同。
3. 逆快取的最小介入是**手動觸發一次 `pages-deploy`**（它有 `workflow_dispatch`）。

**不要一開始就怪 service worker**，理由見上一段：導覽是 network-first。
我在這件事上連續判斷錯兩次（先怪 VERSION 撞號、再怪 CDN），害使用者白清了好幾次快取。

## 前端測試的硬性前提

`backend/test/market-page.test.js` / `frontend-smoke.test.js` 是用 `vm` 載入頁面的
**行內 `<script>`** 來測的，抓法是這個正則：

```js
html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)
```

所以 **`market/index.html` 的主 script 必須是最後一個、且緊貼 `</body>`**。
在它後面插任何東西，測試會抓不到 script 而整批失敗。
函式要能被測到就掛進 `MarketApp.helpers`。

## 註解也算

**靜態契約與前端測試掃的都是原始 HTML 文字，不是 DOM。** 註解是那份文字的一部分，
所以「只是寫在註解裡」不會讓任何一條斷言放過你。這條踩過兩次，兩次都不明顯：

- **禁詞**：程式碼註解寫了「保證」→ `check-static-site.mjs` 當場紅。
- **數標籤**（2026-09-03）：`market/index.html` 的 CSS 註解裡寫了帶角括號的 details
  標籤字樣，而 `market-page.test.js` 是**數那串字**來判斷「摺疊層數」與「主視覺之前
  不得有摺疊」的（`(before.match(/…/g) || []).length`），三條測試同時紅。
  改寫註解之後**又紅一次**——因為新註解裡拿來解釋這件事的那段正則本身又含同一串字。

實務規則：**在被掃描的頁面裡寫註解，不要複述被掃描的字面值。**
真的要提到就換個寫法（「角括號 + details」、「禁詞那幾個字」），或把說明寫進這份
CLAUDE.md ——這個檔沒有被任何一條斷言掃到（`check-static-site.mjs` 只掃
`README.md`、`CHANGES.md`、`weather-proxy/README.md`）。

會咬人的字面值集中在三處：`check-static-site.mjs` 的每一條 `assertNoMatch`、
`frontend-smoke.test.js` 的 `assert.doesNotMatch` 清單、以及 `market-page.test.js`
那三條數標籤的斷言。

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

## /coupon/：人工維護的 feed 之一

`data/coupons.json` **不由 CI 寫入**，是這個 repo 兩份人工維護的 feed 之一
（另一份是 `data/floats.json`，見下一節）。沒有 workflow 碰它，改它就是改 repo 內容。

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

## 不要為了 UI 完整性製造不可驗證的連續數值

**這條是全站規則，不只 `/float/`。** 一個欄位空著很難看，於是拿手上有的數字乘一個
係數把它填滿——那種數字不會讓任何測試變紅，也不會有人在畫面上看出破綻，只會在
真正要用它的場合是錯的。**系統不知道就要說不知道，不是產生一個看起來精準的錯數字。**

`/float/` 的「沉入深度」是最典型的例子，判準寫在 `data/floats.json` 的 `depthPolicy`：

```
資料知道：                    資料不知道：
✓ 浮標標記制度                 ✗ 浮標實際外形
✓ 名義適配鉛重                 ✗ 各高度截面積
✓ 當前總負載                   ✗ 浸沒體積函數
✓ 餘浮力                       ✗ 個別型號實測吃水曲線

所以可以回答「還差多少重量會完全沒入」，不能回答「現在沉入多少公分」。
```

阻擋按硬度排序（順序有意義，schema 測試釘住第一條與最後一條）：
1. 沒有該浮標的實際幾何／浮力曲線資料
2. 阿波是非等截面形狀，沒入體積與吃水深度不是固定線性關係
3. 標、鉛、母線與其他配件共同構成受力系統，浮標不是單獨受力的物體
4. 水體密度只是讓實際結果再偏移的環境變數——**不是**主要阻擋，別把它排前面

**超過完全沒入的臨界之後沒有平衡深度**：浮力已經到頂，多出來的重量沒有東西平衡它，
浮標會持續下沉；隨速度增加流體阻力增加，最終可能趨近終端速度——但那是速度不是深度，
而且一樣算不出來。「會沉」與「立刻等速」是兩件事，措辭不要混。

三道防線，缺一不可：
- `check-static-site.mjs` 的 **`FLOAT_DEPTH_CALCULATION_INVARIANT`**：用
  「下沉語彙 ＋ 數字 ＋ 長度單位」的正則擋住印在畫面上的假深度。
  改那條之前先跑一次反向測試（故意塞一個「沉入 3.2 cm」進去，它必須紅）。
- `float-page.test.js`：`helpers` 的名稱不得出現 `depth`／`submersion`／`draft`。
  靜態契約只擋得到字串，擋不到函式。
- `float-schema.test.js`：`depthPolicy.computable` 一旦被翻成 `true`，
  **每一列浮標都必須有可驗證的幾何資料**。要加深度就得先補資料，不能只加公式。

畫面上可以給的是重量那一側：餘浮力、距離完全沒入還差多少重量、浮力使用率（百分比）。
那些都是資料真的知道的東西。

## /float/：第二份人工維護的 feed

`data/floats.json` **不由 CI 寫入**（磯釣咬鉛與浮標號數的重量對照）。頁面是 `/float/`，
骨架照 `/coupon/`：fetch 一份 `data/` 底下的人工 feed、行內 script 緊貼 `</body>`、
純函式掛 `window.FloatApp.helpers`、`__FLOAT_SKIP_AUTO_INIT__` 擋自動初始化。
下面只記這一頁**額外**的規則。

- **`loadFromShot` 是這份資料的定義性檢查**（對應稅務那邊的「累進差額在級距交界處必須相等」）。
  浮標號數的意義就是「吃得下同名咬鉛」，所以 `floats[].loadGrams` 必須等於同名
  `shots[].grams`。兩張表分叉時肉眼完全看不出來，但配鉛試算給出的**每一個**數字都會是錯的。
  `float-schema.test.js` 逐列比對。只有負浮力標（`000`／`00`）與 `0` 號可以 `loadFromShot: null`。
- **feed 的網址不加 `?v=` 日期參數，而且 `/data/floats.json` 進了 `sw.js` 的 `PRECACHE`。**
  這跟 `/coupon/` 的做法不一樣，**不要「順手統一」**。`sw.js` 對 `/data/` 走 network-first，
  線上一定拿到最新的；加日期參數等於每天換一個 cache key，隔天在沒訊號的堤防上就整頁是空的。
  釣具規格一年動不了幾次，網址固定＋預載才是對的取捨。靜態契約用
  `assertNoMatch(/floats\.json\?/)` 釘住這件事。
- **`confidence` 只有三個值，而且與 `variants[]` 正交。** `cross-checked`（≥2 個來源給同一個
  數字，測試會檢查 `sourceIds.length >= 2`）／`single-source`／`conflicting`（來源分歧，
  **值留 `null`**、把看到的數字記進 `variants`）。廠牌差異走 `variants[]`，不塞進 confidence——
  「這個數字有多可信」與「別家給的是多少」是兩件事。
- **7B／8B 刻意留 `null`，而且已經找過三次了，不要再「補上」。** 目前有三組互不重疊的
  數字，沒有一組拿得到獨立佐證：2.70／3.20〜3.40（商品頁）、3.30／4.00（釣具教學頁）、
  4.50／5.00（部落格）。判法是**看級距接不接得上本表**——本表 B 到 6B 是
  +0.20／+0.20／+0.25／+0.65／+0.80，所以 2.70 接在 6B（2.65）之後只差 0.05 g，
  那個來源的 6B 顯然不是 2.65，兩套不能混用；3.30／4.00 那組（+0.65／+0.70）倒是接得上，
  但只有單一來源。三組都記進 `variants[]`，主值維持 `null`。
  `float-schema.test.js` 有一條專門釘住這件事。
- **來源給的是區間就記成區間**（`variants[].gramsRange`），不要折成中點。8B 的商品頁那組
  本來就是「3.20〜3.40」，折成 3.30 會憑空生出一個沒人講過的數字，而且剛好撞上另一個
  來源的 3.30——看起來像兩個來源互相佐證，實際上正好相反。`grams` 與 `gramsRange`
  二擇一，測試會擋同時寫兩個。
- **`seenVia` 記的是「這個來源是怎麼被讀到的」**，三個值代表三種可信程度：
  `search-summary`（從搜尋摘要讀到，沒開過原始頁）／`user-supplied`（使用者提供，
  本專案沒有自己確認過）／`opened`（人開過那一頁、在上面看到那些數字）。
  改成 `opened` 的判準就是最後那句——**HTTP 200 不算，字串比對命中也不算**。
  目前 18 筆：15 筆 `search-summary`（建表時的環境沒有對外連線）＋ 3 筆 `user-supplied`，
  `opened` 0 筆。這件事同時寫在 `verificationMethod`、渲染在頁面的鮮度列上、
  並由靜態契約釘住那句揭露。
- **`sources[].url` 可以是 `null`，但條件收得很緊。** 現場經驗沒有網址，它仍然是出處
  ——「沒出處的數字不准進表」這條不變式不該因此被繞過。`url` 為 `null` 時 `kind` 必須是
  `field-knowledge` 且 `seenVia` 必須是 `user-supplied`，畫面與複查報告上才看得出
  那是經驗而非文件。`float-source-audit.mjs` 的 `--fetch` 會跳過這種來源
  （對 `null` 發請求會直接丟例外），報告也不印空白網址。
- **配鉛是兩段的，不要只做咬鉛那一半。** 號數標用**相對應號數的鉛墜當主配重穿在母線上**
  （中通鉛／転環鉛），再用**子線的咬鉛微調**。門檻有出處：「5B 以內的阿波，阿波本身
  就是主配重，不額外使用鉛垂，僅在子線上夾上小咬鉛」——所以 `mainSinker.thresholdShot`
  是 `5B`，而且 `needsMainSinker()` 比的是**浮標號數的負荷**，不是差額。
  第一版漏了這條管道：`usableShots()` 不含 `go` **是對的**（那是子線咬鉛的清單），
  但當時除了它沒有第二個配重來源，結果 2 号標的 7.75 g 目標被湊成三顆 6B。
  門檻寫在資料裡而不是 JS 常數，才附得上出處；`float-schema.test.js` 有第二條定義性
  檢查釘住 `thresholdGrams === shots["5B"].grams`。
- **配鉛建議用窮舉而不是貪婪。** 這條刻度不是線性的（2B ＝ 0.75 g，不是 B 的兩倍），
  貪婪法會湊歪；候選只有十幾種、最多三顆，窮舉最準也夠快。主鉛那一段例外——
  它是「取最大的、不超過差額的號數」，因為現場就是照標的號數配。

### 來源複查 `scripts/float-source-audit.mjs`

人工執行，把每個來源反查成「它撐著哪幾列、那幾列宣稱的數值是什麼」。
`--fetch` 會實際拓頁面、在純文字裡比對那些數字；`--only <id>` 只跑一個來源。
**它不寫任何檔案**，`seenVia` 一律人工改。

```
node scripts/float-source-audit.mjs                  離線清單（無網路也能跑）
node scripts/float-source-audit.mjs --fetch          實際拓頁面並比對數值
node scripts/float-source-audit.mjs --only tw-neio   只處理一個來源
```

**它刻意不進 `verify.sh` 與 CI**，理由同 `mobile-audit.html` 那條界線：

1. 它要打十幾個外站。CI 不該把別人的部落格當成自己綠燈的條件——那些站掛一天，
   這個 repo 就紅一天，而那跟本站的程式碼對不對無關。
2. 那些站對 GitHub runner IP 的行為跟家用網路不同（TWSE 就對 runner 回過 HTML 錯誤頁）。
   在 CI 量到的「被擋」是假訊號，會訓練人忽略紅燈。
3. 產出是「人接下來要去看哪幾頁」，不是布林值。自動化只能縮小範圍，不能替代閱讀。

但它的**純函式被 `backend/test/float-source-audit.test.js` 蓋著**（那支不碰網路），
所以邏輯仍有 CI 迴歸保護。也因此那支工具**必須有 isMain guard**——照
`seed-market-52w.mjs` 省略 guard 的話，`npm test` 的那行 import 會真的去打十幾個外站。

只有 `dead`（404／410）會 exit 1：連結真的沒了，該列從此沒有出處。`blocked`（403／429）
與 `unreachable`（5xx／網路錯誤）都不算失敗——部落格擋機器人是常態，人開得起來。
**注意**：如果你在有出口代理的環境跑，代理擋掉的網域也會回 403，工具會報成 `blocked`，
分不出是站方擋的還是代理擋的，也不該去分。

### 真機 smoke test（每次動這頁的版面都要跑）

`mobile-audit.html` 在 `pointer:coarse` 下綠燈**不等於**真機綠燈——CLAUDE.md 上面那節
已經記過一次：模擬給不出原生表單控制項的度量。這一頁有**四個 `<select>`**，正是踩過的那類。

1. 起 `.claude/launch.json` 的 `static-site`，手機開 `http://<區網 IP>:4173/float/`。
2. **四個 select 逐一量**：`#shotFamily`（咬鉛對照的系列篩選）、`#floatPick`、
   `#residualPick`、`#mainSinker`（配鉛試算）。要看三件事：高度真的 ≥44px；
   `appearance:none` 之後自己用兩道 `linear-gradient` 畫的箭頭有畫出來、而且沒壓到文字；
   點下去的命中區對得上。
3. `.step` 步進鈕（−／＋）的命中區、分頁列三顆 tab、來源清單那十幾條連結。
4. **320 與 375 兩個寬度都要看。** 橫捲只該發生在 `.table-wrap` 內，body 不可橫捲。
5. 走訪**三個分頁**都要量——切過去之前那些控制項是 `display:none`，整批會被當成不可見跳過。

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

## `/sky/`：相機 + 感測器的天體辨識

`sky/lib/*.mjs` 是**原生 ESM，由 `node --test` 直接 import**，不走 `vm` 抽行內 script
那條路——天文公式需要密集數值測試，值得為它換掉那個 hack。頁面主 script 仍是 classic、
緊貼 `</body>`（`window.SkyApp.helpers`、`__SKY_SKIP_AUTO_INIT__`），數學庫用 `import()`
動態載入，那正是 `/convert/` 載 vendor 的做法。代價：`check-static-site.mjs` 掃 href/src
看不到動態 import，`sky/lib/*.mjs` 與 `sky/data/*.json` 已在 `mustExist` 逐檔點名，
加新模組要同步加。

完整規格與所有量測數字在 `sky/DESIGN.md`。下面只記會害人重做一次的事。

- **權威天文資料來源在這個環境全部連不到**（實測 2026-09-08）：CDS/VizieR、HEASARC、
  IAU 官方星名表、NOAA 磁偏角計算器都是連線被拒，Harvard TDC 回 403。唯一通得過的是
  `raw.githubusercontent.com`。**不要再花時間試那些網域。** 星表因此走
  `brettonw/YaleBrightStarCatalog` 鏡像（底層 BSC5 公有領域、鏡像轉換腳本 MIT）。
  刻意不用 HYG-Database：它是 CC BY-SA 4.0，會讓這個 repo 出現第一份帶分享相同條款的資料。
- **驗證用「不出貨的 oracle」**：天文算式對 pyerfa（IAU SOFA 的直譯版），星表對 HYG。
  兩者都在 repo 外的 venv／只在本機串流比對，**一個位元組都不進 repo**。這個模式正好
  繞開前面「手機版量測」那節列的三條成本（`backend/` 沒有 lockfile、CI 沒有 `npm install`、
  CI 不該假設執行環境）。實測殘差：GMST 對 `erfa.gmst82` 跨 60 年最大 0.00016 角秒、
  歲差係數對 `erfa.prec76` 差 0.000000000 角秒、星表位置對 HYG 中位 0.59 角秒。
- **沒有權威來源可對時，驗的是結構不變量而不是記憶中的數字**：最亮五顆的順序、
  Polaris 距北天極 0.736 度、六個星等分箱的累積數、log N 斜率、HR 不重複。
  同一組檢查**同時**是 `build-sky-catalog.mjs` 的寫入閘門與 `sky-catalog.test.js` 的斷言，
  照 `update-tax-params.mjs` 的模式——5,080 個數字壞掉時肉眼看不出來。
  字串也在閘門裡（不得含 HTML 特殊字元），因為頁面把名稱插進 `innerHTML`。
- **k-d tree 實測輸給線性掃描，不要「優化」回去。** 5,080 顆、10 度視野：線性 0.0071 ms、
  k-d 0.0036 ms；但 30 度視野是線性 0.0124 ms vs k-d 0.0176 ms，60 度是 0.0242 vs 0.0543
  ——遍歷開銷超過省下的比較。線性掃描已經是 5 ms 預算的 1/700。掃描比的是三維點積不是
  角距：整趟只有乘加、沒有三角函數，而且 0/360 接縫在向量空間裡根本不存在。
- **`acos` 在引數趨近 1 時是壞掉的量尺。** 量兩個近乎平行的向量夾角要用弦長
  （`2·asin(|u−v|/2)`）。用 `acos(點積)` 量到的是 2e-6 度的**底噪**，真正的誤差是 9e-14
  ——驗基底重建時踩過一次，差點誤判成公式有錯。`angles.mjs` 的 `angularSeparation`
  用 haversine 是同一個理由。
- **相機的視野角沒有任何標準介面問得到。** MediaStream 沒有這個欄位，也沒有跨瀏覽器的
  方法問得到焦距。預設 65 度只是起始值，頁面給滑桿讓使用者校正並存進 localStorage。
- **磁偏角沒有修正**（NOAA 計算器被擋、查不到可引用來源）。`geomag.mjs` 只有介面，
  查表回 `null`——**不可以用 0 代替未知**，那會讓畫面自信地指錯方向，同 `domesticRatio`
  那條紅線。畫面上的方位角是磁北的，靜態契約釘住頁面必須說出這件事，
  也釘住視野角拿不到那條。
- **天頂的萬向鎖是虛驚，不要改成四元數。** 平滑 (方位角, 仰角, roll) 在天頂的相機軸誤差
  0.616 度、平滑方向向量 0.578 度；畫面上方的最大轉速天頂 7.2°/s vs 低空 3.4°/s。
  方位角的誤差會被 cos(仰角) 壓掉。而且那三個角**無損保留完整姿態**
  （重建基底對旋轉矩陣最大差 9e-14 度，30 萬組隨機姿態）。
- **`deviceorientation` 的三個角都可能是 null，不是只有 alpha。** 少擋一個，座標轉換就
  丟例外，而那個例外是在 requestAnimationFrame 的回呼裡丟的——**迴圈停止排程、畫面凍結、
  相機還亮著、狀態列卻寫著「就緒」**。`readOrientationEvent()` 整筆丟掉缺角度的事件，
  `frame()` 另外包 try/catch 把錯誤寫上畫面並重新啟用開始鈕。
- **`DeviceMotionEvent.rotationRate` 的欄位沿用 alpha/beta/gamma 這三個名字，但它們是繞
  z/x/y 的角速度**，與 `deviceorientation` 的角同名不同軸。照名字對接會把三軸接錯，
  而且只表現成「轉起來怪怪的」，不會有任何錯誤訊息。
- **`screen.orientation.angle` 不進方位角的換算**：後鏡頭光軸恆為裝置 −z，螢幕內容怎麼轉
  都不會改變它。螢幕角度影響的只有 roll（世界的上方落在畫面的哪個方向）。
- **α 與方位角轉向相反**：α 繞天頂逆時針量、方位角順時針為正，直立時 `az = 360 − α`。
  直接拿 alpha 當方位角，畫面會左右相反。
- **互補濾波的權重必須是 `exp(−dt/τ)` 而不是常數**：感測器回呼的間隔本來就不規則，
  寫死 0.98 會讓平滑程度隨幀率漂移。
- **iOS 的感測器授權必須在使用者手勢的呼叫堆疊裡，排在任何 `await` 之前。**
  實測 2026-09-09 真機：`start()` 先 `await` 了載入函式庫、星表與 `getUserMedia`，
  輪到 `DeviceOrientationEvent.requestPermission()` 時手勢已經被消耗掉，回
  `Requesting device orientation access requires a user gesture to prompt`
  ——**相機拿得到、方位權限當場失敗**，所以看起來像「相機好了但感測器壞了」。
  `requestMotionPermissions()` 同步呼叫方向與動作兩個 requestPermission（iOS 上是
  兩個分開的 API），之後才串載入流程。這個順序被靜態契約釘住：抽出 `start()` 的函式體、
  去掉行註解、比對 `requestMotionPermissions(` 與第一個 `.then(` 的位置。
  **去註解那一步是必要的**——第一版沒做，抓到的是解釋這條規則的註解裡的同名字樣，
  斷言永遠通過，反向測試當場抓到。
- **錯誤路徑要把相機關掉。** 授權失敗時相機還開著，錄影指示燈亮、預覽在跑，
  但覆蓋層沒有作用——看起來像成功了。`catch` 裡 `stopCamera()`。
- **版面是滿版取景器 + 右上角半透明面板**（2026-09-09 改）。三件事被靜態契約釘住，
  都是「桌機模擬綠燈、真機壞掉」的那一類：舞台是 `100dvh`、面板用
  `env(safe-area-inset-*)`、**畫布不得禁用平移手勢**。最後那條是滿版帶來的新坑
  ——畫布鋪滿第一屏之後禁用平移＝整頁捲不動，實測拖曳 `scrollY` 停在 0，
  改成 `manipulation` 才是 439，而且壞掉時沒有任何徵兆。
  **不走 Fullscreen API**：iPhone 的 Safari 不支援對一般元素呼叫 `requestFullscreen()`。
  **改這頁不必 bump `sw.js` 的 `VERSION`**：`/sky/` 是導覽、走 network-first。
- **真機只驗過一次，而且是失敗的那次。** 觸控目標、疊加對不對得齊都還沒驗，
  逐項的檢查單與第一次的結果在 `sky/DESIGN.md` 末尾（版面改版後又多了 5 項）。

## 計劃審查閘門

`.claude/plan.md` 一存在就會觸發 `plan-review.py`，要求 Codex 跨模型審核通過才放行。
不需要審查時**刪掉該檔**解除，不要偽造 marker。
