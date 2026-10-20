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
  formatImageMarker,
  ensureSectionHeadings,
} from "../scripts/lib/markdown.mjs";
import { buildLengthPrompt, buildDraftPrompt, buildTopicPrompt } from "../scripts/lib/prompts.mjs";
import { parseOutlineMarkdown } from "../scripts/lib/markdown.mjs";

import { parseJsonFromText, extractAgentText } from "../scripts/lib/models.mjs";
import {
  loadConfig,
  findType,
  normalizeConfig,
  normalizeWordLimit,
  normalizeImageCount,
  validateConfig,
  validateWarnings,
  deepMerge,
} from "../scripts/lib/config.mjs";
import {
  buildSystemOneBody,
  classifyArticle,
  classifyOrFallback,
  normalizeClassifyResult,
  systemOneUrl,
} from "../scripts/lib/classify.mjs";
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
import { buildDraftInput, normalizeDraftInput, validateDraftInput, loadDraftTemplate, buildDraftVars, summarizeDraftInput } from "../scripts/lib/draft-input.mjs";
import { renderTemplate, validateTemplateSchema } from "../scripts/lib/template.mjs";
import { bodyOnly, emailShell, markdownToHtml, derivePublishStatus } from "../scripts/lib/publish.mjs";
import { ARTIFACT, STAGES, createArticle, detectStartStage, listArticles, openArticle, stageIndex } from "../scripts/lib/article-store.mjs";
import { archiveArticle } from "../scripts/lib/archive.mjs";
import { listZipEntries, zipDirectory } from "../scripts/lib/zip.mjs";

const CONFIG_DIR = path.join(import.meta.dirname, "..", "config");
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_CONFIG_REL = "skills/wechat-article/config/article-types.yaml";
const DRAFT_TEMPLATE = loadDraftTemplate(CONFIG_DIR);

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

test("image_position_format drives marker generation, parsing and replacement", () => {
  const format = "<<img:{index}>>";
  assert.equal(formatImageMarker(format, 3, "说明", "prompt"), "<<img:3|说明|prompt>>");
  assert.equal(formatImageMarker("[[img:{index}]]", 2, "图二"), "[[img:2|图二]]");

  const markers = parseImageMarkers("A\n\n<<img:2|图二|a diagram>>\n\nB", { format });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].index, 2);
  assert.equal(markers[0].description, "图二");
  assert.equal(markers[0].prompt, "a diagram");

  const replaced = replaceImageMarkers("<<img:1|封面>>", new Map([[1, "images/01.png"]]), { format });
  assert.equal(replaced, "![封面](images/01.png)");

  const ensured = ensureImageMarkers("## A\n\n正文段落。\n\n## B\n\n正文段落。", 1, [{ description: "示意图" }], { format });
  assert.match(ensured, /<<img:1\|示意图>>/);
  assert.equal(parseImageMarkers(ensured, { format }).length, 1);
});

