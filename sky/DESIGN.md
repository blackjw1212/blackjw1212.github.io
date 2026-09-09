# /sky/ 設計規格：相機與姿態感測器的天體辨識

> 這份檔案是 `/sky/` 的活規格，四個 Phase 都會回來查它。
> 通用規則在 `~/.claude/CLAUDE.md`、本 repo 的專案事實在根目錄 `CLAUDE.md`，這裡不重抄。
> **四個 Phase 都已實作，`/sky/` 已接上首頁與部署**：102 條測試。
> 唯一沒做的是真機驗證 —— 相機、感測器、觸控目標都必須在真手機上再跑一次。

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

### 5. 邊界條件（每條都有對應測試）

**這一節在 2026-09-08 被實測改寫過。** 初版規格對其中三條的猜測是錯的，而且錯得很像對的
——保留這段修正紀錄，是因為同一個直覺很容易再犯一次。實測腳本的結論見下面各條。

#### 5.1 `asin` 引數溢位 → `NaN`（成立，而且比預期常見得多）

`sin a · sin φ + cos a · cos φ · cos A` 在數學上必定落在 `[-1, 1]`，但浮點會給出
`1.0000000000000002`，`Math.asin` 對它回 `NaN` 且不拋錯。之後每一步都是 `NaN`，
畫面上就是「星星都不見了」而主控台一個字都沒有。

**實測**：40 萬組隨機擾動中出現 4,450 次，正反兩個方向都會發生。觸發條件是
`a ≈ φ` 且 `A ≈ 0` —— 那正是**把手機指向天球極（北極星）**，是這個 app 最常見的動作
之一，不是理論上的角落。

→ `asin` 與 `acos` 的引數一律 `clamp(x, -1, 1)`。

#### 5.2 天頂、天底、觀測者在地極：**不需要特例分支**（初版說需要，是錯的）

初版寫「天頂時分子分母同時為 0，`Math.atan2(0,0)` 只是恰好給出正確答案」。**這是錯的。**

實測：`Math.cos(90 * π/180)` 是 `6.123233995736766e-17`，**不是 0**。所以在天頂時
分母 `x = sin a · cos φ − cos a · sin φ · cos A` 收斂到 `cos φ ≠ 0`，`atan2` 條件良好，
得到 `H ≈ 4e-15°`、`δ = φ`（誤差 < 1e-12°）。天底同理得 `H = ±180°`、`δ = −φ`；
初版說它「取決於 `-0` 的號誌」也不對 —— 號誌來自 `±6.1e-17` 這個真實的微小值，
而且 `+180` 與 `−180` 本來就是同一個方向。

觀測者站在地極（`|φ| = 90`）時公式一樣良好定義（`δ` 就等於仰角）。初版開的
「clamp 到 89.9999 並標記 degenerate」處方是在解一個不存在的問題，而且 clamp 本身
會引入誤差。**真正沒有意義的是「經度」**，所以 LST 無從決定 —— 那是資料問題，
不是這條公式的問題。

→ 三種情況都不加分支。但**三種都要有測試把行為釘住**，否則日後有人「順手加個 if」
就改了行為。時角輸出統一正規化成 `+180`，讓輸出有唯一形式。

#### 5.3 唯一真正的 0/0：站在地極、又剛好指著天頂

此時 `cos φ` 與 `cos a` 同時是 6.1e-17，分子分母都塌成 0，`H` 隨 `A` 亂跳（實測 0、−45、−0）。

但這是**正確答案**：這時看的就是天球極本身，而天極的赤經在定義上就不存在。

→ 判準因此不是「觀測者在哪」而是「看到的是不是天極」：`|δ| > 90 − 1e-9` 時回
`raDefined: false`。這同時涵蓋 5.1 那個 clamp 之後 `δ = 90` 的情況。**不可以回一個
看起來很正常的赤經。**

#### 5.4 `α` 跨 0/360 的接縫（成立）

`359.9°` 與 `0.1°` 的角距是 `0.2°`，不是 `359.8°`。星表查詢**一律**走
`angularSeparation()`，禁止對赤經直接相減 —— 否則 0h 附近的星會整批漏抓，
而且其他天區看起來完全正常。

角距用 haversine 而不是 `acos(sin·sin + cos·cos·cos)`：後者在小角度時引數趨近 1，
`acos` 的相對誤差會炸開。Phase 3 的比對全是視野內的小角度，這是那件事的前提。

