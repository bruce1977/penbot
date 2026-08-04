const fs = require("fs");
const path = require("path");
const { contentHash } = require("./lib/content_hash");
const { stripFrontmatter } = require("./lib/llm");

const RATE_KEY_MAP = { value: "business", tech: "technical", public: "social", academic: "academic", ethics: "ethics" };

// Replace filename-illegal characters and cap length so the target name stays valid on any OS.
function sanitizeTitle(title) {
  return String(title || "untitled")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function yamlStr(s) {
  if (s == null) return '""';
  return JSON.stringify(String(s));
}

function yamlArr(arr) {
  if (!Array.isArray(arr)) arr = [];
  return "[" + arr.map(x => JSON.stringify(String(x))).join(", ") + "]";
}

function buildFrontmatter(meta, rate, body, hash) {
  const raw = (rate && rate.ratings) || {};
  const ratings = {};
  for (const [k, v] of Object.entries(RATE_KEY_MAP)) {
    ratings[v] = typeof raw[k] === "number" ? raw[k] : null;
  }
  const lines = [
    "---",
    `hash: ${yamlStr(hash)}`,
    `title: ${yamlStr(meta.title || "")}`,
    `auther: ${yamlStr(meta.auther || "")}`,
    `date: ${yamlStr(meta.date || "")}`,
    `source: ${yamlStr(meta.source || "")}`,
    `tags: ${yamlArr(meta.tags)}`,
    `keywords: ${yamlArr(meta.keywords)}`,
    `summary: ${yamlStr(meta.summary || "")}`,
    `model: ${yamlStr(meta.model || "")}`,
    "rating:",
    `  business: ${ratings.business}`,
    `  technical: ${ratings.technical}`,
    `  social: ${ratings.social}`,
    `  academic: ${ratings.academic}`,
    `  ethics: ${ratings.ethics}`,
    "---",
  ];
  return `${lines.join("\n")}\n\n${body}`;
}

// Called by analyze_start.js as a module: returns a result object, does not call process.exit.
//
// The hash is derived from the body AFTER stripping any existing frontmatter, so it reflects the
// pure document content and is never polluted by metadata. When targetDir is provided the merged
// file is written there as `${hash}_${title}.md`; otherwise only the in-memory result is returned.
function processFile(absPath, targetDir) {
  if (!fs.existsSync(absPath)) {
    return { status: "error", file: path.basename(absPath), error: "file not found" };
  }

  const base = path.basename(absPath, ".md");
  const srcDir = path.dirname(absPath);
  const metaPath = path.join(srcDir, `${base}.meta.json`);
  const ratePath = path.join(srcDir, `${base}.rate.json`);

  if (!fs.existsSync(metaPath)) {
    return { status: "skip", file: path.basename(absPath), reason: "no .meta.json" };
  }

  const meta = loadJSON(metaPath);
  if (!meta) {
    return { status: "error", file: path.basename(absPath), error: "invalid .meta.json" };
  }

  const rate = loadJSON(ratePath);

  // Strip existing metadata first, then hash the clean body.
  const cleanBody = stripFrontmatter(fs.readFileSync(absPath, "utf-8"));
  const hash = contentHash(cleanBody);

  const merged = buildFrontmatter(meta, rate, cleanBody, hash);

  let targetPath = null;
  if (targetDir) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    targetPath = path.join(targetDir, `${hash}_${sanitizeTitle(meta.title)}.md`);
    fs.writeFileSync(targetPath, merged, "utf-8");
  }

  return { step: "merge", status: "ok", file: path.basename(absPath), hash, targetPath, merged };
}

module.exports = { processFile, buildFrontmatter, sanitizeTitle, RATE_KEY_MAP };

// Keep the standalone CLI entry: node analyze_merge.js <file_path> [target_dir]
// Without target_dir it only prints the result (no file written).
if (require.main === module) {
  const [,, filePath, outDir] = process.argv;
  if (!filePath) {
    console.error("Usage: node analyze_merge.js <file_path> [target_dir]");
    process.exit(1);
  }
  const result = processFile(path.resolve(filePath), outDir);
  console.log(JSON.stringify(result));
  process.exit(result.status === "error" ? 1 : 0);
}
