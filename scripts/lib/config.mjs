import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expandEnv, needNumber, toBool, toNumber } from "./env.mjs";

/**
 * 功能配置布局：入口注入自己的 feature 名，共享 lib 不持有具体功能路径。
 * models.yaml 全局唯一（config/models.yaml），其余按功能目录隔离。
 */
export function featurePaths(feature) {
  return {
    config: `config/${feature}/article-types.yaml`,
    defaults: `config/${feature}/defaults.yaml`,
    models: "config/models.yaml",
    steps: `config/${feature}/steps.yaml`,
  };
}

/**
 * 加载配置：
 *   defaults.yaml（全局默认）→ models.yaml（模型总表）
 *   → article-types.yaml（类型注册表，可覆盖默认）→ config/types/*.yaml → normalize。
 */
export function loadConfig(configPath, { root = process.cwd(), defaultsPath, modelsPath } = {}) {
  if (!configPath) throw new Error("缺少配置路径：入口应传入 featurePaths(<feature>).config 或 --config");
  const resolved = path.resolve(root, configPath);
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
    : [path.join(configDir, "models.yaml"), path.join(path.dirname(configDir), "models.yaml")].find((f) => fs.existsSync(f))
      || path.join(path.dirname(configDir), "models.yaml");
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
  // doctor 读 config.defaults.publish，运行时读类型合并后的 publish —
  // 先把 defaults 段的开关归成真布尔，两边口径才一致。
  defaults.publish = normalizePublish(defaults.publish);
  // defaults.yaml 里可翻转的阈值同样写成 `${PB_*:-默认}`（由 .env 抬起），expandEnv 之后是字符串。
  // doctor 读 defaults 段、运行时读类型合并后的值，先把 defaults 归成数字，两边口径才一致；
  // 类型自己写的值在 normalizeType 里归一。
  defaults.review = coerceNumbers(defaults.review, {
    max_rounds: "defaults.review.max_rounds",
    pass_score: "defaults.review.pass_score",
  });
  defaults.knowledge = coerceNumbers(defaults.knowledge, {
    max_sources: "defaults.knowledge.max_sources",
    excerpt_chars: "defaults.knowledge.excerpt_chars",
    max_file_bytes: "defaults.knowledge.max_file_bytes",
  });
  defaults.illustrations = coerceNumbers(defaults.illustrations, {
    concurrency: "defaults.illustrations.concurrency",
    min: "defaults.illustrations.min",
    max: "defaults.illustrations.max",
    count: "defaults.illustrations.count",
  });
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
  const classifier = normalizeClassifier(config.classifier);

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

/**
 * classifier 只剩行为参数（开关 / 问题名 / 兜底类型）。
 * 判断模型本身与升级参数（deep / escalate_below / min_confidence）的单源
 * 在 steps 节点：config/wechat-article/steps/10-topic.yaml 的
 *   classify_type.models.classify、select_topic.models.best
 * （统一标准见根目录 AGENTS.md）。
 */
function normalizeClassifier(classifier = {}) {
  for (const legacy of ["model", "deep_model", "base_url", "api_key", "endpoint", "provider", "escalate_below", "min_confidence", "timeout_ms", "max_retries"]) {
    if (classifier[legacy] !== undefined) {
      throw new Error(
        `classifier.${legacy} 已废弃：判断模型配置改到 steps 节点 models.<调用名>（10-topic.yaml classify_type / select_topic），models.yaml 只留端点默认`,
      );
    }
  }
  return {
    enabled: toBool(classifier.enabled, true),
    // 三个问题名单源 defaults.yaml classifier.*（三个判定入口都用 needBehavior 要求它们）。
    // 这里不再铺 "article_type"/"topic_pick"/"review_check" 的同值副本：defaults.yaml 三个键
    // 都写死了，副本一旦和配置取值不同，判定请求会问一个配置文件里根本不存在的问题。
    question: classifier.question,
    topic_question: classifier.topic_question,
    check_question: classifier.check_question,
    default_type: classifier.default_type || "",
  };
}

function normalizeType(type, defaults, root, config) {
  const id = String(type.id || "").trim();
  if (!id) throw new Error("存在缺少 id 的文章类型");
  // 评稿/修正/判断的模型调用单源在 steps 节点（统一标准见根目录 AGENTS.md）：
  // type 层写 review.model 不会有任何效果，加载期直接报错而不是静默忽略。
  if (type.review?.model !== undefined) {
    throw new Error(
      `类型 ${id} 的 review.model 已废弃：审稿环节各调用的模型只在 config/wechat-article/steps/30-review.yaml 的 models.<调用名> 配置`,
    );
  }

  const knowledge = {
    ...(defaults.knowledge || {}),
    ...(type.knowledge || {}),
  };
  // max_sources 由 `${PB_KNOWLEDGE_MAX_SOURCES:-8}` 抬起 → 归成数字，
  // 下游（检索条数、weknora.match_count、充足性闸门）拿到的都是 number。
  // 这里不再铺 source/max_sources/excerpt_chars/max_file_bytes 的同值副本：
  // 四项都在 defaults.yaml defaults.knowledge 写着，副本只会让改配置不生效。
  for (const key of ["max_sources", "excerpt_chars", "max_file_bytes"]) {
    if (knowledge[key] === undefined) continue;
    knowledge[key] = needNumber(knowledge[key], `类型 ${id} 的 knowledge.${key}`);
  }
  // 通道 2 外部检索：嵌套合并，类型文件可只覆盖个别阈值。
  // model 不是模型调用（opencode 工具节点自带模型），配置单源在 defaults.yaml web-search.model。
  // 各阈值同样不吃这里的默认值：真正发起检索时由 web-search.mjs 逐项要求
  // （未启用本通道就不需要配全，见 collectWebSearchSources 的 enabled 判定）。
  knowledge["web-search"] = {
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
    // 只保留"没配 = 空"的形状归一：source/enabled/base_url/kb_ids 都参与下面的启用判定。
    // 端点参数（auth_header / timeout_ms）单源 defaults.yaml defaults.knowledge.weknora，
    // 缺了由 knowledge.mjs 在真正请求前抛错点名配置路径；原来这里的 "X-API-Key"/30000
    // 和 defaults.yaml 同值，改配置不生效。match_count 是**继承**不是同值默认：
    // 它与本地检索共用一个条数上限，PB_KNOWLEDGE_MAX_SOURCES 一改两边都变。
    base_url: "",
    api_key: "",
    kb_ids: [],
    match_count: knowledge.max_sources,
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
  // 轮次与通过线都可由 .env 抬起（defaults.yaml 与 types 里的 `${PB_*:-默认}`）；
  // expandEnv 之后是字符串，这里归成数字再交给 clamp。
  // 原来这里的 `?? 3` / `?? 80` 是和 defaults.yaml 同值的第二份真相：抬 PB_PASS_SCORE
  // 只改配置不生效的那类问题就是这么来的。现在缺值不在这里兜，审稿循环用到时抛错点名配置路径。
  if (review.max_rounds !== undefined) {
    review.max_rounds = clamp(needNumber(review.max_rounds, `类型 ${id} 的 defaults.review.max_rounds`), 1, 5);
  }
  // 通过线只在这里解析一次：顶层 pass_score > 类型/defaults 的 review.pass_score > 旧写法
  // scoring.pass_score。原来下面 scoring.pass_score 又各自算一遍带旧写法的链，两条链的取值
  // 只在「类型只写了 scoring.pass_score」时不同——那种写法下 review.pass_score 是 undefined，
  // 审稿循环会抛错，而展示层却看得到分数。合成一条链后 scoring.pass_score 只是别名。
  const passScore = toNumber(type.pass_score, `类型 ${id} 的 pass_score`)
    ?? toNumber(review.pass_score, `类型 ${id} 的 defaults.review.pass_score`)
    ?? toNumber(type.scoring?.pass_score, `类型 ${id} 的 scoring.pass_score`);
  if (passScore !== undefined) review.pass_score = passScore;
  // 核稿服务（correct-cn）的端点、鉴权头、超时与重试全部单源 defaults.yaml
  // defaults.review.correct_cn（auth_header 原来这里写的是 "X-Auth-Key"，而 defaults.yaml
  // 早已改成 Authorization——两份副本并存时，改配置的一方永远赢不了）。
  // 这里只把 enabled 归成真布尔；必填项缺失由 corrector.mjs 在发请求前抛错点名配置路径。
  review.correct_cn = { ...(review.correct_cn || {}), enabled: toBool(review.correct_cn?.enabled, false) };

  const illustrations = deepMerge(defaults.illustrations || {}, type.illustrations || {});
  // 配图并发数可由 `${PB_IMAGE_CONCURRENCY:-2}` 抬起：这里只把字符串归成数字，
  // 缺失/非法值留给 comm 模块的下限兜底（至少 1 个 worker，否则队列永远跑不完）。
  const concurrency = toNumber(illustrations.concurrency, `类型 ${id} 的 illustrations.concurrency`);
  if (concurrency !== undefined) illustrations.concurrency = concurrency;
  Object.assign(illustrations, normalizeImageCount(type.image_count));
  if (type.image_position_format) illustrations.position_format = String(type.image_position_format);
  // 张数区间不再铺 `?? 1` / `?? 5` 的同值副本（defaults.yaml 写的就是 1/5，那份副本只会掩盖配置）：
  // 这里只把写出来的值归成数字并夹进 1-5 的设计区间；缺值不在这里兜，
  // 由 comm/wechat-illustrate.mjs 在真正排张数时抛错点名配置路径。
  const illMin = illustrations.min === undefined ? undefined : clamp(needNumber(illustrations.min, `类型 ${id} 的 illustrations.min`), 1, 5);
  const illMax = illustrations.max === undefined ? undefined : clamp(needNumber(illustrations.max, `类型 ${id} 的 illustrations.max`), illMin ?? 1, 5);
  const illCount = illustrations.count === undefined ? undefined : clamp(needNumber(illustrations.count, `类型 ${id} 的 illustrations.count（image_count.default）`), illMin ?? 1, illMax ?? 5);
  if (illMin !== undefined) illustrations.min = illMin;
  if (illMax !== undefined) illustrations.max = illMax;
  if (illCount !== undefined) illustrations.count = illCount;

  const publish = normalizePublish({
    ...deepMerge(defaults.publish || {}, type.publish || {}),
    email: { ...(defaults.publish?.email || {}), ...(type.publish?.email || {}) },
    wechat: { ...(defaults.publish?.wechat || {}), ...(type.publish?.wechat || {}) },
  });

  const knowledgeDirs = (Array.isArray(type.knowledge_base_path)
    ? type.knowledge_base_path
    : type.knowledge_base_path !== undefined
      ? [type.knowledge_base_path]
      : type.knowledge_dirs || [])
    .filter(Boolean)
    .map((dir) => path.resolve(root, String(dir)));

  const length = normalizeWordLimit(type.word_limit ?? type.length, `类型 ${id} 的 word_limit`);
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
      // 纯别名：值就是上面解析好的 review.pass_score，不再自己算一遍优先级。
      pass_score: review.pass_score,
      dimensions: criteria.map((dimension) => ({
        ...dimension,
        weight: Number(dimension.weight || 0) / totalWeight,
      })),
    },
    review,
    illustrations,
    publish,
    // keywords/exclude_keywords 的空数组只是形状归一（读取端 .map/.join 前不必判空）；
    // 候选条数单源 topic.max_candidates——旧的 candidates 别名没有任何类型写过，
    // 这里的 12 只会让读取端的 `|| 15` 永远不生效，已删。
    topic: { keywords: [], exclude_keywords: [], ...(type.topic || {}) },
    prompts: type.prompts || {},
    // 模型末位回退链：--model > 节点 models.<调用名>.id > type.model > defaults.model。
    // 原来尾巴上还挂着 "llm.local"：defaults.yaml 明明写的是 llm.large，配置被删掉时
    // 代码会静默换到另一个模型，那是第三份真相，已删（缺了由取 profile 时抛错）。
    model: type.model || defaults.model,
    config,
  };
}

