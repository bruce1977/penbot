const fs = require("fs");
const path = require("path");
const { contentHash } = require("../skills/knowledge-analyze/scripts/lib/content_hash");

const [,, inboxDir, markedDir] = process.argv;

if (!inboxDir || !markedDir) {
  console.error("Usage: node analyze_to_marked.js <inbox_dir> <marked_dir>");
  process.exit(1);
}

const RATE_KEY_MAP = { value: "business", tech: "technical", public: "social", academic: "academic", ethics: "ethics" };

function loadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
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
  const title = (meta && meta.title) || "";
  const raw = (rate && rate.ratings) || {};
  const ratings = {};
  for (const [k, v] of Object.entries(RATE_KEY_MAP)) {
    ratings[v] = typeof raw[k] === "number" ? raw[k] : null;
  }
  const lines = [
    "---",
    `hash: ${yamlStr(hash)}`,
    `title: ${yamlStr(title)}`,
    `auther: ${yamlStr(meta ? meta.auther : "")}`,
    `date: ${yamlStr(meta ? meta.date : "")}`,
    `source: ${yamlStr(meta ? meta.source : "")}`,
    `tags: ${yamlArr(meta ? meta.tags : [])}`,
    `keywords: ${yamlArr(meta ? meta.keywords : [])}`,
    `summary: ${yamlStr(meta ? meta.summary : "")}`,
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
  if (!fs.existsSync(inboxDir)) {
    console.error(`Error: inbox directory not found: ${inboxDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(markedDir)) fs.mkdirSync(markedDir, { recursive: true });

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".md")).sort();
  if (files.length === 0) { console.log("No .md files found in inbox"); process.exit(0); }

  let moved = 0, wait = 0, failed = 0;
  for (const f of files) {
    const srcPath = path.join(inboxDir, f);
    const base = f.endsWith(".md") ? f.slice(0, -3) : f;
    const metaPath = path.join(inboxDir, `${base}.meta.json`);
    const ratePath = path.join(inboxDir, `${base}.rate.json`);

    if (!fs.existsSync(metaPath)) {
      console.log(`  WAIT ${f} (no .meta.json)`);
      wait++;
      continue;
    }

    try {
      const meta = loadJSON(metaPath);
      if (!meta) throw new Error("invalid .meta.json");
      const rate = loadJSON(ratePath);
      const content = fs.readFileSync(srcPath, "utf-8");
      const hash = (meta && meta.hash) || contentHash(content);
      const dstName = `${hash}_${f}`;
      const dstPath = path.join(markedDir, dstName);

      if (fs.existsSync(dstPath)) {
        console.log(`  SKIP ${f} (already in marked as ${dstName})`);
        continue;
      }

      const merged = buildFrontmatter(meta, rate, content, hash);
      fs.writeFileSync(dstPath, merged, "utf-8");
      fs.unlinkSync(srcPath);
      fs.unlinkSync(metaPath);
      if (fs.existsSync(ratePath)) fs.unlinkSync(ratePath);
      console.log(`  MERGE ${f} -> ${dstName}`);
      moved++;
    } catch (err) {
      console.error(`  FAIL ${f}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${moved} moved, ${wait} wait, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
