const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, loadPrompt } = require("./lib/llm");

const MODEL = process.env.LLM_RATE_MODEL || process.env.LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const SYSTEM_PROMPT = "你是结构化评分器。只输出纯JSON，不要任何额外文字。";

const [,, filePath] = process.argv;

if (!filePath) {
  console.error("Usage: node extract_rate.js <file_path>");
  process.exit(1);
}

function buildPrompt(content) {
  return loadPrompt(path.join(PROMPT_DIR, "rate_prompt.txt"), {
    content: content.slice(0, 8000),
  });
}

function buildRate(parsed) {
  return {
    ratings: {
      value: typeof parsed.value === "number" ? parsed.value : null,
      tech: typeof parsed.tech === "number" ? parsed.tech : null,
      public: typeof parsed.public === "number" ? parsed.public : null,
      academic: typeof parsed.academic === "number" ? parsed.academic : null,
      ethics: typeof parsed.ethics === "number" ? parsed.ethics : null,
    },
    model: MODEL,
  };
}

function validateRate(rate) {
  const errors = [];
  const dims = ["value", "tech", "public", "academic", "ethics"];
  for (const dim of dims) {
    const v = rate.ratings[dim];
    if (v === null || v === undefined) {
      errors.push(`${dim} is null/undefined`);
    } else if (typeof v !== "number" || v < 0.5 || v > 5) {
      errors.push(`${dim}=${v} out of range [0.5, 5]`);
    }
  }
  return errors;
}

async function processFile(absPath) {
  const base = path.basename(absPath, ".md");
  const ratePath = path.join(path.dirname(absPath), `${base}.rate.json`);

  if (fs.existsSync(ratePath)) {
    console.log(JSON.stringify({ status: "skip", file: path.basename(absPath) }));
    process.exit(0);
  }

  const content = fs.readFileSync(absPath, "utf-8");

  let rate = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await llmChat(SYSTEM_PROMPT, buildPrompt(content), MODEL);
    const parsed = extractJSON(raw);
    const candidate = buildRate(parsed);
    lastErrors = validateRate(candidate);
    if (lastErrors.length === 0) {
      rate = candidate;
      break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
  }

  if (!rate) {
    console.log(JSON.stringify({ status: "error", file: path.basename(absPath), error: `validation failed: ${lastErrors.join("; ")}` }));
    process.exit(1);
  }

  fs.writeFileSync(ratePath, JSON.stringify(rate, null, 2), "utf-8");
  console.log(JSON.stringify({ status: "ok", file: path.basename(absPath), ratePath }));
}

async function main() {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.log(JSON.stringify({ status: "error", file: filePath, error: "file not found" }));
    process.exit(1);
  }
  await processFile(absPath);
}

main().catch(err => {
  console.log(JSON.stringify({ status: "error", file: path.basename(filePath), error: err.message }));
  process.exit(1);
});