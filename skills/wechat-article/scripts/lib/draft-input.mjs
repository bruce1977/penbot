/**
 * Draft input — the contract between "准备阶段" and "写初稿阶段".
 *
 * Everything needed to write a draft lives in one JSON object:
 *   1. title      文章标题
 *   2. outline    文章大纲（小节 + 要点 + 建议字数 + 素材引用）
 *   3. materials  相关资料（整篇或若干段落）
 * plus the type id (决定文风/篇幅/评分) and a few optional hints.
 *
 * Schema: config/draft-input.schema.json
 * CLI:    bundle（生成） / validate --input（校验） / draft --input（使用）
 */

const VERSION = 1;
const ORIGINS = ["local", "weknora", "manual", "other"];

const text = (value) => String(value ?? "").trim();

/** ids must be positive integers and unique; missing/duplicate ones get renumbered. */
function assignIds(materials) {
  const used = new Set();
  let next = 1;
  return materials.map((material) => {
    let id = Number(material.id);
    if (!Number.isFinite(id) || id < 1 || used.has(id)) {
      while (used.has(next)) next += 1;
      id = next;
    }
    used.add(id);
    if (id >= next) next = id + 1;
    return { ...material, id };
  });
}

/** Build a draft input from upstream stage artifacts (topic / outline / sources). */
export function buildDraftInput({ type, topic = {}, outline = {}, sources = [], requirements = "", createdAt = new Date().toISOString() }) {
  const images = Array.isArray(outline.image_plan) ? outline.image_plan : [];
  return normalizeDraftInput({
    version: VERSION,
    type: type.id,
    type_name: type.name,
    created_at: createdAt,
    title: text(outline.title) || text(topic.title) || text(topic.topic),
    thesis: text(outline.thesis) || text(topic.thesis),
    audience: text(outline.audience) || text(type.style?.audience),
    hook: text(outline.hook),
    requirements: text(requirements),
    length: { min: type.length?.min, target: type.length?.target, max: type.length?.max },
    outline: (outline.outline || []).map((section) => ({
      heading: text(section.heading),
      points: (section.points || []).map(text).filter(Boolean),
      target_words: Number(section.target_words) || 0,
      source_refs: (section.source_indexes || section.source_refs || []).map(Number).filter((n) => n > 0),
    })),
    counterpoint: text(outline.counterpoint),
    takeaway: text(outline.takeaway),
    materials: sources.map((source, i) => ({
      id: Number(source.index) || i + 1,
      title: text(source.title),
      date: text(source.date),
      origin: ORIGINS.includes(source.origin) ? source.origin : "local",
      source: text(source.file || source.source),
      url: text(source.url),
      summary: text(source.summary),
      paragraphs: (source.excerpts || source.paragraphs || []).map(text).filter(Boolean),
    })),
    images: {
      count: images.length,
      cover: images.some((img) => String(img.position || "") === "cover"),
      plan: images.map((img, i) => ({
        position: text(img.position) || `inline_${i + 1}`,
        description: text(img.description),
        prompt: text(img.prompt),
      })),
    },
  });
}

/** Coerce an arbitrary object into the canonical shape (no validation). */
export function normalizeDraftInput(raw = {}, { type } = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const materials = assignIds(
    (Array.isArray(input.materials) ? input.materials : [])
      .map((material) => ({
        id: Number(material?.id),
        title: text(material?.title),
        date: text(material?.date),
        origin: ORIGINS.includes(material?.origin) ? material.origin : "manual",
        source: text(material?.source),
        url: text(material?.url),
        summary: text(material?.summary),
        paragraphs: (Array.isArray(material?.paragraphs) ? material.paragraphs : []).map(text).filter(Boolean),
      }))
      .filter((material) => material.title || material.paragraphs.length),
  );

  const knownIds = new Set(materials.map((m) => m.id));
  const outline = (Array.isArray(input.outline) ? input.outline : [])
    .map((section) => ({
      heading: text(section?.heading),
      points: (Array.isArray(section?.points) ? section.points : []).map(text).filter(Boolean),
      target_words: Math.max(0, Number(section?.target_words) || 0),
      source_refs: [...new Set((Array.isArray(section?.source_refs) ? section.source_refs : []).map(Number))].filter((id) => knownIds.has(id)),
    }))
    .filter((section) => section.heading);

  const images = input.images && typeof input.images === "object" ? input.images : {};
  const plan = (Array.isArray(images.plan) ? images.plan : [])
    .map((img, i) => ({
      position: text(img?.position) || `inline_${i + 1}`,
      description: text(img?.description),
      prompt: text(img?.prompt),
    }))
    .filter((img) => img.description);

  const source = input.length && typeof input.length === "object" ? input.length : {};
  return {
    version: Number(input.version) || VERSION,
    type: text(input.type) || text(type?.id),
    type_name: text(input.type_name) || text(type?.name),
    created_at: text(input.created_at) || new Date().toISOString(),
    title: text(input.title),
    thesis: text(input.thesis),
    audience: text(input.audience) || text(type?.style?.audience),
    hook: text(input.hook),
    requirements: text(input.requirements),
    length: {
      min: Number(source.min) || Number(type?.length?.min) || 0,
      target: Number(source.target) || Number(type?.length?.target) || 0,
      max: Number(source.max) || Number(type?.length?.max) || 0,
    },
    outline,
    counterpoint: text(input.counterpoint),
    takeaway: text(input.takeaway),
    materials,
    images: {
      count: Number(images.count) || plan.length,
      cover: images.cover === undefined ? plan.some((img) => img.position === "cover") : Boolean(images.cover),
      plan,
    },
  };
}