test("normalizeImageMarkers renumbers custom-format markers", () => {
  const format = "<!-- img:{index} -->";
  const md = "<!-- img:5|甲 -->\n\n<!-- img:5|重复 -->\n\n<!-- img:9|乙 -->";
  const out = normalizeImageMarkers(md, 2, [], { format });
  const markers = parseImageMarkers(out, { format });
  assert.deepEqual(markers.map((m) => m.index), [1, 2]);
  assert.deepEqual(markers.map((m) => m.description), ["甲", "乙"]);
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
  const retry = DRAFT_TEMPLATE.prompt.retry;
  const expand = buildLengthPrompt({ type, article: "正文", wordCount: 500, direction: "expand", retry, attempt: 1 });
  assert.match(expand.prompt, /800-1300/);
  assert.match(expand.prompt, /优先在现有小节内补充/);
  assert.match(expand.prompt, /第 1 次尝试/);
  assert.doesNotMatch(expand.prompt, /\{\{/);

  const condense = buildLengthPrompt({ type, article: "正文", wordCount: 2000, direction: "condense", retry, attempt: 2 });
  assert.match(condense.prompt, /删除重复表述/);
  assert.match(condense.prompt, /第 2 次尝试/);
});

test("buildDraftPrompt asks for multi-sentence paragraphs", () => {
  const type = {
    name: "T",
    length: { min: 100, max: 200, target: 150 },
    style: {},
    illustrations: { min: 1, max: 3 },
  };
  const input = buildDraftInput({
    type,
    outline: { title: "T", outline: [{ heading: "H", points: ["p"] }] },
    sources: [],
  });
  const prompt = buildDraftPrompt({ type, input, template: DRAFT_TEMPLATE });
  assert.match(prompt.prompt, /每段 2-5 句/);
  assert.match(prompt.prompt, /不要低于 100 字/);
  assert.match(prompt.prompt, /title: T/);
});

/* ------------------------------------------------------------------ */
/* image markers                                                       */
/* ------------------------------------------------------------------ */

test("ensureSectionHeadings 把与纲要同名的裸行升级成 ##", () => {
  const md = [
    buildFrontmatter({ title: "T" }).trimEnd(),
    "",
    "开头段落。",
    "",
    "第一节",
    "",
    "正文。",
    "",
    "1. 第二节",
    "",
    "正文。",
    "",
    "### 第三节",
    "",
    "正文。",
  ].join("\n");
  const fixed = ensureSectionHeadings(md, ["第一节", "第二节", "第三节"]);
  assert.match(fixed, /\n## 第一节\n/);
  assert.match(fixed, /\n## 第二节\n/);
  assert.match(fixed, /\n### 第三节\n/);
  assert.doesNotMatch(fixed, /\n第三节\n/);
  // 正文里的同名句子不动
  const inline = ensureSectionHeadings("前面提到第一节，后面还有内容。", ["第一节"]);
  assert.equal(inline, "前面提到第一节，后面还有内容。");
});

test("ensureImageMarkers 用配图计划的描述补齐缺失标记", () => {
  const md = `${buildFrontmatter({ title: "T" }).trimEnd()}\n\n第一段。\n\n第二段。\n\n第三段。`;
  const out = ensureImageMarkers(md, 2, [
    { position: "cover", description: "封面画面", prompt: "cover art" },
    { position: "inline_1", description: "第二节示意图" },
  ]);
  assert.match(out, /\[\[img:1\|封面画面\|cover art\]\]/);
  assert.match(out, /\[\[img:2\|第二节示意图\]\]/);
});

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

test("parseOutlineMarkdown reads one topic out of a topics proposal document", () => {
  const md = [
    "# AI 资讯快评 · 候选主题与提纲",
    "",
    "---",
    "",
    "## 主题 2：某标题",
    "",
    "- **核心判断**：一句话判断。",
    "- **切入角度**：从工程角度切入。",
    "- **关键词**：甲、乙",
    "",
    "**备选标题**",
    "",
    "1. 标题 A",
    "2. 标题 B",
    "",
    "**提纲**",
    "",
    "1. **开篇**（约 300 字）",
    "   - 要点一",
    "",
    "2. **展开**（约 600 字）",
    "   - 要点二",
    "   - 要点三",
  ].join("\n");
  const outline = parseOutlineMarkdown(md, { title: "某标题" });
  assert.equal(outline.thesis, "一句话判断。");
  assert.deepEqual(outline.outline.map((s) => s.heading), ["开篇", "展开"]);
  assert.equal(outline.outline[0].target_words, 300);
  assert.deepEqual(outline.outline[1].points, ["要点二", "要点三"]);
});

/* ------------------------------------------------------------------ */
/* multi-topic selection prompt                                        */
/* ------------------------------------------------------------------ */

test("buildTopicPrompt asks for several distinct topics when count > 1", () => {
  const type = {
    id: "t",
    name: "测试栏目",
    description: "desc",
    length: { min: 800, max: 1300, target: 1000 },
    style: { audience: "读者" },
    topic: { keywords: ["AI"] },
  };
  const candidates = [
    { title: "文章一", date: "2026-10-01", tags: ["a"], summary: "摘要一", excerpt: "" },
    { title: "文章二", date: "2026-10-02", tags: ["b"], summary: "摘要二", excerpt: "" },
  ];

  const single = buildTopicPrompt({ type, candidates, count: 1 });
  assert.match(single.prompt, /"topic"/);
  assert.doesNotMatch(single.prompt, /"topics"/);

  const multi = buildTopicPrompt({ type, candidates, count: 3 });
  assert.match(multi.prompt, /3 个/);
  assert.match(multi.prompt, /"topics"/);
  assert.match(multi.prompt, /明显不同/);
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
/* draft input（标题 + 大纲 + 资料）                                    */
/* ------------------------------------------------------------------ */

const DRAFT_TYPE = { id: "t1", name: "T1", style: { audience: "读者" }, length: { min: 100, target: 150, max: 200 } };

function sampleDraftInput() {
  return buildDraftInput({
    type: DRAFT_TYPE,
    topic: { title: "备选标题", thesis: "备选判断" },
    outline: {
      title: "文章标题",
      thesis: "核心判断",
      hook: "一个场景",
      outline: [{ heading: "第一节", points: ["要点一"], target_words: 150, source_indexes: [1] }],
      counterpoint: "反方观点",
      takeaway: "结尾结论",
      image_plan: [{ position: "cover", description: "封面画面", prompt: "cover art" }],
    },
    sources: [
      {
        index: 1,
        title: "素材一",
        date: "2026-01-01",
        origin: "local",
        file: "/tmp/a.md",
        summary: "摘要",
        excerpts: ["段落一", "段落二"],
      },
    ],
  });
}

test("buildDraftInput 只保留标题、大纲与资料", () => {
  const input = sampleDraftInput();
  assert.equal(input.type, "t1");
  assert.equal(input.title, "文章标题");
  assert.equal(input.thesis, "核心判断");
  assert.equal(input.audience, "读者");
  assert.deepEqual(input.outline, [{ heading: "第一节", points: ["要点一"], target_words: 150 }]);
  assert.deepEqual(input.materials, [
    { title: "素材一", date: "2026-01-01", source: "/tmp/a.md", paragraphs: ["段落一", "段落二"] },
  ]);
  assert.deepEqual(input.images, [{ position: "cover", description: "封面画面", prompt: "cover art" }]);
  // 字段数量固定：再变复杂就该质疑了
  assert.deepEqual(Object.keys(input), [
    "type",
    "title",
    "thesis",
    "audience",
    "hook",
    "requirements",
    "outline",
    "counterpoint",
    "takeaway",
    "materials",
    "images",
  ]);
  assert.equal(validateDraftInput(input, { schema: DRAFT_TEMPLATE.schema, type: DRAFT_TYPE }).ok, true);
  assert.equal(summarizeDraftInput(input).length, 4);
});

test("validateDraftInput 拦住缺标题、空大纲、空资料", () => {
  const report = validateDraftInput({ type: "t1", title: "", outline: [], materials: [] }, { schema: DRAFT_TEMPLATE.schema });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("title")));
  assert.ok(report.errors.some((e) => e.includes("outline")));
  assert.ok(report.errors.some((e) => e.includes("materials")));
});

test("validateDraftInput 用紧凑 schema 校验嵌套字段", () => {
  const raw = sampleDraftInput();
  raw.outline.push({ heading: "", points: [] });
  raw.materials[0].paragraphs = [];
  const report = validateDraftInput(raw, { schema: DRAFT_TEMPLATE.schema });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("outline[1].heading")));
  assert.ok(report.errors.some((e) => e.includes("outline[1].points")));
  assert.ok(report.errors.some((e) => e.includes("materials[0].paragraphs")));
});

test("行内 schema 支持可选字段、长度区间与项数上限", () => {
  const schema = {
    title: ["string", 1, 5],
    tags: ["array", 1, 2],
    "tags[]": ["string", 1],
    note: "string",
    flag: "boolean",
  };
  assert.deepEqual(validateTemplateSchema({ title: "abc", tags: ["a"], note: "", flag: true }, schema).errors, []);
  const bad = validateTemplateSchema({ title: "abcdef", tags: ["a", "b", "c"], flag: "yes" }, schema);
  assert.ok(bad.errors.some((e) => e.includes("title")));
  assert.ok(bad.errors.some((e) => e.includes("tags")));
  assert.ok(bad.errors.some((e) => e.includes("note")));
  assert.ok(bad.errors.some((e) => e.includes("flag")));
  // 标量数组的元素规则：tags[]
  const scalar = validateTemplateSchema({ title: "abc", tags: [1], note: "", flag: true }, schema);
  assert.ok(scalar.errors.some((e) => e.includes("tags[0]")));
  // 末尾问号 = 可选
  const { note, ...rest } = schema;
  assert.deepEqual(
    validateTemplateSchema({ title: "a", tags: ["a"], flag: true }, { ...rest, "note?": "string" }).errors,
    [],
  );
});

test("renderTemplate 替换嵌套变量，未知变量留空", () => {
  const text = "{{title}}／{{length.min}}-{{length.max}}／{{missing}}／{{tags}}";
  assert.equal(renderTemplate(text, { title: "T", length: { min: 1, max: 2 }, tags: ["a", "b"] }), "T／1-2／／a、b");
});

test("draft 模板文件里的占位符都能被真实变量填满", () => {
  const type = { ...DRAFT_TYPE, illustrations: { min: 1, max: 3 } };
  const vars = buildDraftVars({ type, input: sampleDraftInput() });
  for (const block of [DRAFT_TEMPLATE.prompt.system, DRAFT_TEMPLATE.prompt.user]) {
    assert.doesNotMatch(renderTemplate(block, vars, { keepUnknown: true }), /\{\{/, "模板里有未定义的占位符");
  }
  const rendered = renderTemplate(DRAFT_TEMPLATE.prompt.user, vars);
  assert.match(rendered, /## 主题\n文章标题/);
  assert.match(rendered, /1\. 第一节｜约 150 字/);
  assert.match(rendered, /素材 1：素材一/);
});

test("normalizeDraftInput 丢掉空小节和空素材", () => {
  const input = normalizeDraftInput({
    title: "T",
    outline: [{ heading: "一", points: [" p ", ""] }, { heading: "", points: ["x"] }],
    materials: [{ title: "", paragraphs: [] }, { title: "B", paragraphs: ["y"] }],
  });
  assert.deepEqual(input.outline, [{ heading: "一", points: ["p"], target_words: 0 }]);
  assert.deepEqual(input.materials, [{ title: "B", date: "", source: "", paragraphs: ["y"] }]);
});

test("buildDraftVars 渲染大纲、素材与配图提示", () => {
  const vars = buildDraftVars({ type: DRAFT_TYPE, input: sampleDraftInput() });
  assert.equal(vars.title, "文章标题");
  assert.match(vars.outline, /1\. 第一节｜约 150 字/);
  assert.match(vars.materials, /素材 1：素材一/);
  assert.match(vars.materials, /段落一/);
  assert.equal(vars.image_hint, "1. cover：封面画面");
  assert.equal(vars.length.min, 100);
  assert.equal(vars.image.max, "");
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

test("loadConfig reads the YAML base config and config/types/*.yaml", () => {
  const config = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
  assert.equal(config.types.length, 4);
  const news = findType(config, "ai-news");
  assert.equal(news.name, "AI 资讯快评");
  assert.deepEqual([news.length.min, news.length.max], [800, 1300]);
  assert.equal(news.illustrations.position_format, "[[img:{index}]]");
  assert.equal(news.knowledge.source, "local");
  assert.equal(news.knowledge_dirs.length, 1);
  assert.equal(news.scoring.pass_score, 78);
  assert.ok(news.scoring.dimensions.every((d) => d.weight > 0 && d.weight <= 1));
  assert.equal(config.classifier.provider, "systemone");
  assert.equal(config.classifier.default_type, "ai-news");
  assert.equal(path.isAbsolute(config.project.base_output_folder), true);
});

test("word_limit and image_count accept YAML shorthands", () => {
  assert.deepEqual(normalizeWordLimit("800-1300"), { min: 800, max: 1300, target: 1050 });
  assert.deepEqual(normalizeWordLimit("1500"), { min: 1500, max: 1500, target: 1500 });
  assert.deepEqual(normalizeWordLimit({ min: 1000, max: 2000, target: 1400 }), { min: 1000, max: 2000, target: 1400 });
  assert.deepEqual(normalizeImageCount("1-3"), { min: 1, max: 3 });
  assert.deepEqual(normalizeImageCount(2), { min: 2, max: 2, count: 2 });
  assert.deepEqual(normalizeImageCount({ min: 1, max: 5, default: 3, cover: false }), { min: 1, max: 5, count: 3, cover: false });
  assert.deepEqual(normalizeImageCount(undefined), {});
});

test("normalizeConfig maps YAML-style type fields into the runtime shape", () => {
  const dir = tempDir("wa-cfg-yaml-");
  const config = normalizeConfig(
    {
      defaults: { review: { pass_score: 80 }, illustrations: { style: "扁平插画" } },
      models: { local: { provider: "mock" } },
      types: [
        {
          id: "t1",
          type: "测试类型",
          knowledge_base_path: ["./kb"],
          style: "冷静的观察者",
          word_limit: "500-800",
          pass_score: 70,
          scoring_criteria: [
            { id: "a", name: "A", weight: 1 },
            { id: "b", name: "B", weight: 3 },
          ],
          image_count: { min: 1, max: 4, default: 2 },
          image_position_format: "<<img:{index}>>",
        },
      ],
    },
    dir,
  );
  const type = config.types[0];
  assert.equal(type.name, "测试类型");
  assert.equal(type.style.persona, "冷静的观察者");
  assert.deepEqual(type.length, { min: 500, max: 800, target: 650 });
  assert.equal(type.scoring.pass_score, 70);
  assert.deepEqual(type.scoring.dimensions.map((d) => d.weight), [0.25, 0.75]);
  assert.equal(type.illustrations.style, "扁平插画");
  assert.equal(type.illustrations.count, 2);
  assert.equal(type.illustrations.position_format, "<<img:{index}>>");
  assert.equal(type.knowledge.source, "local");
  assert.equal(path.isAbsolute(type.knowledge_dirs[0]), true);
});

test("validateWarnings flags an unconfigured classifier and unknown default_type", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.classifier = { enabled: true, base_url: "", api_key: "", default_type: "missing" };
  const config = normalizeConfig(raw, dir);
  const warnings = validateWarnings(config);
  assert.ok(warnings.some((w) => w.includes("SYSTEMONE")));
  assert.ok(warnings.some((w) => w.includes("default_type")));
});

test("buildSystemOneBody turns the types into a choice question", () => {
  const body = buildSystemOneBody({
    model: "jev-latest",
    types: [
      {
        id: "ai-news",
        name: "AI 资讯快评",
        description: "单条新闻快速解读",
        style: { persona: "科技媒体主编", audience: "从业者" },
        topic: { keywords: ["发布", "开源"] },
      },
      { id: "ai-insight", name: "AI 深度观点", description: "围绕一个判断展开" },
    ],
    title: "某模型开源",
    outline: "## 发生了什么\n- 细节",
  });
  assert.equal(body.model, "jev-latest");
  assert.match(body.state, /标题：某模型开源/);
  assert.match(body.state, /## 发生了什么/);
  const question = body.questions.article_type;
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.criteria).sort(), ["ai-insight", "ai-news"]);
  assert.match(question.criteria["ai-news"], /单条新闻快速解读/);
  assert.match(question.instructions, /不要依据选项/);
});

test("systemOneUrl does not duplicate /v1", () => {
  assert.equal(systemOneUrl("https://routellm.abacus.ai/v1"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai/", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
});

test("normalizeClassifyResult reads answers.<question>.choice and clamps confidence", () => {
  const types = [{ id: "ai-news" }, { id: "ai-insight" }];
  const good = normalizeClassifyResult(
    {
      answers: {
        article_type: {
          type: "choice",
          choice: "ai-news",
          probabilities: { "ai-news": 0.94, "ai-insight": 0.06 },
          confidence: 2,
        },
      },
    },
    types,
  );
  assert.equal(good.ok, true);
  assert.equal(good.type, "ai-news");
  assert.equal(good.confidence, 1);
  assert.equal(good.probabilities["ai-news"], 0.94);

  const byProbability = normalizeClassifyResult(
    { answers: { article_type: { probabilities: { "ai-insight": 0.7, "ai-news": 0.3 } } } },
    types,
  );
  assert.equal(byProbability.type, "ai-insight");

  assert.equal(normalizeClassifyResult({ answers: {} }, types).ok, false);
  assert.equal(normalizeClassifyResult({ answers: { article_type: { choice: "ghost" } } }, types).ok, false);
});

test("classifyArticle calls /v1/systemone and parses answers", async () => {
  const config = {
    classifier: {
      enabled: true,
      base_url: "http://systemone.local/v1",
      endpoint: "/v1/systemone",
      api_key: "k",
      model: "jev-latest",
      question: "article_type",
      timeout_ms: 1000,
      max_retries: 0,
      min_confidence: 0.5,
    },
    types: [
      { id: "ai-news", name: "AI 资讯快评", enabled: true },
      { id: "ai-insight", name: "AI 深度观点", enabled: true },
    ],
  };
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        id: "systemone-1",
        object: "systemone.classification",
        model: "jev-1.13.0",
        answers: {
          article_type: {
            type: "choice",
            choice: "ai-news",
            probabilities: { "ai-news": 0.91, "ai-insight": 0.09 },
            confidence: 0.88,
          },
        },
        usage: { input_tokens: 120, output_tokens: 2 },
      }),
      { status: 200 },
    );
  };
  const result = await classifyArticle({ config, title: "某模型开源", outline: "## 事实", fetchImpl });
  assert.equal(seen.url, "http://systemone.local/v1/systemone");
  assert.equal(seen.headers.Authorization, "Bearer k");
  assert.equal(seen.body.model, "jev-latest");
  assert.equal(seen.body.questions.article_type.type, "choice");
  assert.match(seen.body.state, /某模型开源/);
  assert.equal(result.ok, true);
  assert.equal(result.type, "ai-news");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.probabilities["ai-news"], 0.91);
});

test("classifyArticle retries 429 before giving up", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "0.01" },
      });
    }
    return new Response(
      JSON.stringify({
        answers: { article_type: { type: "choice", choice: "ai-news", probabilities: { "ai-news": 0.9 }, confidence: 0.9 } },
      }),
      { status: 200 },
    );
  };
  const config = {
    classifier: {
      enabled: true,
      base_url: "http://systemone.local",
      endpoint: "/v1/systemone",
      api_key: "k",
      model: "jev-latest",
      question: "article_type",
      timeout_ms: 1000,
      max_retries: 1,
      min_confidence: 0.5,
    },
    types: [{ id: "ai-news", name: "AI 资讯快评", enabled: true }],
  };
  const result = await classifyArticle({ config, title: "某模型开源", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.type, "ai-news");
});

