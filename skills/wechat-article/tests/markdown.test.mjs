// 共享 Markdown 工具测试：frontmatter / 字数 / 配图标记（各阶段都会用到）
import test from "node:test";
import assert from "node:assert/strict";

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
  normalizeImageMarkers,
  formatImageMarker,
} from "../scripts/lib/markdown.mjs";

/* ------------------------------------------------------------------ */
/* frontmatter / 正文基础                                              */
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

/* ------------------------------------------------------------------ */
/* image markers                                                       */
/* ------------------------------------------------------------------ */

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