#### 5.5 `H` 與 `A` 的正規化不可互用（成立）

`normalizeHourAngle` → `(-180, 180]`，`normalizeDeg` → `[0, 360)`。
混用產生整整 360° 的誤差而且不拋錯。

#### 5.6 `roll` 不影響 `(α, δ)`

只影響 Phase 4 的畫面投影。Phase 1 的函式簽章裡沒有它。

### 6. 磁偏角

```
applyDeclination(magneticAzimuth, declinationDeg) → magneticAzimuth + declinationDeg
```

**東偏為正。** Phase 1 只定這個介面與符號慣例，實作分兩段：

1. 常數表（台灣本島一個值就夠用）。照 repo 對人工維護資料的慣例，每筆必附來源網址與
   查詢日期（參考 `data/coupons.json` 的 `sourceUrl` / `verifiedAt`）。
   **這張表目前是空的，那是刻意的不是漏做**：NOAA 的線上磁偏角計算器（`ngdc.noaa.gov`）
   在本專案的網路環境被 egress proxy 擋住（實測 2026-09-08），拿不到可引用的數值，
   而沒有出處的數字不寫進資料檔。要補這張表，先解決取得可引用來源的問題。
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
| 忽略歲差（J2000 → 2026） | **實測 0.349°**（SOFA 旋轉矩陣，Betelgeuse 位置） | **做**：rigorous 三角轉換，便宜且確定 |
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
2. **對齊公開標準值**：oracle 是 **pyerfa（IAU SOFA 的直譯版）**，不是 Meeus 那本書 ——
   書本身也是在轉述這套標準模型，直接對上游比對可以完全避開「抄錯的參考答案」這個風險
   （錯的 oracle 會讓測試自洽但全錯，比測試失敗危險）。
   已完成的比對（2026-09-08）：
   - `gmstDeg` vs `erfa.gmst82`：1970–2030 間最大差 **0.00016 角秒**
   - 地平↔赤道 vs `erfa.hd2ae`：5 組向量，殘差 < 1e-8 度
   - 歲差係數 vs `erfa.prec76`：±40 年內差 **0.000000000 角秒**
   - 交叉核對：上述向量同時重現了 Meeus Example 12.a（13h10m46.3668s，差 0.0004 角秒）
     與 13.b（金星 A=68.0337°/h=15.1249°，差 0.02″/0.09″），連帶證實 §2 的 `+180°` 換算。
   重新產生 fixture 的方法寫在兩支測試檔的檔頭。**pyerfa 不是這個 repo 的相依**，
   是人工比對時在 repo 外的 venv 裡跑的（backend/ 沒有 lockfile、CI 也沒有 npm install）。
3. **邊界條件**：§5 的六條各一個測試。
4. **Stellarium 人工對齊**：同一組時間與地點，方位角差 < 0.1°。
   **這一條不進 CI**，理由與 `scripts/mobile-audit.html` 完全相同：需要外部軟體，
   而 `.claude/verify.sh` 必須維持快速、確定性、無外部依賴。操作步驟見 §10。

---

## 資料夾架構

```
sky/
  DESIGN.md              本檔
  index.html             ✅ 單頁：相機 + canvas 疊加，行內 classic script 緊貼 </body>
  lib/
    angles.mjs           ✅ toRadians / toDegrees / clamp / normalizeDeg
                            / normalizeHourAngle / angularSeparation
    time.mjs             ✅ julianDay / julianCenturies / gmstDeg / lstDeg
    coords.mjs           ✅ horizontalToHourAngle / hourAngleToHorizontal
                            / horizontalToEquatorial / equatorialToHorizontal
                            / precessionAnglesDeg / precessJ2000ToDate / precessDateToJ2000
                            / refractionDeg / trueAltitudeFromApparentDeg
                            / apparentAltitudeFromTrueDeg
    geomag.mjs           ✅ 介面 only：applyDeclination / lookupDeclination
                            / DECLINATION_TABLE（空表，理由見 §6）
    orientation.mjs      ✅ orientationToMatrix / cameraAxisFromMatrix
                            / pointingFromMatrix / orientationToPointing
                            / rotationRateFromEvent / rotationRateToPointingRates
                            / fuseAngleDeg / createPointingFilter
    catalog.mjs          ✅ parseCatalog / loadCatalog / queryCone
                            / queryConeForDate / nearestStar / describeStar
    project.mjs          ✅ directionFromHorizontal / horizontalFromDirection
                            / basisFromPointing / createProjector
  data/
    bsc5-mag6.json       ✅ 5,080 顆（Yale BSC5，Vmag ≤ 6），220 KB / gzip 75 KB
backend/test/
  sky-time.test.js       ✅ 11 條
  sky-coords.test.js     ✅ 23 條（angles / coords / 邊界 / 歲差 / 折射 / geomag 介面）
  sky-orientation.test.js ✅ 25 條（姿態→指向 / 陀螺儀速率 / 互補濾波 / 有狀態包裝）
  sky-catalog.test.js    ✅ 17 條（schema / 不變量 / 查詢正確性 / 接縫 / 歲差串接 / 效能）
  sky-project.test.js    ✅ 17 條（基底重建 / 投影 / roll / 反投影 / 錐體半徑）
  sky-page.test.js       ✅ 9 條（行內 script 的 helpers）
scripts/
  build-sky-catalog.mjs  ✅ 離線一次性轉檔工具（不進 Actions、不會上線）
```

