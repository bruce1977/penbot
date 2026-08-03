const fs = require("fs");
const path = require("path");
const { contentHash } = require("./lib/content_hash");

const RATE_KEY_MAP = { value: "business", tech: "technical", public: "social", academic: "academic", ethics: "ethics" };

const [,, filePath] = process.argv;

if (!filePath) {
  console.error("Usage: node merge_to_marked.js <file_path>");
  process.exit(1);
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

function main() {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.log(JSON.stringify({ status: "error", file: path.basename(filePath), error: "file not found" }));
    process.exit(1);
  }

  const base = path.basename(absPath, ".md");
  const srcDir = path.dirname(absPath);
  const metaPath = path.join(srcDir, `${base}.meta.json`);
  const ratePath = path.join(srcDir, `${base}.rate.json`);

  if (!fs.existsSync(metaPath)) {
    console.log(JSON.stringify({ status: "skip", file: path.basename(absPath), reason: "no .meta.json" }));
    process.exit(0);
  }

  const meta = loadJSON(metaPath);
  if (!meta) {
    console.log(JSON.stringify({ status: "error", file: path.basename(absPath), error: "invalid .meta.json" }));
    process.exit(1);
  }

  const rate = loadJSON(ratePath);
  const content = fs.readFileSync(absPath, "utf-8");
  const hash = meta.hash || contentHash(content);

  const merged = buildFrontmatter(meta, rate, content, hash);

  console.log(JSON.stringify({
    status: "ok",
    file: path.basename(absPath),
    hash,
    merged,
  }));
}

main();