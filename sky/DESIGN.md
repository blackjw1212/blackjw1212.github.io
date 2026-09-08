# /sky/ 設計規格：相機與姿態感測器的天體辨識

> 這份檔案是 `/sky/` 的活規格，四個 Phase 都會回來查它。
> 通用規則在 `~/.claude/CLAUDE.md`、本 repo 的專案事實在根目錄 `CLAUDE.md`，這裡不重抄。
> **本文件目前只有 Phase 1 是定稿**，Phase 2–4 的段落是待驗證的意圖，不是承諾。

## 這是什麼

用手機的 GPS、UTC 時間、姿態感測器（陀螺儀／加速度計／地磁）與相機，即時算出鏡頭指向
天球的哪個位置，查出那裡有什麼恆星，再把星名疊回相機畫面上。

四個階段：

| Phase | 內容 | 驗收標準 |
|---|---|---|
| 1 | 幾何與天文演算（純數學，無 I/O） | 見「Phase 1 驗收標準」 |
| 2 | 感測器融合與平滑（互補濾波） | 靜置漂移與手震抑制，待定 |
| 3 | 輕量化星表檢索（k-d tree） | 單次查詢 < 5 ms |
| 4 | AR 疊加（天球 → 螢幕像素） | 待定 |

---

## Phase 1：幾何與天文演算

### 1. 管線與方向

**感測器給的是視位置（apparent），星表存的是 J2000 平位置。** 方向寫在最前面，因為修正
加反邊時數值仍然「看起來很合理」，只是差了兩倍的修正量。

```
(A_mag, a_app, roll)
  ── applyDeclination ────────────▶  真北方位角
  ── unrefract ───────────────────▶  視高度 → 真高度
  ── horizontalToEquatorial(φ, LST) ─▶  (α_date, δ_date)
  ── precessDateToJ2000 ──────────▶  (α_2000, δ_2000)   ──▶  星表查詢
```

Phase 4 把星投回畫面時走**完全相反**的順序。兩個方向必須是同一組函式的互逆，
用 round-trip 測試釘住（見驗收標準第 1 條）。

### 2. 角度慣例

這一節是整份規格裡最容易出錯、也最不容易被發現的部分。**每個函式的 JSDoc 都要重述一次。**

| 符號 | 意義 | 範圍與正方向 |
|---|---|---|
| `φ` | 緯度 | `[-90, +90]`，北為正 |
| `λ` | 經度 | `[-180, +180]`，**東為正**（台北 ≈ +121.5） |
| `A` | 方位角 | `[0, 360)`，**真北為 0，向東為正** |
| `a` | 高度角 | `[-90, +90]`，地平線 0、天頂 +90 |
| `H` | 時角 | `(-180, +180]`，**正值代表已過中天（往西）** |
| `α` | 赤經 | `[0, 360)`（**以度為單位，不是小時**） |
| `δ` | 赤緯 | `[-90, +90]` |

三個必須分開的正規化函式，不可互相代用：

- `normalizeDeg(x)` → `[0, 360)`：用於 `A`、`α`、`GMST`、`LST`
- `normalizeHourAngle(x)` → `(-180, +180]`：**只**用於 `H`
- `clampLatitude(x)` / `clampAltitude(x)` → `[-90, +90]`

混用 `normalizeDeg` 與 `normalizeHourAngle` 會產生整整 360° 的誤差，而且不會拋任何錯。

> ⚠️ **Meeus《Astronomical Algorithms》的方位角是「從南起算、向西為正」。**
> 拿他的例題當測試向量時要 `A_north = A_meeus + 180`。這條寫進測試註解 ——
> 不寫的話，下次對不上一定會先去懷疑公式。

### 3. 時間：UTC → JD → GMST → LST

```
JD  = unixMs / 86400000 + 2440587.5
D   = JD - 2451545.0                     // 自 J2000.0 的天數
T   = D / 36525                          // 儒略世紀
GMST(deg) = 280.46061837
          + 360.98564736629 * D
          + 0.000387933 * T * T
          - T * T * T / 38710000
LST(deg)  = normalizeDeg(GMST + λ)
```

- **只吃 UTC 毫秒數。** `Date.getTimezoneOffset()` 永遠不進管線；要顯示本地時間是 UI 的事。
- 忽略 UT1−UTC（|ΔUT1| < 0.9 s，換算後 < 0.004°）。
- 忽略章動造成的 equation of the equinoxes（|Δ| ≤ 1.1 s，< 0.005°），因此本站算的是
  **平恆星時（mean sidereal time）**，不是視恆星時。這件事要在函式名稱上說清楚（`gmstDeg`
  而不是 `gastDeg`），否則之後有人接視位置演算會踩到。

理由見「誤差預算」——這兩項都比手機感測器誤差小三個數量級。