`sky-coords.test.js` 同時涵蓋 `angles.mjs` 與 `geomag.mjs`：前者是座標轉換的純支援函式，
後者在 Phase 1 只有三個斷言，各自開一支檔案不划算。等 `geomag.mjs` 真的長出模型再拆。

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

### Phase 2：感測器融合 —— 演算層已完成，頁面端未動

`sky/lib/orientation.mjs` ＋ `backend/test/sky-orientation.test.js`（25 條）。
下面四條是實作過程中查證出來、且**與直覺相反**的事實。

#### 姿態角 → 相機指向

W3C 的 `deviceorientation` 是內旋 Z-X'-Y''，`R = Rz(α)·Rx(β)·Ry(γ)`，
把裝置座標轉成世界 ENU。**後鏡頭的光軸恆為裝置的 −z**，所以相機軸就是 `−R·(0,0,1)`。

- **`screen.orientation.angle` 不進方位角的換算**（初版規格說要，是錯的）。
  鏡頭固定在機身上，螢幕內容怎麼轉都不會改變光軸指向。螢幕角度影響的只有 roll
  ——世界的上方落在畫面的哪個方向——那是 Phase 4 畫標籤時的事。
- **α 與方位角轉向相反**：α 是繞天頂逆時針量的，方位角順時針為正，直立時
  `az = 360 − α`。把 alpha 直接當方位角用，畫面會左右相反。
- 正對天頂／天底時方位角在幾何上不存在，回 `azimuthDefined: false`
  （與 Phase 1 的 `raDefined` 同一個模式）。

驗證方式：封閉形式對三個基本矩陣連乘（5,000 組隨機，最大差 0）、正交性與 det=1、
六個「手機這樣拿 → 鏡頭看哪裡」的直覺案例。

#### 陀螺儀速率 → 指向速率

**`DeviceMotionEvent.rotationRate` 的欄位沿用 alpha/beta/gamma 這三個名字，
但它們是繞 z / x / y 的角速度**，與 `deviceorientation` 的三個角同名不同軸。
照名字對接會把三軸接錯，而且只會表現成「轉起來怪怪的」，不會有任何錯誤訊息。

映射是 `ω_world = R·ω_device`、`v̇ = ω_world × v`，再投影到方位角與仰角。
用中央差分做數值微分獨立驗證，相對誤差 3e-6（殘差主要來自差分本身）。

#### 互補濾波

`fuseAngleDeg()`：先用陀螺儀預測，再往量測值拉回一部分。兩個容易寫錯的地方：

- **權重是 `exp(−dt/τ)`，不是常數。** 感測器回呼的間隔本來就不規則（掉幀、
  背景分頁），寫死 0.98 會讓平滑程度隨幀率漂移。指數形式讓「一段時間切成幾份」
  得到同一個答案，測試釘住了這條。
- **循環角要走最短路徑。** 359 度與 1 度的中點是 0 度不是 180 度；直接寫
  `w·a + (1−w)·b` 會讓使用者面向北方時畫面瞬間甩到南方。

有陀螺儀時穩態落後為 0；沒有時退化成純低通，落後約「速率 × τ」（測試量到 60°/s
轉頭時約 21 度，與 `rate × τ` 相符）。`DEFAULT_TIME_CONSTANT_SECONDS = 0.35`
**是起始值不是調校值** —— 調它需要真手機。

#### 有狀態的包裝 `createPointingFilter()`

