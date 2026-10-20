import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, slugify, uniqueDir } from "./fsx.mjs";

/**
 * 一篇文章就是一个目录：<BASE_OUTPUT_FOLDER>/draft/<slug>/
 * 每个阶段只写自己的产物；产物存在 = 该阶段已完成，续跑只认文件。
 */
export const ARTIFACT = {
  topic: "01-topic.json",
  topicMd: "01-topic.md",
  sources: "02-sources.json",
  outline: "03-outline.json",
  outlineMd: "03-outline.md",
  draftInput: "04-draft-input.json",
  draft: "05-draft.md",
  reviewDir: "06-review",
  reviewed: "06-reviewed.md",
  images: "07-images.json",
  illustrated: "07-illustrated.md",
  final: "08-final.md",
  finalHtml: "08-final.html",
  publish: "09-publish.json",
  state: "state.json",
  log: "pipeline.log",
};

/** 阶段顺序，对应产物编号 01–09（publish 同时产出 08-final.md 与 09-publish.json）。 */
export const STAGES = ["topic", "sources", "outline", "bundle", "draft", "review", "illustrate", "publish", "archive"];

export function stageIndex(stage) {
  const index = STAGES.indexOf(stage);
  return index < 0 ? STAGES.length : index;
}

export function baseFolder(config) {
  const base = config?.project?.base_output_folder;
  if (!base) {
    throw new Error("未配置 project.base_output_folder（环境变量 BASE_OUTPUT_FOLDER）");
  }
  return path.resolve(base);
}

/** 确保 draft/ 与 published/ 存在。 */
export function ensureLayout(config) {
  const base = baseFolder(config);
  const draft = ensureDir(path.join(base, "draft"));
  const published = ensureDir(path.join(base, "published"));
  return { base, draft, published };
}

function readJsonSafe(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

export function readState(dir) {
  return readJsonSafe(path.join(dir, ARTIFACT.state)) || {};
}

/** draft/ 下的文章目录，按最近修改时间倒序。 */
export function listArticles(config) {
  const { draft } = ensureLayout(config);
  return fs
    .readdirSync(draft, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(draft, entry.name);
      const state = readState(dir);
      return {
        slug: entry.name,
        dir,
        state,
        title: state.article?.title || state.title || entry.name,
        type: state.article?.type || state.type || "",
        updatedAt: fs.statSync(dir).mtime.toISOString(),
        mtime: fs.statSync(dir).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 新建文章目录。slug 冲突时依次尝试 -2、-3，已存在的目录绝不覆盖。
 * 返回 { dir, slug, roots }。
 */
export function createArticle(config, { title = "", slug = "", type, entry = "auto" } = {}) {
  const roots = ensureLayout(config);
  const baseSlug = slugify(slug || title || type?.id || "article");
  const dir = uniqueDir(path.join(roots.draft, baseSlug));
  ensureDir(dir);
  return {
    ...roots,
    dir,
    slug: path.basename(dir),
    article: {
      slug: path.basename(dir),
      title: String(title || "").trim(),
      type: type?.id || "",
      typeName: type?.name || "",
      entry,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * 选择一篇文章：
 * - selector 指定 slug（或 "latest"）→ 必须已存在；
 * - 省略时：draft/ 下只有一篇就直接用，多篇则报错并列出候选。
 */
export function openArticle(config, selector) {
  const roots = ensureLayout(config);
  if (selector && selector !== true && selector !== "latest") {
    const slug = String(selector);
    const dir = path.join(roots.draft, slug);
    if (!exists(dir)) {
      throw new Error(`文章不存在：${dir}\n可用 --article latest 选择最近一篇，或不带 --article 让脚本自动识别`);
    }
    const state = readState(dir);
    return { ...roots, dir, slug, article: state.article || {}, existing: true };
  }
  const items = listArticles(config);
  if (items.length === 0) {
    throw new Error(`没有进行中的文章：${roots.draft}\n先用 auto / manual 创建一篇`);
  }
  if (items.length > 1 && selector !== "latest") {
    const list = items.map((item) => `  - ${item.slug}（${item.title}）`).join("\n");
    throw new Error(`draft 下有多篇文章，请用 --article <slug> 指定，或 --article latest：\n${list}`);
  }
  const item = items[0];
  return { ...roots, dir: item.dir, slug: item.slug, article: item.state.article || {}, existing: true };
}

/**
 * 看「最后一个存在的产物」，返回下一步应该跑的阶段。
 * 例：只有 05-draft.md → review；已有 09-publish.json(status=published) → archive。
 */
export function detectStartStage(dir) {
  const publish = readJsonSafe(path.join(dir, ARTIFACT.publish));
  if (publish?.status === "published") return "archive";
  if (exists(path.join(dir, ARTIFACT.final))) return "publish";
  if (exists(path.join(dir, ARTIFACT.illustrated))) return "publish";
  if (exists(path.join(dir, ARTIFACT.reviewed))) return "illustrate";
  if (exists(path.join(dir, ARTIFACT.draft))) return "review";
  if (exists(path.join(dir, ARTIFACT.draftInput))) return "draft";
  if (exists(path.join(dir, ARTIFACT.outline))) return "bundle";
  if (exists(path.join(dir, ARTIFACT.sources))) return "outline";
  if (exists(path.join(dir, ARTIFACT.topic))) return "sources";
  return "topic";
}

/** 单步命令默认读哪份稿件：从新到旧取第一份存在的。 */
export function pickArticleFile(dir, preference) {
  for (const name of preference) {
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}
