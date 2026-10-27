// 发布与归档阶段测试：配图规划、HTML/邮件、zip、archiveArticle 幂等、发布状态判定
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { composePrompt, resolveImageCount, planImages } from "../../scripts/comm/wechat-illustrate.mjs";
import { bodyOnly, emailShell, markdownToHtml, derivePublishStatus, publishToWechat, wechatChildEnv, wechatCommandString, inlineLocalImages } from "../../scripts/comm/wechat-publish.mjs";
import { relocateLocalImages } from "../../scripts/lib/markdown.mjs";
import { publishArticle, stepEnabled } from "../../scripts/wechat-article.mjs";
import { loadSteps, getStep } from "../../scripts/lib/steps.mjs";
import { createRecorder } from "../../scripts/lib/io-record.mjs";
import { ARTIFACT, createArticle } from "../../scripts/lib/article-store.mjs";
import { archiveArticle } from "../../scripts/lib/archive.mjs";
import { listZipEntries, readZipEntry, zipDirectory } from "../../scripts/lib/zip.mjs";
import { tempDir } from "./helpers.mjs";

const STEPS = loadSteps("config/wechat-article/steps.yaml");
const QUIET_LOGGER = { info() {}, warn() {}, step() {}, error() {} };
const ARTICLE_MD = "---\ntitle: 归档测试稿\n---\n\n# 小节\n\n正文里有 42 个数字。\n";

// 内存 recorder：只收集调用留痕，不落盘
function collectingRecorder() {
  const records = [];
  return { records, record: (rec) => records.push(rec) };
}

