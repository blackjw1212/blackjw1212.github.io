# /convert/vendor/ 的來源

這些檔案是**自帶**的，不從 CDN 載。理由跟 `subtitle/vendor/` 一樣：頁面對使用者說
「檔案不會離開這台裝置」，那句話的前提是這一頁不對外連任何一個第三方端點。
靜態契約 `scripts/check-static-site.mjs` 會逐檔 `mustExist`，也會擋掉 body 端出現
`https?://`。

全部由 `convert/index.html` 在**按下轉檔那一刻**才載入，不進 `sw.js` 的 `PRECACHE`。

抓取日期：2026-09-03。

| 檔案 | 版本 | 來源 |
|---|---|---|
| `pdf.min.mjs`、`pdf.worker.min.mjs` | pdfjs-dist 6.3.289 | `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/` |
| `pdfjs/cmaps/`、`pdfjs/standard_fonts/` | pdfjs-dist 6.3.289 | npm tarball `pdfjs-dist-6.3.289.tgz` 內的同名目錄 |
| `pdf-lib.min.js` | pdf-lib 1.17.1 | `https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/` |
| `jszip.min.js` | jszip 3.10.1 | `https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/` |
| `docx-preview.min.js` | docx-preview 0.4.0 | `https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/` |
| `mammoth.browser.min.js` | mammoth 1.12.2 | `https://cdn.jsdelivr.net/npm/mammoth@1.12.2/` |
| `docx.mjs` | docx 9.7.1（`dist/index.mjs`） | `https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/` |
| `xlsx.full.min.js` | SheetJS 0.20.3 | `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/` |
| `heic-to.min.js` | heic-to 1.5.2（`dist/csp/`） | `https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/csp/` |
| `html2canvas-pro.min.js` | html2canvas-pro 2.4.1 | `https://cdn.jsdelivr.net/npm/html2canvas-pro@2.4.1/dist/` |
| `pako.min.js` | pako 2.1.0 | `https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/` |
| `UTIF.js` | utif2 4.1.0 | `https://cdn.jsdelivr.net/npm/utif2@4.1.0/` |

## 載入方式不一致，是上游決定的，不要「統一」

| 檔案 | 格式 | 取用方式 |
|---|---|---|
| `pdf.min.mjs`、`docx.mjs`、`heic-to.min.js` | ESM | `import()` |
| 其餘 | UMD | `<script src>` 後讀全域變數 |

全域變數名稱：`PDFLib`、`JSZip`、`docx`（← docx-preview，**不是** `docx.mjs`）、
`mammoth`、`XLSX`、`html2canvas`、`pako`、`UTIF`。

兩個容易踩的順序問題：

- **`docx-preview.min.js` 之前必須先載 `jszip.min.js`**：它的 UMD 瀏覽器分支直接讀
  `self.JSZip`，缺了會是 `undefined` 而不是報錯。
- **`UTIF.js` 之前必須先載 `pako.min.js`**：UTIF 在自己的 IIFE 執行期就去讀
  `self.pako`，晚載沒有用。

`docx-preview` 的全域名稱是 `docx`，跟 dolanmiu 的 `docx` 套件撞名。這裡沒有衝突，
因為後者是走 `import()` 拿模組物件、不掛全域——但若哪天把它改成 UMD 版就會對撞。

## pdf.js 的 cmaps / standard_fonts 不可省

169 個 `.bcmap` 加 16 個字型檔約 2.3 MB。少了它們，**沒有內嵌字型的中文 PDF 會轉出
整頁空白**，而 pdf.js 只在 console 抱怨一句，畫面上看起來就像「這份檔轉壞了」。
`convert/index.html` 的 `openPdfDocument()` 把 `cMapUrl` / `standardFontDataUrl`
指到這兩個目錄。

## 沒有收 ffmpeg.wasm

影音轉檔要 `@ffmpeg/core`，實測 npm 上的 unpacked size 是 61.69 MB，而且 GitHub Pages
送不出 COOP/COEP header，多執行緒版在這裡開不起來、只能跑單執行緒。這一頁刻意不做
影音，UI 上也沒有假裝支援。