/**
 * `1500` / `"800-1300"` / `{min,max,target}` → { min, max, target }。
 *
 * word_limit 在 types/README.md 里是必填项，所以这里不再垫 800-2000：
 * 缺了或写成了无法解析的样子直接抛错。原来「解析不出来就用默认区间」会让
 * `word_limit: 八百` 这种笔误静默变成 800-2000，而写作提示词与 de_ai 字数闸门
 * 都以这个区间为准——那是拿代码默认值冒充配置。target 没写时取区间中点，
 * 是纯推导（不是第二份真相）。
 */
export function normalizeWordLimit(value, where = "word_limit") {
  if (value === undefined || value === null || value === "") {
    throw new Error(`缺少配置项 ${where}：必填参数不留代码默认值（写法 1500 / "800-1300" / {min,max,target}）`);
  }
  let min;
  let max;
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
    } else {
      throw new Error(`${where} 无法解析成字数区间：${JSON.stringify(value)}`);
    }
  } else if (typeof value === "object") {
    min = needNumber(value.min, `${where}.min`);
    max = needNumber(value.max, `${where}.max`);
    if (value.target !== undefined) target = needNumber(value.target, `${where}.target`);
  } else {
    throw new Error(`${where} 只支持数字、"min-max" 字符串或 {min,max,target}：${JSON.stringify(value)}`);
  }
  min = Math.round(min);
  max = Math.round(max);
  if (min <= 0 || max <= 0) throw new Error(`${where} 的字数区间必须为正数：${min}-${max}`);
  if (max < min) max = min;
  return { min, max, target: Number.isFinite(target) ? Math.round(target) : Math.round((min + max) / 2) };
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
  // 没传 id 时回退 defaults.yaml 的 defaults.model；代码里不再垫 "llm.local"
  // （那是第三份真相，且两个调用方都必须传 id）。找不到就在下面抛错点名 id。
  const id = name || config.defaults?.model;
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
    // 这三项都嵌在提示词的整句里（文风：{{tone}}。/ 目标读者：{{audience}}。/ 标题风格：{{title_style}}。），
    // 代码里已经不再自创「清晰、克制」这类兜底文案：缺了就是空句子，必须在启动前点名。
    for (const key of ["tone", "audience", "title_style"]) {
      if (!type.style?.[key]) issues.push(`${type.id}: 缺少 style.${key}（写作/纲要/评稿/去 AI 化提示词直接引用它）`);
    }
    if (!hasModel(config, type.model)) issues.push(`${type.id}: model "${type.model}" 未在 models.yaml 中定义`);
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
    // 判断模型调用配置在 steps 节点（classify_type.models.classify）。
    const classifyStep = (config.steps?.steps || []).find((step) => step.step_name === "classify_type");
    const call = classifyStep?.calls?.classify;
    const profile = call ? config.models?.[call.model_id] : null;
    if (config.steps && !call) {
      warnings.push("steps classify_type 未配置 classify 调用（models.classify.id），录入时不会自动分类，将回退到 classifier.default_type");
    } else if (call && !profile?.base_url) {
      warnings.push(`判断模型 ${call.model_id} 未配置 base_url（SYSTEMONE_BASE_URL），录入时不会自动分类，将回退到 classifier.default_type`);
    }
    if (classifier.default_type && !config.types.some((type) => type.id === classifier.default_type)) {
      warnings.push(`classifier.default_type="${classifier.default_type}" 不在 types 中`);
    }
    if (!classifier.default_type) {
      warnings.push("classifier.default_type 未设置：判断模型不可用时，未指定 --type 的录入会直接报错");
    }
    const deepId = call?.options?.deep;
    if (deepId && !config.models?.[deepId]?.model) {
      warnings.push(`classify 调用 options.deep="${deepId}" 未在 models.yaml 定义，不会进行二次判断`);
    }
    // 审稿循环去留判定（scoring.models.check）；未配置只降级为 pass_score 规则，不阻断。
    const scoringStep = (config.steps?.steps || []).find((step) => step.step_name === "scoring");
    const checkCall = scoringStep?.calls?.check;
    if (config.steps && !checkCall) {
      warnings.push("steps scoring 未配置 check 调用（models.check.id），审稿循环去留将按 pass_score 规则决定");
    } else if (checkCall && !config.models?.[checkCall.model_id]?.base_url) {
      warnings.push(`判断模型 ${checkCall.model_id} 未配置 base_url（SYSTEMONE_BASE_URL），审稿循环去留将按 pass_score 规则决定`);
    }
    const checkDeepId = checkCall?.options?.deep;
    if (checkDeepId && !config.models?.[checkDeepId]?.model) {
      warnings.push(`check 调用 options.deep="${checkDeepId}" 未在 models.yaml 定义，不会进行二次判断`);
    }
  }
  for (const type of config.types || []) {
    const ws = type.knowledge?.["web-search"];
    if (ws?.enabled && !ws.model) {
      warnings.push(`${type.id}: web-search 已启用但 defaults.yaml knowledge.web-search.model 未配置，外部检索会走 opencode 默认模型`);
    }
  }
  return warnings;
}

