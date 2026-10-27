import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, slugify, uniqueDir } from "./fsx.mjs";
import { readZipEntry } from "./zip.mjs";

/**
 * 一篇文章就是一个目录：<BASE_OUTPUT_FOLDER>/draft/<slug>/
 * 每个阶段只写自己的产物；产物存在 = 该阶段已完成，续跑只认文件（没有 state.json）。
 * 步骤对外只暴露根目录的 NN-result.json；中间文件收进 NN-step/ 子目录。
 * 阶段编号：01 选题（素材并入 sources）→ 02 初稿（纲要 + 输入 + 初稿）
 * → 03 审稿（核稿 + 修正 + 评稿 + 判定循环）→ 04 组稿（去 AI 化 + 配图，并发）
 * → 05 发布/归档。
 */
export const ARTIFACT = {
  topic: "01-result.json",
  topicMd: "01-step/topic.md",
  topicProposal: "01-step/proposal.json",
  draft: "02-result.json",
  outline: "02-step/outline.json",
  outlineMd: "02-step/outline.md",
  draftInput: "02-step/draft-input.json",
  draftMd: "02-step/draft.md",
  review: "03-result.json",
  reviewDir: "03-step",
  reviewed: "03-step/reviewed.md",
  polished: "04-step/polished.md",
  compose: "04-result.json",
  images: "04-step/images.json",
  composed: "04-step/composed.md",
  imagesDir: "04-step/images",
  publish: "05-result.json",
  final: "05-step/final.md",
  finalHtml: "05-step/final.html",
  log: "logs/pipeline.log",
};

/** 每步对外的唯一契约：根目录 NN-result.json（阶段名 → 文件名）。 */
export const STAGE_RESULT = {
  topic: ARTIFACT.topic,
  draft: ARTIFACT.draft,
  review: ARTIFACT.review,
  compose: ARTIFACT.compose,
  publish: ARTIFACT.publish,
};

/** 每一步只读上一步的 result：这条链就是运行时的输入顺序。 */
export const PREV_STAGE_RESULT = {
  draft: "topic",
  review: "draft",
  compose: "review",
  publish: "compose",
};

/**
 * 阶段 result 的信封（stage / generated_at / title / type / files）。
 * title 与 type 只在 01 产生，之后每一步从上一份 result 原样顺延（读取端优先用继承值，
 * 继承不到才用调用方给的兜底——独立命令可以在只有散落稿件的目录里跑）；
 * files 是累积的产物地图：后面任何一步要读前面的文件，只从这里取路径，不猜文件名。
 */
export function buildEnvelope(dir, stage, overrides = {}) {
  const prev = PREV_STAGE_RESULT[stage];
  const inherited = prev ? readJsonSafe(path.join(dir, STAGE_RESULT[prev])) : null;
  return {
    stage,
    generated_at: new Date().toISOString(),
    title: inherited?.title || overrides.title || "",
    type: inherited?.type || overrides.type || "",
    files: { ...(inherited?.files || {}), ...(overrides.files || {}) },
  };
}

/** 从 01-result.json 提取文章元信息（标题/类型 id/选题时间）。 */
export function readArticleMeta(dir) {
  const result = readJsonSafe(path.join(dir, ARTIFACT.topic));
  return result
    ? { title: result.title || result.topic || "", type: result.type || "", startedAt: result.generated_at || "" }
    : { title: "", type: "", startedAt: "" };
}

/** 读某一步的 result 本体（不存在返回 null）。 */
export function readStageResult(dir, stage) {
  return readJsonSafe(path.join(dir, STAGE_RESULT[stage]));
}

/**
 * 从某一步 result 的 files 地图里取产物路径（相对文章根目录）。
 * 取不到返回 null——独立命令可以对着只有散落稿件的目录跑，那时由调用方回退到 ARTIFACT 常量。
 */
export function fileFromResult(dir, stage, key) {
  const rel = readStageResult(dir, stage)?.files?.[key];
  return typeof rel === "string" && rel ? rel : null;
}


/** 阶段顺序，对应产物编号 01–05（archive 复用 05-result.json，只认发布状态）。 */
export const STAGES = ["topic", "draft", "review", "compose", "publish", "archive"];

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
 *   published/*.zip —— 发布归档，读 zip 内的 05-result.json / 01-result.json；
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
        type: publish?.type || result?.type || "",
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
    return { ...roots, dir, slug, article: { slug, title: meta.title, type: meta.type }, existing: true };
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
    article: { slug: item.slug, title: item.title, type: item.type },
    existing: true,
  };
}

/**
 * 看「最后一个存在的阶段结果」，返回下一步应该跑的阶段。
 * 例：只有 02-step/draft.md（02-result.json 还没写）→ draft 阶段内补写结果；
 * 已有 05-result.json(status=published) → archive。
 */
export function detectStartStage(dir) {
  const publish = readJsonSafe(path.join(dir, ARTIFACT.publish));
  if (publish?.status === "published") return "archive";
  if (publish || exists(path.join(dir, ARTIFACT.final)) || exists(path.join(dir, ARTIFACT.composed))) return "publish";
  if (exists(path.join(dir, ARTIFACT.review))) return "compose";
  if (exists(path.join(dir, ARTIFACT.draft))) return "review";
  if (
    exists(path.join(dir, ARTIFACT.draftMd)) ||
    exists(path.join(dir, ARTIFACT.draftInput)) ||
    exists(path.join(dir, ARTIFACT.outline)) ||
    exists(path.join(dir, ARTIFACT.topic))
  ) {
    return "draft";
  }
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
