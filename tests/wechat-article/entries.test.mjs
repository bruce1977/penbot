// 三种启动入口的参数契约：
//   1 auto  —— 无需参数（自动选题）
//   2 manual —— 标题必填，提纲可选（不给则模型生成）
//   3 post  —— --file 草稿必填，导入后从 review 接着跑
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertEntryInputs, importDraftArticle, hasOutlineInput } from "../../scripts/wechat-article.mjs";
import { ARTIFACT, detectStartStage } from "../../scripts/lib/article-store.mjs";

function tempDir(prefix = "wa-entries-") {
  return fs.mkdtempSync(path.join(process.cwd(), ".temp", prefix));
}

function storeConfig(root) {
  return { __root: root, project: { base_output_folder: path.join(root, "articles") } };
}

/* ---------- manual：标题必填、提纲可选 ---------- */

test("manual：有提纲时标题可来自 --title/--topic 或提纲本身", () => {
  assert.equal(assertEntryInputs({ title: "我的标题", outline: "## A" }, "manual"), "我的标题");
  assert.equal(assertEntryInputs({ topic: "主题即标题", outline: "## A" }, "manual"), "主题即标题");
  assert.equal(assertEntryInputs({ outline: "# 提纲里的标题\n## A" }, "manual"), "提纲里的标题");
});

test("manual：提纲可选——不给提纲只要求标题", () => {
  assert.equal(assertEntryInputs({ title: "只要标题" }, "manual"), "只要标题");
  assert.throws(() => assertEntryInputs({}, "manual"), /manual 入口需要标题/);
  assert.equal(hasOutlineInput({}), false);
  assert.equal(hasOutlineInput({ outline: "## A" }), true);
  assert.equal(hasOutlineInput({ "outline-file": "o.md" }), true);
  // 裸 flag（--outline 不带值）不算给了提纲，且要明确报错
  assert.equal(hasOutlineInput({ outline: true }), false);
  assert.throws(() => assertEntryInputs({ outline: true }, "manual"), /--outline 需要提纲文本/);
  assert.throws(() => assertEntryInputs({ "outline-file": true }, "manual"), /--outline-file 需要一个文件路径参数/);
});

test("manual：--outline-file 不存在要报错", () => {
  assert.throws(() => assertEntryInputs({ title: "t", "outline-file": "no/such/file.md" }, "manual"), /--outline-file 不存在/);
});

/* ---------- post：--file 草稿必填，导入即续跑 ---------- */

test("post：缺 --file / 与提纲或 --article 混用要报错", () => {
  assert.throws(() => assertEntryInputs({}, "post"), /post 入口需要草稿/);
  assert.throws(() => assertEntryInputs({ file: "a.md", outline: "## A" }, "post"), /post 入口不做选题与纲要/);
  assert.throws(() => assertEntryInputs({ file: "a.md", article: "slug" }, "post"), /post 入口总是新建文章目录/);
});

test("post：标题来自 frontmatter / 一级标题 / --title，缺失报错", () => {
  const root = tempDir();
  const withFm = path.join(root, "with-fm.md");
  fs.writeFileSync(withFm, "---\ntitle: 信封里的标题\n---\n\n正文。", "utf8");
  assert.equal(assertEntryInputs({ file: withFm }, "post"), "信封里的标题");

  const withH1 = path.join(root, "with-h1.md");
  fs.writeFileSync(withH1, "# 一级标题\n\n正文。", "utf8");
  assert.equal(assertEntryInputs({ file: withH1 }, "post"), "一级标题");

  assert.equal(assertEntryInputs({ file: withH1, title: "覆盖标题" }, "post"), "覆盖标题");

  const noTitle = path.join(root, "no-title.md");
  fs.writeFileSync(noTitle, "只有正文，没有标题。", "utf8");
  assert.throws(() => assertEntryInputs({ file: noTitle }, "post"), /无法从草稿里取标题/);
  assert.throws(() => assertEntryInputs({ file: path.join(root, "missing.md") }, "post"), /--file 不存在/);
});

test("post：导入落 01/02 产物，detectStartStage 从 review 接跑", () => {
  const root = tempDir();
  const draft = path.join(root, "draft.md");
  fs.writeFileSync(draft, "---\ntitle: 导入的草稿\n---\n\n## 第一节\n\n正文一。\n\n## 第二节\n\n正文二。", "utf8");
  const config = storeConfig(root);
  const article = importDraftArticle(config, { file: draft, slug: "imported" }, { title: "导入的草稿", type: { id: "ai-news" } });

  assert.equal(article.existing, true);
  assert.equal(detectStartStage(article.dir), "review");

  const topic = JSON.parse(fs.readFileSync(path.join(article.dir, ARTIFACT.topic), "utf8"));
  assert.equal(topic.stage, "topic");
  assert.equal(topic.title, "导入的草稿");
  assert.equal(topic.type, "ai-news");
  assert.deepEqual(topic.sources, []);
  assert.equal(topic.angle, "导入已有草稿");
  assert.equal(topic.files.topicMd, null);

  const draftResult = JSON.parse(fs.readFileSync(path.join(article.dir, ARTIFACT.draft), "utf8"));
  assert.equal(draftResult.stage, "draft");
  assert.equal(draftResult.files.draft, "02-step/draft.md");
  assert.equal(draftResult.files.outline, null);
  assert.equal(draftResult.files.draftInput, null);
  assert.equal(draftResult.images_planned, 0);
  assert.equal(draftResult.sections, 2);

  const imported = fs.readFileSync(path.join(article.dir, "02-step", "draft.md"), "utf8");
  assert.match(imported, /^---\n/);
  assert.match(imported, /## 第一节/);

  // 导入是复制语义：原草稿文件保持原样
  assert.match(fs.readFileSync(draft, "utf8"), /^---\ntitle: 导入的草稿/);
});
