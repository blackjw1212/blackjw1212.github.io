# Global Working Contract — blackjw

> 跨所有專案的行為契約。每條規則都應實際改變 Claude 的行為;沒作用的就刪。
> 硬性保證(編譯/測試必過)由 Stop hook 強制執行,本檔只負責「行為傾向」。
> 放置位置:`~/.claude/CLAUDE.md`(全域)。個別專案可再放各自的 `./CLAUDE.md` 覆寫。

## 語言與溝通
- 一律以繁體中文(台灣)回覆說明;程式碼與註解依該專案既有慣例,不擅自改語言。
- 風格:精簡、直接、可直接上線。少來回確認,一次給完整、可交付的成品。
- 不客套、不複述需求、不為湊字數而展開。要問就一次問完關鍵問題。

## 四階段工作流(非小改一律遵守)
1. **探索 Explore** — 先用 grep/讀檔找出根因,**先不要動任何程式碼**;回報 Root Cause。
2. **計劃 Plan** — 列出要改哪個檔、哪個函式、預估行數;謹守「極簡優先」與外科手術式修改。
   非小改時把此計劃寫進 `.claude/plan.md`;它會被 Codex 跨模型互審閘門把關,未在末端取得
   `[REVIEW_PASSED_MARKER]` 前不得宣告完成(見 `codex-review` skill / `plan-review.py`)。
3. **實作 Implement** — 僅在計劃範圍內改動。未提及的程式碼、註解、排版 **100% 保持原樣**,嚴禁順手重構。
4. **驗證 Verify** — 改完必須讓專案編譯/測試通過(見驗證標準)才可宣告完成。
- **例外**:若能用一句話描述 diff(改錯字、加 log、改變數名),跳過 1–2 直接做。過度計劃和不計劃一樣浪費時間。

## 驗證標準(Definition of Done)— 依產物類型,不是只有「編譯」
原則(對齊 Anthropic):每種產物各有「可驗證的綠燈」,完成前要讓對應檢查回 OK/FAIL,而非自我宣稱。
- 韌體 → 建置 exit 0:ESP-IDF `idf.py build` / PlatformIO `pio run` / Arduino `arduino-cli compile`。
- Hackintosh OpenCore → `plutil -lint`(語法)+ `ocvalidate`(語意,**版本須對應 OC release**)。
- ACPI/SSDT → `iasl <file>.dsl` 可編譯成 .aml。
- Gmail 過濾 / 其他 XML → well-formed(無未閉合標籤)+ 無重複/衝突 entry。
- AdGuard / adblock 規則 → `aglint` 通過;必要時 `dead-domains-linter` 查死網域。
- Excel xlsx → 可被 openpyxl 載入(不損毀);版面/列印正確仍需人工或 PDF 渲染確認。
- iOS 套件源 → control 檔合法、`Packages`/`Release` metadata 一致。
- Shell → `shellcheck`;Python → `py_compile`(+ 有測試則 `pytest`);Node → `npm test`/`build`。
- **每個專案可在 `.claude/verify`(可執行腳本)自訂自己的 DoD**,該腳本 exit 0 才算完成 —— 標準不被上面這份清單綁死。
- **共通鐵則**:
  - 「檢查過 ≠ 行為對」。涉及硬體/外部行為(顯示、藍牙手把、GPS、IR 收送、Wi-Fi、實際過濾效果)時,明確列出「還需人工上機/實測的項目」,不要假裝已驗證。
  - **不要捏造檢查結果**。沒跑就說沒跑;失敗就貼重點錯誤。

## 嵌入式硬性紀律(踩過的雷,每個 session 都要記得)
- **不要假設驅動或腳位**。動到顯示或周邊前,先從官方文件 / 原廠 datasheet 確認晶片型號與 pin 定義
  (例:Waveshare AMOLED 用的是 **CO5300**,不是 RM67162;弄錯整個顯示層白做)。
- **ESP32 BT + Wi-Fi 同時開會吃爆 RAM**。沿用既有的雙模式架構(AP 設定模式 / 正常執行模式),
  不要把兩者塞進同一條啟動路徑。
- 設定值走**資料驅動 + NVS 映射**,不要散落硬編碼常數。
- 中文顯示要確認字型資源與編碼(UTF-8 / 字型檔是否包含所需字集)。

## 安全(既有防護不得在重構中被弱化)
- 絕不硬編碼密碼、API key、token、Wi-Fi 憑證 → 走設定檔 / NVS / 環境變數,並確認 `.gitignore` 已排除。
- 既有的 HTTP Basic Auth、CSRF 防護、captive portal 驗證,不得被「順手簡化」掉。
- 祕密不得寫進 commit、log 或 URL query string。

## Git / 交付
- commit 訊息具體(做了什麼 + 為什麼),一個邏輯變更一個 commit。
- 任務完成後給一段簡短 diff 摘要:動了哪些檔、各檔重點一行。
- 同一問題若已被我糾正超過兩次,代表 context 已髒 → 主動建議 `/clear` 重開,而不是硬湊。
