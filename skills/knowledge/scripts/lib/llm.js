const fs = require("fs");

// ─── Configuration ───────────────────────────────────────────────────────────

const KB_LLM_BASE_URL = process.env.KB_LLM_BASE_URL || "http://localhost:11434/v1";
const KB_LLM_API_KEY = process.env.KB_LLM_API_KEY || "";
const DEFAULT_MODEL = "qwen2.5:3b";
const MODEL = process.env.KB_LLM_MODEL || DEFAULT_MODEL;

// Provider can be set explicitly to "ollama" | "openai"; defaults to auto-detect by base_url.
const KB_LLM_PROVIDER = (process.env.KB_LLM_PROVIDER || "auto").toLowerCase();

const REQUEST_TIMEOUT_MS = Number(process.env.KB_LLM_TIMEOUT_MS || 120000);

// Caller already retries 3x on validation failure; this only guards transport errors.
const MAX_RETRIES = 2;

// ─── Statistics ──────────────────────────────────────────────────────────────

// Module-level counters for LLM request accounting.
const _llmStats = { calls: 0, retries: 0 };

function getLlmStats() {
  return { ..._llmStats };
}

// ─── Inference Parameters ────────────────────────────────────────────────────

// Common params supported by both OpenAI-compatible servers and Ollama.
const GEN_PARAMS = {
  temperature: 0.1,
  max_tokens: 400,
};

// Ollama-specific params: only attached when the target backend is Ollama.
const OLLAMA_PARAMS = {
  num_predict: 400,
  num_ctx: 8192,
  top_k: 40,
  repeat_penalty: 1.1,
  keep_alive: -1,
};

// ─── Provider Detection ──────────────────────────────────────────────────────

// Decide whether the target backend is Ollama.
function isOllamaTarget() {
  if (KB_LLM_PROVIDER === "ollama") return true;
  if (KB_LLM_PROVIDER === "openai") return false;
  return /(11434|ollama)/i.test(KB_LLM_BASE_URL);
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (KB_LLM_API_KEY) headers["Authorization"] = `Bearer ${KB_LLM_API_KEY}`;
  return headers;
}

// ─── LLM Chat ────────────────────────────────────────────────────────────────

async function llmChat(systemPrompt, userPrompt, model, opts = {}) {
  const useModel = model || MODEL;
  const temperature = typeof opts.temperature === "number" ? opts.temperature : GEN_PARAMS.temperature;

  // Attach Ollama-specific params for Ollama targets.
  const baseParams = isOllamaTarget() ? { ...GEN_PARAMS, ...OLLAMA_PARAMS } : { ...GEN_PARAMS };
  const params = { ...baseParams, temperature };

  let lastErr;
  _llmStats.calls += 1;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${KB_LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          model: useModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          ...params,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty LLM response");

      return content;
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES) {
        _llmStats.retries += 1;
        console.log(`LLM request failed (${i}/${MAX_RETRIES}): ${err.message}, retrying in ${1000 * i}ms...`);

        await sleep(1000 * i);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`LLM failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

// ─── JSON Extraction ─────────────────────────────────────────────────────────

// Extract the first JSON object from LLM output using brace counting.
function extractJSON(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in LLM output");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error("no complete JSON object in LLM output");
}

// ─── Prompt Loading ──────────────────────────────────────────────────────────

// Load a prompt template and replace {{var}} placeholders.
function loadPrompt(templatePath, vars) {
  let tpl = fs.readFileSync(templatePath, "utf-8");
  for (const [k, v] of Object.entries(vars)) {
    tpl = tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return tpl;
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

// Format current time as ISO 8601 with +08:00 timezone.
function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

// ─── Content Processing ──────────────────────────────────────────────────────

// Strip YAML frontmatter from markdown content.
function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content.replace(/^\n+/, "");
  const end = content.indexOf("---", 3);
  if (end === -1) return content.replace(/^\n+/, "");
  return content.slice(end + 3).replace(/^\n+/, "");
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  llmChat,
  extractJSON,
  loadPrompt,
  nowIso,
  stripFrontmatter,
  MODEL,
  MAX_RETRIES,
  getLlmStats,
};
