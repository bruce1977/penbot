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
  verbatimOverlap,
  missingNumbers,
} from "../../scripts/lib/markdown.mjs";

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

test("countWords 剥离配图标记（含旧格式载荷），说明不计入字数", () => {
  assert.equal(countWords("正文一段。[[img:1]]正文二段。"), 8);
  assert.equal(countWords("正文一段。[[img:1|很长的中文画面说明|a long english prompt]]正文二段。"), 8);
  assert.equal(countWords("正文一段。[图2：旧格式说明]正文二段。"), 8);
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
  const md = "[[img:1]]\n\n[[img:2]]";
  const plans = [
    { index: 1, description: "图一" },
    { index: 2, description: "图二" },
  ];
  const replaced = replaceImageMarkers(md, new Map([[1, "images/01.png"]]), { onFailure: "comment", plans });
  assert.match(replaced, /!\[图一\]\(images\/01\.png\)/);
  assert.match(replaced, /<!-- 配图生成失败：图二 -->/);
  assert.equal(replaceImageMarkers(md, new Map(), { onFailure: "drop", plans }).trim(), "");
});

test("replaceImageMarkers 无配图计划时回退旧标记载荷里的说明", () => {
  const replaced = replaceImageMarkers("[[img:1|图一|c]]", new Map([[1, "images/01.png"]]));
  assert.match(replaced, /!\[图一\]\(images\/01\.png\)/);
});

test("ensureImageMarkers pads to the requested count", () => {
  const md = buildFrontmatter({ title: "t" }) + "第一段。\n\n第二段。\n\n[[img:1]]\n";
  const out = ensureImageMarkers(md, 3);
  assert.equal(parseImageMarkers(out).length, 3);
});

test("image_position_format drives marker generation, parsing and replacement", () => {
  const format = "<<img:{index}>>";
  assert.equal(formatImageMarker(format, 3), "<<img:3>>");
  assert.equal(formatImageMarker("[[img:{index}]]", 2), "[[img:2]]");

  const markers = parseImageMarkers("A\n\n<<img:2|图二|a diagram>>\n\nB", { format });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].index, 2);
  assert.equal(markers[0].description, "图二");
  assert.equal(markers[0].prompt, "a diagram");

  const replaced = replaceImageMarkers("<<img:1>>", new Map([[1, "images/01.png"]]), {
    format,
    plans: [{ index: 1, description: "封面" }],
  });
  assert.equal(replaced, "![封面](images/01.png)");

  const ensured = ensureImageMarkers("## A\n\n正文段落。\n\n## B\n\n正文段落。", 1, { format });
  assert.match(ensured, /<<img:1>>/);
  assert.equal(parseImageMarkers(ensured, { format }).length, 1);
});

test("normalizeImageMarkers renumbers custom-format markers and strips payloads", () => {
  const format = "<!-- img:{index} -->";
  const md = "<!-- img:5|甲 -->\n\n<!-- img:5|重复 -->\n\n<!-- img:9|乙 -->";
  const out = normalizeImageMarkers(md, 2, { format });
  const markers = parseImageMarkers(out, { format });
  assert.deepEqual(markers.map((m) => m.index), [1, 2]);
  assert.ok(!out.includes("甲"));
  assert.ok(!out.includes("乙"));
});

test("ensureImageMarkers 补齐缺失的裸标记，序号连续", () => {
  const md = `${buildFrontmatter({ title: "T" }).trimEnd()}\n\n第一段。\n\n第二段。\n\n第三段。`;
  const out = ensureImageMarkers(md, 2);
  const markers = parseImageMarkers(out);
  assert.deepEqual(markers.map((m) => m.index), [1, 2]);
  assert.match(out, /\[\[img:1\]\]/);
  assert.match(out, /\[\[img:2\]\]/);
  assert.ok(!out.includes("封面画面"));
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
  assert.equal(markers[0].description, "配图 1");
  assert.equal(markers[1].description, "配图 2");
  assert.ok(!out.includes("重复使用或移除"));
  assert.ok(!out.includes("封面|"));
});

test("normalizeImageMarkers caps at the planned count and pads when short", () => {
  const extra = buildFrontmatter({ title: "t" }) + "A\n\n[[img:1|一|]]\n\nB\n\n[[img:2|二|]]\n\nC\n\n[[img:3|三|]]\n";
  assert.equal(parseImageMarkers(normalizeImageMarkers(extra, 2)).length, 2);

  const short = buildFrontmatter({ title: "t" }) + "A\n\n[[img:1|一|]]\n\nB\n\nC\n";
  assert.equal(parseImageMarkers(normalizeImageMarkers(short, 3)).length, 3);
});

/* ------------------------------------------------------------------ */
/* de_ai 本地质量判据（零 token）                                       */
/* ------------------------------------------------------------------ */

test("verbatimOverlap 抓住整篇复读，放行实质改写", () => {
  const src = "过去一年里这个产品的下载量涨到了千万级别，团队在两周之内连续做出三次大版本更新，很多人开始重新讨论它到底能走多远";
  const rewritten = "三个月前它还无人问津，如今每家公司的群聊都在转发同一份榜单，连做投资的人都开始问起团队规模";
  assert.equal(verbatimOverlap(src, src), 1);
  assert.equal(verbatimOverlap(src, rewritten), 0);
  // 整篇誊抄时脚本会回填 frontmatter/标题/配图标记，标记与空白不进比对 key
  assert.ok(verbatimOverlap(src, `# 标题\n\n${src}\n\n[[img:1]]`) > 0.5);
  // 抄掉三分之二仍在闸门以上；只借一两句不算复读
  assert.ok(verbatimOverlap(src, src.slice(0, 66) + rewritten.slice(0, 20)) > 0.5);
  assert.ok(verbatimOverlap(src, src.slice(0, 24) + rewritten) < 0.5);
});

test("verbatimOverlap 忽略 Markdown 装饰，短稿不误判", () => {
  assert.equal(
    verbatimOverlap("这是**一段**很长的中文正文需要超过二十个字才算合格", "这是 一段 很长的中文正文 需要超过二十个字才算合格"),
    1
  );
  assert.equal(verbatimOverlap("这是一段超过二十个字的中文正文用来验证窗口边界", "太短了"), 0);
});

test("missingNumbers 返回原稿有、改写稿丢掉的数字（去重）", () => {
  assert.deepEqual(missingNumbers("2023 年下载量 1000 万，增长 12.5%，共 7 次", "2023 年下载量增长 12.5%，共七次"), ["1000", "7"]);
  assert.deepEqual(missingNumbers("2023 年又一年，2023 年", "年份"), ["2023"]);
  assert.deepEqual(missingNumbers("没有数字的一段话", "改写后的一段话"), []);
});
