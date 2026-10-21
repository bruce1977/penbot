// 初稿阶段测试：draft-input 组装与校验、模板渲染、初稿/长度提示词
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildLengthPrompt, buildDraftPrompt } from "../scripts/lib/prompts.mjs";
import { lengthAction } from "../scripts/lib/markdown.mjs";
import { validateTemplateSchema, renderTemplate } from "../scripts/lib/template.mjs";
import {
  buildDraftInput,
  normalizeDraftInput,
  validateDraftInput,
  loadDraftTemplate,
  buildDraftVars,
  summarizeDraftInput,
} from "../scripts/lib/draft-input.mjs";

const CONFIG_DIR = path.join(import.meta.dirname, "..", "config");
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
