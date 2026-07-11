#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop-hook verifier v2 — 跨產物類型的「可驗證成功標準」閘門。

對齊 Anthropic 官方原則:最高槓桿是給 agent「可驗證的成功標準」,而非單一的「跑測試」。
每種產物各有綠燈定義;本腳本依專案內實際存在的檔案自動派發對應檢查,
任一項失敗即回傳 {"decision":"block",...} 擋下 Claude 宣告完成。

優先序:
  1) .claude/skip-verify 存在            → 放行(硬體專屬改動 / WIP 用)。
  2) .claude/verify(.sh/.py/.cmd/.bat)  → 只跑它,exit code 即裁決。
        這是「驗證標準不被內建項目侷限」的正式逃生口:每個專案可定義任意 DoD。
  3) 否則                                → 跑所有「適用」的內建檢查並聚合失敗。

通則:工具或設定缺失 → 軟性略過(只印警告到 stderr),絕不誤擋。
防無限迴圈:stop_hook_active 為 true 直接放行(已對照官方 hooks 規格)。
放置:~/.claude/hooks/verify.py
"""

import json
import os
import shutil
import subprocess
import sys
import time
import xml.dom.minidom as minidom
from pathlib import Path

# Windows 主控台 Python 的 stdout 預設 cp950(Big5),Claude Code 以 UTF-8 讀 hook 輸出;
# 不強制 UTF-8 中文 reason 會變亂碼(甚至遇非 Big5 字元崩潰)。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SUBPROC_TIMEOUT = 540
TAIL = 1000  # 每項失敗輸出尾段上限(字元)

# 變更偵測涵蓋的副檔名(決定是否要重跑)
SRC_EXT = (".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".ino", ".py", ".S", ".s",
           ".js", ".ts", ".jsx", ".tsx", ".sh", ".plist", ".xml", ".json",
           ".txt", ".yml", ".yaml", ".dsl", ".aml", ".xlsx", ".deb", ".css", ".html")
SKIP_DIRS = {".git", "build", ".pio", "node_modules", ".claude", ".vscode",
             "managed_components", "dist", ".cache", "__pycache__"}
JSONC_DENY = {"tsconfig.json", "jsconfig.json", "devcontainer.json"}


def emit(decision=None, reason=None):
    if decision:
        print(json.dumps({"decision": decision, "reason": reason}, ensure_ascii=False))
    sys.exit(0)


def warn(msg):
    print(f"[verify] {msg}", file=sys.stderr)


def run(cmd, cwd=None):
    """回傳 (returncode, 合併輸出尾段)。"""
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=SUBPROC_TIMEOUT)
        out = ((r.stdout or "")[-TAIL:] + "\n" + (r.stderr or "")[-TAIL:]).strip()
        return r.returncode, out
    except subprocess.TimeoutExpired:
        return 124, f"逾時(>{SUBPROC_TIMEOUT}s)"
    except FileNotFoundError:
        return None, "tool-missing"
    except Exception as e:
        return None, f"exec-error: {e}"


def globs(project, *patterns, recursive=True):
    found = []
    for pat in patterns:
        found += list(project.rglob(pat) if recursive else project.glob(pat))
    return [p for p in found if not any(part in SKIP_DIRS for part in p.parts)]


# ---------- 內建檢查:回傳 (label, failure_reason | None) ----------

def check_firmware(project):
    if (project / "platformio.ini").exists():
        cmd, tool, label = ["pio", "run"], "pio", "PlatformIO 建置"
    elif (project / "CMakeLists.txt").exists() and (
        (project / "sdkconfig").exists() or (project / "sdkconfig.defaults").exists()
        or (project / "main" / "idf_component.yml").exists()):
        cmd, tool, label = ["idf.py", "build"], "idf.py", "ESP-IDF 建置"
    elif (project / "sketch.yaml").exists():
        prof = project / ".claude" / "arduino-profile"
        p = prof.read_text(encoding="utf-8").strip() if prof.exists() else "default"
        cmd, tool, label = ["arduino-cli", "compile", "--profile", p], "arduino-cli", "arduino-cli 編譯"
    else:
        inos = globs(project, "*.ino")
        fqbn = project / ".claude" / "fqbn"
        if inos and fqbn.exists():
            cmd = ["arduino-cli", "compile", "-b", fqbn.read_text(encoding="utf-8").strip(), str(inos[0].parent)]
            tool, label = "arduino-cli", "arduino-cli 編譯"
        else:
            return None
    if shutil.which(tool) is None:
        warn(f"{tool} 不在 PATH → 跳過{label}(請先載入 toolchain 環境)")
        return None
    rc, out = run(cmd, cwd=str(project))
    return (label, f"{label}失敗(exit {rc})\n{out}") if rc not in (0, None) else (label, None)


def check_plist(project):
    files = globs(project, "*.plist", "config.plist")
    if not files:
        return None
    fails = []
    if shutil.which("plutil"):
        for f in files:
            rc, out = run(["plutil", "-lint", str(f)])
            if rc not in (0, None):
                fails.append(f"plist 語法錯誤:{f.name}\n{out}")
    else:
        warn("plutil 不在 PATH → 跳過 plist 語法檢查(僅 macOS 內建)")
    oc = next((p for p in files if p.name == "config.plist"), None)
    if oc and shutil.which("ocvalidate"):
        rc, out = run(["ocvalidate", str(oc)])
        if rc not in (0, None):
            fails.append(f"ocvalidate 不通過:{oc.name}(注意:ocvalidate 版本須對應你的 OpenCore release)\n{out}")
    elif oc:
        warn("ocvalidate 不在 PATH → 跳過 OpenCore 語意檢查")
    return ("plist / OpenCore", "\n".join(fails) if fails else None)


def check_acpi(project):
    files = globs(project, "*.dsl")
    if not files:
        return None
    if shutil.which("iasl") is None:
        warn("iasl 不在 PATH → 跳過 ACPI/SSDT 編譯檢查")
        return None
    fails = []
    for f in files:
        rc, out = run(["iasl", str(f)], cwd=str(f.parent))
        if rc not in (0, None):
            fails.append(f"SSDT 編譯失敗:{f.name}\n{out}")
    return ("ACPI/SSDT", "\n".join(fails) if fails else None)


def check_xml(project):
    files = globs(project, "*.xml")
    if not files:
        return None
    fails = []
    for f in files:
        try:
            minidom.parse(str(f))  # well-formedness(純 Python,免裝工具)
        except Exception as e:
            fails.append(f"XML 不合法:{f.name} — {e}")
    return ("XML(含 Gmail 過濾)", "\n".join(fails) if fails else None)


def check_json(project):
    files = [f for f in globs(project, "*.json") if f.name not in JSONC_DENY]
    if not files:
        return None
    fails = []
    for f in files:
        try:
            # utf-8-sig 容忍 UTF-8 BOM(Windows 編輯器常見);.vscode 等 JSONC
            # 已由 SKIP_DIRS 排除,避免把合法的註解/尾逗號誤判為損毀。
            json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception as e:
            fails.append(f"JSON 不合法:{f.name} — {e}")
    return ("JSON", "\n".join(fails) if fails else None)


def check_adblock(project):
    cfg = globs(project, ".aglintrc", ".aglintrc.yaml", ".aglintrc.yml", ".aglintrc.json")
    if not cfg:
        return None
    runner = ["aglint"] if shutil.which("aglint") else (["npx", "--no-install", "aglint"] if shutil.which("npx") else None)
    if runner is None:
        warn("aglint / npx 不在 PATH → 跳過 adblock 規則檢查")
        return None
    rc, out = run(runner, cwd=str(project))
    # 保險:AGLint 的 exit code 規格未經官方確認,部分 linter 即使有錯仍回 0,
    # 故同時偵測輸出中的 error token(格式如 "12:0  error  ..."),避免漏接。
    import re
    has_error = bool(re.search(r"\d+:\d+\s+error\b", out))
    failed = (rc not in (0, None)) or has_error
    return ("AdGuard 規則", f"AGLint 報告問題(rc={rc})\n{out}" if failed else None)


def check_xlsx(project):
    files = globs(project, "*.xlsx")
    if not files:
        return None
    try:
        import openpyxl  # noqa
    except Exception:
        warn("openpyxl 未安裝 → 跳過 xlsx 完整性檢查(pip install openpyxl)")
        return None
    fails = []
    for f in files:
        try:
            openpyxl.load_workbook(str(f))
        except Exception as e:
            fails.append(f"xlsx 損毀/無法載入:{f.name} — {e}")
    return ("Excel xlsx", "\n".join(fails) if fails else None)


def check_shell(project):
    files = globs(project, "*.sh")
    if not files:
        return None
    if shutil.which("shellcheck") is None:
        warn("shellcheck 不在 PATH → 跳過 shell 檢查")
        return None
    rc, out = run(["shellcheck"] + [str(p) for p in files])
    return ("Shell", f"shellcheck 不通過\n{out}" if rc not in (0, None) else None)


def check_python(project):
    files = globs(project, "*.py")
    if not files:
        return None
    fails = []
    for f in files:
        rc, out = run([sys.executable, "-m", "py_compile", str(f)])
        if rc not in (0, None):
            fails.append(f"Python 語法錯誤:{f.name}\n{out}")
    has_tests = bool(globs(project, "test_*.py", "*_test.py")) or (project / "tests").is_dir()
    if has_tests and shutil.which("pytest"):
        rc, out = run(["pytest", "-q"], cwd=str(project))
        if rc not in (0, None):
            fails.append(f"pytest 失敗\n{out}")
    return ("Python", "\n".join(fails) if fails else None)


def check_node(project):
    if not (project / "package.json").exists():
        return None
    try:
        scripts = json.loads((project / "package.json").read_text(encoding="utf-8") or "{}").get("scripts", {})
    except Exception:
        scripts = {}
    cmd = ["npm", "test"] if "test" in scripts else (["npm", "run", "build"] if "build" in scripts else None)
    if cmd is None:
        return None
    if shutil.which("npm") is None:
        warn("npm 不在 PATH → 跳過 Node 檢查")
        return None
    rc, out = run(cmd, cwd=str(project))
    return ("Node", f"{' '.join(cmd)} 失敗\n{out}" if rc not in (0, None) else None)


BUILTIN_CHECKS = [
    check_firmware, check_plist, check_acpi, check_xml, check_json,
    check_adblock, check_xlsx, check_shell, check_python, check_node,
]


# ---------- 專案自訂標準(override)----------

def find_override(project):
    d = project / ".claude"
    for name in ("verify", "verify.sh", "verify.py", "verify.cmd", "verify.bat"):
        f = d / name
        if f.exists():
            return f
    return None


def run_override(f):
    suffix = f.suffix.lower()
    if suffix == ".py":
        cmd = [sys.executable, str(f)]
    elif suffix == ".sh":
        cmd = ["sh", str(f)]
    elif suffix in (".cmd", ".bat"):
        cmd = [str(f)]
    else:  # 無副檔名:需 +x
        cmd = [str(f)]
    rc, out = run(cmd, cwd=str(f.parent.parent))
    if rc is None:
        warn(f"無法執行自訂驗證 {f.name}:{out} → 放行")
        emit()
    if rc != 0:
        emit("block", f"專案自訂驗證 .claude/{f.name} 不通過(exit {rc})。修好再宣告完成。\n{out}")
    emit()


# ---------- mtime 快速路徑 ----------

def sources_changed(project, marker):
    cutoff = marker.stat().st_mtime
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn.endswith(SRC_EXT):
                try:
                    if os.path.getmtime(os.path.join(root, fn)) > cutoff:
                        return True
                except OSError:
                    continue
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    if data.get("stop_hook_active"):
        sys.exit(0)

    project = Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    try:
        os.chdir(project)
    except OSError:
        sys.exit(0)

    if (project / ".claude" / "skip-verify").exists():
        emit()

    # 專案自訂標準優先(完全取代內建項目)
    ov = find_override(project)
    if ov:
        run_override(ov)  # 內含 emit(),不會返回

    marker = project / ".claude" / ".last_verify_ok"
    if marker.exists() and not sources_changed(project, marker):
        emit()

    failures = []
    ran_any = False
    for chk in BUILTIN_CHECKS:
        try:
            res = chk(project)
        except Exception as e:
            warn(f"{chk.__name__} 內部錯誤:{e}")
            continue
        if res is None:
            continue
        ran_any = True
        label, reason = res
        if reason:
            failures.append(f"● {label}\n{reason}")

    if failures:
        body = "\n\n".join(failures)[:4500]
        emit("block",
             "以下驗證項目未通過,請先修好再宣告完成(不要說任務已完成):\n\n"
             + body
             + "\n\n(如為硬體專屬/暫存改動可 touch .claude/skip-verify 暫時略過)")

    if ran_any:
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(str(int(time.time())), encoding="utf-8")
        except OSError:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
