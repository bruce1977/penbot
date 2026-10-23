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
 * classifier.default_type。真正的“配置缺失”在 validate 里给警告。
 *
 * 请求文案可配置：instructions（纯文本）与 state 模板（{{title}}/{{outline}}、
 * {{blocks}} 等占位符经 renderTemplate 渲染）来自 config/prompts/topic.yaml
 * 的 topic.classify_type、topic.select_best，经 promptById 取回；代码里的
 * 字符串只是缺省兜底。
 */
import { promptById } from "./steps.mjs";
import { renderTemplate } from "./template.mjs";

export async function classifyArticle({ config, cfg: cfgArg, title, outline, logger, fetchImpl = fetch, mock = false, recorder, slot, deepSlot } = {}) {
  const cfg = cfgArg || config?.classifier || {};
  const types = (config?.types || []).filter((type) => type.enabled !== false);

  if (mock) {
    return { ok: true, type: cfg.default_type || types[0]?.id || "", confidence: 1, probabilities: {}, model: "mock", escalated: false };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!types.length) return { ok: false, reason: "没有启用的文章类型" };
  if (!cfg.base_url) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL" };

  const question = cfg.question || "article_type";
  const lightBody = buildSystemOneBody({
    types,
    title,
    outline,
    question,
    model: cfg.model || "jev-latest",
    prompt: promptById(config?.steps, "topic.classify_type"),
  });
  if (!lightBody.state) return { ok: false, reason: "缺少标题或提纲" };

  return twoPassChoice({ cfg, lightBody, options: types, question, logger, fetchImpl, recorder, label: "classify_type", slot, deepSlot });
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

  const question = cfg.topic_question || "topic_pick";
  const options = topics.map((_, i) => ({ id: String(i + 1) }));
  const lightBody = buildTopicChoiceBody({
    topics,
    question,
    model: cfg.model || "jev-latest",
    prompt: promptById(config?.steps, "topic.select_best"),
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
 * 失败不抛出，由调用方回退到 total >= pass_score 规则。
 * 文案在 prompts/review.yaml 的 check（id review.check，代码取）。
 */
export async function checkRevisionNeeded({ config, cfg: cfgArg, score, wordCount, length, passScore, round, logger, fetchImpl = fetch, mock = false, recorder, slot } = {}) {
  const cfg = cfgArg || config?.classifier || {};

  if (mock) {
    return { ok: true, decision: "done", confidence: 1, model: "mock", escalated: false };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!cfg.base_url) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL" };

  const question = cfg.check_question || "review_check";
  const options = [{ id: "done" }, { id: "continue" }];
  const lightBody = buildReviewCheckBody({
    score,
    wordCount,
    length,
    passScore,
    round,
    question,
    model: cfg.model || "jev-latest",
    prompt: promptById(config?.steps, "review.check"),
  });

  const result = await twoPassChoice({ cfg, lightBody, options, question, logger, fetchImpl, recorder, label: "review_check", slot });
  if (!result.ok) return result;
  return { ...result, decision: result.type };
}

/** 一次轻量 → 置信度低于 escalate_below 时用重模型再判一次；二次失败保留一次结果。 */
async function twoPassChoice({ cfg, lightBody, options, question, logger, fetchImpl, recorder, label, slot, deepSlot }) {
  const lightModel = cfg.model || "jev-latest";
  const ask = { options, question, logger, fetchImpl, recorder, label };

  const first = await askSystemOne({ ...ask, cfg, model: lightModel, body: lightBody, slot });
  if (!first.ok) return first;

  const escalateBelow = Number(cfg.escalate_below ?? 0.65);
  const deep = cfg.deep;
  if (!deep?.model || deep.model === lightModel || first.confidence >= escalateBelow) {
    return { ...first, escalated: false };
  }

  logger?.info?.(
    `一次判断（${lightModel}）置信度 ${first.confidence} 低于 ${escalateBelow}，升级二次判断（${deep.model}）`,
  );
  const second = await askSystemOne({ ...ask, cfg: { ...cfg, ...deep }, model: deep.model, body: { ...lightBody, model: deep.model }, slot: deepSlot || slot });
  if (!second.ok) {
    logger?.warn?.(`二次判断不可用（${second.reason || "unknown"}），保留一次判断结果`);
    return { ...first, escalated: true };
  }
  return { ...second, escalated: true, first };
}

/** 单次 /v1/systemone choice 查询：发请求（带重试）、解析答案；问题都不抛出。 */
async function askSystemOne({ cfg, model, body, options, question, logger, fetchImpl, recorder, label, slot }) {
  const url = systemOneUrl(cfg.base_url, cfg.endpoint);
  const started = Date.now();
  const record = (extra) => {
    if (!recorder) return;
    recorder.record({
      label: label || "systemone",
      slot,
      provider: "systemone",
      model,
      duration_ms: Date.now() - started,
      request: { url, body },
      ...extra,
    });
  };
  try {
    const { res, text } = await postWithRetry({ fetchImpl, url, body, cfg, logger });
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
export async function classifyOrFallback({ config, cfg: cfgArg, title, outline, logger, mock = false, recorder, slot, deepSlot } = {}) {
  const cfg = cfgArg || config?.classifier || {};
  const fallbackId =
    cfg.default_type && config.types.some((type) => type.id === cfg.default_type && type.enabled !== false)
      ? cfg.default_type
      : "";

  const result = await classifyArticle({ config, cfg, title, outline, logger, mock, recorder, slot, deepSlot });
  if (result.ok && result.type) {
    if (result.confidence < Number(cfg.min_confidence ?? 0.5)) {
      logger?.warn?.(`判断模型置信度 ${result.confidence} 低于 ${cfg.min_confidence}，按 ${fallbackId || "未分类"} 处理`);
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
export function buildSystemOneBody({ types, title, outline, question = "article_type", model, prompt = {} } = {}) {
  let state;
  if (prompt.state) {
    // 去掉 YAML 块缩进残留的行尾空格，保持 state 干净。
    state = renderTemplate(prompt.state, { title: title || "", outline: outline || "" })
      .replace(/[ \t]+$/gm, "")
      .trim();
  } else {
    state = buildState({ title, outline });
  }
  return {
    ...(model ? { model } : {}),
    state,
    questions: {
      [question]: {
        type: "choice",
        instructions: (prompt.instructions || "").trim()
          || "判断这篇公众号文章最适合归入哪个类型。只依据标题和提纲表达的内容与体裁，不要依据选项在列表中的顺序。",
        criteria: Object.fromEntries(types.map((type) => [type.id, describeType(type)])),
      },
    },
  };
}

/** 组装选题判定请求体：选项是候选主题编号 1..N，评分与依据写进 state/criteria。 */
export function buildTopicChoiceBody({ topics, question = "topic_pick", model, prompt = {} } = {}) {
  const blocks = topics.map((t, i) => {
    const lines = [`${i + 1}. 《${t.title || t.topic}》（写作模型评分 ${t.score ?? "未给出"}）`];
    if (t.thesis) lines.push(`   核心判断：${t.thesis}`);
    if (t.rationale) lines.push(`   理由：${t.rationale}`);
    if (t.source_hints?.length) lines.push(`   素材：${t.source_hints.join(" / ")}`);
    return lines.join("\n");
  });
  let state;
  if (prompt.state) {
    // YAML 块标量解析后已去掉公共缩进，占位符替换按原样插入。
    state = renderTemplate(prompt.state, { count: topics.length, blocks: blocks.join("\n\n") })
      .replace(/[ \t]+$/gm, "")
      .trim();
  } else {
    state = `候选主题（公众号选题，一次模型调用产出，按评分从高到低）：\n\n${blocks.join("\n\n")}`;
  }
  return {
    ...(model ? { model } : {}),
    state,
    questions: {
      [question]: {
        type: "choice",
        instructions: (prompt.instructions || "").trim()
          || "这些是同一批候选选题，请选出最值得现在写的一个，返回其编号。依据：素材是否新、核心判断是否有信息量、标题是否具体不空泛。写作模型评分只作参考；编号只是标签，不要偏向任何编号。",
        criteria: Object.fromEntries(
          topics.map((t, i) => [String(i + 1), `《${t.title || t.topic}》：${t.topic || ""}`]),
        ),
      },
    },
  };
}

/** 组装审稿去留判定请求体：选项 done/continue，评稿结果渲染进 state。 */
export function buildReviewCheckBody({ score, wordCount, length, passScore, round, question = "review_check", model, prompt = {} } = {}) {
  const vars = {
    round,
    total: score?.total ?? "未给出",
    pass_score: passScore ?? "未给出",
    verdict: score?.verdict ?? "未给出",
    word_count: wordCount,
    length: length || {},
    issues: (score?.issues || [])
      .map((issue, i) => `${i + 1}. [${issue.severity || "medium"}][${issue.dimension || ""}] ${issue.problem}（建议：${issue.fix || "未给出"}）`)
      .join("\n") || "（无）",
    must_fix: (score?.must_fix || []).map((item, i) => `${i + 1}. ${item}`).join("\n") || "（无）",
  };
  let state;
  if (prompt.state) {
    state = renderTemplate(prompt.state, vars).replace(/[ \t]+$/gm, "").trim();
  } else {
    state = `公众号文章审稿，第 ${round} 轮评稿结果：总分 ${vars.total}（通过线 ${vars.pass_score}），结论 ${vars.verdict}。篇幅：当前 ${wordCount} 字。剩余问题：\n${vars.issues}`;
  }
  return {
    ...(model ? { model } : {}),
    state,
    questions: {
      [question]: {
        type: "choice",
        instructions: (prompt.instructions || "").trim()
          || "判断这篇稿件是否还需要继续修改。done = 已达到可发表水准，剩余问题只是小瑕疵；continue = 还有必须修复的问题。只依据给出的评分与问题清单判断。",
        criteria: {
          done: prompt.criteria_done || "已达到可发表水准：总分过线、结论 pass、无 high 级问题；剩余仅为可选优化。",
          continue: prompt.criteria_continue || "仍需修改：存在 high 级问题或必须修改项；或结论为 revise 且问题具体可执行。",
        },
      },
    },
  };
}

/** 把标题和提纲压成 SystemOne 的 state（纯文本，避免结构化字段名依赖）。 */
export function buildState({ title, outline }) {
  const heading = String(title || "").trim();
  const body = formatOutline(outline);
  const parts = [];
  if (heading) parts.push(`标题：${heading}`);
  if (body && body !== "（无）") parts.push(`提纲：\n${body}`);
  return parts.join("\n\n");
}

/** 拼 SystemOne 地址：base_url 带 /v1 时不再重复拼 /v1。 */
export function systemOneUrl(baseUrl, endpoint = "/v1/systemone") {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(endpoint || "/v1/systemone");
  if (!base) return path;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) return `${base}${path.slice(3)}`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function normalizeClassifyResult(payload, types, cfg = {}) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "返回不是 JSON 对象" };
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
    min_confidence: Number(cfg.min_confidence ?? 0.5),
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

async function postWithRetry({ fetchImpl, url, body, cfg, logger }) {
  const maxRetries = Math.max(0, Number(cfg.max_retries ?? 2));
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(cfg.timeout_ms || 15000)),
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
