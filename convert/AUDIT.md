# /convert/ 審查紀錄（2026-09-15）

多維度審查：檔案完整性、頁面上的數字、授權、平台主張、每一組轉檔的實際輸出、
邊界情況、契約覆蓋。全部是機器判準（位元組比對、尺寸、頁數、文字內容），
不是目視。驅動腳本在本機 Chromium（Claude 的瀏覽器窗格）對 `localhost:4173` 跑，
66 條全數通過；**修正前有 3 條紅，其中 2 條是真 bug**，見「發現」。

## 一、檔案完整性

12 個 vendor 檔逐一重抓上游、SHA-256 比對：**全部相同**。
`pdfjs/` 185 檔 1,920 KB 來自 npm tarball，未逐檔比對（同一份 tarball 解出來的）。

## 二、頁面上的數字

| 主張 | 實際 | 處置 |
|---|---|---|
| 函式庫合計 11 MB | 逐檔加總 10.45 MB（9.96 MiB）；11 MB 是 `du -sh` 的區塊配置量 | 改成 10.5 MB |
| HEIC 解碼器 2.9 MB | 2,995,463 B = 3.00 MB（2.86 MiB） | 改成 3.0 MB |
| pdf.js 含中文 CMap 3.9 MB | 448 + 1,236 + 1,920 KB = 3.69 MB | 改成 3.7 MB |
| cmaps + fonts 約 2.3 MB（SOURCES.md） | 1.97 MB | 改正 |
| 沒寫尺寸的 SVG 以 1024px 寬繪製 | **假的**：Chrome 給 300×150 | 修程式，見發現 1 |
| canvas 無法輸出 AVIF | `toBlob('image/avif')` 回 `image/png` | 主張成立 |
| WebP 在少數舊瀏覽器會失敗 | 本機可輸出；「舊瀏覽器失敗」**未驗證**，但 `canvasToBlob()` 比對 `blob.type` 的防線已測 | 保留措辭 |
| `TextDecoder('big5')` 可用 | 可用；Big5 位元組 `A4A4` → 「中」 | 成立 |

## 三、授權

見 `vendor/SOURCES.md` 的授權欄。要注意的只有一條：**heic-to 是 LGPL-3.0**。
以獨立檔案、未修改（SHA 相同）、附授權聲明的方式分發是合規的。

## 四、轉檔矩陣（66 條）

每條都讀回輸出 blob 驗：

- **圖片**：PNG(帶透明) → JPG（魔術位元組 `FFD8FF`、尺寸不變、透明區確實填成指定色
  `#00ff00`、自動下載恰好一次）；→ WebP（`RIFF…WEBP`）；→ PNG 最長邊 60（縮成 60×40、
  透明保留 alpha=0）；→ PDF（A4 橫向 841.89×595.28、原圖尺寸模式 300×200 pt）；
  3 張 → PDF 一份 3 頁 `images.pdf`；3 張 → JPG 3 個結果並自動打成 `converted.zip`。
  GIF（1×1 base64 樣本）、BMP（手工 2×2 24-bit）、TIFF（UTIF 自己 encode 的 20×10）、
  SVG（有尺寸 64×32、無尺寸 → 1024×512）全部解得出、尺寸對。
- **PDF**（pdf-lib 造的 3 頁文字 PDF）：→ PNG 在 96／150／300 dpi 的寬各為
  794／1240／2480 px（= 595.28 × dpi ÷ 72）；→ JPG 3 張 + zip；→ TXT 帶 BOM、三頁文字
  順序正確；→ DOCX 解 zip 讀 `word/document.xml` 含三頁文字；分割 3 份各 1 頁；
  擷取 `2-3` 剩第 2、3 頁（用 pdf.js 抽文字驗順序）；刪除 `2` 剩第 1、3 頁；
  旋轉第 1 頁 → `/Rotate 90`、其他頁 0；兩份合併 5 頁且順序 a 後 b；
  **掃描檔**（只嵌一張 PNG 的 PDF）→ TXT 明講「沒有文字圖層…這一頁沒有 OCR」、→ PNG 仍可轉。
