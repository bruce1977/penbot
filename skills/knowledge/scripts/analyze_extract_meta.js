const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, loadPrompt, nowIso } = require("./lib/llm");

const MODEL = process.env.KB_LLM_META_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const SYSTEM_PROMPT = "You are a structured information extractor. Output must be pure JSON. Do not start with words like 'this article' or 'the article'. Summaries should begin directly with the subject (person/company/product).";

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

// Extract metadata from content and write to target file.
// @param {string} content - markdown content to extract metadata from
// @param {string} targetFile - path to write .meta.json output
// @param {string} sourceName - source file name for title extraction and logging
// @returns {Promise<{status: string, file?: string, error?: string, metaPath?: string}>}
async function processFile(content, targetFile, sourceName) {
  const base = path.basename(sourceName, ".md");
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
    return { status: "error", file: sourceName, error: `validation failed: ${lastErrors.join("; ")}` };
  }

  const targetDir = path.dirname(targetFile);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(meta, null, 2), "utf-8");
  return { status: "ok", file: sourceName, metaPath: targetFile };
}

module.exports = { processFile, buildMeta, validateMeta, MODEL };
