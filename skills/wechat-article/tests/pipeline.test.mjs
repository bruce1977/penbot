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
  lengthAction,
  parseImageMarkers,
  replaceImageMarkers,
  ensureImageMarkers,
  normalizeImageMarkers,
} from "../scripts/lib/markdown.mjs";
import { buildLengthPrompt, buildDraftPrompt } from "../scripts/lib/prompts.mjs";
import { parseOutlineMarkdown } from "../scripts/lib/markdown.mjs";

import { parseJsonFromText, extractAgentText } from "../scripts/lib/models.mjs";
import { normalizeConfig, validateConfig, deepMerge } from "../scripts/lib/config.mjs";
import {
  indexKnowledge,
  pickRecent,
  searchKnowledge,
  searchWeKnora,
  collectSources,
  buildTerms,
  extractExcerpts,
} from "../scripts/lib/knowledge.mjs";
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
/* length control                                                      */
/* ------------------------------------------------------------------ */

test("lengthAction classifies drafts against the word range", () => {
  assert.equal(lengthAction(500, { min: 800, max: 1300 }), "expand");
  assert.equal(lengthAction(2000, { min: 800, max: 1300 }), "condense");
  assert.equal(lengthAction(1000, { min: 800, max: 1300 }), null);
  assert.equal(lengthAction(800, { min: 800, max: 1300 }), null);
});

test("buildLengthPrompt switches direction and states the range", () => {
  const type = { name: "AI 资讯快评", length: { min: 800, max: 1300, target: 1000 } };
  const expand = buildLengthPrompt({ type, article: "正文", wordCount: 500, direction: "expand" });
  assert.match(expand.prompt, /800-1300/);
  assert.match(expand.prompt, /扩充要求/);
  assert.match(expand.system, /绝不注水/);

  const condense = buildLengthPrompt({ type, article: "正文", wordCount: 2000, direction: "condense" });
  assert.match(condense.prompt, /压缩要求/);
  assert.match(condense.system, /压缩/);
});

test("buildDraftPrompt asks for multi-sentence paragraphs", () => {
  const type = { name: "T", length: { min: 100, max: 200, target: 150 }, style: {}, illustrations: { min: 1, max: 3 } };
  const prompt = buildDraftPrompt({
    type,
    topic: { topic: "t" },
    outline: { title: "T", outline: [{ heading: "H", points: [] }] },
    sources: [],
  });
  assert.match(prompt.prompt, /每段 2-5 句/);
  assert.match(prompt.prompt, /不要低于 100 字/);
});

/* ------------------------------------------------------------------ */
/* image markers                                                       */
/* ------------------------------------------------------------------ */

test("normalizeImageMarkers drops duplicates and renumbers in order", () => {
  const md = buildFrontmatter({ title: "t" }) + [
    "第一段。",
    "",
    "[[img:1|封面|c1]]",
    "",
    "第二段。",
    "",
    "[[img:2|正文图|c2]]",
    "",
    "第三段。",
    "",
    "[[img:1|重复使用或移除|]]",
    "",
  ].join("\n");
  const out = normalizeImageMarkers(md, 2);
  const markers = parseImageMarkers(out);
  assert.deepEqual(markers.map((m) => m.index), [1, 2]);
  assert.equal(markers[0].description, "封面");
  assert.equal(markers[1].description, "正文图");
  assert.ok(!out.includes("重复使用或移除"));
});

test("normalizeImageMarkers caps at the planned count and pads when short", () => {
  const extra = buildFrontmatter({ title: "t" }) + "A\n\n[[img:1|一|]]\n\nB\n\n[[img:2|二|]]\n\nC\n\n[[img:3|三|]]\n";
  assert.equal(parseImageMarkers(normalizeImageMarkers(extra, 2)).length, 2);

  const short = buildFrontmatter({ title: "t" }) + "A\n\n[[img:1|一|]]\n\nB\n\nC\n";
  assert.equal(parseImageMarkers(normalizeImageMarkers(short, 3)).length, 3);
});

/* ------------------------------------------------------------------ */
/* manual outline parsing                                              */
/* ------------------------------------------------------------------ */

test("parseOutlineMarkdown reads the rendered outline format", () => {
  const md = [
    "# 我的标题",
    "> 核心判断一句话",
    "- 读者：从业者",
    "- 开篇钩子：一个场景",
    "## 结构",
    "1. **事实锚点**（约 400 字）",
    "   - 要点一",
    "   - 要点二",
    "2. **影响判断**（约 250 字）",
    "   - 要点三",
    "## 反方观点",
    "有人认为不是这样。",
    "## 结论",
    "确定性命关重要。",
    "## 配图",
    "- cover：一张封面 | a cover image",
    "  - prompt: a cover image",
  ].join("\n");
  const outline = parseOutlineMarkdown(md, { targetWords: 650 });
  assert.equal(outline.title, "我的标题");
  assert.equal(outline.thesis, "核心判断一句话");
  assert.equal(outline.audience, "从业者");
  assert.equal(outline.hook, "一个场景");
  assert.equal(outline.outline.length, 2);
  assert.equal(outline.outline[0].heading, "事实锚点");
  assert.equal(outline.outline[0].target_words, 400);
  assert.deepEqual(outline.outline[0].points, ["要点一", "要点二"]);
  assert.match(outline.counterpoint, /不是这样/);
  assert.match(outline.takeaway, /性命关重要/);
  assert.equal(outline.image_plan.length, 1);
  assert.equal(outline.image_plan[0].position, "cover");
  assert.equal(outline.image_plan[0].description, "一张封面");
  assert.equal(outline.image_plan[0].prompt, "a cover image");
});

