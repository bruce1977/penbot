import fs from "node:fs";
import path from "node:path";
import { ARTIFACT, ensureLayout } from "./article-store.mjs";
import { ensureDir, exists, relativeTo, timestamp, writeJson, writeText } from "./fsx.mjs";
import { buildFrontmatter, splitFrontmatter } from "./markdown.mjs";
import { zipDirectory } from "./zip.mjs";

function renderName(template, vars) {
  return String(template || "{date}-{slug}.md").replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function copyToKnowledge({ config, type, dir, slug, title, stamp, archive, logger }) {
  const settings = type.publish?.archive || {};
  if (!settings.knowledge_dir || settings.enabled === false) {
    return { ok: true, skipped: true };
  }
  try {
    const root = config.__root || process.cwd();
    const targetDir = ensureDir(path.resolve(root, settings.knowledge_dir));
    const name = renderName(settings.filename, { date: stamp.date, slug, title, type: type.id });
    const target = path.join(targetDir, name);
    const source = path.join(dir, ARTIFACT.final);
    if (!exists(source)) throw new Error(`缺少终稿 ${ARTIFACT.final}`);

    // 交给知识库管线的是带 frontmatter 的 Markdown。
    const { data, body } = splitFrontmatter(fs.readFileSync(source, "utf8"));
    const frontmatter = buildFrontmatter({
      ...data,
      title: title || data.title || slug,
      type: type.id,
      published_at: new Date().toISOString(),
    });
    writeText(target, `${frontmatter}${body}\n`);
    archive.knowledge = { ok: true, file: target };
  } catch (error) {
    // 知识库归档失败不阻塞打包与清理，只记录。
    archive.knowledge = { ok: false, error: error.message };
    logger?.warn?.(`知识库归档失败（不影响发布归档）：${error.message}`);
  }
  return archive.knowledge;
}

/**
 * 发布成功后的归档：
 *   1. 终稿复制到本地知识库的 pipeline 待入库目录（失败不阻塞）
 *   2. 整个 article 目录打包到 published/<YYYYMMDD>-<slug>.zip
 *   3. 删除 draft/<slug>
 *
 * 幂等：zip 路径先写进 06-result.json，重跑时已存在的 zip 直接复用；
 * 目录还剩着就只补做未完成的步骤。
 */
export function archiveArticle({ config, type, dir, slug, publish, logger }) {
  const roots = ensureLayout(config);
  const target = path.resolve(dir);
  if (path.dirname(target) !== path.resolve(roots.draft)) {
    throw new Error(`拒绝归档：${target} 不是 draft/ 下的文章目录`);
  }

  const record = { ...(publish || {}) };
  const stamp = timestamp();
  const archive = { ...(record.archive || {}) };
  const projectRoot = config.__root || process.cwd();

  if (!archive.zip) {
    archive.zip = path.join(roots.published, `${stamp.date}-${slug}.zip`);
  }
  const zipFile = path.resolve(projectRoot, archive.zip);
  archive.zip = relativeTo(projectRoot, zipFile);

  // 1. 知识库
  copyToKnowledge({ config, type, dir: target, slug, title: record.title, stamp, archive, logger });

  // 2. 先落盘清单，再打包（清单因此会进入 zip）
  const next = { ...record, status: "published", archive, archivedAt: new Date().toISOString() };
  writeJson(path.join(target, ARTIFACT.publish), next);

  if (!exists(zipFile)) {
    const result = zipDirectory(target, zipFile);
    logger?.info?.(`已打包：${archive.zip}（${result.entries} 个文件，${(result.bytes / 1024).toFixed(1)} KB）`);
  } else {
    logger?.info?.(`归档包已存在，跳过打包：${archive.zip}`);
  }

  // 3. 清理 draft 目录
  fs.rmSync(target, { recursive: true, force: true });
  logger?.step?.(`已归档并清理：${slug} → ${archive.zip}`);
  return next;
}