// 产物可能位于 NN-step/ 子目录，写入前先补父目录。
function writeArtifact(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

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

test("composePrompt 只渲染配置里的模板，文字不在代码里留副本", () => {
  const template = "{{subject}}. Style: {{style}}. Composition: {{composition}}. Must not contain: {{negative}}.";
  const prompt = composePrompt(
    { prompt: "layered network", description: "架构图", scene: "article-inline" },
    { style: "扁平插画", negative_prompt: "text, logo" },
    "主题",
    template,
    { width: 1080, height: 810, composition: "4:3 framing" },
  );
  assert.equal(prompt, "layered network. Style: 扁平插画. Composition: 4:3 framing. Must not contain: text, logo.");
});

test("composePrompt 纲要 prompt 结尾的句号不会渲染成两个", () => {
  const template = "{{subject}}. Style: {{style}}.";
  assert.equal(
    composePrompt({ prompt: "clean lines, no text." }, { style: "扁平插画" }, "主题", template, {}),
    "clean lines, no text. Style: 扁平插画.",
  );
});

test("composePrompt 纲要没给英文 prompt 时退回中文画面说明与主题", () => {
  const template = "{{subject}}";
  assert.equal(composePrompt({ description: "一张架构图" }, {}, "主题", template, {}), "一张架构图");
  assert.equal(composePrompt({}, {}, "主题", template, {}), "主题");
  // 三层都空 = 上游缺必要输出物，抛错点名，不在代码里塞一个英文占位主体
  assert.throws(() => composePrompt({ index: 1 }, {}, "", template, {}), /没有主体描述/);
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
/* archive / zip                                                       */
/* ------------------------------------------------------------------ */

test("zipDirectory writes a readable archive with nested paths", () => {
  const src = tempDir("wa-zip-src-");
  fs.mkdirSync(path.join(src, "images"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.md"), "hello 世界", "utf8");
  fs.writeFileSync(path.join(src, "images", "01.png"), Buffer.from([1, 2, 3, 4]));

  const out = path.join(tempDir("wa-zip-out-"), "out.zip");
  const result = zipDirectory(src, out);
  assert.equal(result.entries, 2);
  assert.deepEqual(listZipEntries(out).sort(), ["a.md", "images/01.png"]);
  // readZipEntry 从归档里原样取回文件（已写清单靠它读 05-result.json）
  assert.equal(readZipEntry(out, "a.md").toString("utf8"), "hello 世界");
  assert.deepEqual([...readZipEntry(out, "images/01.png")], [1, 2, 3, 4]);
  assert.equal(readZipEntry(out, "missing.json"), null);
});

test("archiveArticle zips the article, copies the final copy to the knowledge dir, then removes draft/", () => {
  const root = tempDir("wa-archive-");
  const config = { __root: root, project: { base_output_folder: path.join(root, "articles") } };
  const type = { id: "ai-news", name: "AI 资讯", publish: { archive: { knowledge_dir: path.join(root, "kb") } } };
  const created = createArticle(config, { title: "归档测试", type });
  writeArtifact(created.dir, ARTIFACT.final, "---\ntitle: 旧标题\n---\n\n正文内容\n");

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
  writeArtifact(created.dir, ARTIFACT.final, "# 正文\n");

  const first = archiveArticle({ config, type, dir: created.dir, slug: created.slug, publish: { title: "重试归档", status: "published" } });

  // 模拟「zip 已打包但目录没删掉」后重跑
  writeArtifact(created.dir, ARTIFACT.final, "# 正文\n");
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

/* ------------------------------------------------------------------ */
/* publish stage：steps 节点 enabled 驱动 + 产物结构校验 + 相对路径      */
/* ------------------------------------------------------------------ */

function publishCtx({ dir, type, options = {}, steps = STEPS, recorder = createRecorder() }) {
  return {
    config: { steps },
    type,
    logger: QUIET_LOGGER,
    options,
    outputDir: dir,
    stamp: { date: "20261026", time: "101500", iso: "2026-10-26T10:15:00.000Z" },
    recorder,
    topic: { title: "归档测试稿" },
  };
}

test("终稿换基准：正文图片引用改成相对 05-step/，缺失与远程图原样留着", () => {
  const dir = tempDir("wa-relocate-");
  const imgDir = path.join(dir, "04-step", "images");
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, "01.png"), "x");
  const md = "![封面](04-step/images/01.png)\n![坏](04-step/images/missing.png)\n![远程](https://x/y.png)\n";
  const out = relocateLocalImages(md, dir, path.join(dir, "05-step"));
  assert.equal(out.markdown, "![封面](../04-step/images/01.png)\n![坏](04-step/images/missing.png)\n![远程](https://x/y.png)\n");
  assert.deepEqual(out.images, [{ alt: "封面", src: "../04-step/images/01.png", file: path.resolve(imgDir, "01.png") }]);
});

test("邮件内联：按 HTML 里出现的相对引用串换 cid（按绝对路径找的话永远不命中）", () => {
  const dir = tempDir("wa-inline-");
  const file = path.join(dir, "04-step", "images", "01.png");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from("png-bytes"));
  const { html, attachments } = inlineLocalImages('<p><img src="../04-step/images/01.png" alt="封面"></p>', [
    { src: "../04-step/images/01.png", file },
  ]);
  assert.match(html, /src="cid:article-image-1"/);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].content_id, "article-image-1");
  assert.equal(attachments[0].content_type, "image/png");
  const missing = inlineLocalImages('<img src="../04-step/images/02.png">', [{ src: "../04-step/images/02.png", file: path.join(dir, "nope.png") }]);
  assert.deepEqual(missing.attachments, []);
  assert.match(missing.html, /02\.png/);
});

test("dry-run 落盘的终稿与邮件 HTML 用同一套相对 05-step/ 的图片引用", async () => {
  const dir = tempDir("wa-publish-img-");
  const imgDir = path.join(dir, "04-step", "images");
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, "01_modelscope.png"), "x");
  const md = "---\ntitle: 带图稿\n---\n正文一段\n\n![封面](04-step/images/01_modelscope.png)\n";
  const type = {
    id: "t",
    name: "T",
    publish: { email: { to: ["someone@example.com"] } },
    // 投递开关单源在 steps 节点 handler_options，type 层 steps.<step>.handler_options 覆盖。
    steps: { publish: { handler_options: { auto_publish: false, email: true, wechat: false } } },
  };
  const result = await publishArticle(publishCtx({ dir, type, options: { "dry-run": true } }), md);
  assert.equal(result.status, "dry_run");
  assert.match(fs.readFileSync(path.join(dir, ARTIFACT.final), "utf8"), /\]\(\.\.\/04-step\/images\/01_modelscope\.png\)/);
  assert.match(fs.readFileSync(path.join(dir, ARTIFACT.finalHtml), "utf8"), /src="\.\.\/04-step\/images\/01_modelscope\.png"/);
});

