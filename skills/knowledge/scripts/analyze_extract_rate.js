const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, loadPrompt } = require("./lib/llm");

const MODEL = process.env.KB_LLM_RATE_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const SYSTEM_PROMPT = "You are a structured rater. Output pure JSON only, no additional text.";

function buildPrompt(content) {
  return loadPrompt(path.join(PROMPT_DIR, "rate_prompt.txt"), {
    content: content.slice(0, 6000),
  });
}

// Coerce a parsed value to a number, or null when missing/invalid (handled by validateRate).
function toNum(v) {
  return typeof v === "number" ? v : null;
}

function buildRate(parsed) {
  return {
    ratings: {
      value: toNum(parsed.value),
      tech: toNum(parsed.tech),
      public: toNum(parsed.public),
      academic: toNum(parsed.academic),
      ethics: toNum(parsed.ethics),
    },
    model: MODEL,
  };
}

function validateRate(rate) {
  const errors = [];
  const dims = ["value", "tech", "public", "academic", "ethics"];
  for (const dim of dims) {
    const v = rate.ratings[dim];
    // null/undefined is treated as a failure: rate_prompt already forbids the model from
    // outputting null and requires a 0.5-5 estimate for every dimension. Therefore a null
    // indicates the model disregarded instructions (a real error) and should trigger a
    // retry, rather than being written into the result.
    if (v === null || v === undefined) {
      errors.push(`${dim} is null/undefined (must be 0.5-5)`);
    } else if (typeof v !== "number" || v < 0.5 || v > 5) {
      errors.push(`${dim}=${v} out of range [0.5, 5]`);
    }
  }
  return errors;
}

// Extract rating from content and write to target file.
// @param {string} content - markdown content to rate
// @param {string} targetFile - path to write .rate.json output
// @param {string} sourceName - source file name for logging
// @returns {Promise<{status: string, file?: string, error?: string, ratePath?: string}>}
async function processFile(content, targetFile, sourceName) {
  let rate = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await llmChat(SYSTEM_PROMPT, buildPrompt(content), MODEL);
    const candidate = buildRate(extractJSON(raw));
    lastErrors = validateRate(candidate);
    if (lastErrors.length === 0) {
      rate = candidate;
      break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
  }

  if (!rate) {
    return { status: "error", file: sourceName, error: `validation failed: ${lastErrors.join("; ")}` };
  }

  const targetDir = path.dirname(targetFile);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(rate, null, 2), "utf-8");
  return { status: "ok", file: sourceName, ratePath: targetFile };
}

module.exports = { processFile, buildRate, validateRate, MODEL };