/**
 * 三个投递开关（auto_publish / email.enabled / wechat.enabled）归成真布尔。
 * defaults.yaml 把它们写成 `${PB_AUTO_PUBLISH:-false}` 等形式，由 .env 抬起；
 * expandEnv 替换出来的是字符串，而读取端混用 `=== true`（入口）与真值判断（doctor），
 * 不归一会让 "false" 在真值判断里当成开。
 */
function normalizePublish(publish = {}) {
  const out = { ...publish, email: { ...(publish.email || {}) }, wechat: { ...(publish.wechat || {}) } };
  out.auto_publish = toBool(out.auto_publish, false);
  out.email.enabled = toBool(out.email.enabled, false);
  out.wechat.enabled = toBool(out.wechat.enabled, false);
  return out;
}

/**
 * 按 labels 表把 env 抬起的数字字符串归成真数字：键不存在（或值为空串）就不动它，
 * 让上层的默认值/类型层的值照常生效；写了但不是数字直接抛错。
 */
function coerceNumbers(obj, labels) {
  const out = { ...(obj || {}) };
  for (const [key, label] of Object.entries(labels)) {
    if (out[key] === undefined) continue;
    const n = toNumber(out[key], label);
    if (n !== undefined) out[key] = n;
  }
  return out;
}