test("parseOutlineMarkdown reads a minimal user outline and distributes words", () => {
  const md = ["# 标题", "## 第一段", "- 甲", "- 乙", "## 第二段", "- 丙"].join("\n");
  const outline = parseOutlineMarkdown(md, { targetWords: 1000 });
  assert.equal(outline.title, "标题");
  assert.deepEqual(outline.outline.map((s) => s.heading), ["第一段", "第二段"]);
  assert.deepEqual(outline.outline[1].points, ["丙"]);
  assert.equal(outline.outline.reduce((n, s) => n + s.target_words, 0), 1000);
});

test("parseOutlineMarkdown returns null only when nothing is parseable", () => {
  assert.equal(parseOutlineMarkdown("", {}), null);
  assert.equal(parseOutlineMarkdown("只有一句话", {}).outline.length, 1);
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

test("normalizeConfig resolves knowledge.source and WeKnora defaults", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { weknora: { base_url: "http://wk/api/v1", api_key: "k" } };
  raw.types[0].knowledge = { source: "weknora", weknora: { kb_ids: "kb1" } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "weknora");
  assert.deepEqual(type.knowledge.weknora.kb_ids, ["kb1"]);
  assert.equal(type.knowledge.weknora.base_url, "http://wk/api/v1");
  assert.equal(type.knowledge.weknora.auth_header, "X-API-Key");
});

test("normalizeConfig degrades a WeKnora source when base_url is missing", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "local");
  assert.ok(type.knowledge.weknora.disabled_reason);
});

test("validateConfig flags a WeKnora source without kb_ids", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "weknora" };
  const issues = validateConfig(normalizeConfig(raw, dir));
  assert.ok(issues.some((i) => i.includes("kb_ids")));
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
/* weknora knowledge source                                            */
/* ------------------------------------------------------------------ */

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function weknoraType(overrides = {}) {
  return {
    name: "T",
    topic: { keywords: ["Agent"] },
    knowledge: {
      source: "weknora",
      max_sources: 6,
      excerpt_chars: 500,
      weknora: { base_url: "http://wk/api/v1", api_key: "k", kb_ids: ["kb1"], match_count: 6 },
      ...overrides,
    },
  };
}

function kbDir(count = 6) {
  const dir = tempDir("wa-kb-");
  for (let i = 1; i <= count; i++) {
    fs.writeFileSync(
      path.join(dir, `agent-${i}.md`),
      `---\ntitle: Agent 稳定性 ${i}\ndate: 2026-09-0${i}\n---\n\nAgent 工具调用稳定性问题 ${i}，需要系统性分析。\n`,
    );
  }
  return dir;
}

test("searchWeKnora normalizes hits, strips image noise and parses frontmatter", async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(String(url), /\/knowledge-bases\/kb1\/hybrid-search$/);
    assert.deepEqual(JSON.parse(init.body), { query_text: "Agent", match_count: 6 });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            knowledge_id: "k1",
            knowledge_title: "标题一",
            content: "![](resource://abc) 正文 A",
            score: 0.02,
            knowledge_description: "一段摘要",
            knowledge_custom_metadata: "date: 2025-01-20T10:00:00+08:00\nkeywords: AI, Agent",
          },
          { knowledge_id: "k1", knowledge_title: "标题一", content: "正文 B", score: 0.05 },
        ],
      }),
      text: async () => "",
    };
  });
  try {
    const hits = await searchWeKnora(weknoraType(), "Agent", {});
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "weknora://kb1/k1");
    assert.equal(hits[0].date, "2025-01-20");
    assert.deepEqual(hits[0].tags, ["AI", "Agent"]);
    assert.equal(hits[0].summary, "一段摘要");
    assert.equal(hits[0].score, 0.05);
    assert.equal(hits[0].excerpts.length, 2);
    assert.ok(!hits[0].excerpts[0].includes("resource://"));
  } finally {
    restore();
  }
});

test("searchWeKnora logs and skips failing knowledge bases", async () => {
  const warnings = [];
  const restore = stubFetch(async () => ({ ok: false, status: 500, text: async () => "boom" }));
  try {
    const type = weknoraType({ weknora: { base_url: "http://wk/api/v1", api_key: "k", kb_ids: ["kb1"] } });
    const hits = await searchWeKnora(type, "Agent", { logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(hits, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 500/);
  } finally {
    restore();
  }
});

test("collectSources interleaves local and WeKnora when source=both", async () => {
  const dir = kbDir(6);
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [1, 2, 3].map((i) => ({
        knowledge_id: `w${i}`,
        knowledge_title: `远端 ${i}`,
        content: `远端内容 ${i}`,
        score: 0.03 - i * 0.01,
      })),
    }),
    text: async () => "",
  }));
  try {
    const type = weknoraType({ source: "both", max_sources: 6 });
    type.knowledge_dirs = [dir];
    const sources = await collectSources(type, {
      topic: { topic: "Agent 稳定性" },
      notes: indexKnowledge(type, { logger: null }),
    });
    assert.equal(sources.length, 6);
    assert.deepEqual(sources.map((s) => s.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(sources.filter((s) => s.origin === "weknora").length, 3);
    assert.equal(sources[0].origin, "local");
    assert.equal(sources[1].origin, "weknora");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectSources stays offline in mock mode even for a WeKnora source", async () => {
  const dir = kbDir(3);
  const restore = stubFetch(async () => {
    throw new Error("network must not be used in mock mode");
  });
  try {
    const type = weknoraType();
    type.knowledge_dirs = [dir];
    const sources = await collectSources(type, {
      topic: { topic: "Agent 稳定性" },
      notes: indexKnowledge(type, { logger: null }),
      mock: true,
    });
    assert.ok(sources.length >= 1);
    assert.equal(sources.every((s) => s.origin === "local"), true);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