替呼叫端管住三件實際會發生的事：第一筆沒有前值可混、時間戳重複或倒退不可改變狀態、
間隔超過 `MAX_GAP_SECONDS`（分頁切走再切回來）要重新初始化而不是拿舊速率去積分。

#### 還沒做的：頁面端

- **iOS 13+ 的 `DeviceOrientationEvent.requestPermission()` 只能在使用者手勢的呼叫堆疊裡呼叫。**
  自動要會直接被拒，而且之後要不回來。`dash/index.html` 已有可抄的完整範例與註解，
  包含把「傾角授權」與 wakeLock 併成同一顆按鈕的做法。
- 授權與錯誤的 UI 照全站慣例走 `setState(node, message, tone)`（tone 為 `""` / `"ok"` / `"error"`），
  **只在畫面上降級，不 alert、不 throw 到頂層**。
- **`webkitCompassHeading` 與 α 的關係尚未查證**：iOS 上 α 的原點是否為磁北、
  `webkitCompassHeading` 給的是磁北還是真北，都要真機確認。演算層刻意不假設，
  只收「已經是真北的方位角」。
- τ 的實機調校、以及地磁受干擾（靠近金屬、磁吸配件）時的偵測。
  `deviceorientation` 不提供磁場強度，因此無法從這一層判斷，可能要靠
  `webkitCompassAccuracy`（僅 iOS）或請使用者做 8 字校正。

### Phase 3：星表檢索 —— 已完成

`sky/lib/catalog.mjs` ＋ `sky/data/bsc5-mag6.json` ＋ `scripts/build-sky-catalog.mjs`
＋ `backend/test/sky-catalog.test.js`（17 條）。

#### 資料來源與授權

**所有權威來源在本專案的網路環境都連不到**（實測 2026-09-08）：CDS/VizieR、HEASARC、
IAU 官方星名表都是連線被拒，Harvard TDC 回 403。唯一可達的是 `raw.githubusercontent.com`。

選定 `brettonw/YaleBrightStarCatalog` 的 **`bsc5-all.json`**：

- 它有**數值化**的 RA/Dec 分量（`RAh/RAm/RAs`、`DEd/DEm/DEs`、`DE-`），不必解析
  `"00h 05m 09.9s"` 這種字串，少一整類失敗模式。座標是 J2000，與 §1 的管線相符。
- **授權乾淨**：底層 BSC5 是公有領域（Harvard TDC / NASA ADC），鏡像 repo 的 MIT
  只蓋它自己的轉換腳本。**刻意不用 HYG-Database** —— 它是 CC BY-SA 4.0，
  會讓這個 repo 出現第一份帶分享相同條款的資料。
- Vmag ≤ 6.0 → **5,080 顆**，其中 2,738 顆有稱號。

#### 怎麼驗證一份沒有權威來源可對的資料

同 Phase 1 的原則：**不比對記憶中的座標，比對幾何與統計上必然成立的事實**。
這組檢查同時是 `build-sky-catalog.mjs` 的寫入閘門（不過就 exit 1 且不寫檔，
照 `update-tax-params.mjs` 的模式）與 `sky-catalog.test.js` 的斷言 ——
兩邊都釘住，重新產生資料時弄壞了會在 CI 當場紅。

| 檢查 | 實得 |
|---|---|
| 最亮五顆 | Sirius −1.46、Canopus −0.72、Arcturus −0.04、Rigil Kentaurus −0.01、Vega 0.03 |
| 距北天極 2° 內最亮 | Polaris，距極 **0.736°** |
| 距南天極 2° 內最亮 | Polaris Australis（σ Oct），距極 1.044° |
| 星等累積數 | V≤1:15、≤2:50、≤3:174、≤4:518、≤5:1630、≤6:5080 |
| log N 相鄰斜率 | 0.47–0.54（理論約 0.6，實際天空因銀河結構略平） |
| HR 重複 / 座標越界 | 0 / 0 |

**另用 HYG-Database 當不出貨的獨立 oracle**（`--cross-check-hyg` 旗標；HYG 是
CC BY-SA，**一個位元組都不進 repo**，同 Phase 1 用 pyerfa 的模式）：

- 以 HR 對上 5,044 / 5,080
- 位置差：中位 **0.59″**、99% 在 3.5″ 內、最大 21.9″，**無一超過 60″**
- 星等差：中位 **0.010**；45 顆差 > 0.5（多為變星，兩表取樣時期不同）