/* ------------------------------------------------------------------ */
/* 投递台账（外部副作用不接受"重跑覆盖"）                                */
/* ------------------------------------------------------------------ */

/** 假投递命令：被调用一次就往计数文件写一行，退出码 0（等价于草稿箱投递成功）。 */
function deliveryStub(dir) {
  const stub = path.join(dir, "fake-publish-cli.mjs");
  fs.writeFileSync(
    stub,
    [
      "import fs from \"node:fs\";",
      "fs.appendFileSync(process.env.PB_TEST_DELIVERY_COUNTER, \"call\\n\");",
      "console.log(\"draft created\");",
      "",
    ].join("\n"),
    "utf8",
  );
  return stub;
}

function wechatType(stub) {
  return {
    id: "t",
    name: "T",
    publish: { wechat: { command: `node ${stub}` } },
    steps: { publish: { handler_options: { auto_publish: true, email: false, wechat: true } } },
  };
}

test("投递台账：同一份终稿重跑不再调投递命令，改了稿子才重投", async () => {
  const dir = tempDir("wa-ledger-");
  const counter = path.join(dir, "calls.txt");
  const stub = deliveryStub(dir);
  process.env.PB_TEST_DELIVERY_COUNTER = counter;
  const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    const first = await publishArticle(publishCtx({ dir, type: wechatType(stub) }), ARTICLE_MD);
    assert.equal(first.status, "published");
    assert.equal(calls(), 1);
    const ledgerFile = path.join(dir, ARTIFACT.delivered);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.wechat.status, "delivered");
    assert.match(ledger.wechat.digest, /^[0-9a-f]{16}$/);

    const second = await publishArticle(publishCtx({ dir, type: wechatType(stub) }), ARTICLE_MD);
    assert.equal(second.wechat.skipped, "already_delivered");
    assert.equal(second.wechat.success, true);
    assert.equal(second.status, "published", "已投成功仍算发布完成，归档照常");
    assert.equal(calls(), 1, "台账记过 delivered 的渠道不能重投");

    const third = await publishArticle(publishCtx({ dir, type: wechatType(stub) }), `${ARTICLE_MD}\n\n又补了一段。\n`);
    assert.equal(third.wechat.skipped, undefined);
    assert.equal(calls(), 2, "终稿改了（摘要变了）就该重投");
    assert.notEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).wechat.digest, ledger.wechat.digest);
  } finally {
    delete process.env.PB_TEST_DELIVERY_COUNTER;
  }
});

test("台账停在 attempting = 状态未知：不自动重投，且不算发布成功", async () => {
  const dir = tempDir("wa-ledger-unknown-");
  const counter = path.join(dir, "calls.txt");
  const stub = deliveryStub(dir);
  process.env.PB_TEST_DELIVERY_COUNTER = counter;
  const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    await publishArticle(publishCtx({ dir, type: wechatType(stub) }), ARTICLE_MD);
    assert.equal(calls(), 1);

    // 模拟"发起后进程被杀，没拿到结果"：状态退回 attempting，摘要仍是这份终稿的。
    const ledgerFile = path.join(dir, ARTIFACT.delivered);
    const torn = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    torn.wechat.status = "attempting";
    fs.writeFileSync(ledgerFile, JSON.stringify(torn, null, 2), "utf8");

    const result = await publishArticle(publishCtx({ dir, type: wechatType(stub) }), ARTICLE_MD);
    assert.equal(result.wechat.skipped, "delivery_state_unknown");
    assert.equal(result.wechat.success, false);
    assert.equal(result.status, "failed", "状态未知不能当成已发布（否则归档会把没投出去的稿子清掉）");
    assert.equal(calls(), 1, "宁可不投，也不赌上次没落账的那次没成功");
  } finally {
    delete process.env.PB_TEST_DELIVERY_COUNTER;
  }
});

