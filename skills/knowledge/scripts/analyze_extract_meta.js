const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, loadPrompt, nowIso } = require("./lib/llm");

const MODEL = process.env.KB_LLM_META_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const SYSTEM_PROMPT = "你是结构化信息提取器。输出必须是纯 JSON，禁止使用'本文''文章''该文'等元词开头。摘要应以主体（人名/公司名/产品名）直接切入。";

// Pull the candidate title from the filename (text after the 4th underscore segment).
function titleFromFilename(baseName) {
  const parts = baseName.split("_");
  return parts.length > 4 ? parts.slice(4).join("_") : "";
}

function buildPrompt(candidateTitle, content) {
  return loadPrompt(path.join(PROMPT_DIR, "meta_prompt.txt"), {
    title: candidateTitle,
    content: content.slice(0, 8000),
  });
}

function buildMeta(parsed, candidateTitle) {
  return {
    title: String(parsed.title || candidateTitle || ""),
    date: nowIso(),
    auther: String(parsed.auther || ""),
    source: String(parsed.source || ""),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    summary: String(parsed.summary || ""),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
    model: MODEL,
  };
}

function validateMeta(meta) {
  const errors = [];
  if (!meta.title || meta.title.trim().length === 0) errors.push("title is empty");
  if (!Array.isArray(meta.tags) || meta.tags.length < 2 || meta.tags.length > 5) errors.push(`tags should be 2-5 items, got ${meta.tags ? meta.tags.length : 0}`);
  if (!meta.summary || meta.summary.trim().length < 20) errors.push("summary is too short");
  if (!Array.isArray(meta.keywords) || meta.keywords.length < 3 || meta.keywords.length > 5) errors.push(`keywords should be 3-5 items, got ${meta.keywords ? meta.keywords.length : 0}`);
  return errors;
}

// Called by the main script analyze_start.js as a module: returns a result object, does not call process.exit.
async function processFile(absPath) {
  const base = path.basename(absPath, ".md");
  const metaPath = path.join(path.dirname(absPath), `${base}.meta.json`);

  if (fs.existsSync(metaPath)) {
    return { status: "skip", file: path.basename(absPath) };
  }

  const content = fs.readFileSync(absPath, "utf-8");
  const candidateTitle = titleFromFilename(base);

  let meta = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await llmChat(SYSTEM_PROMPT, buildPrompt(candidateTitle, content), MODEL);
    const candidate = buildMeta(extractJSON(raw), candidateTitle);
    lastErrors = validateMeta(candidate);
    if (lastErrors.length === 0) {
      meta = candidate;
      break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
  }

  if (!meta) {
    return { status: "error", file: path.basename(absPath), error: `validation failed: ${lastErrors.join("; ")}` };
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return { step: "meta", status: "ok", file: path.basename(absPath), metaPath };
}

module.exports = { processFile, buildMeta, validateMeta, MODEL };

// Keep the standalone CLI entry: node analyze_extract_meta.js <file_path>
if (require.main === module) {
  const [,, filePath] = process.argv;
  if (!filePath) {
    console.error("Usage: node analyze_extract_meta.js <file_path>");
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
