import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, asBool, asNumber, asList } from "../scripts/lib/args.mjs";
import { expandEnv } from "../scripts/lib/env.mjs";
import {
  splitFrontmatter,
  buildFrontmatter,
  normalizeArticle,
  stripCodeFence,
  getTitle,
  countWords,
  parseImageMarkers,
  replaceImageMarkers,
  ensureImageMarkers,
} from "../scripts/lib/markdown.mjs";
import { parseJsonFromText, extractAgentText } from "../scripts/lib/models.mjs";
import { normalizeConfig, validateConfig, deepMerge } from "../scripts/lib/config.mjs";
import { indexKnowledge, pickRecent, searchKnowledge, buildTerms, extractExcerpts } from "../scripts/lib/knowledge.mjs";
import { normalizeIssues, applyCorrections } from "../scripts/lib/corrector.mjs";
import { composePrompt, resolveImageCount, planImages } from "../scripts/lib/illustrate.mjs";
import { bodyOnly, emailShell, markdownToHtml } from "../scripts/lib/publish.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

test("parseArgs handles values, flags, --no-flags and repeats", () => {
  const { command, args, options } = parseArgs([
    "run",
    "--type",
    "ai-news",
    "--mock",
    "--no-email",
    "--to",
    "a@x.com",
    "--to=b@y.com",
    "extra",
  ]);
  assert.equal(command, "run");
  assert.deepEqual(args, ["extra"]);
  assert.equal(options.type, "ai-news");
  assert.equal(options.mock, true);
  assert.equal(options.email, false);
  assert.deepEqual(options.to, ["a@x.com", "b@y.com"]);
});

test("asBool / asNumber / asList normalize option values", () => {
  assert.equal(asBool(undefined, true), true);
  assert.equal(asBool("false"), false);
  assert.equal(asBool("yes"), true);
  assert.equal(asNumber("12", 3), 12);
  assert.equal(asNumber(undefined, 3), 3);
  assert.deepEqual(asList("a, b;c"), ["a", "b", "c"]);
});

/* ------------------------------------------------------------------ */
/* env                                                                 */
/* ------------------------------------------------------------------ */

test("expandEnv resolves ${VAR} and ${VAR:-default}", () => {
  process.env.WA_TEST_VAR = "real";
  assert.equal(expandEnv("${WA_TEST_VAR}"), "real");
  assert.equal(expandEnv("${WA_TEST_MISSING:-fallback}"), "fallback");
  assert.equal(expandEnv("${WA_TEST_MISSING}"), "");
  assert.deepEqual(expandEnv(["${WA_TEST_VAR}", { k: "${WA_TEST_MISSING:-d}" }]), ["real", { k: "d" }]);
  delete process.env.WA_TEST_VAR;
});

/* ------------------------------------------------------------------ */
/* markdown                                                            */
/* ------------------------------------------------------------------ */

test("frontmatter round-trips through build and split", () => {
  const md = buildFrontmatter({ title: "标题", type: "ai-news", keywords: ["a", "b"] });
  const { data, body } = splitFrontmatter(`${md}正文内容\n`);
  assert.equal(data.title, "标题");
  assert.equal(data.type, "ai-news");
  assert.deepEqual(data.keywords, ["a", "b"]);
  assert.equal(body, "正文内容");
});

test("normalizeArticle ensures a title and strips code fences", () => {
  const out = normalizeArticle("```markdown\n# 原标题\n\n内容\n```", { title: "新标题", type: "t" });
  assert.match(out, /^---\n/);
  assert.equal(getTitle(out), "新标题");
  assert.ok(!out.includes("```"));
});

test("stripCodeFence unwraps a single outer fence", () => {
  assert.equal(stripCodeFence("```\nhello\n```"), "hello");
  assert.equal(stripCodeFence("no fence"), "no fence");
});

test("countWords counts CJK characters and latin words", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("你好 hello"), 3);
});