### 4. 地平 ↔ 赤道

正向（感測器 → 天球）：

```
δ = asin( clamp(sin a · sin φ + cos a · cos φ · cos A, -1, 1) )
H = atan2( -sin A · cos a,  sin a · cos φ - cos a · sin φ · cos A )
α = normalizeDeg(LST - H)
```

反向（天球 → 畫面，Phase 4 與 round-trip 測試共用）：

```
a = asin( clamp(sin δ · sin φ + cos δ · cos φ · cos H, -1, 1) )
A = normalizeDeg( atan2( -sin H · cos δ,  sin δ · cos φ - cos δ · sin φ · cos H ) )
H = normalizeHourAngle(LST - α)
```

### 5. 邊界條件

**每一條都要有一個對應的測試。** 這些不是理論上的角落，是實際會在使用者手上發生的輸入
（把手機舉到正上方就是天頂）。

#### 5.1 `asin` 引數溢位 → `NaN`

`sin a · sin φ + cos a · cos φ · cos A` 在數學上必定落在 `[-1, 1]`，但浮點運算會給出
`1.0000000000000002`，`Math.asin` 對它回 `NaN`，**而且不拋錯**。之後每一步都是 `NaN`，
畫面上就是「星星都不見了」而主控台一個字都沒有。

一律 `clamp(x, -1, 1)`。repo 已有先例：`dash/index.html` 的 `haversineMeters()` 用
`Math.min(1, ...)` 收斂 `Math.asin` 的引數。

#### 5.2 天頂 `a = +90°`

`cos a = 0` 讓 `atan2` 的分子與分母**同時**為 0。`Math.atan2(0, 0)` 在 JS 定義為 `0`，
於是 `H = 0`、`α = LST`、`δ = φ` —— **恰好是正確答案**。

但這是巧合，不是設計。顯式分支回 `{ dec: φ, hourAngle: 0 }`，並用測試釘住，
不要留給下一個人去驗證 `atan2(0,0)` 的規格。

#### 5.3 天底 `a = -90°`

正確答案是 `δ = -φ`、`H = 180°`。公式會走到 `atan2(-0, -cos φ)`，回 `-π`，
換算後是 `-180°` —— 數值等價，但**取決於 `-0` 的號誌**（`-sin A · cos a` 在 `cos a = +0`
時是 `-0`）。同樣顯式分支。

#### 5.4 極點 `|φ| → 90°`

`cos φ = 0` 時 `atan2` 本身仍良好定義，但**經度在極點沒有意義**，LST 因此也失去意義：
同一個 `(A, a)` 配上任何 `λ` 都會得到不同的 `α`，而且每一個看起來都很正常。

判準：`|φ| > 89.9999` 時 clamp 到 `±89.9999`，並在回傳值帶 `degenerate: true`，
讓 UI 有機會說「在極點附近方位角無法決定赤經」。

#### 5.5 `α` 跨 0/360 的接縫

`359.9°` 與 `0.1°` 的角距是 `0.2°`，不是 `359.8°`。星表查詢**一律**走
`angularSeparation()`，禁止對赤經直接相減 —— 否則 0h 附近的星會整批漏抓，
而且其他天區看起來完全正常。

#### 5.6 螢幕方向與 roll

`roll` 只影響 Phase 4 的畫面投影，**不影響 `(α, δ)`**。Phase 1 的函式簽章裡不要有它。

### 6. 磁偏角

```
applyDeclination(magneticAzimuth, declinationDeg) → magneticAzimuth + declinationDeg
```

**東偏為正。** Phase 1 只定這個介面與符號慣例，實作分兩段：

1. 先做常數表（台灣本島一個值就夠用）。照 repo 對人工維護資料的慣例，每筆必附來源網址與
   查詢日期（參考 `data/coupons.json` 的 `sourceUrl` / `verifiedAt`）。
2. **查不到就回 `null`，不准填 0。** 這是 repo 既有的紅線（見根目錄 `CLAUDE.md` 關於
   `domesticRatio` 的那段：誤填 0 比 `null` 危險，因為 `null` 會讓上層回退到「未修正」的
   提示，而 0 會讓畫面自信地指錯方向）。

完整 WMM 係數表（約 1,700 個數字）留到確認 0.36° 級的誤差真的重要時再談。
以目前的誤差預算，它排在感測器誤差後面很遠。

### 7. 誤差預算

**這張表決定做什麼、不做什麼。** 改任何一條修正之前先回來看它。