/**
 * Check the three required pieces before spending a model call.
 * Returns { ok, errors, warnings } — errors block drafting, warnings do not.
 */
export function validateDraftInput(raw) {
  const input = normalizeDraftInput(raw);
  const errors = [];
  const warnings = [];

  if (input.version !== VERSION) errors.push(`version 必须是 ${VERSION}，当前是 ${input.version}`);
  if (!input.type) errors.push("缺少 type（文章类型 id）");
  if (!input.title) errors.push("缺少 title（文章标题）");
  else if ([...input.title].length > 40) warnings.push(`title 有 ${[...input.title].length} 个字，公众号标题建议不超过 30 字`);

  if (input.outline.length === 0) errors.push("outline 为空：至少需要一个小节");

  const ids = new Set(input.materials.map((m) => m.id));
  if (input.materials.length === 0) errors.push("materials 为空：至少需要一篇相关资料");
  input.materials.forEach((material) => {
    if (!material.title) errors.push(`素材 ${material.id} 缺少 title`);
    if (material.paragraphs.length === 0) errors.push(`素材 ${material.id} 缺少 paragraphs（相关资料正文）`);
  });

  input.outline.forEach((section, i) => {
    const label = `大纲第 ${i + 1} 节「${section.heading}」`;
    if (section.points.length === 0) warnings.push(`${label} 没有要点`);
    if (section.source_refs.length === 0) warnings.push(`${label} 未关联素材`);
  });

  // Dangling refs are dropped by normalizeDraftInput, so check the raw input.
  const rawSections = Array.isArray(raw?.outline) ? raw.outline : [];
  rawSections.forEach((section, i) => {
    const heading = text(section?.heading) || `第 ${i + 1} 节`;
    const refs = [...new Set((Array.isArray(section?.source_refs) ? section.source_refs : []).map(Number))].filter((n) => n > 0);
    for (const id of refs) {
      if (!ids.has(id)) errors.push(`大纲「${heading}」引用了不存在的素材 id ${id}`);
    }
  });

  if (!input.thesis) warnings.push("缺少 thesis（核心判断）");
  if (!input.takeaway) warnings.push("缺少 takeaway（结尾结论）");
  if (!input.requirements) warnings.push("未设置 requirements（额外写作要求）");

  const planned = input.outline.reduce((sum, section) => sum + section.target_words, 0);
  if (input.length.target > 0 && planned > 0) {
    const diff = Math.abs(planned - input.length.target) / input.length.target;
    if (diff > 0.4) {
      warnings.push(`大纲建议字数合计 ${planned}，与目标 ${input.length.target} 相差 ${(diff * 100).toFixed(0)}%`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Adapt the draft input to the shape buildDraftPrompt expects.
 * Keeping the prompt builder unchanged means one source of truth for wording.
 */
export function toPromptParts(input) {
  const material = (m) => ({
    index: m.id,
    title: m.title,
    file: m.source,
    date: m.date,
    tags: [],
    summary: m.summary,
    excerpts: m.paragraphs,
  });

  return {
    topic: { topic: input.title, title: input.title, thesis: input.thesis, angle: "", rationale: "" },
    outline: {
      title: input.title,
      thesis: input.thesis,
      audience: input.audience,
      hook: input.hook,
      outline: input.outline.map((section) => ({
        heading: section.heading,
        points: section.points,
        target_words: section.target_words,
        source_indexes: section.source_refs,
      })),
      counterpoint: input.counterpoint,
      takeaway: input.takeaway,
      image_plan: input.images.plan,
    },
    sources: input.materials.map(material),
  };
}

/** Short human-readable summary for logs and CLI output. */
export function summarizeDraftInput(input) {
  const sections = input.outline.length;
  const points = input.outline.reduce((sum, s) => sum + s.points.length, 0);
  const paragraphs = input.materials.reduce((sum, m) => sum + m.paragraphs.length, 0);
  const planned = input.outline.reduce((sum, s) => sum + s.target_words, 0);
  return [
    `标题：${input.title}`,
    `大纲：${sections} 节 / ${points} 个要点 / 建议 ${planned} 字`,
    `资料：${input.materials.length} 篇 / ${paragraphs} 段`,
    `配图：${input.images.plan.length} 张`,
  ];
}
