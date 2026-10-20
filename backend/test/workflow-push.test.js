// 兩支會 commit 資料的 workflow，推送前都要先跟上遠端。
//
// update-stock-risk-feed.yml 交易時段每 30 分鐘 commit 一次，update-market-feed.yml 一天四班，
// 再加上手動推版——直接 `git push` 會互撞。實測各掉過一班資料，錯誤都是 `rejected (fetch first)`：
//   2026-10-19 15:13  update-stock-risk-feed（run 撞上當晚的手動推版）
//   2026-10-20 01:35  update-market-feed（workflow_dispatch 跑了約 25 分鐘，中途有人推版）
// 兩支動的檔案不重疊，所以 rebase 不會衝突。這條測試讀的是 workflow 原文。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const name of ["update-market-feed.yml", "update-stock-risk-feed.yml"]) {
  test(`${name} rebases onto the remote before pushing, and retries`, async () => {
    const yml = await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
    // 只看 run 指令本身，不看註解——註解裡解釋這件事的字樣會讓斷言假通過
    const code = yml.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
    const pull = code.indexOf("git pull --rebase");
    const push = code.indexOf("git push");
    assert.ok(pull > -1, "推送前要先 git pull --rebase");
    assert.ok(push > pull, "rebase 要排在 push 之前");
    assert.match(code, /for attempt in/, "撞上一次就放棄等於還是會掉資料，要重試");
    assert.match(code, /git rebase --abort/, "rebase 失敗要先退出，下一次重試才不會卡在 rebase 中");
    // 推送成功後仍要顯式派工部署（GITHUB_TOKEN 推的 commit 不觸發 on:push）
    assert.ok(code.indexOf("gh workflow run pages-deploy.yml") > push, "部署派工要在推送之後");
  });
}