test("邮件渠道同一条台账：摘要已记 delivered 就跳过，不发 SMTP 但仍落 html", async () => {
  const dir = tempDir("wa-ledger-email-");
  const counter = path.join(dir, "calls.txt");
  const stub = deliveryStub(dir);
  process.env.PB_TEST_DELIVERY_COUNTER = counter;
  const ledgerFile = path.join(dir, ARTIFACT.delivered);
  try {
    // 先让公众号渠道真投一次，从台账里拿这份终稿的真实摘要——
    // 摘要口径是「挪完图片引用之后的终稿」，手写算不出来，只能问台账。
    await publishArticle(publishCtx({ dir, type: wechatType(stub) }), ARTICLE_MD);
    const { digest } = JSON.parse(fs.readFileSync(ledgerFile, "utf8")).wechat;

    // 把同一摘要挂到 email 名下，模拟「这封邮件上次已经发成功」
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({ email: { status: "delivered", digest, at: "2026-10-27T00:00:00.000Z" } }, null, 2),
      "utf8",
    );

    const type = {
      id: "t",
      name: "T",
      publish: { email: { to: ["a@b.c"] } },
      steps: { publish: { handler_options: { auto_publish: true, email: true, wechat: false } } },
    };
    const result = await publishArticle(publishCtx({ dir, type }), ARTICLE_MD);
    assert.equal(result.email.skipped, "already_delivered");
    assert.equal(result.status, "published");
    assert.equal(fs.existsSync(path.join(dir, ARTIFACT.finalHtml)), true, "跳过发送也要落邮件 HTML");
    assert.equal(fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length, 1, "email 渠道跳过不该再动投递命令");
  } finally {
    delete process.env.PB_TEST_DELIVERY_COUNTER;
  }
});

test("stepEnabled 默认放行，type 层 enabled=false 才关", () => {
  assert.equal(stepEnabled("archive", { steps: STEPS }, { id: "t" }), true);
  assert.equal(stepEnabled("archive", { steps: STEPS }, { id: "t", steps: { archive: { enabled: false } } }), false);
  // 配置没加载（steps 缺失）时不假装环节被关掉
  assert.equal(stepEnabled("archive", undefined, { id: "t" }), true);
});

test("publish 节点 enabled=false：整环节不执行，05 产物一个都不落", async () => {
  const dir = tempDir("wa-publish-off-");
  const type = {
    id: "t",
    name: "T",
    steps: { publish: { enabled: false } },
  };
  const result = await publishArticle(publishCtx({ dir, type }), ARTICLE_MD);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "steps.publish.enabled=false");
  assert.equal(fs.existsSync(path.join(dir, ARTIFACT.final)), false);
  assert.equal(fs.existsSync(path.join(dir, ARTIFACT.publish)), false);
});

test("投递开关单源在 publish 节点的 handler_options，auto 默认一路发布到底", () => {
  const opts = getStep(STEPS, "publish").handler_options;
  assert.deepEqual(opts, { auto_publish: true, email: true, wechat: true });
});

