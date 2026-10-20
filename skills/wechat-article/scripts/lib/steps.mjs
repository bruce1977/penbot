import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expandEnv } from "./env.mjs";
import { normalizeModelMap } from "./config.mjs";

export const DEFAULT_STEPS_PATH = "skills/wechat-article/config/steps.yaml";

/** 模型字段的大写别名 → 内部小写字段。两种写法都接受。 */
const MODEL_ALIASES = {
  PROVIDER: "provider",
  BASE_URL: "base_url",
  MODEL: "model_name",
  model: "model_name",
  MODEL_NAME: "model_name",
  API_KEY: "api_key",
  ENDPOINT: "endpoint",
  COMMAND: "command",
  AGENT: "agent",
  TEMPERATURE: "temperature",
  MAX_TOKENS: "max_tokens",
  NUM_CTX: "num_ctx",
  TIMEOUT_MS: "timeout",
  timeout_ms: "timeout",
};

const MODEL_PROVIDERS = new Set(["ollama", "openai", "opencode", "systemone", "image", "none", "mock"]);

/**
 * 读取 steps.yaml，展开 ${ENV}，归一化模型、handler、提示词和 I/O 契约。
 * 文件不存在会抛错；CLI 会先判断存在性（steps 是可选配置）。
 */
export function loadSteps(stepsPath = DEFAULT_STEPS_PATH, { root = process.cwd(), config } = {}) {
  const resolved = path.isAbsolute(stepsPath) ? stepsPath : path.resolve(root, stepsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`步骤配置不存在：${resolved}`);
  }
  const raw = readYamlFile(resolved, "步骤配置");
  const configDir = path.dirname(resolved);
  // 独立使用 loadSteps 时，自动读取同目录的 models.yaml；
  // CLI 会传入完整 config，直接用 config.models。
  const models = config?.models || loadModelsFallback(configDir);
  const prompts = config?.prompts || loadRegistryDir(configDir, "prompts", "prompts");
  const schemas = config?.schemas || loadRegistryDir(configDir, "schemas", "schemas");
  return normalizeSteps(expandEnv(raw), {
    root,
    config: { ...(config || {}), models, prompts, schemas, __dir: config?.__dir || configDir },
    file: resolved,
    prompts,
    schemas,
  });
}

/**
 * 读取 config/prompts/*.yaml、config/schemas/*.yaml。
 * 每个文件用顶层 prompts:/schemas: 包一层；id 由「文件名（去扩展名）+ 配置项 key」组成，
 * 例如 prompts/topic.yaml 里的 classify_type → topic.classify_type。
 * 没有这一层的文件（例如 prompts/draft.json）会被跳过。
 */
function loadRegistryDir(configDir, dirName, key) {
  const dir = path.join(configDir, dirName);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.(ya?ml|json)$/i.test(name) && !name.startsWith("_"))
    .sort();
  for (const name of files) {
    const file = path.join(dir, name);
    const data = expandEnv(readYamlFile(file, key === "prompts" ? "提示词文件" : "数据结构文件"));
    if (data[key] === undefined) continue;
    if (!isPlainObject(data[key])) {
      throw new Error(`${file} 的 ${key}: 必须是对象（key = 配置项名）`);
    }
    const namespace = path.basename(name, path.extname(name));
    if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) {
      throw new Error(`${file} 的文件名不能作为 id 命名空间：${namespace}`);
    }
    for (const [item, value] of Object.entries(data[key])) {
      if (!/^[a-z][a-z0-9_]*$/.test(item)) {
        throw new Error(`${file} 的配置项名不合法：${item}（只允许小写字母、数字、下划线）`);
      }
      const id = `${namespace}.${item}`;
      if (Object.prototype.hasOwnProperty.call(out, id)) {
        throw new Error(`${key} id 重复：${id}（${file}）`);
      }
      out[id] = value;
    }
  }
  return out;
}

