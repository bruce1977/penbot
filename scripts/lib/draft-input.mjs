/**
 * Draft input — the contract between "准备阶段" and "写初稿阶段".
 *
 * 三样东西装在一个 JSON 里（校验规则见 config/schemas/draft.yaml 的 draft_input）：
 *   title      文章标题
 *   outline    文章大纲：[{ heading, points[], target_words? }]
 *   materials  相关资料：[{ title, date?, source?, paragraphs[] }]
 *
 * 其余字段都可选：type / thesis / audience / hook / requirements /
 * counterpoint / takeaway / images。
 *
 * 提示词在 config/prompts/draft.yaml 的 draft_writing，校验规则在
 * config/schemas/draft.yaml 的 draft_input；改文案不用碰代码。
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "./fsx.mjs";
import { formatSources, loadSource } from "./knowledge.mjs";
import { validateTemplateSchema } from "./template.mjs";

export const DRAFT_PROMPT_FILE = "prompts/draft.yaml";
export const DRAFT_SCHEMA_FILE = "schemas/draft.yaml";

const text = (value) => String(value ?? "").trim();
const lines = (value) => (Array.isArray(value) ? value : []).map(text).filter(Boolean);

/** Load config/prompts/draft.yaml + config/schemas/draft.yaml. */
export function loadDraftTemplate(configDir) {
  const promptFile = path.join(configDir, DRAFT_PROMPT_FILE);
  const schemaFile = path.join(configDir, DRAFT_SCHEMA_FILE);
  const promptData = parseYaml(readText(promptFile));
  const schemaData = parseYaml(readText(schemaFile));
  const prompt = promptData?.prompts?.draft_writing;
  const schema = schemaData?.schemas?.draft_input?.output;

  if (!prompt || typeof prompt !== "object") {
    throw new Error(`${promptFile} 缺少 prompts.draft_writing`);
  }
  if (!prompt.system || !prompt.user) {
    throw new Error(`${promptFile} 的 prompts.draft_writing 缺少 system / user`);
  }
  if (!schema || typeof schema !== "object") {
    throw new Error(`${schemaFile} 缺少 schemas.draft_input.output（紧凑校验 DSL）`);
  }
  return { prompt, schema };
}

/** Build a draft input from upstream artifacts (topic / outline / sources). */
export function buildDraftInput({ type, topic = {}, outline = {}, sources = [], requirements = "", baseDir = "" }) {
  return normalizeDraftInput({
    type: type.id,
    title: text(topic.title) || text(topic.topic),
    thesis: text(outline.thesis) || text(topic.thesis),
    audience: text(outline.audience) || text(type.style?.audience),
    hook: text(outline.hook),
    requirements: text(requirements),
    outline: (outline.outline || []).map((section) => ({
      heading: section.heading,
      points: section.points,
      target_words: section.target_words,
    })),
    counterpoint: text(outline.counterpoint),
    takeaway: text(outline.takeaway),
    materials: sources.map((source) => {
      // 链接条目只带 index/title/link（link 相对文章目录），素材字段靠 baseDir 回读落地 MD。
      const meta = loadSource(source, { baseDir });
      return {
        title: meta.title,
        date: meta.date,
        source: meta.source,
        paragraphs: meta.excerpts,
      };
    }),
    images: (outline.image_plan || []).map((image) => ({
      position: image.position,
      description: image.description,
      prompt: image.prompt,
    })),
  });
}

/** Coerce an arbitrary object into the canonical shape (no validation). */
export function normalizeDraftInput(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    type: text(input.type),
    title: text(input.title),
    thesis: text(input.thesis),
    audience: text(input.audience),
    hook: text(input.hook),
    requirements: text(input.requirements),
    outline: (Array.isArray(input.outline) ? input.outline : [])
      .map((section) => ({
        heading: text(section?.heading),
        points: lines(section?.points),
        target_words: Math.max(0, Number(section?.target_words) || 0),
      }))
      .filter((section) => section.heading),
    counterpoint: text(input.counterpoint),
    takeaway: text(input.takeaway),
    materials: (Array.isArray(input.materials) ? input.materials : [])
      .map((material) => ({
        title: text(material?.title),
        date: text(material?.date),
        source: text(material?.source),
        paragraphs: lines(material?.paragraphs),
      }))
      .filter((material) => material.title || material.paragraphs.length),
    images: (Array.isArray(input.images) ? input.images : [])
      .map((image, i) => ({
        position: text(image?.position) || `inline_${i + 1}`,
        description: text(image?.description),
        prompt: text(image?.prompt),
      }))
      .filter((image) => image.description),
  };
}