test("命令行 --wechat 覆盖节点里的渠道开关（节点开关不是最终门槛）", async () => {
  const dir = tempDir("wa-publish-cli-switch-");
  const counter = path.join(dir, "calls.txt");
  const stub = deliveryStub(dir);
  process.env.PB_TEST_DELIVERY_COUNTER = counter;
  try {
    const type = {
      id: "t",
      name: "T",
      publish: { wechat: { command: `node ${stub}` } },
      steps: { publish: { handler_options: { auto_publish: true, email: false, wechat: false } } },
    };
    const result = await publishArticle(publishCtx({ dir, type, options: { wechat: true } }), ARTICLE_MD);
    assert.equal(result.status, "published");
    assert.equal(result.channels.wechat, true);
    assert.equal(fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    delete process.env.PB_TEST_DELIVERY_COUNTER;
  }
});

test("--mock 不发真实请求：投递按演练处理，不调外部投递命令", async () => {
  const dir = tempDir("wa-publish-mock-");
  const counter = path.join(dir, "calls.txt");
  const stub = deliveryStub(dir);
  process.env.PB_TEST_DELIVERY_COUNTER = counter;
  try {
    const ctx = { ...publishCtx({ dir, type: wechatType(stub) }), mock: true };
    const result = await publishArticle(ctx, ARTICLE_MD);
    assert.equal(result.status, "dry_run");
    assert.equal(fs.existsSync(counter), false, "mock 运行不能真的调投递命令");
  } finally {
    delete process.env.PB_TEST_DELIVERY_COUNTER;
  }
});

test("投递开关三个键必填：缺了抛错点名配置路径，不静默当成 false", async () => {
  const dir = tempDir("wa-publish-noswitch-");
  const bare = { ...STEPS.byName.get("publish"), handler_options: {} };
  const byName = new Map(STEPS.byName);
  byName.set("publish", bare);
  const steps = {
    ...STEPS,
    steps: STEPS.steps.map((step) => (step.step_name === "publish" ? bare : step)),
    byName,
  };
  await assert.rejects(
    () => publishArticle(publishCtx({ dir, type: { id: "t", name: "T" }, steps }), ARTICLE_MD),
    /publish\.handler_options\.auto_publish/,
  );
});

test("dry-run 发布：05-result.json 用相对路径、按 schema 校验通过、CLI 密钥打码", async () => {
  const dir = tempDir("wa-publish-dryrun-");
  const type = {
    id: "t",
    name: "T",
    publish: {
      email: { to: ["someone@example.com"] },
      wechat: { api_key: "sekret-wechat-key", command: "npx --yes @wenyan-md/cli" },
    },
    steps: { publish: { handler_options: { auto_publish: false, email: true, wechat: true } } },
  };
  const result = await publishArticle(publishCtx({ dir, type, options: { "dry-run": true } }), ARTICLE_MD);

  assert.equal(result.status, "dry_run");
  assert.equal(result.files.final, "05-step/final.md");
  assert.equal(result.files.html, "05-step/final.html");
  assert.ok(!path.isAbsolute(result.files.final));
  assert.ok(!result.wechat.command.includes("sekret-wechat-key"), result.wechat.command);
  assert.match(result.wechat.command, /--api-key \*\*\*/);

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT.publish), "utf8"));
  assert.deepEqual(persisted.validation, { checked: true, ok: true, errors: [], warnings: [] });
});

test("05 产物形状偏离 schema 时按真实数据判定，不合格项如实记进 validation", async () => {
  const dir = tempDir("wa-publish-schema-");
  const type = { id: "t", name: "T", steps: { publish: { handler_options: { email: false, wechat: false } } } };
  const result = await publishArticle(publishCtx({ dir, type }), ARTICLE_MD);
  assert.equal(result.status, "skipped");
  assert.equal(result.validation.checked, true);
  assert.equal(result.validation.ok, true, result.validation.errors.join("；"));

  const { validateTemplateSchema } = await import("../../scripts/lib/template.mjs");
  const publishFormat = getStep(STEPS, "publish").result_output_format;
  // 信封（stage/generated_at/title/type/files）齐全，只把 status 与 channels.wechat 写成不合格的值，
  // 确认校验器按真实字段名报错。
  const broken = {
    stage: "publish",
    generated_at: "2026-10-26T00:00:00.000Z",
    title: "T",
    type: "t",
    status: null,
    files: { final: "05-step/final.md" },
    channels: { email: true, wechat: "yes" },
  };
  const check = validateTemplateSchema(broken, publishFormat);
  assert.ok(check.errors.includes("status 缺失"), check.errors.join("；"));
  assert.ok(check.errors.includes("channels.wechat 应为布尔值"), check.errors.join("；"));
});

