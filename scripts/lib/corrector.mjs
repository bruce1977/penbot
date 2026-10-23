import { sleep } from "./fsx.mjs";

/**
 * correct-cn client.
 * Docs: https://github.com/bruce1977/correct-cn
 *
 * POST {base_url}{endpoint}
 *   body: { text, enable_audit?, enable_final_suggestion? }
 *   response: { corrected_text, issues[], sensitive_words[], final_suggestion?, has_issues }
 */
export function createCorrector(correctConfig = {}, logger) {
  const base = String(correctConfig.base_url || "").replace(/\/+$/, "");
  const endpoint = correctConfig.endpoint || "/api/pipeline";
  const enabled = correctConfig.enabled !== false && Boolean(base);

  async function check(text) {
    if (!enabled) {
      return { enabled: false, ok: true, skipped: true, issues: [], corrected_text: text, final_suggestion: null };
    }
    const url = `${base}${endpoint}`;
    const body = { text };
    if (correctConfig.enable_audit !== undefined) body.enable_audit = Boolean(correctConfig.enable_audit);
    if (correctConfig.enable_final_suggestion !== undefined) {
      body.enable_final_suggestion = Boolean(correctConfig.enable_final_suggestion);
    }

    const headers = { "Content-Type": "application/json" };
    if (correctConfig.api_key) {
      headers[correctConfig.auth_header || "X-Auth-Key"] = correctConfig.api_key;
      if ((correctConfig.auth_header || "").toLowerCase() === "authorization") {
        headers.Authorization = `Bearer ${correctConfig.api_key}`;
      }
    }

    const retries = Number(correctConfig.retries ?? 2);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), correctConfig.timeout_ms || 120000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const raw = await res.text();
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`Non-JSON response: ${raw.slice(0, 200)}`);
        }
        const issues = normalizeIssues(data);
        logger?.info(
          `核稿完成：${issues.length} 条问题，has_issues=${Boolean(data.has_issues)}，corrected=${Boolean(data.corrected_text)}`,
        );
        return {
          enabled: true,
          ok: true,
          issues,
          corrected_text: data.corrected_text || text,
          final_suggestion: data.final_suggestion || null,
          review_suggestions: data.review_suggestions || "",
          typos: data.typos || [],
          sensitive_words: data.sensitive_words || [],
          raw: data,
        };
      } catch (error) {
        lastError = error;
        const message = error.name === "AbortError" ? `timeout after ${correctConfig.timeout_ms || 120000}ms` : error.message;
        logger?.warn(`核稿请求失败（第 ${attempt + 1}/${retries + 1} 次）：${message}`);
        if (attempt < retries) await sleep(1500 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    logger?.warn(`核稿服务不可用，将回退到模型校对：${lastError?.message || "unknown"}`);
    return {
      enabled: true,
      ok: false,
      skipped: false,
      error: lastError?.message || "unknown error",
      issues: [],
      corrected_text: text,
      final_suggestion: null,
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

export function normalizeIssues(data = {}) {
  const issues = [];
  for (const issue of data.issues || []) {
    issues.push({
      type: issue.type || "typo",
      verdict: issue.verdict || "",
      original: issue.original || issue.word || "",
      corrected: issue.corrected || "",
      suggestion: issue.suggestion || "",
      line: issue.line,
      start: issue.start,
      end: issue.end,
      category: issue.category,
    });
  }
  if (!issues.length) {
    for (const typo of data.typos || []) {
      issues.push({
        type: "typo",
        verdict: "typo_confirmed",
        original: typo.original || "",
        corrected: typo.corrected || "",
        suggestion: typo.original ? `${typo.original} → ${typo.corrected}` : "",
        line: typo.line,
        start: typo.start,
        end: typo.end,
      });
    }
    for (const word of data.sensitive_words || []) {
      issues.push({
        type: "sensitive",
        verdict: "sensitive_confirmed",
        original: word.word || "",
        suggestion: `敏感词：${word.word}（${word.category || ""}）`,
        line: word.line,
        category: word.category,
      });
    }
  }
  // Only confirmed issues are actionable.
  return issues.filter((issue) => {
    if (!issue.verdict) return true;
    return issue.verdict.endsWith("_confirmed");
  });
}

/**
 * Apply confirmed issues to the original text by literal replacement.
 * Falls back to the service's corrected/final text when replacements cannot be located.
 */
export function applyCorrections(article, result, { apply = "issues" } = {}) {
  if (!result || result.skipped) return { text: article, applied: 0 };
  if (apply === "final" && result.final_suggestion) {
    return { text: result.final_suggestion, applied: result.issues.length, mode: "final_suggestion" };
  }
  if (apply === "none") return { text: article, applied: 0, mode: "none" };

  let text = article;
  let applied = 0;
  for (const issue of result.issues || []) {
    if (issue.type === "sensitive") continue; // sensitive words need human/LLM judgement
    const from = issue.original;
    const to = issue.corrected;
    if (!from || !to || from === to) continue;
    if (text.includes(from)) {
      text = text.split(from).join(to);
      applied += 1;
    }
  }
  if (applied === 0 && result.corrected_text && result.corrected_text !== article) {
    // Sentence-level corrections may not be literal replacements; prefer the
    // service output only when lengths are close enough to avoid truncation.
    const ratio = result.corrected_text.length / Math.max(1, article.length);
    if (ratio > 0.9 && ratio < 1.1) {
      return { text: result.corrected_text, applied: result.issues.length, mode: "corrected_text" };
    }
  }
  return { text, applied, mode: "issues" };
}
