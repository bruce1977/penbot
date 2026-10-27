import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expandEnv, toBool } from "./env.mjs";
import { normalizeModelMap } from "./config.mjs";

/**
 * 模型调用模板（统一标准见根目录 AGENTS.md）：
 * 每个步骤节点用 `models: { <调用名>: { id, options } }` 声明其真实模型调用，
 * id 前缀选择模板，options 是调用级参数（只允许模板白名单内的字段），
 * 未配置的参数吃 models.yaml 端点默认值。
 */
const CALL_TEMPLATES = {
  /** llm.*：文本生成调用。retry_limit = 结构化调用总尝试上限（含首轮）。 */
  llm: ["retry_limit", "timeout", "temperature", "max_tokens"],
  /** systemone.*：判断调用。deep = 低置信度时升级的二次判断模型 id。 */
  systemone: ["deep", "escalate_below", "min_confidence"],
};

function templateOfModelId(id) {
  const prefix = String(id).split(".")[0];
  return CALL_TEMPLATES[prefix] ? prefix : "";
}

/** 调用项允许的字段；轮次/档位覆盖项只允许 id / options（提示词与数据结构只在默认调用上声明）。 */
const CALL_ENTRY_KEYS = ["id", "options"];

/** 校验并归一化 options（按模板白名单，数值字段就地转成数字）。 */
function normalizeOptions({ name, path: callPath, template, options, models, file }) {
  const value = options === undefined ? {} : options;
  if (!isPlainObject(value)) throw new Error(`步骤 ${name}.${callPath}.options 必须是对象（${file}）`);
  const allowed = CALL_TEMPLATES[template];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`步骤 ${name}.${callPath}（${template} 模板）不支持参数 ${key}；可用：${allowed.join(" / ")}`);
    }
  }
  if (template === "llm") {
    if (value.retry_limit !== undefined) {
      const n = toInt(value.retry_limit, NaN);
      if (!(n >= 1)) throw new Error(`步骤 ${name}.${callPath}.options.retry_limit 必须是 ≥1 的整数（总尝试上限，含首轮）`);
      value.retry_limit = n;
    }
    if (value.timeout !== undefined) {
      const n = toInt(value.timeout, NaN);
      if (!(n > 0)) throw new Error(`步骤 ${name}.${callPath}.options.timeout 必须大于 0（ms）`);
      value.timeout = n;
    }
    for (const key of ["temperature", "max_tokens"]) {
      if (value[key] !== undefined) {
        const n = Number(value[key]);
        if (!Number.isFinite(n)) throw new Error(`步骤 ${name}.${callPath}.options.${key} 必须是数字`);
        value[key] = n;
      }
    }
  } else {
    const deepId = value.deep === undefined || value.deep === "" ? "" : String(value.deep).trim();
    if (deepId) {
      if (templateOfModelId(deepId) !== "systemone") {
        throw new Error(`步骤 ${name}.${callPath}.options.deep 必须是 systemone.* 模型 id：${deepId}`);
      }
      if (!models[deepId]) {
        throw new Error(`步骤 ${name}.${callPath}.options.deep 引用了未在 config/models.yaml 定义的模型 id：${deepId}`);
      }
      value.deep = deepId;
    }
    for (const key of ["escalate_below", "min_confidence"]) {
      if (value[key] !== undefined) {
        const n = Number(value[key]);
        if (!(n >= 0 && n <= 1)) throw new Error(`步骤 ${name}.${callPath}.options.${key} 必须在 0-1 之间`);
        value[key] = n;
      }
    }
  }
  return value;
}

/**
 * 归一化单个模型调用项。baseTemplate 非空时表示变体覆盖项（轮次/档位）：
 * 允许省略 id（继承默认模型），且模板必须与默认调用一致。
 */
