const fs = require("fs");

const KB_LLM_BASE_URL = process.env.KB_LLM_BASE_URL || "http://localhost:11434/v1";
const KB_LLM_API_KEY = process.env.KB_LLM_API_KEY || "";
const DEFAULT_MODEL = "qwen2.5:3b";
const REQUEST_TIMEOUT_MS = Number(process.env.KB_LLM_TIMEOUT_MS || 120000);
const MAX_RETRIES = 3;

const MODEL = process.env.KB_LLM_MODEL || DEFAULT_MODEL;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (KB_LLM_API_KEY) headers["Authorization"] = `Bearer ${KB_LLM_API_KEY}`;
  return headers;
}

async function llmChat(systemPrompt, userPrompt, model) {
  const useModel = model || MODEL;
  let lastErr;
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
          temperature: 0,
          top_k: 40,
          repeat_penalty: 1.1,
          num_predict: 500,
          num_ctx: 8192,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error("empty LLM response");
      return content;
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES) await sleep(2000 * i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`LLM failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in LLM output");
  return JSON.parse(match[0]);
}

function loadPrompt(templatePath, vars) {
  let tpl = fs.readFileSync(templatePath, "utf-8");
  for (const [k, v] of Object.entries(vars)) {
    tpl = tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return tpl;
}

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content.replace(/^\n+/, "");
  const end = content.indexOf("---", 3);
  if (end === -1) return content.replace(/^\n+/, "");
  return content.slice(end + 3).replace(/^\n+/, "");
}

module.exports = { llmChat, extractJSON, loadPrompt, nowIso, stripFrontmatter, MODEL, MAX_RETRIES };