test("公众号 CLI 调用留痕：provider、退出码与耗时入镜，输出里的密钥被替换", async () => {
  const workDir = tempDir("wa-wechat-");
  const cli = path.join(workDir, "fake-wenyan.mjs");
  // 假 CLI 从环境变量取密钥并回显（真实 CLI 失败时也会把命令行整条打进日志），
  // 以此验证留痕落盘前做过密钥替换。
  fs.writeFileSync(cli, 'import process from "node:process";\nconsole.log("uploading with key " + process.env.PB_FAKE_SECRET);\nprocess.exit(3);\n', "utf8");
  const recorder = collectingRecorder();
  process.env.PB_FAKE_SECRET = "sekret-wechat-key";
  let result;
  try {
    result = await publishToWechat({
      markdownFile: path.join(workDir, "final.md"),
      // command / env_file 单源 defaults.yaml defaults.publish.wechat（代码里那份同值副本已删）。
      // 指向不存在的文件：--env-file 只在文件存在时才加，留痕的命令形状因此与是否装了 .env 无关。
      config: { command: `node ${cli}`, env_file: path.join(workDir, "absent.env"), api_key: "sekret-wechat-key" },
      logger: QUIET_LOGGER,
      recorder,
      slot: "02",
    });
  } finally {
    delete process.env.PB_FAKE_SECRET;
  }
  assert.equal(result.success, false);
  assert.equal(result.code, 3);
  assert.equal(recorder.records.length, 1);
  const rec = recorder.records[0];
  assert.equal(rec.provider, "wenyan-md");
  assert.equal(rec.label, "publish");
  assert.equal(rec.slot, "02");
  assert.equal(rec.error, "exit 3");
  assert.equal(typeof rec.duration_ms, "number");
  assert.match(rec.request.command, /--api-key \*\*\*/);
  assert.ok(!JSON.stringify(rec).includes("sekret-wechat-key"), "留痕里不能有密钥");
  assert.match(rec.response, /uploading with key \*\*\*/);
});

test("凭据别名：管线只配 WECHAT_MP_*，CLI 读的是 WECHAT_APP_*（实测缺映射会报「未提供 AppID」）", async () => {
  assert.equal(wechatChildEnv({ WECHAT_MP_APP_ID: "mp-id", WECHAT_MP_APP_SECRET: "mp-secret" }).WECHAT_APP_ID, "mp-id");
  assert.equal(wechatChildEnv({ WECHAT_APP_ID: "own", WECHAT_MP_APP_ID: "mp-id" }).WECHAT_APP_ID, "own");
  const workDir = tempDir("wa-cred-");
  const cli = path.join(workDir, "fake-cred.mjs");
  fs.writeFileSync(cli, 'import process from "node:process";\nconsole.log("id=" + (process.env.WECHAT_APP_ID || "none"));\n', "utf8");
  const own = process.env.WECHAT_APP_ID;
  delete process.env.WECHAT_APP_ID;
  process.env.WECHAT_MP_APP_ID = "wx-mapped-id";
  let result;
  try {
    result = await publishToWechat({ markdownFile: path.join(workDir, "final.md"), config: { command: `node ${cli}`, env_file: path.join(workDir, "absent.env") }, logger: QUIET_LOGGER });
  } finally {
    delete process.env.WECHAT_MP_APP_ID;
    if (own !== undefined) process.env.WECHAT_APP_ID = own;
  }
  assert.equal(result.success, true, result.output);
  assert.match(result.output, /id=wx-mapped-id/);
});

test("Windows 下命令串自己加引号：含空格的路径不会被 cmd 拆开", () => {
  assert.equal(wechatCommandString(["npx", "--yes", "a.mjs"]), "npx --yes a.mjs");
  assert.equal(wechatCommandString(["node", "D:\\my dir\\fake cli.mjs", "-f", "D:\\a b\\final.md"]), 'node "D:\\my dir\\fake cli.mjs" -f "D:\\a b\\final.md"');
});

test("archiveArticle 校验归档块：knowledge_dir 留空记 skipped，打包与清理照做", () => {
  const root = tempDir("wa-archive-validate-");
  const config = { __root: root, steps: STEPS, project: { base_output_folder: path.join(root, "articles") } };
  const type = { id: "ai-news", name: "AI 资讯", publish: { archive: { knowledge_dir: "" } } };
  const created = createArticle(config, { title: "校验归档", type });
  writeArtifact(created.dir, ARTIFACT.final, "# 正文\n");

  const result = archiveArticle({ config, type, dir: created.dir, slug: created.slug, publish: { title: "校验归档", status: "published" } });

  assert.deepEqual(result.archive.knowledge, { ok: true, skipped: true });
  assert.equal(result.archive.validation.checked, true);
  assert.equal(result.archive.validation.ok, true, result.archive.validation.errors.join("；"));
  assert.equal(fs.existsSync(path.resolve(root, result.archive.zip)), true);
  assert.equal(fs.existsSync(created.dir), false);
});