#### 線性掃描勝過 k-d tree（實測）

原規格要求「實現 k-d Tree 或 Spatial Hashing，確保搜尋時間小於 5 ms」。
量測結果讓這條失去理由：

| 視野 | 平均命中 | 線性掃描 | k-d tree |
|---|---|---|---|
| 5° | 9.7 顆 | 0.0065 ms | 0.0016 ms |
| 10° | 38.9 顆 | **0.0071 ms** | 0.0036 ms |
| 30° | 342 顆 | **0.0124 ms** | 0.0176 ms |
| 60° | 1,274 顆 | **0.0242 ms** | 0.0543 ms |

k-d tree 只在窄視野快 2 倍，**30° 以上反而慢 2 倍**（遍歷開銷超過省下的比較），
還要多約 120 行與一次 10 ms 建樹。線性掃描已是 5 ms 預算的 1/700；就算日後放寬到
Vmag ≤ 8（約 4 萬顆）也只有 0.06 ms。**想「優化」這段之前先重跑這個量測。**

實作上的兩個要點：

- **比的是三維點積不是角距**：單位向量內積單調對應角距，整趟掃描只有乘加、
  沒有三角函數，而且 0/360 接縫在向量空間裡根本不存在。只有真的命中的那幾顆
  才算一次 `acos` 換成度。
- **要 precess 的是查詢方向，不是星表**：轉一個方向 vs 轉 5,080 顆星，
  而且旋轉保角、錐體半徑不必跟著變。有一條測試量出「不做這一步會差 0.35 度」，
  那正是誤差預算表裡歲差那一行的依據。

#### 名稱：5,080 顆全收，46% 沒有稱號

Vmag ≤ 6 裡只有 334 顆有俗名、1,482 顆有 Bayer、2,194 顆有 Flamsteed；
**2,342 顆（46.1%）三者皆無**。決定是全部收錄、無稱號者標 `HR 1234`，
查詢結果帶 `hasDesignation` 讓 Phase 4 自己決定畫不畫標籤 ——
星座形狀需要那些暗星，拿掉就跟真實天空對不起來。

**俗名用 BSC5 的（公有領域），其中 38 個是舊稱**，與 IAU 現行名不同。
IAU 官方清單在本環境取不到，所以只記下已知差異：

| HR | BSC5 | IAU 現行 |
|---|---|---|
| 264 | Navi | Cih |
| 437 | Kullat Nunu | Alpherg |
| 510 | Torcularis Septentrionalis | Torcular |
| 963 | Fornacis | Dalim |
| 1346 / 1373 | Hyadum I / II | Prima / Secunda Hyadum |
| 1577 | Kabdhilinan | Hassaleh |
| 1605 | Haldus | Almaaz |
| 1612 / 1641 | Haedus / Hoedus II | Saclateni / Haedus |

（完整 38 筆用 `node scripts/build-sky-catalog.mjs --cross-check-hyg` 重新列出。）

### Phase 4：相機畫面疊加 —— 已完成（真機未驗）

`sky/lib/project.mjs` ＋ `sky/index.html` ＋ `backend/test/sky-project.test.js`（17 條）
＋ `backend/test/sky-page.test.js`（9 條）。

#### 開工前先量掉的一個疑慮：天頂的萬向鎖

Phase 2 平滑的是 (方位角, 仰角, roll)，而這組參數在天頂是奇異的 —— 那正是看星星時
最常指的方向。動手改成四元數之前先量：

| 仰角 | 相機軸誤差（角度法） | 相機軸誤差（向量法） | 畫面上方誤差 | 最大轉速 |
|---|---|---|---|---|
| 10° | 0.703° | 0.703° | 0.390° | 3.4°/s |
| 45° | 0.643° | 0.643° | 0.525° | 5.1°/s |
| 88° | 0.583° | 0.578° | 0.627° | 6.8°/s |
| 90° | 0.616° | 0.578° | 0.624° | 7.2°/s |

**差距 0.04 度，沒有肉眼可見的亂轉，所以 Phase 2 不必改。** 原因是方位角的誤差會被
`cos(仰角)` 壓掉。這一段留著是因為「天頂會壞掉」的直覺很合理但是錯的。

而且 `basisFromPointing` 重建出的三軸與旋轉矩陣的真實三軸在 30 萬組隨機姿態下
**最大差 9e-14 度** —— (方位角, 仰角, roll) 無損保留了完整姿態。

