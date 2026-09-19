// 四道閘門的命令列入口。人工執行，也可以掛進交易工具的 pipeline。
//
// 為什麼不進 .claude/verify.sh／CI（比照 float-source-audit.mjs 的那段界線）：
// 它驗的是**使用者的交易紀錄與模型輸出**，不是這個 repo 的原始碼。repo 的 CI 綠不綠
// 跟某個人的交易日誌對不對無關，把它掛進 Stop gate 只會讓閘門對著空檔案跑。
// 純函式全部被 backend/test/*.test.js 蓋著，所以邏輯本身仍有迴歸保護。
//
// 用法：
//   node scripts/fin-contract-check.mjs --trade-log <file.json>
//   node scripts/fin-contract-check.mjs --data <file.json>
//   node scripts/fin-contract-check.mjs --backtest <file.json>
//   node scripts/fin-contract-check.mjs --output <file.txt|->
//   node scripts/fin-contract-check.mjs --tax <instrument>:<YYYY-MM-DD>[:daytrade]
//
// exit 0 = 全數通過；exit 1 = 有違規（訊息印在 stdout）。

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateTradeLog, validateFinancialData, validateBacktestResult, recomputePnl } from "./lib/fin-contracts.mjs";
import { auditOutput } from "./lib/numeric-audit.mjs";
import { resolveTax } from "./lib/rule-clock.mjs";

const TAX_TABLE = fileURLToPath(new URL("../data/tw-trading-costs.json", import.meta.url));

export function parseArgs(argv) {
  const modes = ["--trade-log", "--data", "--backtest", "--output", "--tax"];
  const i = argv.findIndex((a) => modes.includes(a));
  if (i === -1) return { mode: null, target: null };
  return { mode: argv[i].slice(2), target: argv[i + 1] ?? null };
}

function report(title, result) {
  if (result.ok) {
    console.log(`✅ ${title}`);
    return 0;
  }
  console.log(`❌ ${title}${result.code ? `  [${result.code}]` : ""}`);
  if (result.rule_status || result.verification_status) {
    console.log(`   rule_status=${result.rule_status ?? "—"}  verification_status=${result.verification_status ?? "—"}`);
  }
  for (const e of result.errors ?? result.reasons ?? []) console.log(`   · ${e}`);
  for (const v of result.violations ?? []) {
    console.log(`   · L${v.line} [${v.code}] ${v.excerpt}`);
    console.log(`       ${v.hint}`);
  }
  return 1;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readText(path) {
  if (path === "-") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(path, "utf8");
}

export async function run(argv) {
  const { mode, target } = parseArgs(argv);
  if (!mode || !target) {
    console.log("用法：node scripts/fin-contract-check.mjs --trade-log|--data|--backtest|--output|--tax <target>");
    return 1;
  }

  if (mode === "tax") {
    const [instrumentType, tradeDate, kind] = target.split(":");
    const table = await readJson(TAX_TABLE);
    // today 與 tradeDate 是兩個時鐘：前者決定資料新不新鮮，後者決定法規有沒有效。
    const today = argv.includes("--today") ? argv[argv.indexOf("--today") + 1] : new Date().toISOString().slice(0, 10);
    const res = resolveTax(table, {
      instrumentType, tradeDate, today,
      dayTrade: kind === "daytrade",
      allowStale: argv.includes("--allow-stale"),
    });
    if (!res.ok) return report(`稅率解析 ${target}（today=${today}）`, res);
    console.log(`✅ 稅率解析 ${target}（today=${today}）`);
    console.log(`   rate=${res.rate}  rule=${res.ruleId}`);
    console.log(`   rule_status=${res.rule_status}  verification_status=${res.verification_status}  複查期限=${res.verification_due}`);
    for (const w of res.warnings ?? []) console.log(`   ⚠ ${w}`);
    return 0;
  }

  if (mode === "output") return report("輸出數字完整性", auditOutput(await readText(target)));

  const doc = await readJson(target);
  if (mode === "trade-log") {
    const res = validateTradeLog(doc);
    const code = report("trade-log/v1", res);
    if (res.ok) {
      // pnl_net 留 null 是合法的「未知」；這裡把重算值補出來給人看。
      for (const t of doc.trades) {
        if (t.pnl_net === null || t.pnl_net === undefined) {
          const re = recomputePnl(t);
          if (re?.net !== null && re !== null) console.log(`   ℹ trade ${t.trade_id} pnl_net 未填，重算為 ${re.net}`);
        }
      }
    }
    return code;
  }
  if (mode === "data") return report("financial-data/v1", validateFinancialData(doc));
  if (mode === "backtest") return report("回測執行證明", validateBacktestResult(doc));
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