test("classifyOrFallback degrades to classifier.default_type", async () => {
  const config = {
    classifier: { enabled: true, base_url: "", api_key: "", default_type: "ai-news", min_confidence: 0.5 },
    types: [{ id: "ai-news", name: "AI 资讯快评", enabled: true }],
  };
  const outcome = await classifyOrFallback({ config, title: "某模型开源" });
  assert.equal(outcome.typeId, "ai-news");
  assert.equal(outcome.source, "default");
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

test("use_weknora=false 把所有类型压回本地目录", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { use_weknora: "false", weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const config = normalizeConfig(raw, dir);
  assert.equal(config.defaults.knowledge.use_weknora, false);
  assert.equal(config.types[0].knowledge.source, "local");
  assert.equal(config.types[0].knowledge.weknora.enabled, false);
  assert.match(config.types[0].knowledge.weknora.disabled_reason, /use_weknora/);
  assert.deepEqual(validateConfig(config), []);
});

test("use_weknora 默认开启，显式 true 保留远端来源", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { use_weknora: true, weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "both");
  assert.equal(type.knowledge.weknora.enabled, true);
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

/* ------------------------------------------------------------------ */
/* article store / resume / archive                                    */
/* ------------------------------------------------------------------ */

function storeConfig(prefix = "wa-store-") {
  const root = tempDir(prefix);
  return { __root: root, project: { base_output_folder: path.join(root, "articles") } };
}

test("normalizeConfig resolves base_output_folder against the project root", () => {
  const config = normalizeConfig({ project: { base_output_folder: "out/wa" }, types: [] }, path.join("C:", "proj"));
  assert.equal(config.project.base_output_folder, path.resolve("C:/proj", "out/wa"));
});

test("createArticle uses the title slug, creates draft/ and published/, and never overwrites", () => {
  const config = storeConfig();
  const type = { id: "ai-news", name: "AI 资讯" };
  const first = createArticle(config, { title: "AI 测试 文章", type });
  const second = createArticle(config, { title: "AI 测试 文章", type });

  assert.equal(first.slug, "AI-测试-文章");
  assert.equal(second.slug, "AI-测试-文章-2");
  assert.ok(fs.existsSync(path.join(config.project.base_output_folder, "draft")));
  assert.ok(fs.existsSync(path.join(config.project.base_output_folder, "published")));
  assert.ok(fs.existsSync(first.dir));
  assert.ok(fs.existsSync(second.dir));
});

test("detectStartStage follows the artifact chain, publish status decides archive", () => {
  const config = storeConfig();
  const { dir } = createArticle(config, { title: "断点续跑", type: { id: "ai-news" } });
  const write = (name, content = "{}") => fs.writeFileSync(path.join(dir, name), content, "utf8");

  assert.equal(detectStartStage(dir), "topic");
  write(ARTIFACT.topic);
  assert.equal(detectStartStage(dir), "sources");
  write(ARTIFACT.sources);
  assert.equal(detectStartStage(dir), "outline");
  write(ARTIFACT.outline);
  assert.equal(detectStartStage(dir), "bundle");
  write(ARTIFACT.draftInput);
  assert.equal(detectStartStage(dir), "draft");
  write(ARTIFACT.draft);
  assert.equal(detectStartStage(dir), "review");
  write(ARTIFACT.reviewed);
  assert.equal(detectStartStage(dir), "illustrate");
  write(ARTIFACT.illustrated);
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.final);
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.publish, JSON.stringify({ status: "skipped" }));
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.publish, JSON.stringify({ status: "published" }));
  assert.equal(detectStartStage(dir), "archive");
});

