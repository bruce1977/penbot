import fs from "node:fs";
import path from "node:path";
import { expandEnv } from "./env.mjs";
import { readJson } from "./fsx.mjs";

export const DEFAULT_CONFIG_PATH = "skills/wechat-article/config/article-types.json";

/** Load config, expand env vars and resolve relative paths against the project root. */
export function loadConfig(configPath, { root = process.cwd() } = {}) {
  const resolved = path.resolve(root, configPath || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = readJson(resolved);
  const config = expandEnv(raw);
  config.__path = resolved;
  config.__root = root;
  config.__dir = path.dirname(resolved);
  return normalizeConfig(config, root);
}

export function normalizeConfig(config, root = process.cwd()) {
  const defaults = config.defaults || {};
  const types = (config.types || []).map((type) => normalizeType(type, defaults, root, config));
  const ids = new Set();
  for (const type of types) {
    if (ids.has(type.id)) throw new Error(`Duplicate article type id: ${type.id}`);
    ids.add(type.id);
  }
  return {
    ...config,
    project: {
      output_dir: "output/wechat-article",
      language: "zh-CN",
      ...(config.project || {}),
    },
    models: config.models || {},
    defaults,
    types,
  };
}

function normalizeType(type, defaults, root, config) {
  const merged = deepMerge(
    {
      enabled: true,
      knowledge: defaults.knowledge || {},
      review: defaults.review || {},
      illustrations: defaults.illustrations || {},
      publish: defaults.publish || {},
    },
    type,
  );
  const knowledge = {
    max_sources: 8,
    excerpt_chars: 1800,
    lookback_days: 365,
    max_file_bytes: 400000,
    ...(defaults.knowledge || {}),
    ...(type.knowledge || {}),
  };
  const review = deepMerge(defaults.review || {}, type.review || {});
  review.max_rounds = clamp(review.max_rounds ?? 3, 1, 5);
  review.pass_score = review.pass_score ?? type.scoring?.pass_score ?? 80;
  review.correct_cn = {
    enabled: true,
    endpoint: "/api/pipeline",
    auth_header: "X-Auth-Key",
    apply: "issues",
    timeout_ms: 180000,
    fallback_llm: true,
    ...(defaults.review?.correct_cn || {}),
    ...(type.review?.correct_cn || {}),
  };
  const illustrations = deepMerge(defaults.illustrations || {}, type.illustrations || {});
  illustrations.min = clamp(illustrations.min ?? 1, 1, 5);
  illustrations.max = clamp(illustrations.max ?? 5, illustrations.min, 5);
  if (illustrations.count !== undefined) {
    illustrations.count = clamp(illustrations.count, illustrations.min, illustrations.max);
  }
  const publish = deepMerge(defaults.publish || {}, type.publish || {});
  publish.email = { ...(defaults.publish?.email || {}), ...(type.publish?.email || {}) };
  publish.wechat = { ...(defaults.publish?.wechat || {}), ...(type.publish?.wechat || {}) };

  const knowledgeDirs = (merged.knowledge_dirs || [])
    .filter(Boolean)
    .map((dir) => path.resolve(root, dir));

  const length = {
    min: type.length?.min ?? 800,
    max: type.length?.max ?? 2000,
    target: type.length?.target ?? Math.round(((type.length?.min ?? 800) + (type.length?.max ?? 2000)) / 2),
  };
  if (length.max < length.min) length.max = length.min;

  const dimensions = type.scoring?.dimensions || [];
  const totalWeight = dimensions.reduce((sum, d) => sum + Number(d.weight || 0), 0) || 1;

  return {
    ...merged,
    id: type.id,
    name: type.name || type.id,
    description: type.description || "",
    enabled: merged.enabled !== false,
    knowledge_dirs: knowledgeDirs,
    knowledge,
    style: type.style || {},
    length,
    scoring: {
      pass_score: type.scoring?.pass_score ?? review.pass_score,
      dimensions: dimensions.map((d) => ({
        ...d,
        weight: Number(d.weight || 0) / totalWeight,
      })),
    },
    review,
    illustrations,
    publish,
    topic: { keywords: [], exclude_keywords: [], candidates: 12, ...(type.topic || {}) },
    prompts: type.prompts || {},
    model: type.model || defaults.model || "local",
    config,
  };
}

export function findType(config, id) {
  const type = config.types.find((t) => t.id === id);
  if (!type) {
    const available = config.types.map((t) => t.id).join(", ");
    throw new Error(`Unknown article type "${id}". Available: ${available}`);
  }
  return type;
}

export function listTypes(config) {
  return config.types.filter((t) => t.enabled);
}

export function getModelProfile(config, name) {
  const id = name || config.defaults?.model || "local";
  const profile = config.models?.[id];
  if (!profile) {
    throw new Error(`Unknown model profile "${id}". Available: ${Object.keys(config.models || {}).join(", ")}`);
  }
  return { id, ...profile };
}

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override === undefined ? base : override;
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Lightweight validation, independent of the JSON schema file. */
export function validateConfig(config) {
  const issues = [];
  if (!Array.isArray(config.types) || config.types.length === 0) issues.push("types 不能为空");
  for (const type of config.types || []) {
    if (!type.id) issues.push("存在缺少 id 的文章类型");
    if (!type.scoring?.dimensions?.length) issues.push(`${type.id}: 缺少 scoring.dimensions`);
    if (type.knowledge_dirs.length === 0) issues.push(`${type.id}: 未配置 knowledge_dirs，将无法从本地知识库选题`);
    for (const dir of type.knowledge_dirs) {
      if (!fs.existsSync(dir)) issues.push(`${type.id}: 知识库目录不存在 ${dir}`);
    }
    if (type.length.min >= type.length.max) issues.push(`${type.id}: length.min 应小于 length.max`);
    if (!config.models?.[type.model]) issues.push(`${type.id}: model "${type.model}" 未在 models 中定义`);
    if (!config.models?.[type.review?.model || type.model]) {
      issues.push(`${type.id}: review.model "${type.review?.model}" 未在 models 中定义`);
    }
  }
  return issues;
}
