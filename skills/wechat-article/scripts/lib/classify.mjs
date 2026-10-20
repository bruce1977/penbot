/**
 * 判断模型：System One 决策模型 API（TypeSafe Jev / Laya / vLLM 同款）。
 *
 *   POST {base_url}/v1/systemone
 *   Authorization: Bearer <api_key>
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
 * 任何网络/解析问题都不抛出：返回 { ok:false, reason }，由调用方回退到
 * classifier.default_type。真正的“配置缺失”在 validate 里给警告。
 */
export async function classifyArticle({ config, title, outline, logger, fetchImpl = fetch, mock = false } = {}) {
  const cfg = config?.classifier || {};
  const types = (config?.types || []).filter((type) => type.enabled !== false);

  if (mock) {
    return { ok: true, type: cfg.default_type || types[0]?.id || "", confidence: 1, probabilities: {}, model: "mock" };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!types.length) return { ok: false, reason: "没有启用的文章类型" };
  if (!cfg.base_url || !cfg.api_key) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL / SYSTEMONE_API_KEY" };

  const question = cfg.question || "article_type";
  const body = buildSystemOneBody({ types, title, outline, question, model: cfg.model || "jev-latest" });
  if (!body.state) return { ok: false, reason: "缺少标题或提纲" };

  const url = systemOneUrl(cfg.base_url, cfg.endpoint);
  try {
    const { res, text } = await postWithRetry({ fetchImpl, url, body, cfg, logger });
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
    const result = normalizeClassifyResult(data, types, { ...cfg, question });
    if (!result.ok) {
      logger?.warn?.(`判断模型返回无法识别：${result.reason}`);
      return { ...result, raw: data };
    }
    return { ...result, model: data.model || cfg.model, usage: data.usage, raw: data };
  } catch (error) {
    logger?.warn?.(`判断模型调用失败：${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * 分类 + 回退。返回 { typeId, source, result }：
 *   source = classifier | default | none
 */
export async function classifyOrFallback({ config, title, outline, logger, mock = false } = {}) {
  const cfg = config?.classifier || {};
  const fallbackId =
    cfg.default_type && config.types.some((type) => type.id === cfg.default_type && type.enabled !== false)
      ? cfg.default_type
      : "";

  const result = await classifyArticle({ config, title, outline, logger, mock });
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
export function buildSystemOneBody({ types, title, outline, question = "article_type", model } = {}) {
  const state = buildState({ title, outline });
  return {
    ...(model ? { model } : {}),
    state,
    questions: {
      [question]: {
        type: "choice",
        instructions:
          "判断这篇公众号文章最适合归入哪个类型。只依据标题和提纲表达的内容与体裁，不要依据选项在列表中的顺序。",
        criteria: Object.fromEntries(types.map((type) => [type.id, describeType(type)])),
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
        Authorization: `Bearer ${cfg.api_key}`,
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

/** 把提纲（Markdown 字符串或 03-outline.json）转成可读文本。 */
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
