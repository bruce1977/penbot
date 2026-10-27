/**
 * 判断模型：System One 决策模型 API（TypeSafe Jev / Laya / vLLM 同款）。
 *
 *   POST {base_url}/v1/systemone
 *   Authorization: Bearer <api_key>（可选，端点未启用鉴权时可不配置）
 *   {
 *     "model": "jev-latest",
 *     "state": "标题 + 提纲",
 *     "questions": {
 *       "article_type": {
 *         "type": "choice",
 *         "instructions": "判断这篇文章最适合归入哪个类型",
 *         "criteria": { "ai-news": "说明", "ai-insight": "说明" }
 *       }
 *     }
 *   }
 *
 * 返回（不是文本生成，也没有 choices/messages）：
 *   {
 *     "answers": {
 *       "article_type": {
 *         "type": "choice",
 *         "choice": "ai-news",
 *         "probabilities": { "ai-news": 0.94, ... },
 *         "confidence": 0.91
 *       }
 *     },
 *     "model": "jev-1.13.0",
 *     "usage": { ... }
 *   }
 *
 * 两段式判断：先用轻量模型（cfg.model）判一次；置信度低于 cfg.escalate_below
 * 且配置了 cfg.deep 时，用重模型（cfg.deep.model）再判一次并采用其结果。
 * 二次判断失败时保留一次结果。classifyOrFallback 再按 min_confidence 兜底。
 *
 * 三类判定共用同一端点与升级策略：
 *   classifyArticle        标题 + 提纲 → 选文章类型；
 *   selectBestTopic        写作模型的候选主题（带评分）→ 选最值得写的编号；
 *   checkRevisionNeeded    评稿结果 → 判断稿件是否还需要继续修改（done/continue）。
 *
 * 任何网络/解析问题都不抛出：返回 { ok:false, reason }，由调用方回退到
 * classifier.default_type。文案配置缺失是工程错误，抛出中断流程（见下一段）。
 *
 * 请求文案单源 = 节点 models.<调用名>.prompt：调用方（入口的 systemOneCallConfig）
 * 把它解析出的提示词块放进 cfg.prompt，其中 instructions（纯文本）与 state 模板
 * （{{title}}/{{outline}}、{{blocks}} 等占位符经 renderTemplate 渲染）都来自
 * config/prompts/；代码里不留提示词副本，缺 key 直接抛错（缺配置是配置说谎，
 * 不能静默用默认文案跑起来）。
 *
 * 端点参数（base_url / model / endpoint / timeout_ms / max_retries）单源
 * config/models.yaml，问题名单源 defaults.yaml classifier.*，闸门参数
 * （escalate_below / min_confidence）单源 steps 节点 models.<调用名>.options：
 * 这里只读不算，缺了就抛错点名配置路径——代码里写死过一份和配置不一致的值
 * （timeout_ms 15000 vs models.yaml 60000/120000、model "jev-latest" 在任何配置里
 * 都不存在，还进了留痕）。
 */
import { renderTemplate } from "./template.mjs";

/** 行为参数（问题名）缺失：抛错点名 defaults.yaml，代码不留同值副本。 */
function needBehavior(cfg, key) {
  const value = String(cfg?.[key] ?? "").trim();
  if (!value) throw new Error(`缺少判断模型行为参数：defaults.yaml classifier.${key}`);
  return value;
}

/**
 * 端点参数缺失：抛错点名 config/models.yaml（导出给调用方组装 cfg 时复用同一口径，
 * where 用来点名具体模型 id）。
 */
export function needEndpointParam(cfg, key, where = "config/models.yaml systemone.*") {
  const value = cfg?.[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`判断模型缺少 ${key}：${where}`);
  }
  return value;
}

/**
 * 置信度闸门参数（escalate_below / min_confidence）单源 steps 节点
 * models.<调用名>.options：缺了就抛错，代码不替配置决定「有没有闸门」。
 * 不想要闸门就显式写 0（0-1 由 steps 加载期校验）。
 */
export function needGateParam(cfg, key, where = "steps 节点 models.<调用名>.options") {
  const value = cfg?.[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`判断模型缺少 ${key}：${where}（不设闸门请写 0）`);
  }
  return Number(value);
}

/**
 * 取提示词块里的一个字段：缺失即抛错，并指名是哪个 prompt id 没写全。
 * where 用于区分同一块里的多个字段（如审稿去留的 done/continue 选项文案）。
 */