| 來源 | 量級 | 決策 |
|---|---|---|
| 地磁方位角（手機） | ±2°～±10° | **最大宗。準確度的戰場在 Phase 2，不在這裡。** |
| 加速度計傾角 | ±1°～±2° | 同上 |
| 忽略歲差（J2000 → 2026） | ≈ 0.36°（50.29″/年 × 26 年） | **做**：rigorous 三角轉換，便宜且確定 |
| 大氣折射（地平線） | 0.57°（34′） | **做**：Bennett 公式 |
| 大氣折射（30° 仰角） | 0.03°（1.7′） | 同一支函式順便涵蓋 |
| 忽略章動與 equation of equinoxes | < 0.005° | 忽略 |
| 忽略 UT1−UTC | < 0.004° | 忽略 |
| GPS 位置誤差 10 m | ~0.0001° | 忽略 |
| 周日光行差 | ≤ 0.32″ | 忽略 |
| 恆星周年視差 | < 1″ | 忽略 |

**結論：Phase 1 的目標不是「準」，是「數學不能是誤差來源」。** 相對於感測器的度級誤差，
數學層的殘差壓到 0.01° 以下就綽綽有餘；再往下追是浪費。

### 8. Phase 1 驗收標準（DoD）

1. **Round-trip 不變量**：隨機 1,000 組 `(φ, λ, t, A, a)`，`horizontalToEquatorial` 後再
   `equatorialToHorizontal`，誤差 < 1e-9 度。極點與天頂／天底另有專屬測試，不混進這一條。
2. **對齊公開標準值**：用 Meeus《Astronomical Algorithms》的 GMST 例題與金星地平座標例題
   當固定測試向量。**實作時翻原書核對數字，不可憑記憶抄** —— 記錯一位不會讓任何測試變紅，
   只會讓所有測試一起錯。記得套用 §2 的 `+180°` 方位角換算。
3. **邊界條件**：§5 的六條各一個測試。
4. **Stellarium 人工對齊**：同一組時間與地點，方位角差 < 0.1°。
   **這一條不進 CI**，理由與 `scripts/mobile-audit.html` 完全相同：需要外部軟體，
   而 `.claude/verify.sh` 必須維持快速、確定性、無外部依賴。操作步驟見 §10。

---

## 資料夾架構

```
sky/
  DESIGN.md              本檔
  index.html             (Phase 2+) 單頁：UI + 行內 classic script，緊貼 </body>
  lib/
    angles.mjs           (P1) normalizeDeg / normalizeHourAngle / clamp / angularSeparation
    time.mjs             (P1) julianDay / julianCenturies / gmstDeg / lstDeg
    coords.mjs           (P1) horizontalToEquatorial / equatorialToHorizontal
                              / precessDateToJ2000 / refraction
    geomag.mjs           (P1) applyDeclination + 磁偏角查表介面
    orientation.mjs      (P2) 互補濾波
    catalog.mjs          (P3) 星表載入 + 單位向量 + k-d tree
    project.mjs          (P4) 天球 → 螢幕像素
  data/
    bsc5-mag6.json       (P3) 精簡亮星表（Yale BSC，Vmag ≤ 6）
backend/test/
  sky-time.test.js       (P1)
  sky-coords.test.js     (P1)
  sky-page.test.js       (P2+) 行內 script 的 helpers
```

### 為什麼純數學庫是獨立 ESM，不塞進行內 script

本 repo 的頁面測試是用這條正則從 HTML 抽行內 `<script>` 丟進 `vm` 跑的：

```js
html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)
```

天文公式是這個專案最需要密集數值測試的部分（1,000 組 round-trip、六條邊界、兩組標準向量），
值得為它換掉那個 hack：

- **好處**：`backend/test/*.test.js` 直接 `import("../../sky/lib/coords.mjs")`，
  拿到真正的模組，不必維護 vm sandbox 的 globals 清單，也不會踩到 realm 的原型陷阱
  （既有測試為此得改用寬鬆 `node:assert` 或 `JSON.parse(JSON.stringify(...))`）。
- **頁面端不破例**：主 script 仍是 classic、仍緊貼 `</body>`（照 `/subtitle/` 與 `/convert/`
  的骨架），用 `await import("/sky/lib/coords.mjs")` 動態載入。這正是 `/convert/` 載 vendor
  的既有做法，不是新發明。
- **代價**：`scripts/check-static-site.mjs` 掃 href/src 的迴圈**看不到動態 `import()` 的檔**，
  所以 `sky/lib/*.mjs` 與 `sky/data/*.json` 必須逐檔加進 `mustExist`。
  理由與該腳本對 convert vendor 寫的那段註解相同。加新模組要同步加，否則
  pages-deploy 漏檔時 Site check 仍會綠。

### 為什麼星表放 `sky/data/` 而不是根目錄 `data/`

根目錄 `data/` 是 CI 每日自動 commit 的 feed，有 schema 測試與資料管線（唯一的人工例外是
`coupons.json`）。星表是一次產生、之後永不變的靜態資產，混進去會讓「這個目錄由 CI 寫入」
這條規則出現例外，也會讓 schema 測試的邊界變模糊。