/**
 * Validate against the template schema. Hard errors block drafting,
 * warnings (style/density hints) do not.
 */
export function validateDraftInput(raw, { schema, type, advisory = false } = {}) {
  if (!schema) throw new Error("validateDraftInput 需要 schema（config/schemas/draft.yaml 的 draft_input）");
  // Validate the raw object so that empty headings / paragraphs are reported
  // instead of being silently dropped by normalization.
  const report = validateTemplateSchema(raw || {}, schema);
  const errors = [...report.errors];
  const input = normalizeDraftInput(raw);
  const warnings = [...report.warnings];

  // 自动管线里这些字段常为空属正常；advisory 只给人工录入校验（input 命令）报。
  if (advisory) {
    if (!input.thesis) warnings.push("缺少 thesis（核心判断）");
    if (!input.takeaway) warnings.push("缺少 takeaway（结尾结论）");
    if (!input.requirements) warnings.push("未设置 requirements（额外写作要求）");
  }
  input.outline.forEach((section, i) => {
    if (section.points.length === 0) warnings.push(`大纲第 ${i + 1} 节「${section.heading}」没有要点`);
  });

  const target = Number(type?.length?.target) || 0;
  const planned = input.outline.reduce((sum, section) => sum + section.target_words, 0);
  if (target > 0 && planned > 0) {
    const diff = Math.abs(planned - target) / target;
    if (diff > 0.4) warnings.push(`大纲建议字数合计 ${planned}，与目标 ${target} 相差 ${(diff * 100).toFixed(0)}%`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Variables available to {{...}} in config/prompts/draft.yaml. */
export function buildDraftVars({ type, input, maxChars = 18000 }) {
  const outline = input.outline
    .map((section, i) => {
      const words = section.target_words ? `｜约 ${section.target_words} 字` : "";
      return `${i + 1}. ${section.heading}${words}\n   ${section.points.join("\n   ") || "（按标题展开）"}`;
    })
    .join("\n");

  const imageHint = input.images.length
    ? input.images.map((image, i) => `${i + 1}. ${image.position}：${image.description}`).join("\n")
    : "封面 1 张 + 正文 1-2 张";

  return {
    type_name: type?.name || "",
    persona: type?.style?.persona || "",
    tone: type?.style?.tone || "清晰、克制",
    title_style: type?.style?.title_style || "准确、有信息量",
    title: input.title,
    thesis: input.thesis,
    hook: input.hook,
    audience: input.audience || type?.style?.audience || "",
    counterpoint: input.counterpoint || "（无）",
    takeaway: input.takeaway,
    requirements_block: input.requirements ? `\n补充要求：${input.requirements}` : "",
    outline,
    materials: formatSources(toSources(input.materials), { maxChars }) || "（无）",
    image_hint: imageHint,
    extra: type?.prompts?.draft_extra ? `\n- ${type.prompts.draft_extra}` : "",
    length: {
      min: type?.length?.min ?? "",
      target: type?.length?.target ?? "",
      max: type?.length?.max ?? "",
    },
    image: {
      min: type?.illustrations?.min ?? "",
      max: type?.illustrations?.max ?? "",
    },
  };
}

/** Short human-readable summary for logs and CLI output. */
export function summarizeDraftInput(input) {
  const points = input.outline.reduce((sum, section) => sum + section.points.length, 0);
  const paragraphs = input.materials.reduce((sum, material) => sum + material.paragraphs.length, 0);
  const planned = input.outline.reduce((sum, section) => sum + section.target_words, 0);
  return [
    `标题：${input.title}`,
    `大纲：${input.outline.length} 节 / ${points} 个要点${planned ? ` / 建议 ${planned} 字` : ""}`,
    `资料：${input.materials.length} 篇 / ${paragraphs} 段`,
    `配图：${input.images.length} 张`,
  ];
}

/** Adapt materials to the shape formatSources expects. */
function toSources(materials) {
  return materials.map((material, i) => ({
    index: i + 1,
    title: material.title,
    file: material.source || "",
    date: material.date || "",
    tags: [],
    summary: "",
    excerpts: material.paragraphs,
  }));
}
