const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, loadPrompt } = require("./lib/llm");

const MODEL = process.env.KB_LLM_RATE_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const SYSTEM_PROMPT = "你是结构化评分器。只输出纯JSON，不要任何额外文字。";

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

// Called by the main script analyze_start.js as a module: returns a result object, does not call process.exit.
async function processFile(absPath) {
  const base = path.basename(absPath, ".md");
  const ratePath = path.join(path.dirname(absPath), `${base}.rate.json`);

  if (fs.existsSync(ratePath)) {
    return { status: "skip", file: path.basename(absPath) };
  }

  const content = fs.readFileSync(absPath, "utf-8");

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
    return { status: "error", file: path.basename(absPath), error: `validation failed: ${lastErrors.join("; ")}` };
  }

  fs.writeFileSync(ratePath, JSON.stringify(rate, null, 2), "utf-8");
  return { step: "rate", status: "ok", file: path.basename(absPath), ratePath };
}

module.exports = { processFile, buildRate, validateRate, MODEL };

// Keep the standalone CLI entry: node analyze_extract_rate.js <file_path>
if (require.main === module) {
  const [,, filePath] = process.argv;
  if (!filePath) {
    console.error("Usage: node analyze_extract_rate.js <file_path>");
    process.exit(1);
  }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.log(JSON.stringify({ status: "error", file: filePath, error: "file not found" }));
    process.exit(1);
  }
  processFile(absPath)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.status === "error" ? 1 : 0);
    })
    .catch((err) => {
      console.log(JSON.stringify({ status: "error", file: path.basename(filePath), error: err.message }));
      process.exit(1);
    });
}
