import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expandEnv } from "./env.mjs";

export const DEFAULT_CONFIG_PATH = "skills/wechat-article/config/article-types.yaml";
export const DEFAULT_DEFAULTS_PATH = "skills/wechat-article/config/defaults.yaml";
export const DEFAULT_MODELS_PATH = "skills/wechat-article/config/models.yaml";

/**
 * 加载配置：
 *   defaults.yaml（全局默认）→ models.yaml（模型总表）
 *   → article-types.yaml（类型注册表，可覆盖默认）→ config/types/*.yaml → normalize。
 */
export function loadConfig(configPath, { root = process.cwd(), defaultsPath, modelsPath } = {}) {
  const resolved = path.resolve(root, configPath || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const registry = readYaml(resolved);
  const configDir = path.dirname(resolved);
  const defaultsFile = defaultsPath
    ? path.resolve(root, defaultsPath)
    : path.join(configDir, "defaults.yaml");
  const modelsFile = modelsPath
    ? path.resolve(root, modelsPath)
    : path.join(configDir, "models.yaml");
  const defaults = fs.existsSync(defaultsFile) ? readYaml(defaultsFile) : {};
  const models = fs.existsSync(modelsFile) ? readYaml(modelsFile) : {};
  const base = mergeConfig(defaults, registry);
  // models.yaml 支持两种写法：顶层 llm/opencode/systemone，或包一层 models:。
  // 也兼容旧的扁平 models（defaults.yaml 里直接列 local/local-large）。
  base.model_groups = models.models && isPlainObject(models.models) ? models.models : models;
  base.__path = resolved;
  base.__defaults_path = fs.existsSync(defaultsFile) ? defaultsFile : "";
  base.__models_path = fs.existsSync(modelsFile) ? modelsFile : "";
  base.__root = root;
  base.__dir = configDir;
  base.types = loadTypeFiles(base, configDir);
  return normalizeConfig(expandEnv(base), root);
}

/** 深合并：对象递归，数组/标量直接覆盖。 */
function mergeConfig(base, override) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value);
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readYaml(file) {
  const data = parseYaml(fs.readFileSync(file, "utf8"));
  if (data === undefined || data === null) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`配置根节点必须是对象：${file}`);
  }
  return data;
}

/**
 * types 支持两种写法：
 *
 *   # 推荐：key = 类型 id，value = config/types/ 下的文件名
 *   types:
 *     ai-news: ai-news.yaml
 *
 *   # 兼容旧写法：数组
 *   types:
 *     - ai-news
 *     - { file: ai-news.yaml, ... }
 *
 * 省略 types 时自动扫描 config/types/*.yaml。
 */
function loadTypeFiles(base, configDir) {
  const typesDir = path.resolve(configDir, "types");
  const entries = base.types;

  if (entries === undefined || entries === null || (Array.isArray(entries) && entries.length === 0)) {
    if (!fs.existsSync(typesDir)) return [];
    return fs
      .readdirSync(typesDir)
      .filter((name) => /\.(ya?ml|json)$/i.test(name) && !name.startsWith("_"))
      .sort()
      .map((name) => readTypeFile(typesDir, name));
  }

  if (Array.isArray(entries)) {
    return entries.map((entry) => {
      if (typeof entry === "string") return readTypeFile(typesDir, entry);
      if (isPlainObject(entry)) {
        if (!entry.file) return entry;
        const { file, ...inline } = entry;
        return { ...readTypeFile(typesDir, file), ...inline };
      }
      throw new Error(`types 里的条目必须是类型 id、文件路径或对象：${JSON.stringify(entry)}`);
    });
  }

  if (isPlainObject(entries)) {
    return Object.entries(entries).map(([id, value]) => {
      if (typeof value === "string") {
        return { ...readTypeFile(typesDir, value), id };
      }
      if (isPlainObject(value)) {
        const { file, ...overrides } = value;
        const inline = file ? readTypeFile(typesDir, file) : {};
        return { ...inline, ...overrides, id: overrides.id || id };
      }
      throw new Error(`types.${id} 必须是文件名或对象：${JSON.stringify(value)}`);
    });
  }

  throw new Error(`types 必须是对象或数组：${JSON.stringify(entries)}`);
}

