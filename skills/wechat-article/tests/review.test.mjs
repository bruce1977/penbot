// 审稿阶段测试：核稿问题归一化与修正替换
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeIssues, applyCorrections } from "../scripts/lib/corrector.mjs";

test("normalizeIssues keeps only confirmed issues and maps typos", () => {
  const issues = normalizeIssues({
    issues: [
      { type: "typo", verdict: "typo_confirmed", original: "在坐", corrected: "在座" },
      { type: "typo", verdict: "typo_rejected", original: "无", corrected: "误" },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].corrected, "在座");

  const fromTypos = normalizeIssues({ typos: [{ original: "帐号", corrected: "账号" }] });
  assert.equal(fromTypos.length, 1);
  assert.equal(fromTypos[0].type, "typo");
});

test("applyCorrections performs literal replacement and skips sensitive words", () => {
  const result = {
    skipped: false,
    issues: [
      { type: "typo", original: "在坐", corrected: "在座" },
      { type: "sensitive", original: "敏感", corrected: "" },
    ],
  };
  const applied = applyCorrections("他还在坐位上坐着。", result);
  assert.equal(applied.applied, 1);
  assert.match(applied.text, /在座/);
});