function normalizeCallEntry({ name, path: callPath, entry, models, file, baseTemplate = "", allowVariants = false }) {
  const value = typeof entry === "string" ? { id: entry } : entry;
  if (!isPlainObject(value)) {
    throw new Error(`步骤 ${name}.${callPath} 必须是 { id, options } 或模型 id 字符串（${file}）`);
  }
  const allowedKeys = allowVariants
    ? [...CALL_ENTRY_KEYS, "rounds", "levels", "prompt", "schema"]
    : CALL_ENTRY_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`步骤 ${name}.${callPath} 不支持字段 ${key}（可用：${allowedKeys.join(" / ")}）`);
    }
  }
  const id = String(value.id || "").trim();
  let template = baseTemplate;
  if (!id) {
    if (!baseTemplate) {
      throw new Error(`步骤 ${name}.${callPath} 必须是 { id, options } 或模型 id 字符串（${file}）`);
    }
  } else {
    template = templateOfModelId(id);
    if (!template) {
      throw new Error(`步骤 ${name}.${callPath} 的模型 id 必须落在已定义模板下（${Object.keys(CALL_TEMPLATES).join(" / ")}）：${id}`);
    }
    if (baseTemplate && template !== baseTemplate) {
      throw new Error(`步骤 ${name}.${callPath} 的变体覆盖（轮次/档位）必须与默认调用使用同一模板（${baseTemplate}）：${id}`);
    }
    if (!models[id]) throw new Error(`步骤 ${name}.${callPath} 引用了未在 config/models.yaml 定义的模型 id：${id}`);
  }
  const options = normalizeOptions({ name, path: callPath, template, options: value.options, models, file });
  return { id, template, options };
}

/** rounds: { <轮次>: { id?, options? } }，轮次从 1 起；覆盖项至少写 id 或一个 options 字段。 */
function normalizeRounds({ name, label, rounds, models, file, template }) {
  if (rounds === undefined) return {};
  if (!isPlainObject(rounds)) {
    throw new Error(`步骤 ${name}.${label}.rounds 必须是对象（键为轮次，从 1 起）（${file}）`);
  }
  const out = {};
  for (const [key, value] of Object.entries(rounds)) {
    if (!/^[1-9]\d*$/.test(key)) {
      throw new Error(`步骤 ${name}.${label}.rounds 的轮次键必须是从 1 起的整数：${key}`);
    }
    requireVariant(name, label, "rounds", key, value);
    const normalized = normalizeCallEntry({
      name,
      path: `${label}.rounds.${key}`,
      entry: value,
      models,
      file,
      baseTemplate: template,
    });
    out[Number(key)] = { model_id: normalized.id, options: normalized.options };
  }
  return out;
}

/**
 * levels: { <档位名>: { id?, options? } }，档位名是标识符（如 light / standard / deep）。
 * 与 rounds 同构：只覆盖写出的字段，档位由运行时传入（见各步骤 handler_options.level）。
 */
function normalizeLevels({ name, label, levels, models, file, template }) {
  if (levels === undefined) return {};
  if (!isPlainObject(levels)) {
    throw new Error(`步骤 ${name}.${label}.levels 必须是对象（键为档位名）（${file}）`);
  }
  const out = {};
  for (const [key, value] of Object.entries(levels)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(`步骤 ${name}.${label}.levels 的档位名不合法：${key}（只允许小写字母、数字、下划线）`);
    }
    requireVariant(name, label, "levels", key, value);
    const normalized = normalizeCallEntry({
      name,
      path: `${label}.levels.${key}`,
      entry: value,
      models,
      file,
      baseTemplate: template,
    });
    out[key] = { model_id: normalized.id, options: normalized.options };
  }
  return out;
}

function requireVariant(name, label, kind, key, value) {
  const entry = isPlainObject(value) ? value : {};
  const hasOptions = isPlainObject(entry.options) && Object.keys(entry.options).length > 0;
  if (!String(entry.id || "").trim() && !hasOptions) {
    throw new Error(`步骤 ${name}.${label}.${kind}.${key} 至少写 id 或一个 options 字段（否则是无效覆盖）`);
  }
}