test("parseImageMarkers reads canonical and legacy markers", () => {
  const markers = parseImageMarkers("A [[img:1|架构图|a diagram of layers]] B [图2：旧格式说明]");
  assert.equal(markers.length, 2);
  assert.equal(markers[0].index, 1);
  assert.equal(markers[0].description, "架构图");
  assert.equal(markers[0].prompt, "a diagram of layers");
  assert.equal(markers[1].index, 2);
  assert.equal(markers[1].description, "旧格式说明");
});

test("replaceImageMarkers replaces hits and handles failures", () => {
  const md = "[[img:1|图一|c]]\n\n[[img:2|图二|c]]";
  const replaced = replaceImageMarkers(md, new Map([[1, "images/01.png"]]), { onFailure: "comment" });
  assert.match(replaced, /!\[图一\]\(images\/01\.png\)/);
  assert.match(replaced, /<!-- 配图生成失败：图二 -->/);
  assert.equal(replaceImageMarkers(md, new Map(), { onFailure: "drop" }).trim(), "");
});

test("ensureImageMarkers pads to the requested count", () => {
  const md = buildFrontmatter({ title: "t" }) + "第一段。\n\n第二段。\n\n[[img:1|已有|c]]\n";
  const out = ensureImageMarkers(md, 3);
  assert.equal(parseImageMarkers(out).length, 3);
});

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

test("parseJsonFromText handles fenced, embedded and invalid input", () => {
  assert.deepEqual(parseJsonFromText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonFromText('前言 {"a":{"b":2}} 后缀'), { a: { b: 2 } });
  assert.throws(() => parseJsonFromText("no json here"));
});

test("extractAgentText concatenates NDJSON text parts and raises errors", () => {
  const stdout = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "text", part: { text: "第一段" } }),
    JSON.stringify({ type: "text", part: { text: "第二段" } }),
  ].join("\n");
  assert.equal(extractAgentText(stdout), "第一段\n第二段");

  const err = JSON.stringify({ type: "error", error: { message: "boom" } });
  assert.throws(() => extractAgentText(err), /boom/);

  assert.equal(extractAgentText("纯文本输出"), "纯文本输出");
});

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

function rawConfig(knowledgeDir) {
  return {
    project: {},
    models: { local: { provider: "mock" } },
    defaults: {
      model: "local",
      review: { correct_cn: { base_url: "http://localhost" } },
      knowledge: {},
      illustrations: {},
      publish: {},
    },
    types: [
      {
        id: "t1",
        name: "T1",
        knowledge_dirs: [knowledgeDir],
        model: "local",
        length: { min: 100, max: 200, target: 150 },
        scoring: {
          pass_score: 80,
          dimensions: [
            { id: "a", name: "A", weight: 1 },
            { id: "b", name: "B", weight: 3 },
          ],
        },
        review: {},
        illustrations: {},
        topic: {},
      },
    ],
  };
}

test("normalizeConfig normalizes weights, dirs and numeric ranges", () => {
  const dir = tempDir("wa-cfg-");
  const config = normalizeConfig(rawConfig(dir), dir);
  const type = config.types[0];
  assert.equal(type.id, "t1");
  const [a, b] = type.scoring.dimensions;
  assert.equal(a.weight, 0.25);
  assert.equal(b.weight, 0.75);
  assert.equal(path.isAbsolute(type.knowledge_dirs[0]), true);
  assert.equal(type.review.max_rounds, 3);
  assert.equal(type.illustrations.min, 1);
  assert.equal(type.illustrations.max, 5);
  assert.equal(type.knowledge.max_sources, 8);
});

test("validateConfig reports missing knowledge dirs and unknown models", () => {
  const missing = path.join(os.tmpdir(), "wa-does-not-exist-" + Date.now());
  const config = normalizeConfig(rawConfig(missing), os.tmpdir());
  config.types[0].model = "ghost";
  const issues = validateConfig(config);
  assert.ok(issues.some((i) => i.includes("知识库目录不存在")));
  assert.ok(issues.some((i) => i.includes('model "ghost"')));
});