function loadModelsFallback(dir) {
  const file = path.join(dir, "models.yaml");
  if (!fs.existsSync(file)) return {};
  const raw = readYamlFile(file, "模型配置");
  return normalizeModelMap({ model_groups: raw.models && typeof raw.models === "object" ? raw.models : raw });
}

export function normalizeSteps(
  raw = {},
  { root = process.cwd(), config, file = "", prompts, schemas } = {},
) {
  const defaults = raw.defaults || {};
  const models = config?.models || raw.models || {};
  const promptRegistry = prompts || config?.prompts || {};
  const schemaRegistry = schemas || config?.schemas || {};
  const defaultModel = normalizeModel(defaults.model || {}, {}, models);
  const dir = file ? path.dirname(file) : root;
  // phases 是推荐的 key → value 写法；steps 数组/对象继续兼容。
  const entries = resolveStepEntries(raw.phases !== undefined ? raw.phases : raw.steps, {
    dir,
    file,
  });
  const steps = entries.map((step, index) =>
    normalizeStep(step, {
      defaults,
      defaultModel,
      models,
      root,
      index,
      file: step.__file || file,
      prompts: promptRegistry,
      schemas: schemaRegistry,
    }),
  );
  const byName = new Map();
  for (const step of steps) byName.set(step.step_name, step);

  return {
    version: Number(raw.version || 1),
    file,
    defaults: {
      retry_limit: toInt(defaults.retry_limit, 0),
      timeout: toInt(defaults.timeout, 600000),
      prompt: defaults.prompt || {},
    },
    models,
    prompts: promptRegistry,
    schemas: schemaRegistry,
    steps,
    byName,
    config,
  };
}

/**
 * phases 推荐写法：key = 阶段名，value = 阶段文件。
 *   phases:
 *     topic: steps/10-topic.yaml
 *
 * 兼容旧写法：steps 数组 + 文件引用/内联步骤。
 */
function resolveStepEntries(entries, { dir, file }) {
  if (entries === undefined || entries === null) return [];
  if (Array.isArray(entries)) return resolveEntryList(entries, { dir, file });
  if (isPlainObject(entries)) {
    const out = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry === "string") {
        out.push(...readPhaseSteps(resolveStepFile(dir, entry)));
        continue;
      }
      if (!isPlainObject(entry)) {
        throw new Error(`phases.${key} 必须是文件名或对象`);
      }
      if (entry.file) {
        const phaseFile = resolveStepFile(dir, entry.file);
        const { file: _file, ...inline } = entry;
        for (const step of readPhaseSteps(phaseFile)) out.push({ ...step, ...inline });
        continue;
      }
      if (entry.step_name || entry.name || entry.handler) {
        out.push({ ...entry, step_name: entry.step_name || entry.name || key, __file: file });
        continue;
      }
      out.push(...readPhaseData(entry, file));
    }
    return out;
  }
  throw new Error(`phases / steps 必须是数组或对象：${JSON.stringify(entries)}`);
}

function resolveEntryList(entries, { dir, file }) {
  const out = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      out.push(...readPhaseSteps(resolveStepFile(dir, entry)));
      continue;
    }
    if (!isPlainObject(entry)) continue;
    if (entry.file) {
      const phaseFile = resolveStepFile(dir, entry.file);
      const { file: _file, ...inline } = entry;
      for (const step of readPhaseSteps(phaseFile)) out.push({ ...step, ...inline });
      continue;
    }
    if (entry.step_name || entry.name) {
      out.push({ ...entry, __file: file });
      continue;
    }
    out.push(...readPhaseData(entry, file));
  }
  return out;
}

function readPhaseSteps(file) {
  return readPhaseData(expandEnv(readYamlFile(file, "步骤文件")), file);
}

/**
 * 阶段文件支持两种步骤写法：
 *   steps:
 *     select_topic: { handler: ..., model: ... }   # 推荐，key = step_name
 *   steps:
 *     - step_name: select_topic ...
 *
 * 提示词和数据结构不写在这里，只用 id 引用：
 *   prompt: select_topic
 *   schema: select_topic
 */