/**
 * 归一化节点 models 注册表 → calls：
 * { 调用名: { label, model_id, template, options, prompt?, prompt_id?, schema?, schema_id?,
 *             output_format?, rounds?, levels? } }。
 * 写法不合规一律抛错（配置错误在加载期暴露，不在运行时静默降级）。
 *
 * 提示词与数据结构可以写在两处：
 *   - 节点级 prompt/schema（标量 id）：无模型调用节点（本地组装、外部 handler）或单调用节点；
 *   - 调用级 models.<调用名>.prompt/.schema：多调用节点的每次调用各写各的。
 * 多调用节点必须逐调用声明（节点级标量会被第二个调用误继承），加载期校验。
 */
function normalizeCalls(step, { models, name, file, prompts = {}, schemas = {} }) {
  for (const legacy of ["model", "retry_limit", "timeout"]) {
    if (step[legacy] !== undefined) {
      throw new Error(
        `步骤 ${name} 使用了已废弃的扁平字段 ${legacy}（${file}）：模型调用改用 models: { <调用名>: { id, options } }`,
      );
    }
  }
  const raw = step.models;
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new Error(`步骤 ${name} 的 models 必须是对象（${file}）`);

  const calls = {};
  for (const [label, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]*$/.test(label)) {
      throw new Error(`步骤 ${name} 的调用名不合法：${label}（只允许小写字母、数字、下划线）`);
    }
    const entry = typeof value === "string" ? { id: value } : value;
    if (!isPlainObject(entry) || !String(entry.id || "").trim()) {
      throw new Error(`步骤 ${name}.${label} 必须是 { id, options } 或模型 id 字符串（${file}）`);
    }
    const normalized = normalizeCallEntry({ name, path: label, entry, models, file, allowVariants: true });
    const call = { label, model_id: normalized.id, template: normalized.template, options: normalized.options };
    // 轮次/档位覆盖只有 llm 生成调用会用到（revision/scoring 传轮次、de_ai 传档位）；
    // 判断调用按标签一次一次发起，运行时不传轮次也不传档位，写了就是假配置。
    if (normalized.template !== "llm" && (entry.rounds !== undefined || entry.levels !== undefined)) {
      const kind = entry.rounds !== undefined ? "rounds" : "levels";
      throw new Error(
        `步骤 ${name}.${label} 不支持 ${kind}：${normalized.template} 判断调用运行时不传轮次/档位（只有 llm 生成调用可以）（${file}）`,
      );
    }
    if (entry.prompt !== undefined) {
      call.prompt = normalizePrompt(
        resolvePromptRef(entry.prompt, { prompts, step: `${name}.${label}` }),
        {},
      );
      call.prompt_id = typeof entry.prompt === "string" ? entry.prompt : "";
    }
    if (entry.schema !== undefined) {
      const schema = resolveSchemaRef(entry.schema, { schemas, step: `${name}.${label}` });
      call.schema = schema;
      call.schema_id = typeof entry.schema === "string" ? entry.schema : "";
      call.input_format = schema.input || {};
      call.output_format = schema.output || {};
    }
    const rounds = normalizeRounds({
      name,
      label,
      rounds: entry.rounds,
      models,
      file,
      template: normalized.template,
    });
    if (Object.keys(rounds).length) call.rounds = rounds;
    const levels = normalizeLevels({
      name,
      label,
      levels: entry.levels,
      models,
      file,
      template: normalized.template,
    });
    if (Object.keys(levels).length) call.levels = levels;
    calls[label] = call;
  }
  return calls;
}

/**
 * 解析一次调用的最终模型与参数：默认调用 → 档位覆盖（levels）→ 轮次覆盖（rounds）。
 * 两级覆盖都只替换写出的字段（id 缺省继承，options 按键合并），
 * 轮次后应用是因为它更贴近本次运行的真实上下文。
 */
