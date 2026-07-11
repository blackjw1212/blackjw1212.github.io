#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop-hook:Loop Engineering 迴圈控制器(harness 強制,不靠模型自律)。

把 Loop Engineering 的三個關鍵機制從 prompt 搬進 harness —— 這是「Agent-in-the-loop」
與「Human-in-the-loop」的真正分界:
  1) 客觀驗收:跑 loop.json.checks(二元;全 exit 0 才算綠燈)。
  2) 無進展偵測:對「失敗輸出」取 hash;連續 N 輪同一個 hash → 判定停滯而停。
  3) 硬性停止:輪次計數持久化在 .claude/.loop_state.json,達 max_rounds 就硬停。
模型無權繞過上限 —— counter 由本 hook 維護,迴圈一定有界,不會變 token 黑洞。

武裝方式:專案放 .claude/loop.json(範例見 .claude/loop.example.json)。不存在 → 完全不作用。
決策:PASS(綠燈放行)/ CONTINUE(擋下逼下一輪)/ HARD_STOP(達上限)/ STALL_STOP(無推進)。
遇 HARD_STOP / STALL_STOP:先擋一次要 Claude 依格式攤開權衡與困惑「舉手提報」,下一次即放行(交還人類)。
fail-open:loop.json 壞掉或讀不到 → 放行,絕不因設定錯誤而卡死 session。

放置:~/.claude/hooks/loop-gate.py 或 <repo>/.claude/hooks/loop-gate.py
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# Windows 主控台 Python 的 stdout 預設是 cp950(Big5),但 Claude Code 以 UTF-8 讀 hook
# 輸出。不強制 UTF-8 會導致中文 reason 亂碼、甚至遇非 Big5 字元(如 ✗)直接崩潰。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

TAIL = 800                 # 每個失敗 check 的輸出尾段上限(字元)
DEFAULT_MAX_ROUNDS = 3
DEFAULT_NO_PROGRESS = 2
SUBPROC_TIMEOUT = 540


def out(decision=None, reason=None):
    if decision:
        print(json.dumps({"decision": decision, "reason": reason}, ensure_ascii=False))
    sys.exit(0)


def load_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def save_json(p, obj):
    try:
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        Path(p).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def run_checks(checks, cwd):
    """跑二元檢查清單。回傳 (all_green, 失敗報告, 失敗簽章 sig)。"""
    fails = []
    for c in checks:
        try:
            r = subprocess.run(c, cwd=cwd, shell=True, capture_output=True,
                               text=True, timeout=SUBPROC_TIMEOUT)
            rc = r.returncode
            tail = ((r.stdout or "")[-TAIL:] + "\n" + (r.stderr or "")[-TAIL:]).strip()
        except subprocess.TimeoutExpired:
            rc, tail = 124, f"逾時(>{SUBPROC_TIMEOUT}s)"
        except Exception as e:  # noqa: BLE001
            rc, tail = 1, f"exec-error: {e}"
        if rc != 0:
            fails.append((c, rc, tail))
    if not fails:
        return True, "", ""
    report = "\n\n".join(f"✗ `{c}`(exit {rc})\n{tail}" for c, rc, tail in fails)
    sig = hashlib.sha256(
        "\n".join(f"{c}|{rc}|{tail}" for c, rc, tail in fails).encode("utf-8")
    ).hexdigest()
    return False, report, sig


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    _ = data  # stop_hook_active 不用於本 hook:輪次上限本身就是防迴圈的硬邊界。

    project = Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    cfg = load_json(project / ".claude" / "loop.json")
    if not cfg or not cfg.get("checks"):
        sys.exit(0)  # 未武裝 → 不作用

    checks = cfg["checks"]
    max_rounds = int(cfg.get("max_rounds", DEFAULT_MAX_ROUNDS))
    no_prog = int(cfg.get("no_progress_limit", DEFAULT_NO_PROGRESS))
    boundaries = cfg.get("boundaries", [])

    state_path = project / ".claude" / ".loop_state.json"
    state = load_json(state_path) or {"round": 0, "sigs": [], "stop_pending": False}

    # 上一輪已請求「舉手提報」→ 這次放行,交還人類。
    if state.get("stop_pending"):
        try:
            state_path.unlink()
        except OSError:
            pass
        out()

    all_green, report, sig = run_checks(checks, str(project))

    # 綠燈:達標,放行並清狀態。
    if all_green:
        try:
            state_path.unlink()
        except OSError:
            pass
        out()

    round_no = state["round"] + 1
    sigs = state["sigs"]
    stalled = no_prog > 0 and len(sigs) >= no_prog and all(s == sig for s in sigs[-no_prog:])
    hard = round_no > max_rounds

    bnd = ("\n必守邊界(精準外科手術式修改):\n- " + "\n- ".join(boundaries)) if boundaries else ""

    # 硬停:達上限或停滯 → 先擋一次要求依格式提報,下次放行。
    if hard or stalled:
        save_json(state_path, {"round": round_no, "sigs": sigs + [sig], "stop_pending": True})
        kind = (f"已達最大輪次上限({max_rounds} 輪)" if hard
                else f"連續 {no_prog} 輪錯誤完全沒變化(判定無推進)")
        out("block",
            f"【迴圈硬性停止:{kind}】\n"
            "不要再自行嘗試修正。請立即停下來、依下列格式「舉手提報」,攤開權衡與困惑等待人類介入:\n\n"
            "- 【執行狀態】:" + ("達到最大輪次停止" if hard else "觸發無推進停止") + "\n"
            "- 【最後一輪的驗收數據】:(把下方仍失敗的項目與關鍵錯誤摘要填入)\n"
            "- 【成果/代碼變更】:(目前為止做了什麼)\n"
            "- 【困惑與權衡】:(卡在哪、你嘗試過什麼、為何過不了、你的取捨建議)\n\n"
            "目前仍未通過的檢查:\n" + report +
            "\n\n提報完即結束對話(本閘門下一次會放行)。")

    # 否則:繼續下一輪(有界)。
    save_json(state_path, {"round": round_no, "sigs": sigs + [sig], "stop_pending": False})
    out("block",
        f"【Loop 第 {round_no}/{max_rounds} 輪:驗收未過,請進入下一輪修正】\n"
        "以「精準外科手術式修改 + 極簡優先」修好下列失敗項,只動必要之處,然後再停一次讓我複驗。"
        + bnd + "\n\n仍失敗的檢查:\n" + report +
        "\n\n(修好全部即自動放行;達上限或連續無進展會自動硬停並要你提報。)")


if __name__ == "__main__":
    main()
