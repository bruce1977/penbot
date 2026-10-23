// 初稿阶段测试：draft-input 组装与校验、模板渲染、初稿/修正提示词
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildRevisePrompt, buildDraftPrompt } from "../../scripts/lib/prompts.mjs";
import { loadSteps } from "../../scripts/lib/steps.mjs";
import { lengthAction } from "../../scripts/lib/markdown.mjs";
import { validateTemplateSchema, renderTemplate } from "../../scripts/lib/template.mjs";
import {
  buildDraftInput,
  normalizeDraftInput,
  validateDraftInput,
  loadDraftTemplate,
  buildDraftVars,
  summarizeDraftInput,
} from "../../scripts/lib/draft-input.mjs";

const CONFIG_DIR = path.join(import.meta.dirname, "../../config/wechat-article");
const DRAFT_TEMPLATE = loadDraftTemplate(CONFIG_DIR);

/* ------------------------------------------------------------------ */
/* length control                                                      */
/* ------------------------------------------------------------------ */

test("lengthAction classifies drafts against the word range", () => {
  assert.equal(lengthAction(500, { min: 800, max: 1300 }), "expand");
  assert.equal(lengthAction(2000, { min: 800, max: 1300 }), "condense");
  assert.equal(lengthAction(1000, { min: 800, max: 1300 }), null);
  assert.equal(lengthAction(800, { min: 800, max: 1300 }), null);
});

test("buildRevisePrompt renders first-round basis and word-count retry block", () => {
  const type = { name: "AI 资讯快评", length: { min: 800, max: 1300, target: 1000 } };
  const prompt = loadSteps("config/wechat-article/steps.yaml").prompts["revision.revision"];

  const first = buildRevisePrompt({
    prompt,
    type,
    article: "正文",
    corrections: [{ type: "typo", original: "在", corrected: "再" }],
    round: 1,
    wordCount: 700,
  });
  assert.match(first.system, /改稿编辑/);
  assert.match(first.prompt, /首轮修改：本轮没有评分意见/);
  assert.match(first.prompt, /\[typo\] 在 → 再/);
  assert.match(first.prompt, /800-1300/);
  assert.doesNotMatch(first.prompt, /上一稿不合格/);
  assert.doesNotMatch(first.prompt, /\{\{/);

  const retry = buildRevisePrompt({
    prompt,
    type,
    article: "正文",
    review: { total: 60, verdict: "revise", issues: [{ severity: "high", dimension: "length", problem: "篇幅不足", fix: "补充素材" }], must_fix: ["补 300 字"] },
    corrections: [],
    round: 2,
    wordCount: 700,
    attempt: 3,
    failReason: { words: 700, action: "expand" },
  });
  assert.match(retry.prompt, /总分：60，结论：revise/);
  assert.match(retry.prompt, /上一稿不合格（第 3 次尝试）/);
  assert.match(retry.prompt, /需要增补约 300 字/);
  assert.match(retry.prompt, /优先在现有小节内补充/);
  assert.match(retry.prompt, /核稿未发现需要修复的问题/);
  assert.doesNotMatch(retry.prompt, /\{\{/);
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
    topic: { title: "T" },
    outline: { outline: [{ heading: "H", points: ["p"] }] },
    sources: [],
  });
  const prompt = buildDraftPrompt({ type, input, template: DRAFT_TEMPLATE });
  assert.match(prompt.prompt, /每段 2-5 句/);
  assert.match(prompt.prompt, /不要低于 100 字/);
  assert.match(prompt.prompt, /title: T/);
});

/* ------------------------------------------------------------------ */
/* draft input（标题 + 大纲 + 资料）                                    */
/* ------------------------------------------------------------------ */

const DRAFT_TYPE = { id: "t1", name: "T1", style: { audience: "读者" }, length: { min: 100, target: 150, max: 200 } };

function sampleDraftInput() {
  return buildDraftInput({
    type: DRAFT_TYPE,
    topic: { title: "文章标题", thesis: "备选判断" },
    outline: {
      title: "旧字段：标题单源在选题步，此处应被忽略",
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

test("validateDraftInput 的可选字段提示只在 advisory（人工录入）时报", () => {
  const raw = sampleDraftInput();
  delete raw.thesis;
  delete raw.requirements;
  const auto = validateDraftInput(raw, { schema: DRAFT_TEMPLATE.schema, type: DRAFT_TYPE });
  assert.equal(auto.warnings.some((w) => w.includes("requirements")), false);
  assert.equal(auto.warnings.some((w) => w.includes("thesis")), false);
  const manual = validateDraftInput(raw, { schema: DRAFT_TEMPLATE.schema, type: DRAFT_TYPE, advisory: true });
  assert.ok(manual.warnings.some((w) => w.includes("requirements")));
  assert.ok(manual.warnings.some((w) => w.includes("thesis")));
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

test("行内 schema：缺失/类型错为硬错误，长度与项数越界为警告", () => {
  const schema = {
    title: ["string", 1, 5],
    tags: ["array", 1, 2],
    "tags[]": ["string", 1],
    note: "string",
    flag: "boolean",
  };
  assert.deepEqual(validateTemplateSchema({ title: "abc", tags: ["a"], note: "", flag: true }, schema).errors, []);
  const bad = validateTemplateSchema({ title: "abcdef", tags: ["a", "b", "c"], flag: "yes" }, schema);
  // 字符串超长 / 数组超上限 → warnings
  assert.ok(bad.warnings.some((w) => w.includes("title")));
  assert.ok(bad.warnings.some((w) => w.includes("tags")));
  // 必填缺失 / 类型不符 → errors
  assert.ok(bad.errors.some((e) => e.includes("note")));
  assert.ok(bad.errors.some((e) => e.includes("flag")));
  // 数组项数不足 min → error（下游读不到内容）
  assert.ok(validateTemplateSchema({ title: "abc", tags: [], note: "", flag: true }, schema).errors.some((e) => e.includes("tags")));
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

test("schema 尾项备注不参与校验（desc 只做文档，不供提示词）", () => {
  const schema = {
    title: ["string", 1, 64, "最终标题"],
    alternatives: ["array", 2],
    "alternatives[]": ["string", 1, "备选标题"],
    outline: ["array", 3],
    "outline[].heading": ["string", 1, 24, "小节标题"],
    "outline[].target_words?": ["number", 100, 800],
    score: ["number", 0, 100],
    flag: "boolean",
  };
  // desc 落在 max 位置时不能被当作边界：不应产生「最多」类警告
  const r = validateTemplateSchema(
    { title: "短", alternatives: ["a", "b"], outline: [{ heading: "一" }, { heading: "二" }, { heading: "三" }], score: 50, flag: true },
    schema,
  );
  assert.ok(!r.warnings.some((w) => w.includes("最多")));
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
