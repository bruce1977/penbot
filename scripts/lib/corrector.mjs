import { needConfig, needNumber } from "./env.mjs";
import { sleep } from "./fsx.mjs";

/**
 * correct-cn rule clients.
 * Docs: https://github.com/bruce1977/correct-cn
 *
 * 并行调用两个规则端点，只采集候选，不做裁决：
 *   POST /api/correct          { text } -> { original, corrected, errors[], model }
 *   POST /api/sensitive/check  { text } -> { is_sensitive, count, sensitive_words[] }
 *
 * `/api/correct#corrected` 实测与原文逐字相同，真正可用的是 `errors[]`；
 * 候选统一经 selectCandidates() 过滤（空 original、仅大小写差异、纯 ASCII 短词、
 * original==corrected、重复项），剩下的交给改稿模型逐条核实。
 * 敏感词误报率高，只做摘要留痕，不进入修改提示词。
 *
 * 每次真实 HTTP 请求（含失败重试）经 recorder 落 <step>/api/ 留痕：只记请求体与响应原文，
 * 鉴权 header / api_key 一律不写。两个端点各占一个 API_SLOT 子步骤号。
 */
export function createCorrector(correctConfig = {}, logger, { recorder, slots = {} } = {}) {
  const base = String(correctConfig.base_url || "").replace(/\/+$/, "");
  const enabled = correctConfig.enabled !== false && Boolean(base);
  // 端点、鉴权头、超时与重试单源 defaults.yaml defaults.review.correct_cn，这里不铺同值副本。
  // 历史教训：config.mjs 里曾写 auth_header: "X-Auth-Key"，而 defaults.yaml 早已改成
  // Authorization（服务真用的是后者）——两份并存时改配置的一方永远赢不了。
  // 只在服务真开着时才要求配全：关掉核稿不需要为它准备端点参数。
  const where = (key) => `defaults.yaml defaults.review.correct_cn.${key}`;
  const correctEndpoint = enabled ? needConfig(correctConfig.correct_endpoint, where("correct_endpoint")) : "";
  const sensitiveEndpoint = enabled ? needConfig(correctConfig.sensitive_endpoint, where("sensitive_endpoint")) : "";
  const timeoutMs = enabled ? needNumber(correctConfig.timeout_ms, where("timeout_ms")) : 0;
  const retries = enabled ? needNumber(correctConfig.retries, where("retries")) : 0;

  async function postJson(endpoint, body, { label, slot }) {
    const url = `${base}${endpoint}`;
    const headers = { "Content-Type": "application/json" };
    if (correctConfig.api_key) {
      const authHeader = needConfig(correctConfig.auth_header, where("auth_header"));
      if (String(authHeader).toLowerCase() === "authorization") {
        headers.Authorization = `Bearer ${correctConfig.api_key}`;
      } else {
        headers[authHeader] = correctConfig.api_key;
      }
    }
    const record = (extra) =>
      recorder?.record({ label, slot, provider: "correct-cn", request: body, ...extra });

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      let raw = "";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        raw = await res.text();
        record({ attempt: attempt + 1, duration_ms: Date.now() - startedAt, response: raw, error: res.ok ? undefined : `HTTP ${res.status}` });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`Non-JSON response: ${raw.slice(0, 200)}`);
        }
        return { ok: true, data, duration_ms: Date.now() - startedAt };
      } catch (error) {
        lastError = error;
        const message = error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message;
        if (!raw && !/HTTP \d/.test(message)) {
          record({ attempt: attempt + 1, duration_ms: Date.now() - startedAt, error: message });
        }
        logger?.warn(`${label} 请求失败（第 ${attempt + 1}/${retries + 1} 次）：${message}`);
        if (attempt < retries) await sleep(800 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError?.message || "unknown error" };
  }

  async function check(text) {
    if (!enabled) {
      return {
        enabled: false,
        ok: true,
        skipped: true,
        candidates: [],
        sensitive: [],
        errors: { correct: null, sensitive: null },
        timings: {},
      };
    }

    const [correct, sensitive] = await Promise.all([
      postJson(correctEndpoint, { text }, { label: "correct", slot: slots.correct }),
      postJson(sensitiveEndpoint, { text }, { label: "sensitive", slot: slots.sensitive }),
    ]);

    const candidates = correct.ok ? selectCandidates(correct.data?.errors) : [];
    const sensitiveHits = sensitive.ok ? sensitive.data?.sensitive_words || [] : [];
    const summary = summarizeSensitive(sensitiveHits);
    logger?.info(
      `核稿候选 ${candidates.length} 条（接口原始 ${correct.ok ? (correct.data?.errors || []).length : 0} 条），敏感词命中 ${summary.count} 条 / ${summary.unique.length} 个词（仅留痕）`,
    );

    return {
      enabled: true,
      ok: Boolean(correct.ok && sensitive.ok),
      skipped: false,
      candidates,
      sensitive: sensitiveHits,
      errors: { correct: correct.error || null, sensitive: sensitive.error || null },
      timings: { correct_ms: correct.duration_ms ?? null, sensitive_ms: sensitive.duration_ms ?? null },
    };
  }

  async function health() {
    if (!enabled) return { ok: false, reason: "disabled or base_url missing" };
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
      return { ok: res.ok, status: res.status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return { check, health, enabled };
}

/** 只保留可交给改稿模型的错别字候选；大小写差异与纯 ASCII 短词一律视为噪声。 */
export function selectCandidates(errors = []) {
  const seen = new Set();
  const candidates = [];
  for (const error of errors || []) {
    const original = String(error?.original ?? "");
    const corrected = String(error?.corrected ?? "");
    if (!original || !corrected || original === corrected) continue;
    const ascii = /^[\x20-\x7E]+$/.test(original);
    if (ascii && original.toLowerCase() === corrected.toLowerCase()) continue;
    if (ascii && original.length <= 3) continue;
    const key = `${original}\u0000${corrected}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      type: "typo",
      original,
      corrected,
      line: error.line,
      start: error.start,
      end: error.end,
    });
  }
  return candidates;
}

/** 敏感词只留摘要：命中次数、去重词表、分类分布；原文仍由 api/ 留痕保存。 */
export function summarizeSensitive(hits = []) {
  const occurrences = new Map();
  const byCategory = {};
  for (const hit of hits || []) {
    const word = String(hit?.word || "").trim();
    if (!word) continue;
    occurrences.set(word, (occurrences.get(word) || 0) + 1);
    const category = hit.category || "unknown";
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  return {
    count: [...occurrences.values()].reduce((sum, n) => sum + n, 0),
    unique: [...occurrences.keys()],
    by_category: byCategory,
  };
}