test("deepMerge merges nested objects and replaces arrays", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

/* ------------------------------------------------------------------ */
/* knowledge                                                           */
/* ------------------------------------------------------------------ */

test("buildTerms produces CJK bigrams and latin words without stopwords", () => {
  const terms = buildTerms("大模型 Agent 的推理成本");
  assert.ok(terms.includes("agent"));
  assert.ok(terms.includes("模型"));
  assert.ok(terms.includes("推理"));
  assert.ok(!terms.includes("的"));
});

test("indexKnowledge, pickRecent and searchKnowledge rank by relevance", () => {
  const dir = tempDir("wa-kb-");
  fs.writeFileSync(
    path.join(dir, "agent.md"),
    "---\ntitle: Agent 稳定性\ndate: 2026-09-01\ntags: [Agent, 稳定性]\n---\n\nAgent 的不稳定来自工具调用与上下文管理。\n",
  );
  fs.writeFileSync(path.join(dir, "cooking.md"), "---\ntitle: 红烧肉做法\ndate: 2020-01-01\n---\n\n今天来做一道红烧肉。\n");

  const type = { knowledge_dirs: [dir] };
  const notes = indexKnowledge(type, { logger: null });
  assert.equal(notes.length, 2);

  const recent = pickRecent(notes, { days: 365, limit: 10 });
  assert.equal(recent[0].title, "Agent 稳定性");

  const hits = searchKnowledge(notes, { topic: "Agent 稳定性", limit: 5 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].title, /Agent/);
  assert.ok(hits[0].score > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("extractExcerpts picks paragraphs matching the terms", () => {
  const body = [
    "无关的第一段，用来填充内容，这里需要写得足够长以便通过长度过滤。".repeat(2),
    "Agent 工具调用经常失败，这是当前最核心的问题所在，有必要在正文里重点展开讨论并给出可行的缓解方案。",
    "结尾段落，同样需要足够长度来满足过滤条件，否则会被丢弃掉。".repeat(2),
  ].join("\n\n");
  const excerpts = extractExcerpts(body, ["agent", "工具"], 400, 1);
  assert.equal(excerpts.length, 1);
  assert.match(excerpts[0], /Agent/);
});

/* ------------------------------------------------------------------ */
/* corrector                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* illustrate                                                          */
/* ------------------------------------------------------------------ */

test("resolveImageCount clamps to the type's min/max", () => {
  const type = { illustrations: { min: 2, max: 4 } };
  assert.equal(resolveImageCount(type, { image_plan: [] }, { count: 9 }), 4);
  assert.equal(resolveImageCount(type, { image_plan: [] }, { count: 1 }), 2);
});

test("planImages pads the plan and marks the first as cover", () => {
  const plans = planImages({ title: "T", image_plan: [{ description: "一张图" }] }, 3, { cover: true });
  assert.equal(plans.length, 3);
  assert.equal(plans[0].scene, "wechat-cover");
  assert.equal(plans[1].scene, "article-inline");
  assert.equal(plans[0].description, "一张图");
});

test("composePrompt merges subject, style and negative prompt", () => {
  const prompt = composePrompt({ prompt: "layered network", description: "架构图" }, { style: "扁平插画" }, "主题");
  assert.match(prompt, /layered network/);
  assert.match(prompt, /扁平插画/);
  assert.match(prompt, /no text/);
});

/* ------------------------------------------------------------------ */
/* publish                                                             */
/* ------------------------------------------------------------------ */

test("bodyOnly strips frontmatter", () => {
  assert.equal(bodyOnly("---\ntitle: t\n---\n\n正文"), "\n正文");
});

test("emailShell escapes the title and markdownToHtml renders headings", async () => {
  const html = emailShell("<b>x</b>", await markdownToHtml("# 标题\n\n正文"));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<h1>标题<\/h1>/);
});