function readTypeFile(typesDir, ref) {
  const name = String(ref);
  const hasExt = /\.(ya?ml|json)$/i.test(name);
  const candidates = hasExt ? [name] : [`${name}.yaml`, `${name}.yml`, `${name}.json`];
  const file = candidates.map((candidate) => path.join(typesDir, candidate)).find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error(`找不到文章类型配置：${candidates.join(" / ")}（目录 ${typesDir}）`);
  }
  const data = readYaml(file);
  if (!data.id) data.id = path.basename(file).replace(/\.(ya?ml|json)$/i, "");
  data.__file = file;
  return data;
}

export function normalizeConfig(config, root = process.cwd()) {
  const defaults = config.defaults || {};
  // Global kill switch: when off, every type falls back to local document dirs
  // even if the type itself asks for `weknora` or `both`.
  defaults.knowledge = {
    ...(defaults.knowledge || {}),
    use_weknora: toBool(defaults.knowledge?.use_weknora, true),
  };
  const types = (config.types || []).map((type) => normalizeType(type, defaults, root, config));
  const ids = new Set();
  for (const type of types) {
    if (ids.has(type.id)) throw new Error(`Duplicate article type id: ${type.id}`);
    ids.add(type.id);
  }
  const project = {
    base_output_folder: "output/wechat-article",
    language: "zh-CN",
    ...(config.project || {}),
  };
  // The article root comes from BASE_OUTPUT_FOLDER only (env/config), never from a CLI flag.
  project.base_output_folder = path.resolve(root, project.base_output_folder);

  const models = normalizeModelMap(config);
  const classifier = normalizeClassifier(config.classifier, models);

  return {
    ...config,
    project,
    classifier,
    models,
    model_groups: config.model_groups || {},
    defaults,
    types,
  };
}

/**
 * 把 models.yaml 的分类结构压平成 id → profile：
 *   llm.local → { provider: ollama, ... }
 *   opencode.writer → { provider: opencode, ... }
 *   systemone.classifier → { provider: systemone, ... }
 * 旧的扁平 config.models（local/local-large）继续兼容。
 */
export function normalizeModelMap(config = {}) {
  const groups = config.model_groups || {};
  const flat = {};
  const providers = { llm: "ollama", opencode: "opencode", systemone: "systemone" };

  for (const [name, profile] of Object.entries(config.models || {})) {
    if (isPlainObject(profile)) flat[name] = normalizeModelProfile(profile);
  }

  for (const [group, entries] of Object.entries(groups)) {
    if (!isPlainObject(entries)) continue;
    // 兼容 models: { local: { provider: ... } } 这种扁平写法
    if (isModelProfile(entries)) {
      flat[group] = normalizeModelProfile(entries);
      continue;
    }
    for (const [name, profile] of Object.entries(entries)) {
      if (!isPlainObject(profile)) continue;
      flat[`${group}.${name}`] = normalizeModelProfile({
        provider: providers[group] || group,
        ...profile,
      });
    }
  }
  return flat;
}

const MODEL_FIELD_ALIASES = {
  PROVIDER: "provider",
  BASE_URL: "base_url",
  MODEL_NAME: "model",
  MODEL: "model",
  API_KEY: "api_key",
  ENDPOINT: "endpoint",
  COMMAND: "command",
  AGENT: "agent",
  TIMEOUT_MS: "timeout_ms",
  TEMPERATURE: "temperature",
  MAX_TOKENS: "max_tokens",
  NUM_CTX: "num_ctx",
};

/** models.yaml 里大写字段（BASE_URL / MODEL_NAME / API_KEY）统一转小写。 */
function normalizeModelProfile(profile) {
  const out = { ...profile };
  for (const [alias, key] of Object.entries(MODEL_FIELD_ALIASES)) {
    if (out[alias] !== undefined) {
      if (out[key] === undefined) out[key] = out[alias];
      delete out[alias];
    }
  }
  return out;
}

function isModelProfile(value) {
  return isPlainObject(value) && ["provider", "base_url", "model", "command", "PROVIDER", "BASE_URL", "MODEL_NAME"].some((key) => value[key] !== undefined);
}