function promptText(prompt, key, promptId, where = key) {
  const text = String(prompt?.[key] ?? "").trim();
  if (!text) {
    throw new Error(`缺少提示词字段 ${where}（${key}）：${promptId || "节点未声明 prompt id"}，在该功能 config/<feature>/prompts/ 注册表里补上`);
  }
  return text;
}

/** 渲染 state 模板并清掉 YAML 块标量留下的行尾空格。 */
function renderState(prompt, promptId, vars) {
  return renderTemplate(promptText(prompt, "state", promptId), vars).replace(/[ \t]+$/gm, "").trim();
}

export async function classifyArticle({ config, cfg: cfgArg, title, outline, logger, fetchImpl = fetch, mock = false, recorder, slot } = {}) {
  const cfg = cfgArg || config?.classifier || {};
  const types = (config?.types || []).filter((type) => type.enabled !== false);

  if (mock) {
    return { ok: true, type: cfg.default_type || types[0]?.id || "", confidence: 1, probabilities: {}, model: "mock", escalated: false };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!types.length) return { ok: false, reason: "没有启用的文章类型" };
  if (!cfg.base_url) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL" };

  const question = needBehavior(cfg, "question");
  const lightBody = buildSystemOneBody({
    types,
    title,
    outline,
    question,
    model: cfg.model,
    prompt: cfg.prompt || {},
    promptId: cfg.prompt_id || "",
  });
  if (!lightBody.state) return { ok: false, reason: "缺少标题或提纲" };

  return twoPassChoice({ cfg, lightBody, options: types, question, logger, fetchImpl, recorder, label: "classify_type", slot });
}

/**
 * 通用单选判断：给一份「状态文案 + 判据文案 + 选项」，用 systemone 判一次。
 * 不走两段式升级（轻量判断不需要 escalate），但复用 askSystemOne 的重试/留痕/解析。
 * 文案（state / instructions / criteria）由调用方从配置读出传入，代码不留副本——
 * 与 classify_type 的规则一致；选项 id 就是答案。
 * 返回 { ok, type: 选中项, confidence, ... }；未配置端点/网络/解析问题都不抛出，
 * 返回 { ok:false, reason } 由调用方回退本地规则（判断模型不可用是设计好的降级）。
 * question（问题名）缺失是工程错误：答案要从 answers.<question> 读，没名字取不到。
 */
export async function classifyChoice({
  cfg = {},
  question,
  prompt = {},
  vars = {},
  options = [],
  logger,
  fetchImpl = fetch,
  mock = false,
  mockChoice,
  recorder,
  slot,
  label = "classify_choice",
} = {}) {
  if (!question) throw new Error("classifyChoice 缺少 question（问题名单源配置，如 defaults.yaml pipeline.classify.question）");
  if (mock) return { ok: true, type: mockChoice || options[0]?.id || "", confidence: 1, model: "mock", escalated: false };
  if (!options.length) return { ok: false, reason: "没有选项" };
  // base_url 缺失 = 判断模型不可用，走降级而不是抛错（端点级必填只对真要用的调用生效）。
  if (!cfg.base_url) return { ok: false, reason: "未配置判断模型端点（config/models.yaml systemone.*）" };

  const promptId = cfg.prompt_id || "调用方配置（如 defaults.yaml pipeline.classify）";
  const body = {
    ...(cfg.model ? { model: cfg.model } : {}),
    state: renderState(prompt, promptId, vars),
    questions: {
      [question]: {
        type: "choice",
        instructions: promptText(prompt, "instructions", promptId),
        criteria: prompt.criteria && typeof prompt.criteria === "object" ? prompt.criteria : {},
      },
    },
  };
  return askSystemOne({ cfg, model: cfg.model, body, options, question, logger, fetchImpl, recorder, label, slot });
}

/**
 * 选题判定：写作模型给出候选主题（标题 + 评分 + 依据），systemone 选一个最值得写的。
 * 选项编号 "1".."N"；返回 { ok, index }，失败由调用方回退到评分第一篇。
 */