---

## Phase 2–4 的已知前提（尚未定稿）

### Phase 2：感測器融合

- **iOS 13+ 的 `DeviceOrientationEvent.requestPermission()` 只能在使用者手勢的呼叫堆疊裡呼叫。**
  自動要會直接被拒，而且之後要不回來。`dash/index.html` 已有可抄的完整範例與註解，
  包含把「傾角授權」與 wakeLock 併成同一顆按鈕的做法。
- 授權與錯誤的 UI 照全站慣例走 `setState(node, message, tone)`（tone 為 `""` / `"ok"` / `"error"`），
  **只在畫面上降級，不 alert、不 throw 到頂層**。
- `screen.orientation.angle` 要納入方位角換算，`dash/index.html` 的 `normalizeLean()`
  是既有的參考實作。

### Phase 3：星表

- 資料源 Yale Bright Star Catalog，篩 `Vmag ≤ 6.0`，約 9,000 筆。需要一支離線轉檔 script
  （放 `scripts/`，該目錄不在部署 allowlist、不會上線）。
- 赤經赤緯先轉成三維單位向量再建 k-d tree：球面上的「最近」在角度空間有接縫（§5.5），
  在向量空間沒有。
- 查詢預算 < 5 ms。

### Phase 4：AR 疊加

- 相機需要 `getUserMedia`。**全 repo 目前沒有任何 `getUserMedia` 的使用先例**，
  沒有可抄的權限流程，這一段要自己建立並補進本檔。
- 需要相機的實際 FOV 才能把角度換成像素；`MediaTrackSettings` 不一定給得出來，
  可能得做成使用者可校正的參數。這一點尚未查證。

---

## 新頁上線時必須同步改的六處

**`sky/index.html` 真的存在的那一刻**，下面六處要一起改。缺任何一處都會出現
「Site check 綠但 Pages deploy 失敗」或「靜態契約綠但 npm test 紅」—— 兩個 workflow
檢查的東西不同，綠燈不代表上線成功。

1. **首頁 `index.html`**：新增一張卡片，屬性順序固定 `class → data-primary-entry → href →
   aria-label`（兩條正則都靠它），`aria-label` 必須以卡片 `<h2>` 開頭並另外帶上目的地路徑。
   順帶更新 `<meta name="description">` 與 `og:description` 裡的工具數與清單。
2. **`scripts/check-static-site.mjs`**：primary entries 的字面值**出現在條件與錯誤訊息兩處，
   兩處都要改**；加上本頁的 title / canonical / theme-color 比對；`mustExist` 逐檔列出
   `sky/lib/*.mjs` 與 `sky/data/*.json`；把 `sky/index.html` 加進頁面掃描迴圈的陣列。
3. **`backend/test/frontend-smoke.test.js`**：`assert.deepEqual(primaryLinks, ...)` 與
   同一個 test 裡逐條的 `href` 斷言。**同一份清單釘在兩個地方，只改一邊會讓 `npm test` 紅
   而靜態契約綠。**
4. **`.github/workflows/pages-deploy.yml`** 的 `cp -R` allowlist 加 `sky`。
5. **`sw.js`**：`PRECACHE` 加 `/sky/` 並 bump `VERSION`（不 bump 的話 cache key 沒變，
   回訪使用者拿不到新清單）。**`sky/lib/` 與 `sky/data/` 不進 `PRECACHE`** ——
   走既有的 cache-first 靜態資產分支，理由同 vendor：不該讓只想看 `/stocks/` 的訪客
   先吞下整份星表。
6. **`scripts/mobile-audit.html`** 在**真手機**上跑一次 375 與 320。模擬綠燈不等於真機綠燈；
   若本頁有 `<select>`，記得先 `appearance:none` 才撐得起 44px，而且下拉箭頭要用
   `linear-gradient` 畫、不要用 SVG data URI。

---

## Stellarium 人工對齊步驟

1. 在 Stellarium 設定一個固定觀測地點（例如台北 25.0330°N, 121.5654°E, 海拔 10 m）與一個
   固定 UTC 時刻，關閉大氣（Atmosphere）以排除折射，關閉「視位置」相關的額外修正。
2. 選一顆亮星，記下它的方位角與高度角。**注意 Stellarium 預設的方位角也可能是從南起算**，
   在設定裡確認一次。
3. 把那組 `(A, a, φ, λ, t)` 餵進 `horizontalToEquatorial`，比對輸出的 `(α, δ)` 與
   Stellarium 顯示的 J2000 座標。
4. 差值 < 0.1° 才算通過。差 0.3°～0.4° 通常表示歲差沒套或套反邊；差整整 180° 是方位角
   起算方向；差 360°/n 的整數倍是正規化函式用錯。