function readPhaseData(data, file) {
  const rawSteps = data.steps;
  let list;
  if (Array.isArray(rawSteps)) {
    list = rawSteps.map((step) => ({ ...step }));
  } else if (isPlainObject(rawSteps)) {
    list = Object.entries(rawSteps).map(([name, step]) => {
      if (!isPlainObject(step)) throw new Error(`步骤 ${name} 必须是对象（${file}）`);
      return { ...step, step_name: name };
    });
  } else if (data.step_name || data.name) {
    list = [data];
  } else {
    throw new Error(`步骤文件缺少 steps: 对象/数组或 step_name：${file}`);
  }

  return list.map((step) => ({
    ...step,
    step_name: String(step.step_name || step.name || "").trim(),
    __file: file,
  }));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveStepFile(dir, ref) {
  const value = String(ref || "").trim();
  if (!value) throw new Error("步骤文件引用为空");
  const base = path.isAbsolute(value) ? value : path.resolve(dir, value);
  const candidates = /\.(ya?ml)$/i.test(base) ? [base] : [`${base}.yaml`, `${base}.yml`];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`找不到步骤文件：${value}（基准目录 ${dir}）`);
  return found;
}

function readYamlFile(file, label) {
  let data;
  try {
    data = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}解析失败：${file}（${error.message}）`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label}根节点必须是对象：${file}`);
  }
  return data;
}

function normalizeStep(
  step = {},
  { defaults, defaultModel, models, root, index, file, prompts = {}, schemas = {} },
) {
  const name = String(step.step_name || step.name || "").trim();
  if (!name) throw new Error(`${file || "steps.yaml"} 第 ${index + 1} 个步骤缺少 step_name`);

  const modelInput = step.model === undefined ? defaultModel : step.model;
  const model = normalizeModel(modelInput, defaultModel, models);
  const schema = resolveSchemaRef(step.schema, { schemas, step: name });
  const inputFormat = step.input_format !== undefined ? step.input_format : schema.input;
  const outputFormat = step.output_format !== undefined ? step.output_format : schema.output;

  return {
    step_name: name,
    label: String(step.label || name),
    description: String(step.description || ""),
    stage: String(step.stage || name),
    enabled: step.enabled !== false,
    modes: toStringArray(step.modes, ["auto", "manual", "run"]),
    handler: parseHandler(step.handler, root),
    model,
    handler_options: step.handler_options || {},
    input_format: inputFormat || {},
    output_format: outputFormat || {},
    retry_limit: Math.max(0, toInt(step.retry_limit, defaults.retry_limit ?? 0)),
    timeout: toInt(step.timeout, defaults.timeout ?? 600000),
    loop: step.loop || null,
    artifacts: normalizeArtifacts(step.artifacts),
    depends_on: toStringArray(step.depends_on, []),
    prompt: normalizePrompt(resolvePromptRef(step.prompt, { prompts, step: name }), defaults.prompt),
    prompt_id: typeof step.prompt === "string" ? step.prompt : "",
    schema: step.schema || "",
    schema_id: typeof step.schema === "string" ? step.schema : "",
    when: step.when || "",
    source: file || "",
  };
}

function resolvePromptRef(value, { prompts = {}, step = "" } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return value;
  const id = value.trim();
  if (!id) return {};
  if (!Object.prototype.hasOwnProperty.call(prompts, id)) {
    throw new Error(`步骤 ${step || "?"} 引用了不存在的提示词 id：${id}`);
  }
  return prompts[id];
}

function resolveSchemaRef(value, { schemas = {}, step = "" } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return value;
  const id = value.trim();
  if (!id) return {};
  if (!Object.prototype.hasOwnProperty.call(schemas, id)) {
    throw new Error(`步骤 ${step || "?"} 引用了不存在的数据结构 id：${id}`);
  }
  return schemas[id];
}