export async function selectBestTopic({ config, cfg: cfgArg, topics = [], logger, fetchImpl = fetch, mock = false, recorder, slot } = {}) {
  const cfg = cfgArg || config?.classifier || {};

  if (mock) {
    let best = 0;
    topics.forEach((t, i) => {
      if (Number(t.score) > Number(topics[best].score)) best = i;
    });
    return { ok: true, index: best, confidence: 1, model: "mock", escalated: false };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!topics.length) return { ok: false, reason: "没有候选主题" };
  if (topics.length === 1) return { ok: true, index: 0, confidence: 1, model: "single-candidate", escalated: false };
  if (!cfg.base_url) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL" };

  const question = needBehavior(cfg, "topic_question");
  const options = topics.map((_, i) => ({ id: String(i + 1) }));
  const lightBody = buildTopicChoiceBody({
    topics,
    question,
    model: cfg.model,
    prompt: cfg.prompt || {},
    promptId: cfg.prompt_id || "",
  });

  const result = await twoPassChoice({ cfg, lightBody, options, question, logger, fetchImpl, recorder, label: "select_best", slot });
  if (!result.ok) return result;
  const index = Number(result.type) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= topics.length) {
    return { ok: false, reason: `未知的候选编号 ${result.type}`, raw: result.raw };
  }
  return { ...result, index };
}

/**
 * 审稿循环去留判定：评稿结果（总分/结论/剩余问题）→ systemone 判断
 * 是否还需要继续修改。选项 done / continue，返回 { ok, decision }；
 * 失败不抛出，由调用方回退到 composite_score >= pass_score 规则。
 * 文案来自节点 models.check.prompt（调用方解析后放进 cfg.prompt）。
 */
export async function checkRevisionNeeded({ config, cfg: cfgArg, score, wordCount, length, passScore, round, logger, fetchImpl = fetch, mock = false, recorder, slot } = {}) {
  const cfg = cfgArg || config?.classifier || {};

  if (mock) {
    return { ok: true, decision: "done", confidence: 1, model: "mock", escalated: false };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!cfg.base_url) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL" };

  const question = needBehavior(cfg, "check_question");
  const options = [{ id: "done" }, { id: "continue" }];
  const lightBody = buildReviewCheckBody({
    score,
    wordCount,
    length,
    passScore,
    round,
    question,
    model: cfg.model,
    prompt: cfg.prompt || {},
    promptId: cfg.prompt_id || "",
  });

  const result = await twoPassChoice({ cfg, lightBody, options, question, logger, fetchImpl, recorder, label: "review_check", slot });
  if (!result.ok) return result;
  return { ...result, decision: result.type };
}

/** 一次轻量 → 置信度低于节点 options.escalate_below 时用重模型再判一次；二次失败保留一次结果。
 *  二次判断属同一子步骤的「尝试」（留痕文件名带 (2)，轮次不推进），沿用同一 slot。 */
async function twoPassChoice({ cfg, lightBody, options, question, logger, fetchImpl, recorder, label, slot }) {
  const lightModel = cfg.model || "";
  const lightModelName = lightModel || "端点默认模型";
  const ask = { options, question, logger, fetchImpl, recorder, label };

  const first = await askSystemOne({ ...ask, cfg, model: lightModel, body: lightBody, slot });
  if (!first.ok) return first;

  const deep = cfg.deep;
  if (!deep?.model || deep.model === lightModel) return { ...first, escalated: false };
  // 只有真会升级（配了不同的重模型）才需要闸门值；缺了就抛错，代码不替配置决定阈值。
  const escalateBelow = needGateParam(cfg, "escalate_below");
  if (first.confidence >= escalateBelow) {
    return { ...first, escalated: false };
  }

  logger?.info?.(
    `一次判断（${lightModelName}）置信度 ${first.confidence} 低于 ${escalateBelow}，升级二次判断（${deep.model}）`,
  );
  const second = await askSystemOne({ ...ask, cfg: { ...cfg, ...deep }, model: deep.model, body: { ...lightBody, model: deep.model }, slot, attempt: 2 });
  if (!second.ok) {
    logger?.warn?.(`二次判断不可用（${second.reason || "unknown"}），保留一次判断结果`);
    return { ...first, escalated: true };
  }
  return { ...second, escalated: true, first };
}

/** 单次 /v1/systemone choice 查询：发请求（带重试）、解析答案；问题都不抛出。
 *  端点参数在这一步之前取（needEndpointParam 缺字段抛错属工程错误，要冒泡出去）；
 *  try 里的 catch 只吞网络/解析问题，不能把「配置没写」降级成判断模型不可用。 */
