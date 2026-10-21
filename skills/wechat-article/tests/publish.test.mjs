// 发布与归档阶段测试：配图规划、HTML/邮件、zip、archiveArticle 幂等、发布状态判定
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { composePrompt, resolveImageCount, planImages } from "../scripts/lib/illustrate.mjs";
import { bodyOnly, emailShell, markdownToHtml, derivePublishStatus } from "../scripts/lib/publish.mjs";
import { ARTIFACT, createArticle } from "../scripts/lib/article-store.mjs";
import { archiveArticle } from "../scripts/lib/archive.mjs";
import { listZipEntries, readZipEntry, zipDirectory } from "../scripts/lib/zip.mjs";
import { tempDir } from "./helpers.mjs";

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
  // readZipEntry 从归档里原样取回文件（已写清单靠它读 08-publish.json）
  assert.equal(readZipEntry(out, "a.md").toString("utf8"), "hello 世界");
  assert.deepEqual([...readZipEntry(out, "images/01.png")], [1, 2, 3, 4]);
  assert.equal(readZipEntry(out, "missing.json"), null);
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