> 量這件事時踩到一個坑：一開始用 `acos(點積)` 量兩個向量的夾角，量到 2e-6 度，
> 差點誤判成公式有錯。`acos` 的引數趨近 1 時相對誤差會炸開，那是**量尺自己的底噪**。
> 換成弦長之後才看到真正的 9e-14。這正是 `angles.mjs` 裡註明「用 haversine 不用
> acos」的同一個坑。

#### 投影

針孔模型、正方形像素，所以垂直視野角由畫面高度推出來，不是第二個自由參數。

- **背後的天體必須擋掉**：除以負的深度會得到一個看起來完全正常的座標，
  把背後的星畫到畫面上。
- **`coneRadiusDeg`** 是畫面四角落到光軸的夾角，拿它當星表查詢的錐體半徑，
  就不會漏掉角落也不會多撈整片天空。有一條測試用 3,000 組隨機方向確認
  「畫面內的星必定在這個半徑內」。
- 反投影 `unproject()` 讓使用者點畫面問「那裡是什麼」，與 `project()` 互為反函數
  （全畫面 500 組，誤差 < 1e-8 px）。

#### 相機視野角拿不到，所以做成可校正

**MediaStream 沒有任何標準欄位提供 FOV**，也沒有跨瀏覽器的方法問得到鏡頭焦距。
`DEFAULT_HORIZONTAL_FOV_DEG = 65` 只是起始值。頁面提供滑桿讓使用者用一顆認得出來的
亮星校正，結果存進 `localStorage`。靜態契約釘住頁面必須說出這件事。

#### 每一幀的管線

```
感測器 → orientationToPointing → createPointingFilter（平滑）
       → createProjector（建基底 + 焦距）
相機軸 → trueAltitudeFromApparentDeg（拆掉折射）→ horizontalToEquatorial
       → queryConeForDate（precess 回 J2000 後查星表，半徑用 coneRadiusDeg）
每顆星 → precessJ2000ToDate → equatorialToHorizontal
       → apparentAltitudeFromTrueDeg（補上折射）→ project → 畫點與標籤
```

**折射修正在這裡是加在星上而不是相機軸上**（§1 寫的是後者）。兩者都對，但疊加畫面
要的是「鏡頭看到的位置」，把每顆星各自搬到視位置比對整條光軸做一次修正更準 ——
折射隨仰角非線性，畫面上下緣的差在地平線附近可以到零點幾度。§1 那個方向仍然適用於
「判斷鏡頭正中央指著什麼」這種單一方向的問題。

#### 頁面端

- `getUserMedia` 在本 repo沒有先例，權限流程是新寫的：一次點擊裡依序要相機、
  方位感測器（iOS 的 `requestPermission` 只能在使用者手勢的呼叫堆疊裡呼叫）、
  位置，失敗只在畫面上降級不 alert。
- 缺什麼一次講完（`describeBlockers`），不要讓使用者一項一項試。
- **`deviceorientation` 的三個角都可能是 null，不是只有 alpha**（2026-09-09 修）。
  少擋一個，`orientationToPointing` 就會丟例外，而那個例外是在 rAF 的回呼裡丟的
  —— 迴圈停止排程、畫面凍結、相機還亮著、狀態列卻寫著「就緒」。那是最糟的一種失敗，
  因為它看起來像在運作。`readOrientationEvent()` 整筆丟掉缺角度的事件；
  `frame()` 另外包 try/catch，出錯就停掉迴圈、把訊息寫上畫面、重新啟用開始鈕
  （照 `/subtitle/` 與 `/convert/` 的錯誤路徑）。繼續排程沒有意義：
  同一個例外會以每秒 60 次的頻率重複發生。
- 標籤重疊會讓畫面變成一團字，`selectLabels` 依亮度貪婪挑選並跳過太近的。

---

## 新頁上線時必須同步改的六處（2026-09-08 已全部完成）

`sky/index.html` 落地時這六處已經一起改完。清單留著是給下一個新頁用的 ——
缺任何一處都會出現「Site check 綠但 Pages deploy 失敗」或「靜態契約綠但 npm test 紅」，
兩個 workflow 檢查的東西不同，綠燈不代表上線成功。

**驗證部署那一步的方法**：照 `pages-deploy.yml` 的 `cp -R` 那行複製到一個暫存目錄，
再對它跑 `node scripts/check-static-site.mjs <該目錄>` —— 那正是 workflow 做的事，
可以在推之前就抓到漏掉的目錄。

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