async function askSystemOne({ cfg, model, body, options, question, logger, fetchImpl, recorder, label, slot, attempt }) {
  const where = cfg.model_id ? `config/models.yaml ${cfg.model_id}` : "config/models.yaml systemone.*";
  const url = systemOneUrl(cfg.base_url, needEndpointParam(cfg, "endpoint", where));
  const timeoutMs = Number(needEndpointParam(cfg, "timeout_ms", where));
  const maxRetries = Math.max(0, Number(needEndpointParam(cfg, "max_retries", where)));
  const started = Date.now();
  const record = (extra) => {
    if (!recorder) return;
    recorder.record({
      label: label || "systemone",
      slot,
      attempt,
      provider: "systemone",
      model,
      duration_ms: Date.now() - started,
      request: { url, body },
      ...extra,
    });
  };
  try {
    const { res, text } = await postWithRetry({
      fetchImpl,
      url,
      body,
      api_key: cfg.api_key,
      timeoutMs,
      maxRetries,
      logger,
    });
    record({ response: text, error: res.ok ? undefined : `HTTP ${res.status}` });
    if (!res.ok) {
      const detail = errorMessage(text);
      logger?.warn?.(`判断模型 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
      return { ok: false, reason: `HTTP ${res.status}${detail ? `：${detail}` : ""}`, raw: text };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      logger?.warn?.(`判断模型返回不是 JSON：${text.slice(0, 200)}`);
      return { ok: false, reason: "响应不是 JSON", raw: text };
    }
    const result = normalizeClassifyResult(data, options, { ...cfg, question });
    if (!result.ok) {
      logger?.warn?.(`判断模型返回无法识别：${result.reason}`);
      return { ...result, raw: data };
    }
    return { ...result, model: data.model || model, usage: data.usage, raw: data };
  } catch (error) {
    record({ response: "", error: error.message });
    logger?.warn?.(`判断模型调用失败：${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * 分类 + 回退。返回 { typeId, source, result }：
 *   source = classifier | default | none
 */
export async function classifyOrFallback({ config, cfg: cfgArg, title, outline, logger, mock = false, recorder, slot } = {}) {
  const cfg = cfgArg || config?.classifier || {};
  const fallbackId =
    cfg.default_type && config.types.some((type) => type.id === cfg.default_type && type.enabled !== false)
      ? cfg.default_type
      : "";

  const result = await classifyArticle({ config, cfg, title, outline, logger, mock, recorder, slot });
  if (result.ok && result.type) {
    const minConfidence = needGateParam(cfg, "min_confidence", "steps 节点 classify_type.models.classify.options");
    if (result.confidence < minConfidence) {
      logger?.warn?.(`判断模型置信度 ${result.confidence} 低于 ${minConfidence}，按 ${fallbackId || "未分类"} 处理`);
      if (fallbackId) return { typeId: fallbackId, source: "default", result };
      return { typeId: "", source: "none", result };
    }
    return { typeId: result.type, source: "classifier", result };
  }

  if (fallbackId) {
    logger?.warn?.(`自动分类不可用（${result.reason || "unknown"}），回退到 classifier.default_type=${fallbackId}`);
    return { typeId: fallbackId, source: "default", result };
  }
  logger?.warn?.(`自动分类不可用（${result.reason || "unknown"}），且没有可用默认类型`);
  return { typeId: "", source: "none", result };
}

/** 组装 /v1/systemone 请求体：一个 choice 问题，选项就是启用的文章类型。 */
export function buildSystemOneBody({ types, title, outline, question = "article_type", model, prompt = {}, promptId = "" } = {}) {
  return {
    ...(model ? { model } : {}),
    state: renderState(prompt, promptId, { title: title || "", outline: outline || "" }),
    questions: {
      [question]: {
        type: "choice",
        instructions: promptText(prompt, "instructions", promptId),
        criteria: Object.fromEntries(types.map((type) => [type.id, describeType(type)])),
      },
    },
  };
}

/** 组装选题判定请求体：选项是候选主题编号 1..N，评分与依据写进 state/criteria。 */
export function buildTopicChoiceBody({ topics, question = "topic_pick", model, prompt = {}, promptId = "" } = {}) {
  const blocks = topics.map((t, i) => {
    const lines = [`${i + 1}. 《${t.title || t.topic}》（写作模型评分 ${t.score ?? "未给出"}）`];
    if (t.thesis) lines.push(`   核心判断：${t.thesis}`);
    if (t.rationale) lines.push(`   理由：${t.rationale}`);
    if (t.source_hints?.length) lines.push(`   素材：${t.source_hints.join(" / ")}`);
    return lines.join("\n");
  });
  return {
    ...(model ? { model } : {}),
    state: renderState(prompt, promptId, { count: topics.length, blocks: blocks.join("\n\n") }),
    questions: {
      [question]: {
        type: "choice",
        instructions: promptText(prompt, "instructions", promptId),
        criteria: Object.fromEntries(
          topics.map((t, i) => [String(i + 1), `《${t.title || t.topic}》：${t.topic || ""}`]),
        ),
      },
    },
  };
}

/** 组装审稿去留判定请求体：选项 done/continue，评稿结果渲染进 state。 */
export function buildReviewCheckBody({ score, wordCount, length, passScore, round, question = "review_check", model, prompt = {}, promptId = "" } = {}) {
  const vars = {
    round,
    total: score?.composite_score ?? "未给出",
    pass_score: passScore ?? "未给出",
    verdict: score?.verdict ?? "未给出",
    word_count: wordCount,
    length: length || {},
    issues: (score?.issues || [])
      .map((issue, i) => `${i + 1}. [${issue.severity || "medium"}][${issue.dimension || ""}] ${issue.problem}（建议：${issue.fix || "未给出"}）`)
      .join("\n") || "（无）",
    must_fix: (score?.must_fix || []).map((item, i) => `${i + 1}. ${item}`).join("\n") || "（无）",
  };
  return {
    ...(model ? { model } : {}),
    state: renderState(prompt, promptId, vars),
    questions: {
      [question]: {
        type: "choice",
        instructions: promptText(prompt, "instructions", promptId),
        criteria: {
          done: promptText(prompt, "criteria_done", promptId, "done 选项文案"),
          continue: promptText(prompt, "criteria_continue", promptId, "continue 选项文案"),
        },
      },
    },
  };
}

/** 拼 systemone 地址：endpoint 由调用方从 models.yaml 取（缺了先抛错，这里不留第二份默认）。
 *  base_url 带 /v1 时不再重复拼 /v1。 */
export function systemOneUrl(baseUrl, endpoint) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = `/${String(endpoint).replace(/^\/+/, "")}`;
  if (!base) return path;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) return `${base}${path.slice(3)}`;
  return `${base}${path}`;
}

export function normalizeClassifyResult(payload, types, cfg = {}) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "返回不是 JSON 对象" };
  // question 由调用方（三个判定入口）显式传入；这里的默认值只服务直接调用本函数的
  // 使用者，与上面三个 build* 的签名默认同口径（lib API 部分入参默认，不是配置兜底）。
  const question = cfg.question || "article_type";
  const answer = payload.answers?.[question];
  if (!answer || typeof answer !== "object") return { ok: false, reason: `answers 里没有 ${question}` };

  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
  const choice = String(answer.choice || topProbability(probabilities) || "").trim();
  if (!choice) return { ok: false, reason: "答案里没有 choice" };
  if (!types.some((type) => type.id === choice)) return { ok: false, reason: `未知类型 ${choice}` };

  const rawConfidence = Number(answer.confidence ?? probabilities[choice] ?? 0);
  return {
    ok: true,
    type: choice,
    confidence: Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0,
    probabilities,
    scores: probabilities,
  };
}

function describeType(type) {
  const style = type.style || {};
  const parts = [type.description || type.name];
  if (style.persona) parts.push(`定位：${style.persona}`);
  if (style.audience) parts.push(`读者：${style.audience}`);
  if (type.topic?.keywords?.length) parts.push(`关键词：${type.topic.keywords.join("、")}`);
  return parts.filter(Boolean).join("；");
}

function topProbability(probabilities) {
  return Object.entries(probabilities || {}).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "";
}

async function postWithRetry({ fetchImpl, url, body, api_key, timeoutMs, maxRetries, logger }) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(api_key ? { Authorization: `Bearer ${api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const seconds = Number(res.headers?.get?.("retry-after") || 1);
      const wait = Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, 5000);
      logger?.warn?.(`判断模型暂时不可用（HTTP ${res.status}），${wait}ms 后重试（${attempt + 1}/${maxRetries}）`);
      await delay(wait);
      continue;
    }
    return { res, text };
  }
}

function errorMessage(text) {
  try {
    return JSON.parse(text)?.error?.message || "";
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把提纲（Markdown 字符串或 02-step/outline.json）转成可读文本。 */
export function formatOutline(outline) {
  if (!outline) return "（无）";
  if (typeof outline === "string") return outline.trim() || "（无）";
  const sections = Array.isArray(outline) ? outline : outline.outline || [];
  const lines = [];
  if (outline.title) lines.push(`标题：${outline.title}`);
  if (outline.thesis) lines.push(`核心判断：${outline.thesis}`);
  for (const section of sections) {
    const heading = section.heading || section.title || "";
    if (!heading) continue;
    lines.push(`## ${heading}`);
    for (const point of section.points || []) lines.push(`- ${point}`);
  }
  return lines.join("\n").trim() || "（无）";
}
