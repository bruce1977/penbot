// 审稿阶段测试：核稿规则候选过滤、并行端点留痕、评分回算
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createCorrector, selectCandidates, summarizeSensitive } from "../../scripts/lib/corrector.mjs";
import { normalizeScore, ruleBasedScore } from "../../scripts/wechat-article.mjs";
import { createRecorder } from "../../scripts/lib/io-record.mjs";
import { tempDir } from "./helpers.mjs";

test("selectCandidates 只保留可交给改稿模型的错别字候选", () => {
  const candidates = selectCandidates([
    { original: "在坐", corrected: "在座", line: 2, start: 3, end: 4 },
    { original: "Agent", corrected: "agent" },
    { original: "AI", corrected: "ai" },
    { original: "API", corrected: "api" },
    { original: "", corrected: "。" },
    { original: "分险", corrected: "分险" },
    { original: "帐号", corrected: "账号" },
    { original: "帐号", corrected: "账号" },
  ]);
  assert.deepEqual(candidates.map((c) => `${c.original}→${c.corrected}`), ["在坐→在座", "帐号→账号"]);
  assert.equal(candidates[0].type, "typo");
  assert.equal(candidates[0].line, 2);
});

test("summarizeSensitive 只统计词频/去重/分类，不保留定位", () => {
  const summary = summarizeSensitive([
    { word: "词甲", category: "politics", line: 1, start: 0, end: 2 },
    { word: "词甲", category: "politics", line: 5, start: 0, end: 2 },
    { word: "词乙", category: "ad" },
    { word: "  " },
  ]);
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.unique, ["词甲", "词乙"]);
  assert.deepEqual(summary.by_category, { politics: 2, ad: 1 });
  assert.equal("line" in summary, false);
});

