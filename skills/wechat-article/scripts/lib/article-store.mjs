import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, slugify, uniqueDir } from "./fsx.mjs";
import { readZipEntry } from "./zip.mjs";

/**
 * 一篇文章就是一个目录：<BASE_OUTPUT_FOLDER>/draft/<slug>/
 * 每个阶段只写自己的产物；产物存在 = 该阶段已完成，续跑只认文件（没有 state.json）。
 * 步骤对外只暴露根目录的 NN-result.json；中间文件收进 NN-step/ 子目录。
 * 素材收集（gather_materials）属于选题步：结果并入 01-result.json 的 sources 字段，
 * 本地/外部素材的中间文件收进 01-step/，因此编号从 01 选题直接接到 02 纲要。
 * 目前仅选题步（01）完成改造，02–08 仍用旧式文件名，逐步迁移。
 */
export const ARTIFACT = {
  topic: "01-result.json",
  topicMd: "01-step/topic.md",
  topicProposal: "01-step/proposal.json",
  outline: "02-outline.json",
  outlineMd: "02-outline.md",
  draftInput: "03-draft-input.json",
  draft: "04-draft.md",
  reviewDir: "05-review",
  reviewed: "05-reviewed.md",
  images: "06-images.json",
  illustrated: "06-illustrated.md",
  final: "07-final.md",
  finalHtml: "07-final.html",
  publish: "08-publish.json",
  log: "pipeline.log",
};

/** 从 01-result.json 提取文章元信息（标题/类型/时间），旧布局目录回退 01-topic.json。 */
export function readArticleMeta(dir) {
  const result = readJsonSafe(path.join(dir, ARTIFACT.topic));
  if (result) {
    return {
      title: result.title || result.topic || "",
      type: result.type?.id || "",
      typeName: result.type?.name || "",
      startedAt: result.generated_at || "",
    };
  }
  const legacy = readJsonSafe(path.join(dir, "01-topic.json"));
  return legacy
    ? { title: legacy.title || legacy.topic || "", type: legacy.type || "", typeName: "", startedAt: "" }
    : { title: "", type: "", typeName: "", startedAt: "" };
}

/** 阶段顺序，对应产物编号 01–08（publish 同时产出 07-final.md 与 08-publish.json）。 */
export const STAGES = ["topic", "outline", "bundle", "draft", "review", "illustrate", "publish", "archive"];

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

/** draft/ 下的文章目录，按最近修改时间倒序。标题/类型从 01-result.json 读取。 */
export function listArticles(config) {
  const { draft } = ensureLayout(config);
  return fs
    .readdirSync(draft, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(draft, entry.name);
      const meta = readArticleMeta(dir);
      return {
        slug: entry.name,
        dir,
        title: meta.title || entry.name,
        type: meta.type,
        startedAt: meta.startedAt,
        updatedAt: fs.statSync(dir).mtime.toISOString(),
        mtime: fs.statSync(dir).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 已写过的文章清单（选题去重用）：
 *   published/*.zip —— 发布归档，读 zip 内的 08-publish.json / 01-result.json；
 *   draft/          —— 在写/已选题的文章（读 01-result.json）。
 * 坏包忽略不阻塞选题。返回按日期倒序。
 */
export function listWrittenArticles(config, { limit = 60 } = {}) {
  const roots = ensureLayout(config);
  const items = [];

  let zips = [];
  try {
    zips = fs.readdirSync(roots.published).filter((f) => f.toLowerCase().endsWith(".zip"));
  } catch {
    /* published/ 不存在就当没写过 */
  }
  for (const name of zips) {
    const file = path.join(roots.published, name);
    try {
      const readJsonEntry = (entry) => {
        const buf = readZipEntry(file, entry);
        return buf ? JSON.parse(buf.toString("utf8")) : null;
      };
      const publish = readJsonEntry(ARTIFACT.publish);
      const result = readJsonEntry(ARTIFACT.topic);
      const title = publish?.title || result?.title || result?.topic || "";
      if (!title) continue;
      items.push({
        title,
        topic: result?.topic || "",
        date: String(publish?.archivedAt || result?.generated_at || "").slice(0, 10),
        type: result?.type?.id || publish?.type || "",
        source: "published",
      });
    } catch {
      /* 跳过损坏的归档 */
    }
  }

  for (const a of listArticles(config)) {
    const result = readJsonSafe(path.join(a.dir, ARTIFACT.topic));
    const title = a.title || "";
    if (!title) continue;
    items.push({
      title,
      topic: result?.topic || "",
      date: String(a.startedAt || a.updatedAt || "").slice(0, 10),
      type: a.type || "",
      source: "draft",
    });
  }

  return items.sort((x, y) => (y.date || "").localeCompare(x.date || "")).slice(0, limit);
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
    const meta = readArticleMeta(dir);
    return { ...roots, dir, slug, article: { slug, title: meta.title, type: meta.type, typeName: meta.typeName }, existing: true };
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
  return {
    ...roots,
    dir: item.dir,
    slug: item.slug,
    article: { slug: item.slug, title: item.title, type: item.type, typeName: "" },
    existing: true,
  };
}

/**
 * 看「最后一个存在的产物」，返回下一步应该跑的阶段。
 * 例：只有 04-draft.md → review；已有 08-publish.json(status=published) → archive。
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
  if (exists(path.join(dir, ARTIFACT.topic))) return "outline";
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