---

## 真機驗證檢查單（第 2 項已驗過一次並修正，其餘未執行）

演算層的每一條都有自動測試，但**下面這些只有真手機答得出來**。這個開發環境沒有相機、
沒有感測器，也連不到手機。跑完把結果貼回來，我再依結果修。

起本機伺服器：`.claude/launch.json` 的 `static-site`（port 4173），
手機連 `http://<區網 IP>:4173/sky/`。**那不是 secure context** —— `getUserMedia` 與
`DeviceOrientationEvent.requestPermission` 在多數瀏覽器只允許 HTTPS 或 localhost，
所以真機測試多半要走已部署的 `https://blackjw1212.github.io/sky/`。

| # | 要驗的 | 判準 / 要回報什麼 |
|---|---|---|
| 1 | 觸控目標 | 真手機開 `scripts/mobile-audit.html`，量 375 與 320。`/sky/` 只有 range 與 button、刻意沒有 `<select>`（真機上唯一冒出 18 個違規的元素），但仍要實測。回報違規清單。 |
| 2 | 一次點擊拿到所有權限 | **2026-09-09 實測失敗，已修，待重驗。** 原因：`start()` 先 await 了載入函式庫、星表與 `getUserMedia`，輪到 `DeviceOrientationEvent.requestPermission()` 時手勢已被消耗，回 `Requesting device orientation access requires a user gesture to prompt`——相機拿得到、方位權限當場失敗。現在 `requestMotionPermissions()` 是 `start()` 的第一個動作，方向與動作兩個 requestPermission 同步發出，之後才串載入流程；靜態契約釘住這個順序。重驗要看：iOS 有沒有跳出「動作與方向存取權」對話框、相機／方位／位置是否全部到位、狀態列有沒有「還缺：…」。 |
| 3 | 感測器缺角度 | 有沒有裝置只給 alpha？狀態列會停在「還缺：方位感測器」而不是凍結（`readOrientationEvent` 會整筆丟掉缺角度的事件）。 |
| 4 | `webkitCompassHeading` | iOS 上把它與 `alpha` 一起印出來比對。**它給的是磁北還是真北？** 這題答了才能決定磁偏角要不要補、補在哪一層。演算層刻意沒有假設。 |
| 5 | 視野角校正 | 找一顆認得出來的亮星（織女、天狼、北極星），調滑桿到疊加的點與真實星重合。**記下那個度數**，那是這支鏡頭的實測值。 |
| 6 | 疊加對不對得齊 | 整個專案的重點。回報：偏移量大約幾度、是**整體平移**（磁偏角或方位角誤差）還是**旋轉**（roll 或螢幕角度）還是**縮放不對**（視野角）。三種病因對應三個不同的修法。 |
| 7 | 幀率 | 疊加是否順暢？中央附近的表格會不會抖？如果卡，先看是不是每幀重查星表（0.0071 ms，理論上不該是瓶頸）。 |
| 8 | 分頁切走 | 已知行為：相機不會停、指示燈仍亮。**刻意不處理** —— 停掉 track 之後重開可能在 iOS 觸發再次授權，那是這個環境驗證不了的風險。確認這個行為可以接受，或決定要改。（**錯誤路徑不同**：授權或載入失敗時 `stopCamera()` 會關掉相機，因為使用者本來就得重按一次。） |

回報第 6 項時附一張照片最有用：看得出星點與真實星的相對位置，比任何描述都準。

### 第一次實測（2026-09-09）留下的兩個教訓

1. **授權順序**：見第 2 項。這條 `CLAUDE.md` 早就寫過、`dash/index.html` 也有可抄的
   實作，我還把它寫進了這份文件的「頁面端」注意事項——然後在自己的程式裡違反它。
   會被文件擋下的錯誤，實際上只有機器判準擋得下，所以那條順序現在在靜態契約裡。
2. **`sw.js` 的 `VERSION` 撞號**：`/sky/` 上線後首頁看不到新卡片，不是部署漏檔，
   是兩條分支各自把 `v8` bump 到 `v9`，git 不判成衝突，合併結果與已部署的值相同、
   cache key 等於沒變。判準寫進 `CLAUDE.md` 的部署那一節：合併後要比對的是
   「合併結果的 VERSION」與 **`origin/main` 上的 VERSION**，不是「我有沒有 bump」。