/** handler 支持 builtin:xxx、相对脚本路径、HTTP(S) URL，或 { kind, entry } 对象。 */
export function parseHandler(handler, root = process.cwd()) {
  if (handler && typeof handler === "object") {
    const kind = String(handler.kind || handler.type || "").trim() || inferKind(handler.entry || handler.path || handler.url || "");
    const value = String(handler.entry || handler.path || handler.url || "").trim();
    return {
      kind,
      entry: kind === "builtin" ? value.replace(/^builtin:/, "") : "",
      path: kind === "script" ? resolveScript(value, root) : "",
      url: kind === "http" ? value : "",
      raw: value,
    };
  }

  const value = String(handler || "").trim();
  const kind = inferKind(value);
  if (kind === "http") return { kind, entry: "", path: "", url: value, raw: value };
  if (kind === "script") return { kind, entry: "", path: resolveScript(value, root), url: "", raw: value };
  return { kind: "builtin", entry: value.replace(/^builtin:/, ""), path: "", url: "", raw: value };
}

function inferKind(value) {
  if (/^https?:\/\//i.test(value)) return "http";
  if (/\.(mjs|cjs|js|ts|ps1|cmd|bat|sh)$/i.test(value)) return "script";
  if (value.startsWith("builtin:")) return "builtin";
  return "builtin";
}

function resolveScript(value, root) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * 归一化模型配置。合并顺序：base → input。
 * 支持字符串 profile（models.<name>）和对象；对象里 BASE_URL 等大写键会转成小写。
 */
export function normalizeModel(input, base = {}, profiles = {}) {
  if (input === "none") return { provider: "none" };
  if (typeof input === "string") {
    if (!input || input === "default") return normalizeModel(base, {}, profiles);
    const profile = profiles[input] || (!input.includes(".") ? profiles[`llm.${input}`] : undefined);
    if (!profile) throw new Error(`未知模型 id：${input}（config/models.yaml 里没有）`);
    // 命中的是完整模型定义，不再叠加 defaults，避免把 llm 的 model 带进 systemone。
    return normalizeModel(profile, {}, profiles);
  }

  const incoming = { ...(input && typeof input === "object" ? input : {}) };
  // 先把大写别名转成小写，再做合并；否则 base 里的 provider/base_url 会盖掉步骤自己的值。
  for (const [alias, key] of Object.entries(MODEL_ALIASES)) {
    if (incoming[alias] !== undefined) {
      if (incoming[key] === undefined) incoming[key] = incoming[alias];
      delete incoming[alias];
    }
  }
  if (String(incoming.provider || "").toLowerCase() === "none") {
    return { provider: "none" };
  }

  const merged = { ...(base || {}), ...incoming };
  for (const [alias, key] of Object.entries(MODEL_ALIASES)) {
    if (merged[alias] !== undefined) {
      if (merged[key] === undefined) merged[key] = merged[alias];
      delete merged[alias];
    }
  }

  const provider = String(merged.provider || "ollama").toLowerCase();
  return {
    provider,
    base_url: String(merged.base_url || ""),
    model_name: String(merged.model_name || merged.model || ""),
    api_key: String(merged.api_key || ""),
    endpoint: String(merged.endpoint || ""),
    command: String(merged.command || "opencode"),
    agent: String(merged.agent || ""),
    temperature: optionalNumber(merged.temperature),
    max_tokens: optionalNumber(merged.max_tokens),
    num_ctx: optionalNumber(merged.num_ctx),
    timeout: optionalNumber(merged.timeout ?? merged.timeout_ms),
  };
}

function normalizePrompt(prompt, defaultPrompt = {}) {
  const value = typeof prompt === "string" ? { user: prompt } : prompt || {};
  const merged = { ...(defaultPrompt || {}), ...value };
  const out = {};
  for (const [key, text] of Object.entries(merged)) {
    out[key] = typeof text === "string" ? text : text == null ? "" : String(text);
  }
  return out;
}

function normalizeArtifacts(artifacts = {}) {
  if (Array.isArray(artifacts)) return { reads: [], writes: artifacts.map(String) };
  return {
    reads: toStringArray(artifacts?.reads, []),
    writes: toStringArray(artifacts?.writes, []),
  };
}

export function getStep(steps, name) {
  if (!steps) return null;
  if (steps.byName) return steps.byName.get(name) || null;
  if (Array.isArray(steps)) return steps.find((step) => step.step_name === name) || null;
  return null;
}

export function stepNames(steps) {
  return (steps?.steps || []).map((step) => step.step_name);
}

/**
 * 合并类型覆盖：config/types/<id>.yaml 里的
 *   steps.<step_name>.{model,timeout,retry_limit,prompt,enabled,handler_options}
 * 优先于 steps.yaml 的默认值。
 */
export function resolveStep(stepOrName, { steps, type } = {}) {
  const step = typeof stepOrName === "string" ? getStep(steps, stepOrName) : stepOrName;
  if (!step) return null;
  const override = type?.steps?.[step.step_name] || {};
  const model = override.model !== undefined
    ? normalizeModel(override.model, step.model, steps?.models || {})
    : step.model;
  const schema = override.schema === undefined
    ? null
    : resolveSchemaRef(override.schema, {
        schemas: steps?.schemas || {},
        step: step.step_name,
      });

  return {
    ...step,
    enabled: override.enabled ?? step.enabled,
    model,
    retry_limit: Math.max(0, toInt(override.retry_limit, step.retry_limit)),
    timeout: Math.max(1, toInt(override.timeout, step.timeout)),
    handler_options: deepMerge(step.handler_options, override.handler_options),
    input_format: override.input_format ?? schema?.input ?? step.input_format,
    output_format: override.output_format ?? schema?.output ?? step.output_format,
    prompt: resolveStepPrompt(step.step_name, { steps, type }),
    prompt_id: typeof override.prompt === "string" ? override.prompt : step.prompt_id,
    schema: override.schema ?? step.schema,
    schema_id: typeof override.schema === "string" ? override.schema : step.schema_id,
  };
}

/**
 * 提示词优先级：type.steps.<step>.prompt > steps 里的 prompt id。
 * type.steps.<step>.prompt 是提示词 id，例如 ai-news.draft_writing；
 * 对应配置在 config/prompts/ai-news.yaml 的 draft_writing 项。
 * 旧 prompts.*_extra 继续追加。
 */
export function resolveStepPrompt(stepOrName, { steps, type } = {}) {
  const step = typeof stepOrName === "string" ? getStep(steps, stepOrName) : stepOrName;
  if (!step) return {};
  const prompts = steps?.prompts || {};
  const overrideValue = type?.steps?.[step.step_name]?.prompt;
  const override = overrideValue === undefined
    ? {}
    : resolvePromptRef(overrideValue, { prompts, step: step.step_name });
  const prompt = { ...(step.prompt || {}), ...override };

  const legacyKey = LEGACY_EXTRA[step.step_name];
  const legacy = legacyKey ? type?.prompts?.[legacyKey] : "";
  if (legacy) prompt.extra = [prompt.extra, legacy].filter(Boolean).join("\n");

  return prompt;
}

const LEGACY_EXTRA = {
  select_topic: "topic_extra",
  outline: "outline_extra",
  draft_writing: "draft_extra",
  review: "review_extra",
  scoring: "score_extra",
  revision: "revise_extra",
  length_adjust: "length_extra",
};

export function validateSteps(steps, { types = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!steps) {
    warnings.push("未加载步骤配置（config/steps.yaml 不存在）");
    return { errors, warnings };
  }
  if (!steps.steps.length) errors.push("steps.yaml 里没有任何步骤");

  const names = new Set();
  for (const step of steps.steps) {
    const label = step.step_name || "(未命名)";
    if (!/^[a-z][a-z0-9_]*$/.test(step.step_name)) {
      errors.push(`步骤名不合法：${label}（只允许小写字母、数字、下划线）`);
    }
    if (names.has(step.step_name)) errors.push(`步骤名重复：${label}`);
    names.add(step.step_name);

    if (!["builtin", "script", "http"].includes(step.handler.kind)) {
      errors.push(`步骤 ${label} 的 handler.kind 不支持：${step.handler.kind}`);
    }
    if (step.handler.kind === "builtin" && !step.handler.entry) {
      errors.push(`步骤 ${label} 缺少 handler entry（例如 builtin:select_topic）`);
    }
    if (step.handler.kind === "script" && !step.handler.path) {
      errors.push(`步骤 ${label} 缺少脚本路径`);
    }
    if (step.handler.kind === "http" && !step.handler.url) {
      errors.push(`步骤 ${label} 缺少 HTTP URL`);
    }
    if (!(step.timeout > 0)) errors.push(`步骤 ${label} 的 timeout 必须大于 0`);
    if (step.retry_limit < 0) errors.push(`步骤 ${label} 的 retry_limit 不能为负数`);

    if (!Object.keys(step.input_format || {}).length) warnings.push(`步骤 ${label} 未声明 input_format`);
    if (!Object.keys(step.output_format || {}).length) warnings.push(`步骤 ${label} 未声明 output_format`);

    if (!MODEL_PROVIDERS.has(step.model.provider)) {
      errors.push(`步骤 ${label} 的 model.provider 不支持：${step.model.provider}`);
    }
    if (requiresModelName(step.model) && !step.model.model_name && !step.model.agent) {
      warnings.push(`步骤 ${label} 使用 ${step.model.provider}，但没配置 MODEL_NAME`);
    }
    if (requiresBaseUrl(step.model) && !step.model.base_url) {
      warnings.push(`步骤 ${label} 使用 ${step.model.provider}，但没配置 BASE_URL`);
    }
  }

  for (const step of steps.steps) {
    for (const dep of step.depends_on) {
      if (!names.has(dep)) errors.push(`步骤 ${step.step_name} 依赖了不存在的步骤：${dep}`);
    }
  }

  for (const type of types) {
    for (const name of Object.keys(type.steps || {})) {
      if (!names.has(name)) warnings.push(`类型 ${type.id} 覆盖了未知步骤：${name}`);
      const override = type.steps?.[name] || {};
      if (typeof override.prompt === "string" && !hasId(steps.prompts, override.prompt)) {
        errors.push(`类型 ${type.id} 的步骤 ${name} 引用了不存在的提示词 id：${override.prompt}`);
      }
      if (typeof override.schema === "string" && !hasId(steps.schemas, override.schema)) {
        errors.push(`类型 ${type.id} 的步骤 ${name} 引用了不存在的数据结构 id：${override.schema}`);
      }
    }
  }

  return { errors, warnings };
}

function requiresModelName(model) {
  return ["ollama", "openai", "systemone", "image"].includes(model.provider) && !model.model_name;
}

function hasId(map, id) {
  return Boolean(map && Object.prototype.hasOwnProperty.call(map, id));
}

function requiresBaseUrl(model) {
  return ["ollama", "openai", "image"].includes(model.provider) && !model.base_url;
}

export function formatModelLabel(model) {
  if (!model || model.provider === "none") return "none";
  if (model.provider === "opencode") {
    return `opencode:${model.agent || model.model_name || "default"}`;
  }
  return `${model.provider}:${model.model_name || "?"}`;
}

export function resolveSteps(steps, { type } = {}) {
  return (steps?.steps || []).map((step) => resolveStep(step, { steps, type }));
}

function deepMerge(base, override) {
  if (!override) return base || {};
  if (!base) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toStringArray(value, fallback) {
  if (value === undefined || value === null) return [...fallback];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