- **DOCX**（docx.mjs 造的：H1 + 中英混排段落 + 1×2 表格）：→ HTML 含 `<h1>` 與
  `<table>`；→ MD 以 `# 審查標題` 開頭；→ TXT 帶 BOM；→ PDF 1 頁 595.29×841.9 pt、
  `getTextContent()` 0 個 item（**「文字不可選取」是實測**）、暗像素 841 個（不是白紙）。
- **試算表**：XLSX 兩張 → CSV 兩檔、各帶 BOM、檔名含工作表名；→ JSON 數值型別保留
  （`數量: 2` 是 number）；→ HTML 兩個 `<table>`；CSV 帶 BOM → XLSX 讀回時 BOM 沒進
  儲存格、數值型別對；Big5 CSV 用 UTF-8 讀是亂碼、選 Big5 讀出「中文」。

## 五、邊界

| 輸入 | 結果 |
|---|---|
| 0 byte 的 `.png` | 「失敗：這個檔案解不開，瀏覽器不認得它的內容」，不卡住 |
| 4 MB 全零的 `.png` | 同上 |
| `%PDF-1.7 garbage` | 「失敗：Invalid PDF structure.」 |
| 8 byte 假 ZIP 當 `.docx` | 「失敗：Corrupted zip: can't find end of central directory」 |
| 頁碼 `9`（只有 3 頁） | 「頁碼 9 超出這份檔案的 3 頁」 |
| 頁碼 `abc` | 「看不懂的頁碼：abc」 |
| 刪掉 `1-3` 全部頁 | 「這樣會刪光整份 PDF，沒有留下任何一頁」 |
| 單一 PDF 選合併 | 「合併需要至少兩份 PDF。」 |
| PDF + PNG 混丟 | 沒有輸出按鈕、「一批只能處理同一種來源格式，請分批丟。」 |
| `.bin` 未知格式 | 「認不出這個格式，這一頁不會硬轉。」 |
| `.pptx`（ZIP 系但不支援） | 不支援的格式，不硬轉 |

## 六、發現與處置

1. **SVG 沒寫尺寸時不是 1024 寬，是 300×150。** `<img>` 對這種 SVG 回報的
   `naturalWidth` 是 CSS 替換元素的預設 300×150，不是 0，`naturalWidth || 1024` 永遠
   走不到後半。修法：`svgIntrinsicSize()` 用 DOMParser 讀 `width`/`height`，沒有就照
   `viewBox` 比例配 1024 寬。修後實測 `viewBox="0 0 10 5"` → 1024×512。
2. **`File.type` 為空字串的 `.svg` 解不開。** `<img>` 對沒有 `image/svg+xml` 型別的
   blob 直接 onerror。拖放進來的檔案型別由作業系統決定，不保證有。修法：餵 `<img>`
   前重新包一層 `image/svg+xml`。
3. 頁面上的三個容量數字全部偏大（見第二節），改成逐檔加總的值。
4. `vendor/SOURCES.md` 補授權欄；heic-to 的 LGPL 條件寫明。

## 七、這次沒驗到的（誠實列出）

- **HEIC 真檔解碼**：沒有樣本。只驗了模組載得起來、`isHeic()` 對 PNG 回 false。
- **AVIF 真檔解碼**：瀏覽器沒有 AVIF 編碼器，造不出樣本。
- **WebP 在舊瀏覽器失敗的路徑**：本機 Chromium 支援 WebP，走不到那條。
- **加密 PDF**：pdf-lib 造不出加密檔；`ignoreEncryption: true` 那條分支未實測。
- **Safari／iOS**、**真手機**：只在桌機 Chromium 與 375px 模擬下量過。
- **大檔**（例如 200 頁 PDF、50 MB 圖）的記憶體與時間。
- **多頁 TIFF、動畫 GIF 只取第一格**：頁面這樣主張，樣本都只有一頁／一格，沒驗到「只取第一」。