test("createCorrector 并行调用两个规则端点，各自留痕且密钥/URL 不入盘", async () => {
  const dir = path.join(tempDir("wa-correct-rec-"), "03-step");
  fs.mkdirSync(dir, { recursive: true });
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  const seen = [];
  let correctCalls = 0;
  const restore = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (url.endsWith("/api/sensitive/check")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ is_sensitive: true, count: 2, sensitive_words: [{ word: "词甲", category: "politics" }] }),
      };
    }
    correctCalls += 1;
    if (correctCalls === 1) return { ok: false, status: 500, text: async () => "upstream down" };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          original: "他还在坐位上。",
          corrected: "他还在坐位上。",
          errors: [
            { original: "在坐", corrected: "在座" },
            { original: "Agent", corrected: "agent" },
          ],
        }),
    };
  };
  try {
    const corrector = createCorrector(
      {
        base_url: "http://correct.test/",
        correct_endpoint: "/api/correct",
        sensitive_endpoint: "/api/sensitive/check",
        api_key: "SECRET-KEY",
        auth_header: "Authorization",
        // timeout_ms / retries 单源 defaults.yaml，缺了 corrector 直接抛错点名配置路径。
        timeout_ms: 5000,
        retries: 1,
      },
      null,
      { recorder, slots: { correct: "01", sensitive: "02" } },
    );
    const out = await corrector.check("他还在坐位上。");
    assert.equal(out.ok, true);
    assert.deepEqual(out.candidates.map((c) => `${c.original}→${c.corrected}`), ["在坐→在座"]);
    assert.equal(out.sensitive.length, 1);
    assert.equal(out.errors.correct, null);
    assert.equal(typeof out.timings.correct_ms, "number");

    assert.deepEqual(fs.readdirSync(path.join(dir, "api")).sort(), [
      "1_1(2)-correct.correct-cn.json",
      "1_1-correct.correct-cn.json",
      "2_1-sensitive.correct-cn.json",
    ]);
    const failed = fs.readFileSync(path.join(dir, "api", "1_1-correct.correct-cn.json"), "utf8");
    const ok = JSON.parse(fs.readFileSync(path.join(dir, "api", "1_1(2)-correct.correct-cn.json"), "utf8"));
    const sensitive = JSON.parse(fs.readFileSync(path.join(dir, "api", "2_1-sensitive.correct-cn.json"), "utf8"));
    for (const text of [failed, JSON.stringify(ok), JSON.stringify(sensitive)]) {
      assert.doesNotMatch(text, /SECRET-KEY/);
      assert.doesNotMatch(text, /http:\/\/correct\.test/);
    }
    assert.match(failed, /HTTP 500/);
    assert.equal(ok.request.text, "他还在坐位上。");
    assert.match(ok.response, /在坐/);
    assert.equal(sensitive.slot, "02");
    assert.equal(seen[0].auth, "Bearer SECRET-KEY"); // 密钥只在 header，不进留痕
    assert.ok(seen.every((call) => call.body.text === "他还在坐位上。"));
  } finally {
    globalThis.fetch = restore;
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("createCorrector 未配置 base_url 时跳过且不调 fetch", async () => {
  const out = await createCorrector({ enabled: true }, null, {}).check("正文");
  assert.equal(out.skipped, true);
  assert.deepEqual(out.candidates, []);
  assert.deepEqual(out.errors, { correct: null, sensitive: null });
});

test("createCorrector 开着却缺端点必填参数时抛错点名配置路径", () => {
  const base = {
    enabled: true,
    base_url: "http://correct.test",
    correct_endpoint: "/api/correct",
    sensitive_endpoint: "/api/sensitive/check",
    auth_header: "Authorization",
    retries: 1,
  };
  // timeout_ms 没有代码默认值：defaults.yaml 没写就是配置说谎。
  assert.throws(() => createCorrector(base, null, {}), /defaults\.review\.correct_cn\.timeout_ms/);
  // 关掉核稿不需要为它准备端点参数（不会为了没人用的配置抛错）。
  assert.doesNotThrow(() => createCorrector({ ...base, enabled: false, retries: undefined }, null, {}));
});

// ── 综合评分：闸门唯一读的数字，必须由脚本按权重回算 ──────────────
const scoreType = {
  review: { pass_score: 80 },
  scoring: { dimensions: [{ id: "thesis", name: "观点", weight: 0.5 }, { id: "evidence", name: "论据", weight: 0.5 }] },
  length: { min: 800, max: 1300, target: 1000 },
  illustrations: { min: 1, position_format: "[[img:{n}]]" },
};

test("normalizeScore 按维度权重回算 composite_score，模型自报 total 只留痕", () => {
  const score = normalizeScore(
    scoreType,
    {
      dimensions: [
        { id: "thesis", score: 90, comment: "观点明确" },
        { id: "evidence", score: 70, comment: "论据不足" },
      ],
      total: 95,
      verdict: "pass",
      issues: [],
      must_fix: [],
    },
    1000,
    { model: "qwen3.6:35b" },
  );
  assert.equal(score.composite_score, 80);
  assert.equal(score.reported_score, 95);
  assert.equal(score.verdict, "pass", "80 达到通过线 80");
  assert.equal(score.scorer, "model");
  assert.equal(score.scorer_model, "qwen3.6:35b");
  assert.equal(score.word_count, 1000);
});

test("normalizeScore 缺维度按 60 计入回算，结论由阈值判而非模型自报", () => {
  const score = normalizeScore(scoreType, { dimensions: [{ id: "thesis", score: 90 }], total: 90, verdict: "pass" }, 700, { model: "m" });
  assert.equal(score.composite_score, 75);
  assert.equal(score.verdict, "revise", "自报 pass，但回算 75 < 80");
  assert.equal(score.reported_verdict, "pass");
});

test("ruleBasedScore 兜底评分标注 scorer=rule，无自报分", () => {
  const article = "# 标题\n\n第一段内容。\n\n第二段内容。\n\n[[img:1]]";
  const score = ruleBasedScore(scoreType, article, 3);
  assert.equal(score.scorer, "rule");
  assert.equal(score.reported_score, null);
  assert.equal(score.scorer_model, null);
  assert.equal(typeof score.composite_score, "number");
});