test("openArticle auto-selects the only article and refuses to guess between several", () => {
  const config = storeConfig();
  const first = createArticle(config, { title: "第一篇", type: { id: "ai-news" } });
  assert.equal(openArticle(config).slug, first.slug);

  const second = createArticle(config, { title: "第二篇", type: { id: "ai-news" } });
  assert.throws(() => openArticle(config), /--article/);
  assert.equal(openArticle(config, "第二篇").slug, second.slug);
  assert.ok(listArticles(config).length === 2);
});

test("zipDirectory writes a readable archive with nested paths", () => {
  const src = tempDir("wa-zip-src-");
  fs.mkdirSync(path.join(src, "images"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.md"), "hello 世界", "utf8");
  fs.writeFileSync(path.join(src, "images", "01.png"), Buffer.from([1, 2, 3, 4]));

  const out = path.join(tempDir("wa-zip-out-"), "out.zip");
  const result = zipDirectory(src, out);
  assert.equal(result.entries, 2);
  assert.deepEqual(listZipEntries(out).sort(), ["a.md", "images/01.png"]);
});

test("archiveArticle zips the article, copies the final copy to the knowledge dir, then removes draft/", () => {
  const root = tempDir("wa-archive-");
  const config = { __root: root, project: { base_output_folder: path.join(root, "articles") } };
  const type = { id: "ai-news", name: "AI 资讯", publish: { archive: { knowledge_dir: path.join(root, "kb") } } };
  const created = createArticle(config, { title: "归档测试", type });
  fs.writeFileSync(path.join(created.dir, ARTIFACT.final), "---\ntitle: 旧标题\n---\n\n正文内容\n", "utf8");

  const result = archiveArticle({
    config,
    type,
    dir: created.dir,
    slug: created.slug,
    publish: { title: "归档测试", status: "published" },
  });

  assert.equal(fs.existsSync(created.dir), false);
  const zipFile = path.resolve(root, result.archive.zip);
  assert.ok(fs.existsSync(zipFile));
  const names = listZipEntries(zipFile);
  assert.ok(names.includes(ARTIFACT.final));
  assert.ok(names.includes(ARTIFACT.publish));

  const knowledgeFile = result.archive.knowledge.file;
  assert.ok(fs.existsSync(knowledgeFile));
  const knowledge = fs.readFileSync(knowledgeFile, "utf8");
  assert.match(knowledge, /title: 归档测试/);
  assert.match(knowledge, /published_at:/);
  assert.match(knowledge, /正文内容/);
});

test("archiveArticle is idempotent: an existing zip is reused instead of creating -2", () => {
  const root = tempDir("wa-archive-retry-");
  const config = { __root: root, project: { base_output_folder: path.join(root, "articles") } };
  const type = { id: "ai-news", name: "AI 资讯", publish: { archive: { knowledge_dir: "" } } };
  const created = createArticle(config, { title: "重试归档", type });
  fs.writeFileSync(path.join(created.dir, ARTIFACT.final), "# 正文\n", "utf8");

  const first = archiveArticle({ config, type, dir: created.dir, slug: created.slug, publish: { title: "重试归档", status: "published" } });

  // 模拟「zip 已打包但目录没删掉」后重跑
  fs.mkdirSync(created.dir, { recursive: true });
  fs.writeFileSync(path.join(created.dir, ARTIFACT.final), "# 正文\n", "utf8");
  const second = archiveArticle({
    config,
    type,
    dir: created.dir,
    slug: created.slug,
    publish: { title: "重试归档", status: "published", archive: { ...first.archive } },
  });

  assert.equal(second.archive.zip, first.archive.zip);
  const zips = fs.readdirSync(path.join(config.project.base_output_folder, "published")).filter((name) => name.endsWith(".zip"));
  assert.equal(zips.length, 1);
});

test("derivePublishStatus only reports published when every enabled channel succeeded", () => {
  assert.equal(derivePublishStatus({ dryRun: true, emailEnabled: true, email: { success: true } }), "dry_run");
  assert.equal(derivePublishStatus({ emailEnabled: false, wechatEnabled: false }), "skipped");
  assert.equal(derivePublishStatus({ emailEnabled: true, email: { success: true } }), "published");
  assert.equal(derivePublishStatus({ emailEnabled: true, email: { success: true, dryRun: true } }), "dry_run");
  assert.equal(derivePublishStatus({ emailEnabled: true, wechatEnabled: true, email: { success: true }, wechat: { success: true } }), "published");
  assert.equal(derivePublishStatus({ emailEnabled: true, wechatEnabled: true, email: { success: true }, wechat: { success: false } }), "partial");
  assert.equal(derivePublishStatus({ emailEnabled: true, email: { success: false } }), "failed");
});
