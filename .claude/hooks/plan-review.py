#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop-hook:Cross-Model Review 計劃審查閘門(Claude ↔ Codex 跨模型互審)。

當 .claude/plan.md 存在、但結尾沒有審核通過暗號 [REVIEW_PASSED_MARKER] 時,
攔下 Claude、注入提示詞,逼它執行 codex-review skill(把實作計劃送交 Codex 當無情
Reviewer),來回辯駁到 Codex 回 `VERDICT: APPROVED`、Claude 在 plan.md 末端蓋章為止。

與 verify.py 並存且職責不同:
  - verify.py     → 審「完成的程式碼能否編譯/測試」(交付前)。
  - plan-review   → 審「實作計劃的邏輯漏洞 / corner case」(動手前)。

設計原則:
  - 只攔截、不自己呼叫 Codex —— 由 Claude 讀 skill 後驅動,符合 harness 分工。
  - 沒有 .claude/plan.md 就完全不管(閘門未啟用),不影響閒聊 / 小回覆。
  - 防無限迴圈:stop_hook_active 為 true 直接放行(已對照官方 hooks 規格;
    Claude Code 並無固定「連續 block 上限」,此檢查是唯一可靠的防迴圈)。
放置:~/.claude/hooks/plan-review.py 或 <repo>/.claude/hooks/plan-review.py
"""

import json
import os
import sys
from pathlib import Path

# Windows 主控台 Python 的 stdout 預設 cp950(Big5),Claude Code 以 UTF-8 讀 hook 輸出;
# 不強制 UTF-8 中文 reason 會變亂碼(甚至遇非 Big5 字元崩潰)。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MARKER = "[REVIEW_PASSED_MARKER]"


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    # 防無限迴圈:已是強制續跑狀態 → 放行(每段工作只擋一次)。
    if data.get("stop_hook_active"):
        sys.exit(0)

    project = Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    plan = project / ".claude" / "plan.md"

    # 閘門未啟用:沒有實作計劃就不攔。
    if not plan.exists():
        sys.exit(0)

    try:
        text = plan.read_text(encoding="utf-8-sig")
    except OSError:
        sys.exit(0)

    # marker 必須落在「結尾」:看最後一個非空行,避免計劃中途提到暗號就誤放行。
    tail = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if tail and MARKER in tail[-1]:
        sys.exit(0)  # 已通過審核 → 放行

    reason = (
        "【系統攔截:未偵測到審核標記】\n"
        "你尚未取得 Reviewer (Codex) 的審核通過標記。請勿結束對話或將控制權交還給使用者。\n\n"
        "請立即執行 `codex-review` skill:\n"
        "1. 讀取 .claude/plan.md(你目前規劃的 Implementation Plan)。\n"
        "2. 在「同一個 Codex session」中把實作計劃送交 Codex 審查:\n"
        "   - 第一輪:codex exec -s read-only -C \"<repo>\" -o <tmp> \"<reviewer 提示詞 + 計劃>\",\n"
        "     並立刻從 ~/.codex/sessions 最新 rollout 檔擷取 session id($SID)。\n"
        "   - 後續輪:codex exec resume \"$SID\" -o <tmp> \"<你的修改/反駁>\"(用精準 id,勿用 --last,勿加 -s)\n"
        "3. 嚴格依審查方法論與 Codex 來回辯駁:該修的做精準外科手術式修改並更新 plan.md;\n"
        "   該駁的拿嚴謹技術理據反駁說服它。直到 Codex 回覆中出現 `VERDICT: APPROVED`。\n"
        "4. 取得 APPROVED 後,在 .claude/plan.md「最尾端」另起一行蓋上暗號:\n"
        "   " + MARKER + "\n"
        "   蓋章後本閘門即放行,可結束對話。\n\n"
        "(若這次根本不需要計劃審查,刪掉 .claude/plan.md 即可解除此閘門。)"
    )
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
