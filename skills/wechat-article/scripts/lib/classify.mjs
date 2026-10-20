import { parseJsonFromText } from "./models.mjs";

/**
 * 判断模型（systemone）：根据标题 + 提纲选择文章类型。
 *
 * 走 OpenAI 兼容接口（POST {base_url}{endpoint}），请求体是 chat/completions，
 * 要求模型只返回 JSON：
 *   { "type": "ai-news", "confidence": 0.86, "reason": "...", "scores": { ... } }
 *
 * 任何网络/解析问题都不会抛出：返回 { ok:false, reason }，由调用方回退到
 * classifier.default_type。真正的“配置缺失”在 validate 里给警告。
 */
export async function classifyArticle({ config, title, outline, logger, fetchImpl = fetch, mock = false } = {}) {
  const cfg = config?.classifier || {};
  const types = (config?.types || []).filter((type) => type.enabled !== false);

  if (mock) {
    return { ok: true, type: cfg.default_type || types[0]?.id || "", confidence: 1, reason: "mock", scores: {}, model: "mock" };
  }
  if (!cfg.enabled) return { ok: false, reason: "classifier.disabled" };
  if (!types.length) return { ok: false, reason: "没有启用的文章类型" };
  if (!cfg.base_url || !cfg.api_key) return { ok: false, reason: "未配置 SYSTEMONE_BASE_URL / SYSTEMONE_API_KEY" };
  if (!String(title || "").trim()) return { ok: false, reason: "缺少标题" };

  const url = `${String(cfg.base_url).replace(/\/+$/, "")}${cfg.endpoint || "/v1/chat/completions"}`;
  const body = {
    model: cfg.model || "systemone",
    messages: [
      { role: "system", content: "你是公众号选题分类器，只输出 JSON，不要解释，不要 Markdown。" },
      { role: "user", content: buildClassifyPrompt({ types, title, outline }) },
    ],
    temperature: 0,
    max_tokens: 512,
  };
  if (cfg.json_mode) body.response_format = { type: "json_object" };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(cfg.timeout_ms || 30000)),
    });
    const text = await res.text();
    if (!res.ok) {
      logger?.warn?.(`判断模型 HTTP ${res.status}：${text.slice(0, 200)}`);
      return { ok: false, reason: `HTTP ${res.status}`, raw: text };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    const content = extractText(data);
    const parsed = parseJsonFromText(content);
    const result = normalizeClassifyResult(parsed, types, cfg);
    if (!result.ok) {
      logger?.warn?.(`判断模型返回无法识别：${content.slice(0, 200)}`);
      return result;
    }
    return { ...result, model: cfg.model, raw: parsed };
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
  const fallbackId = cfg.default_type && config.types.some((type) => type.id === cfg.default_type && type.enabled !== false)
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

export function buildClassifyPrompt({ types, title, outline }) {
  const lines = [
    "# 任务",
    "根据下面的文章标题和提纲，从候选类型中选出最合适的一个。",
    "",
    "# 候选类型",
  ];
  for (const type of types) {
    const style = type.style || {};
    const bits = [
      `${type.id}（${type.name}）：${type.description || ""}`.trim(),
      style.persona ? `定位：${style.persona}` : "",
      style.audience ? `读者：${style.audience}` : "",
      type.topic?.keywords?.length ? `关键词：${type.topic.keywords.join("、")}` : "",
    ].filter(Boolean);
    lines.push(`- ${bits.join("｜")}`);
  }
  lines.push("", "# 文章标题", String(title || "").trim(), "", "# 提纲", formatOutline(outline));
  lines.push(
    "",
    "# 输出",
    '只输出一个 JSON：{"type":"<候选类型 id>","confidence":0.0-1.0,"reason":"一句话理由","scores":{"<id>":0.0}}',
    "scores 里给出每个候选类型的匹配度（0-1），用于排查。不要输出 JSON 以外的任何文字。",
  );
  return lines.join("\n");
}

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

function extractText(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  const choice = data.choices?.[0];
  if (choice?.message?.content) return choice.message.content;
  if (choice?.text) return choice.text;
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.result === "string") return data.result;
  if (typeof data.content === "string") return data.content;
  return JSON.stringify(data);
}

export function normalizeClassifyResult(parsed, types, cfg = {}) {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "返回不是 JSON 对象" };
  const id = String(parsed.type || parsed.type_id || parsed.id || parsed.article_type || "").trim();
  if (!id) return { ok: false, reason: "返回里没有 type" };
  if (!types.some((type) => type.id === id)) return { ok: false, reason: `未知类型 ${id}` };

  const confidence = Number(parsed.confidence ?? parsed.score ?? 0);
  const scores = parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
  return {
    ok: true,
    type: id,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: String(parsed.reason || ""),
    scores,
    min_confidence: Number(cfg.min_confidence ?? 0.5),
  };
}