function normalizeClassifier(classifier = {}, models = {}) {
  const modelId = String(classifier.model || "systemone.classifier");
  const profile = models[modelId] || {};
  const modelName = profile.model || profile.model_name || (modelId.includes(".") ? "" : modelId) || "jev-latest";
  const normalized = {
    enabled: toBool(classifier.enabled, true),
    provider: profile.provider || classifier.provider || "systemone",
    base_url: profile.base_url || classifier.base_url || "",
    endpoint: profile.endpoint || classifier.endpoint || "/v1/systemone",
    api_key: profile.api_key || classifier.api_key || "",
    model: modelName,
    model_id: modelId,
    question: classifier.question || "article_type",
    timeout_ms: Number(profile.timeout_ms || classifier.timeout_ms || 15000),
    max_retries: Number(profile.max_retries ?? classifier.max_retries ?? 2),
    min_confidence: Number(classifier.min_confidence ?? 0.5),
    // 一次判断置信度低于该值时升级到 deep_model 二次判断；deep_model 为空 = 不升级
    escalate_below: Number(classifier.escalate_below ?? 0.65),
    default_type: classifier.default_type || "",
    deep_model_id: "",
    deep: null,
  };

  const deepId = String(classifier.deep_model || "").trim();
  if (deepId) {
    normalized.deep_model_id = deepId;
    const deepProfile = models[deepId] || {};
    const deepName = deepProfile.model || deepProfile.model_name || (deepId.includes(".") ? "" : deepId);
    if (deepName) {
      // 端点/密钥缺省继承一次判断，允许 deep 节点独立覆盖 timeout / retries。
      normalized.deep = {
        model: deepName,
        base_url: deepProfile.base_url || normalized.base_url,
        endpoint: deepProfile.endpoint || normalized.endpoint,
        api_key: deepProfile.api_key || normalized.api_key,
        timeout_ms: Number(deepProfile.timeout_ms || normalized.timeout_ms),
        max_retries: Number(deepProfile.max_retries ?? normalized.max_retries),
      };
    }
  }
  return normalized;
}

