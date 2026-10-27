// 纲要阶段测试：parseOutlineMarkdown（渲染格式 / 用户手写提纲 / 选题文档）、小节标题规整
// 与纲要提示词的条件文案
import test from "node:test";
import assert from "node:assert/strict";

import { parseOutlineMarkdown, ensureSectionHeadings, buildFrontmatter } from "../../scripts/lib/markdown.mjs";
import { buildOutlinePrompt } from "../../scripts/lib/prompts.mjs";
import { loadSteps } from "../../scripts/lib/steps.mjs";

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

/* ------------------------------------------------------------------ */
/* 纲要提示词的条件文案（prompts/outline.yaml → outline.outline）        */
/* ------------------------------------------------------------------ */

const OUTLINE_PROMPT = loadSteps("config/wechat-article/steps.yaml").prompts["outline.outline"];

function outlineCase(type, sources = []) {
  return buildOutlinePrompt({
    prompt: OUTLINE_PROMPT,
    promptId: "outline.outline",
    type: { id: "t", name: "栏目", length: { min: 800, max: 1300, target: 1000 }, illustrations: { min: 1, max: 3 }, ...type },
    topic: { topic: "主题", thesis: "判断", angle: "角度" },
    sources,
  });
}

test("buildOutlinePrompt 的素材与配图整句从注册表取，缺 key 抛错", () => {
  assert.match(outlineCase({}).prompt, /全文配图 1-3 张，按小节内容自行决定张数/);
  assert.match(outlineCase({ illustrations: { min: 1, max: 3, count: 2 } }).prompt, /全文配图 1-3 张，建议 2 张/);
  assert.match(outlineCase({}).prompt, /（无可用素材，请基于常识谨慎写作/);
  // 用户补充要求那句也在注册表里；没带补充要求时整行留空
  const withRequirements = buildOutlinePrompt({
    prompt: OUTLINE_PROMPT,
    promptId: "outline.outline",
    type: { id: "t", name: "栏目", length: { min: 800, max: 1300, target: 1000 }, illustrations: { min: 1, max: 3 } },
    topic: { topic: "主题" },
    sources: [],
    userRequirements: "别写融资",
  });
  assert.match(withRequirements.prompt, /用户补充要求：别写融资/);
  assert.doesNotMatch(outlineCase({}).prompt, /用户补充要求/);
  assert.throws(
    () => buildOutlinePrompt({
      prompt: { ...OUTLINE_PROMPT, requirements_block: "" },
      promptId: "outline.outline",
      type: { id: "t", name: "栏目", length: { min: 1, max: 2 }, illustrations: { min: 1, max: 3 } },
      topic: { topic: "主题" },
      sources: [],
      userRequirements: "别写融资",
    }),
    /缺少提示词文案 outline\.outline\.requirements_block/,
  );
  // 张数区间也单源类型配置：缺了抛错点名配置路径，不垫「建议 3 张」
  assert.throws(
    () => outlineCase({ illustrations: { max: 3 } }, [{ index: 1, title: "素材", excerpts: ["段落"] }]),
    /缺少配置项 类型 t 的 illustrations\.min/,
  );
  for (const key of ["no_materials", "image_plan_range", "image_plan_default"]) {
    const broken = { ...OUTLINE_PROMPT, [key]: "" };
    assert.throws(
      () => buildOutlinePrompt({
        prompt: broken,
        promptId: "outline.outline",
        type: { id: "t", name: "栏目", length: { min: 1, max: 2 }, illustrations: { min: 1, max: 3, count: key === "image_plan_default" ? 2 : undefined } },
        topic: { topic: "主题" },
        sources: [],
      }),
      new RegExp(`缺少提示词文案 outline\.outline\.${key}`),
    );
  }
});