export function resolveCall(call, round = null, level = null) {
  let resolved = { model_id: call?.model_id || "", options: { ...(call?.options || {}) } };
  const levelOverride = level === null || level === undefined ? null : call?.levels?.[String(level)];
  if (levelOverride) {
    resolved = {
      model_id: levelOverride.model_id || resolved.model_id,
      options: { ...resolved.options, ...levelOverride.options },
    };
  }
  const roundOverride = round === null || round === undefined ? null : call?.rounds?.[Number(round)];
  if (!roundOverride) return resolved;
  return {
    model_id: roundOverride.model_id || resolved.model_id,
    options: { ...resolved.options, ...roundOverride.options },
  };
}

/**
 * 读取 steps.yaml，展开 ${ENV}，归一化模型、handler、提示词和 I/O 契约。
 * 文件不存在会抛错；CLI 会先判断存在性（steps 是可选配置）。
 */
export function loadSteps(stepsPath, { root = process.cwd(), config } = {}) {
  if (!stepsPath) throw new Error("缺少步骤配置路径：入口应传入 featurePaths(<feature>).steps 或 --steps");
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
 * 没有这一层的文件会被跳过。
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
  // models.yaml 全局唯一：先找功能目录（旧布局），再退到上一级 config/models.yaml。
  const file = [path.join(dir, "models.yaml"), path.join(path.dirname(dir), "models.yaml")].find((f) => fs.existsSync(f));
  if (!file) return {};
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
  for (const legacy of ["model", "retry_limit", "timeout"]) {
    if (defaults[legacy] !== undefined) {
      throw new Error(
        `steps 配置的 defaults.${legacy} 已废弃：调用参数只在各节点 models.<调用名>.options 配置（默认值吃 config/models.yaml）`,
      );
    }
  }
  const dir = file ? path.dirname(file) : root;
  // phases 是推荐的 key → value 写法；steps 数组/对象继续兼容。
  const entries = resolveStepEntries(raw.phases !== undefined ? raw.phases : raw.steps, {
    dir,
    file,
  });
  const steps = entries.map((step, index) =>
    normalizeStep(step, {
      defaults,
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
    file,
    defaults: {
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
 *     select_topic: { handler: ..., models: { ... } }   # 推荐，key = step_name
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
    throw new Error(`${label}解析失败：${file}（${error.message}）`, { cause: error });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label}根节点必须是对象：${file}`);
  }
  return data;
}

function normalizeStep(
  step = {},
  { defaults, models, root, index, file, prompts = {}, schemas = {} },
) {
  const name = String(step.step_name || step.name || "").trim();
  if (!name) throw new Error(`${file || "steps.yaml"} 第 ${index + 1} 个步骤缺少 step_name`);

  const calls = normalizeCalls(step, { models, name, file, prompts, schemas });
  requirePerCallContracts(step, calls, { name, file });
  const schema = resolveSchemaRef(step.schema, { schemas, step: name });
  // result_schema 校验的是**脚本自己落盘的 NN-result.json 本体**（title/type/files 之外的载荷），
  // 与节点级 schema（模型输出/中间产物的契约）是两件事：01–04 的 schema 口已被模型调用占用。
  const resultSchema = resolveSchemaRef(step.result_schema, { schemas, step: name });
  if (step.result_schema !== undefined && Object.keys(resultSchema.output || {}).length === 0) {
    throw new Error(
      `步骤 ${name} 的 result_schema ${step.result_schema} 没有 output DSL（${file}）：result 本体的契约必须是可执行紧凑 DSL，挂了没人校验就是说谎`,
    );
  }
  const inputFormat = step.input_format !== undefined ? step.input_format : (schema.input || resultSchema.input);
  const outputFormat = step.output_format !== undefined ? step.output_format : schema.output;

  return {
    step_name: name,
    label: String(step.label || name),
    description: String(step.description || ""),
    stage: String(step.stage || name),
    stage_declared: step.stage !== undefined && String(step.stage).trim() !== "",
    // enabled 可由 `${PB_*_ENABLED:-true}` 抬起（04 的两条分支），expandEnv 之后是字符串：
    // 用 `!== false` 判会让 "false" 当成开，所以走 toBool。是否显式写了开关由下面这行记。
    enabled: toBool(step.enabled, true),
    // 是否显式写了 enabled：validateSteps 用它判断"写了关不掉的开关"。
    enabled_declared: step.enabled !== undefined,
    modes: toStringArray(step.modes, ["auto", "manual", "run"]),
    handler: parseHandler(step.handler, root),
    // 模型调用注册表：{ 调用名: { model_id, template, options, rounds?, levels? } }；无调用的本地节点为空。
    calls,
    handler_options: step.handler_options || {},
    input_format: inputFormat || {},
    output_format: outputFormat || {},
    artifacts: normalizeArtifacts(step.artifacts),
    depends_on: toStringArray(step.depends_on, []),
    prompt: normalizePrompt(resolvePromptRef(step.prompt, { prompts, step: name }), defaults.prompt),
    prompt_id: typeof step.prompt === "string" ? step.prompt : "",
    schema: step.schema || "",
    schema_id: typeof step.schema === "string" ? step.schema : "",
    // NN-result.json 本体的校验契约（紧凑 DSL），由入口在落盘前跑 validateProduced。
    result_schema: step.result_schema || "",
    result_output_format: resultSchema.output || {},
    source: file || "",
  };
}

/**
 * 多调用节点的提示词/数据结构必须逐调用声明：节点级标量只属于单调用节点，
 * 或无模型调用的本地节点（组稿、发布这类只产 JSON 的节点）。两个调用共用同一份
 * 节点级提示词时，第二个调用会拿到不相干的文案并静默降级，所以加载期直接抛错。
 */
function requirePerCallContracts(step, calls, { name, file }) {
  const labels = Object.keys(calls);
  if (labels.length === 1 && step.prompt !== undefined && calls[labels[0]].prompt) {
    throw new Error(
      `步骤 ${name} 的提示词声明了两处（节点级 prompt 与 models.${labels[0]}.prompt），只保留一处（${file}）`,
    );
  }
  if (labels.length < 2) return;
  for (const label of labels) {
    if (!calls[label].prompt) {
      throw new Error(
        `步骤 ${name} 有 ${labels.length} 个模型调用，models.${label}.prompt 必须单独声明提示词 id（${file}）`,
      );
    }
  }
  for (const key of ["prompt", "schema"]) {
    if (step[key] !== undefined) {
      throw new Error(
        `步骤 ${name} 有 ${labels.length} 个模型调用，节点级 ${key} 会被其他调用误继承：写进真正拥有它的 models.<调用名>（${file}）`,
      );
    }
  }
}

/**
 * 一次调用的完整契约：提示词块 + 校验 DSL（运行时唯一取词入口）。
 * 调用级声明优先；单调用节点与无模型调用节点吃节点级值（含 type 层覆盖）。
 */
export function stepCallContract(step, label) {
  if (!step) return null;
  const call = step.calls?.[label];
  return {
    prompt: call?.prompt ?? step.prompt ?? {},
    prompt_id: call?.prompt_id ?? step.prompt_id ?? "",
    schema: call?.schema ?? null,
    schema_id: call?.schema_id ?? step.schema_id ?? "",
    input_format: call?.input_format ?? step.input_format ?? {},
    output_format: call?.output_format ?? step.output_format ?? {},
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

/** 按 id 取提示词原文块（config/prompts/*.yaml 注册表），未注册返回 {}。 */
export function promptById(steps, id) {
  return steps?.prompts?.[id] || {};
}

/** 按 id 取数据结构（config/schemas/*.yaml 注册表），未注册返回 {}。 */
export function schemaById(steps, id) {
  return steps?.schemas?.[id] || {};
}

export function stepNames(steps) {
  return (steps?.steps || []).map((step) => step.step_name);
}

/**
 * 合并类型覆盖：config/types/<id>.yaml 里的
 *   steps.<step_name>.{prompt,enabled,handler_options,schema,input_format,output_format}
 * 优先于 steps 的默认值。模型调用不在这里覆盖（单源 = 节点 models.<调用名>）。
 */
export function resolveStep(stepOrName, { steps, type } = {}) {
  const step = typeof stepOrName === "string" ? getStep(steps, stepOrName) : stepOrName;
  if (!step) return null;
  const override = type?.steps?.[step.step_name] || {};
  const schema = override.schema === undefined
    ? null
    : resolveSchemaRef(override.schema, {
      schemas: steps?.schemas || {},
      step: step.step_name,
    });

  return {
    ...step,
    // type 层覆盖同样可能是 `${...}` 抬起的字符串：没写就吃节点值，写了就归一成布尔。
    enabled: override.enabled === undefined ? step.enabled : toBool(override.enabled, step.enabled),
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
 * prompt id 是 `<文件>.<key>`，例如 draft.draft_writing 对应
 * config/<feature>/prompts/draft.yaml 的 draft_writing 项。
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
};

/**
 * 校验步骤注册表。除了通用形状检查，还接收入口提供的两份词汇表：
 *   stages    —— 流程阶段名（即 --stage 的取值），节点的 stage 必须落在其中；
 *   skippable —— 入口支持"关掉就跳过"的节点名，只有这些节点可以写 enabled。
 * 传了才检查（不传 = 该管线不约束），这样 lib 不写死某条管线的词表。
 */
export function validateSteps(steps, { types = [], stages, skippable } = {}) {
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

    // 契约可以写在节点级（单调用/无调用节点）或调用级（多调用节点），任一处有就算声明。
    const hasFormat = (key) =>
      Object.keys(step[key] || {}).length > 0 ||
      Object.keys(step.calls || {}).some((callName) => Object.keys(stepCallContract(step, callName)?.[key] || {}).length > 0);
    if (!hasFormat("input_format")) warnings.push(`步骤 ${label} 未声明 input_format`);
    // 产物契约（result_schema）也算声明过输出格式：publish/archive 这类节点没有模型输出，
    // 它校验的就是自己落的 NN-result.json。
    if (!hasFormat("output_format") && !step.result_schema) warnings.push(`步骤 ${label} 未声明 output_format`);

    // result_schema = 本节点会落盘的那份 NN-result.json 本体的校验契约；
    // 挂在不会写 result 的节点上等于配置说谎（代码没处可跑它）。
    if (step.result_schema) {
      const writesResult = (step.artifacts?.writes || []).some((item) => /(?:^|\/)\d{2}-result\.json/.test(String(item)));
      if (!writesResult) {
        errors.push(
          `步骤 ${label} 声明了 result_schema ${step.result_schema}，但 artifacts.writes 里没有 NN-result.json——产物契约只能挂在真正落盘 result 的节点上${step.source ? `（${step.source}）` : ""}`,
        );
      }
    }

    if (Array.isArray(stages) && !stages.includes(step.stage)) {
      errors.push(
        `步骤 ${label} 的 stage ${step.stage_declared ? `"${step.stage}"` : "未声明"}不在流程阶段表（${stages.join("|")}）——stage 表示这个节点属于哪一次 --stage 边界`,
      );
    }
    if (Array.isArray(skippable) && step.enabled_declared && !skippable.includes(step.step_name)) {
      errors.push(
        `步骤 ${label} 写了 enabled，但入口不支持跳过它（可跳过：${skippable.join("|") || "无"}）——删掉这行，假开关比没开关更坏${step.source ? `（${step.source}）` : ""}`,
      );
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
      if (Array.isArray(skippable) && override.enabled !== undefined && !skippable.includes(name)) {
        errors.push(`类型 ${type.id} 覆盖步骤 ${name} 的 enabled，但入口不支持跳过它（可跳过：${skippable.join("|") || "无"}）`);
      }
    }
  }

  return { errors, warnings };
}

function hasId(map, id) {
  return Boolean(map && Object.prototype.hasOwnProperty.call(map, id));
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