function normalizeType(type, defaults, root, config) {
  const id = String(type.id || "").trim();
  if (!id) throw new Error("存在缺少 id 的文章类型");

  const knowledge = {
    source: "local",
    max_sources: 8,
    excerpt_chars: 1800,
    lookback_days: 365,
    max_file_bytes: 400000,
    ...(defaults.knowledge || {}),
    ...(type.knowledge || {}),
  };
  // 通道 2 外部检索：嵌套合并，类型文件可只覆盖个别阈值。
  knowledge["web-search"] = {
    enabled: false,
    max_queries: 2,
    max_per_query: 3,
    max_sources: 6,
    excerpt_chars: 800,
    timeout_ms: 600000,
    ...(defaults.knowledge?.["web-search"] || {}),
    ...(type.knowledge?.["web-search"] || {}),
  };
  knowledge["web-search"].enabled = toBool(knowledge["web-search"].enabled, false);
  knowledge["web-search"].gate = {
    ...(defaults.knowledge?.["web-search"]?.gate || {}),
    ...(type.knowledge?.["web-search"]?.gate || {}),
  };
  // 新写法：knowledge_source 直接写在类型顶层。
  if (type.knowledge_source) knowledge.source = type.knowledge_source;
  knowledge.weknora = {
    enabled: false,
    base_url: "",
    api_key: "",
    auth_header: "X-API-Key",
    kb_ids: [],
    kb_names: {},
    match_count: knowledge.max_sources || 8,
    vector_threshold: 0,
    keyword_threshold: 0,
    timeout_ms: 30000,
    ...(defaults.knowledge?.weknora || {}),
    ...(type.knowledge?.weknora || {}),
    ...(type.weknora || {}),
  };
  // Knowledge source: local document dirs, the remote WeKnora KB, or both.
  const source = String(knowledge.source || "local").toLowerCase();
  knowledge.source = ["local", "weknora", "both"].includes(source) ? source : "local";
  knowledge.weknora.enabled = knowledge.source !== "local";
  if (!Array.isArray(knowledge.weknora.kb_ids)) {
    knowledge.weknora.kb_ids = knowledge.weknora.kb_ids ? [knowledge.weknora.kb_ids] : [];
  }
  knowledge.weknora.kb_ids = knowledge.weknora.kb_ids.filter(Boolean).map(String);
  // Global switch wins over the per-type source.
  if (defaults.knowledge?.use_weknora === false) {
    knowledge.source = "local";
    knowledge.weknora.enabled = false;
    knowledge.weknora.disabled_reason = "全局开关 use_weknora=false";
  }
  // WeKnora is only usable when a base_url is configured.
  if (knowledge.weknora.enabled && !knowledge.weknora.base_url) {
    knowledge.source = "local";
    knowledge.weknora.disabled_reason = "base_url 未配置";
  }
  if (knowledge.source !== "local" && knowledge.weknora.kb_ids.length === 0) {
    knowledge.weknora.disabled_reason = knowledge.weknora.disabled_reason || "kb_ids 未配置";
  }

  const review = deepMerge(defaults.review || {}, type.review || {});
  review.max_rounds = clamp(review.max_rounds ?? 3, 1, 5);
  review.pass_score = type.pass_score ?? review.pass_score ?? 80;
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
  Object.assign(illustrations, normalizeImageCount(type.image_count));
  if (type.image_position_format) illustrations.position_format = String(type.image_position_format);
  illustrations.min = clamp(illustrations.min ?? 1, 1, 5);
  illustrations.max = clamp(illustrations.max ?? 5, illustrations.min, 5);
  if (illustrations.count !== undefined) {
    illustrations.count = clamp(illustrations.count, illustrations.min, illustrations.max);
  }

  const publish = deepMerge(defaults.publish || {}, type.publish || {});
  publish.email = { ...(defaults.publish?.email || {}), ...(type.publish?.email || {}) };
  publish.wechat = { ...(defaults.publish?.wechat || {}), ...(type.publish?.wechat || {}) };

  const knowledgeDirs = (Array.isArray(type.knowledge_base_path)
    ? type.knowledge_base_path
    : type.knowledge_base_path !== undefined
      ? [type.knowledge_base_path]
      : type.knowledge_dirs || [])
    .filter(Boolean)
    .map((dir) => path.resolve(root, String(dir)));

  const length = normalizeWordLimit(type.word_limit ?? type.length);
  const criteria = Array.isArray(type.scoring_criteria)
    ? type.scoring_criteria
    : Array.isArray(type.scoring?.dimensions)
      ? type.scoring.dimensions
      : [];
  const totalWeight = criteria.reduce((sum, d) => sum + Number(d.weight || 0), 0) || 1;

  const style = typeof type.style === "string" ? { persona: type.style } : type.style || {};

  return {
    ...type,
    id,
    name: type.type || type.name || id,
    description: type.description || "",
    enabled: type.enabled !== false,
    knowledge_dirs: knowledgeDirs,
    knowledge,
    style,
    length,
    scoring: {
      pass_score: type.pass_score ?? type.scoring?.pass_score ?? review.pass_score,
      dimensions: criteria.map((dimension) => ({
        ...dimension,
        weight: Number(dimension.weight || 0) / totalWeight,
      })),
    },
    review,
    illustrations,
    publish,
    topic: { keywords: [], exclude_keywords: [], candidates: 12, ...(type.topic || {}) },
    prompts: type.prompts || {},
    model: type.model || defaults.model || "llm.local",
    config,
  };
}

/** `1500` / `"800-1300"` / `{min,max,target}` → { min, max, target }。 */
export function normalizeWordLimit(value) {
  let min = 800;
  let max = 2000;
  let target;
  if (typeof value === "number" && Number.isFinite(value)) {
    min = max = Math.round(value);
  } else if (typeof value === "string") {
    const pair = value.match(/(\d+)\s*[-~到]\s*(\d+)/);
    if (pair) {
      min = Number(pair[1]);
      max = Number(pair[2]);
    } else if (/^\d+$/.test(value.trim())) {
      min = max = Number(value.trim());
    }
  } else if (value && typeof value === "object") {
    min = Number(value.min ?? min);
    max = Number(value.max ?? max);
    if (value.target !== undefined) target = Number(value.target);
  }
  if (!Number.isFinite(min) || min <= 0) min = 800;
  if (!Number.isFinite(max) || max <= 0) max = 2000;
  if (max < min) max = min;
  return { min, max, target: Number.isFinite(target) ? target : Math.round((min + max) / 2) };
}

