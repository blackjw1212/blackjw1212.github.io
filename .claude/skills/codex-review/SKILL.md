---
name: codex-review
description: 把當前 .claude/plan.md 送交 Codex 當無情 Reviewer 做跨模型互審(Cross-Model Review),在同一 Codex session 來回辯駁,直到 Codex 回 VERDICT: APPROVED 後在計劃末端蓋上 [REVIEW_PASSED_MARKER]。當 plan-review Stop hook 攔截要求審查、或需要對實作計劃做跨模型 review 時使用。
---

# codex-review — Claude ↔ Codex 跨模型互審

把你的 **Implementation Plan**(`.claude/plan.md`)交給 Codex 當「極度嚴謹、絕不放水」的 Reviewer。
你(Claude)負責創意與實作;Codex 負責挑邏輯漏洞。來回辯駁到雙方達成共識,你才蓋章收工。

## 前置
- Reviewer 引擎:Codex CLI(`codex exec`,非互動;`-s read-only` 讓它只讀不改你的檔)。
- Session 續接(**精準 id,不要用 `--last`**):第一輪用 `codex exec` 建立 session,立刻擷取它的 **session id**,後續輪一律 `codex exec resume "<id>"`,以保留上下文(這是「同一 session 收斂」的關鍵,避免每輪重新發明問題)。用 `--last` 在多個 codex session 並行時會接錯;用 id 才安全。`resume` **不接受 `-s/--sandbox`**,它會繼承第一輪的 read-only 沙箱,後續輪勿再加 `-s`。
- 擷取裁決:加 `-o <tmpfile>` 把 Codex 最終訊息寫進檔案再讀,別只靠 stdout 尾段。

## 第一輪:送審
把下面這段 **Reviewer 系統提示詞** 連同 `.claude/plan.md` 全文一起送出:

```
codex exec -s read-only -C "<repo 絕對路徑>" -o /tmp/codex_review.txt - <<'PROMPT'
# Role
你是一位極度嚴謹、無趣、追求系統穩定且絕不犯錯的資深後端架構師與程式審查員 (Reviewer)。

# Goal
審查以下 Implementation Plan。找出疏漏的 corner cases、邊界條件處理不當、或邏輯上可能引發
Bug 的地方(例如:高並發下的超賣、Race Condition、交易/重試的冪等性、錯誤處理與回滾、
資源洩漏、時序與一致性)。

# Rules & Constraints
1. 【嚴格收斂,拒絕沒事找事】:本對話為連續 session。第一輪「一次性」指出所有你認為真正
   重要、會引發系統崩潰的結構性問題。後續輪次的核心職責是「驗收」修改是否解決上一輪的問題;
   除非有重大漏洞,不要在後續輪次重新發明、隨機挑出新的次要小毛病。
2. 【拒絕敷衍,必須明確表態】:不設輪次上限,通關唯一標準是「雙方真正達成邏輯共識」。
   絕不為了結束對話而盲目點頭。面對爭議,你要麼被說服(明確說「我被說服了,此設計可行」),
   要麼堅持立場(清楚指出你到底在堅持哪個邏輯漏洞)。
3. 【放行標準】:當所有你指出的關鍵漏洞皆獲合理解決、雙方達成共識,於回覆「最後一行」輸出:
   VERDICT: APPROVED

---
以下是待審的 Implementation Plan:
<在此貼上 .claude/plan.md 全文>
PROMPT
```

讀 `/tmp/codex_review.txt` 取得 Codex 回覆。

接著**立刻擷取這個 session 的 id**(供後續輪精準 resume,取代易接錯的 `--last`)。Codex 把每個 session 持久化成 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,第一行 `session_meta.payload.id` 即為 id:

```bash
SID=$(python3 -c "import json,glob,os; base=os.path.expanduser(os.environ.get('CODEX_HOME') or '~/.codex'); f=max(glob.glob(base+'/sessions/**/rollout-*.jsonl',recursive=True), key=os.path.getmtime); print(json.loads(open(f,encoding='utf-8').readline())['payload']['id'])")
echo "$SID"   # 記下這個 id,本輪審查循環全程用它
```

> 擷取要緊接在第一輪之後、且這之前別開其他 codex session,以免 mtime 抓到別人的 session。萬一 id 抓失敗,退而用 `resume --last`(僅在沒有並行 session 時可靠)。

## 審查循環(收到回饋後)
- **Codex 提出質疑** → 依「先思考再編碼」評估其合理性:
  - 合理 → 對 plan.md 做「精準外科手術式修改」(只動有漏洞處,其餘原樣),更新計劃;
  - 不合理 → 拿嚴謹技術理據反駁、說服它。
  然後把「你的修改/反駁」用 `codex exec resume "$SID" -o /tmp/codex_review.txt "<內容>"`
  送回複查(用第一輪擷取的精準 id;resume 已繼承 read-only,勿加 -s)。**每一輪都要真的回到 Codex**,不可自行宣稱通過。
- **Codex 回覆含 `VERDICT: APPROVED`** → 審核正式通過。立即在 `.claude/plan.md`「最尾端」另起一行蓋章:

  ```
  [REVIEW_PASSED_MARKER]
  ```

  之後即可結束對話(plan-review hook 會放行)。

## 鐵則
- 不捏造審查結果:沒真的跑 `codex` 就不准蓋章;Codex 的原文裁決要可追溯(留在 /tmp/codex_review.txt)。
- marker 只蓋在「真正取得 APPROVED」之後,且只蓋在檔案最尾端一行。
- 若這次任務根本不需要計劃審查,正確解法是刪掉 `.claude/plan.md` 解除閘門,而不是偽造 marker。
- 全程用第一輪擷取的精準 `$SID` 做 resume,**不要用 `--last`**;這樣即使同時有多個 codex session 並行也不會接錯。
