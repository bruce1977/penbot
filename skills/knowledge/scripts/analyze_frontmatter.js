const fs = require("fs");
const path = require("path");

const RATE_KEY_MAP = { value: "business", tech: "technical", public: "social", academic: "academic", ethics: "ethics" };

// Replace filename-illegal characters and cap length so the target name stays valid on any OS.
function sanitizeTitle(title) {
  return String(title || "untitled")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function yamlStr(s) {
  if (s == null) return '""';
  return JSON.stringify(String(s));
}

function yamlArr(arr) {
  if (!Array.isArray(arr)) arr = [];
  return "[" + arr.map(x => JSON.stringify(String(x))).join(", ") + "]";
}

// Generate YAML frontmatter header from metadata and rating.
// @param {Object} meta - metadata object
// @param {Object} rate - rating object
// @param {string} hash - content hash
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(meta, rate, hash) {
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
  return lines.join("\n");
}

// Load JSON file safely.
function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

module.exports = { generateYamlHeader, sanitizeTitle, loadJSON, RATE_KEY_MAP };