/** `3` / `"1-5"` / `{min,max,default,cover}` → { min, max, count?, cover? }。 */
export function normalizeImageCount(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.round(value);
    return { min: n, max: n, count: n };
  }
  if (typeof value === "string") {
    const pair = value.match(/(\d+)\s*[-~到]\s*(\d+)/);
    if (pair) return { min: Number(pair[1]), max: Number(pair[2]) };
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      return { min: n, max: n, count: n };
    }
    return {};
  }
  if (typeof value === "object") {
    const out = {};
    if (value.min !== undefined) out.min = Number(value.min);
    if (value.max !== undefined) out.max = Number(value.max);
    const count = value.default ?? value.count;
    if (count !== undefined) out.count = Number(count);
    if (value.cover !== undefined) out.cover = value.cover !== false;
    return out;
  }
  return {};
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
  const id = name || config.defaults?.model || "llm.local";
  if (id === "none") return { id: "none", provider: "none" };
  const models = config.models || {};
  let key = id;
  let profile = models[key];
  // 兼容旧写法：model: local → llm.local
  if (!profile && !String(id).includes(".")) {
    key = `llm.${id}`;
    profile = models[key];
  }
  if (!profile) {
    throw new Error(`Unknown model id "${id}". Available: ${Object.keys(models).join(", ")}`);
  }
  return { id: key, ...profile };
}

/** 判断模型 id 是否存在；none 是保留值（纯本地脚本）。 */
export function hasModel(config, id) {
  if (!id || id === "none") return true;
  if (config.models?.[id]) return true;
  return !String(id).includes(".") && Boolean(config.models?.[`llm.${id}`]);
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

/** 硬错误：会阻止管线启动。 */
export function validateConfig(config) {
  const issues = [];
  if (!Array.isArray(config.types) || config.types.length === 0) issues.push("types 不能为空");
  for (const type of config.types || []) {
    if (!type.id) issues.push("存在缺少 id 的文章类型");
    if (!type.name) issues.push(`${type.id}: 缺少 type（类型名称）`);
    if (!type.scoring?.dimensions?.length) issues.push(`${type.id}: 缺少 scoring_criteria`);
    if (type.knowledge_dirs.length === 0) issues.push(`${type.id}: 未配置 knowledge_base_path，将无法从本地知识库选题`);
    for (const dir of type.knowledge_dirs) {
      if (!fs.existsSync(dir)) issues.push(`${type.id}: 知识库目录不存在 ${dir}`);
    }
    if (type.length.min > type.length.max) issues.push(`${type.id}: word_limit.min 应小于等于 word_limit.max`);
    if (type.illustrations.min > type.illustrations.max) issues.push(`${type.id}: image_count.min 应小于等于 image_count.max`);
    if (!hasModel(config, type.model)) issues.push(`${type.id}: model "${type.model}" 未在 models.yaml 中定义`);
    if (!hasModel(config, type.review?.model || type.model)) {
      issues.push(`${type.id}: review.model "${type.review?.model}" 未在 models.yaml 中定义`);
    }
    if (type.knowledge.source !== "local") {
      const w = type.knowledge.weknora || {};
      if (!w.base_url) issues.push(`${type.id}: knowledge_source=${type.knowledge.source} 但未配置 weknora.base_url`);
      if (!w.api_key) issues.push(`${type.id}: knowledge_source=${type.knowledge.source} 但未配置 weknora.api_key`);
      if (!w.kb_ids?.length) issues.push(`${type.id}: knowledge_source=${type.knowledge.source} 但未配置 weknora.kb_ids`);
    }
  }
  return issues;
}

/** 软警告：不阻止运行，但会在 validate 里提示。 */
export function validateWarnings(config) {
  const warnings = [];
  const classifier = config.classifier || {};
  if (classifier.enabled) {
    if (!classifier.base_url) {
      warnings.push("判断模型（systemone）未配置 SYSTEMONE_BASE_URL，录入时不会自动分类，将回退到 classifier.default_type");
    }
    if (classifier.default_type && !config.types.some((type) => type.id === classifier.default_type)) {
      warnings.push(`classifier.default_type="${classifier.default_type}" 不在 types 中`);
    }
    if (!classifier.default_type) {
      warnings.push("classifier.default_type 未设置：判断模型不可用时，未指定 --type 的录入会直接报错");
    }
    if (classifier.deep_model_id && !classifier.deep) {
      warnings.push(`classifier.deep_model="${classifier.deep_model_id}" 未在 models.yaml 定义，不会进行二次判断`);
    }
  }
  return warnings;
}

/** Coerce JSON/env values ("true"/"false"/0/1) into a boolean. */
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled"].includes(text)) return false;
  if (["true", "1", "yes", "on", "enabled"].includes(text)) return true;
  return fallback;
}
