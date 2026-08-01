const fs = require("fs");
const path = require("path");

const [,, baseDir] = process.argv;
if (!baseDir) {
  console.error("Usage: node scripts/check_exists_all.js <base_dir>");
  process.exit(1);
}

const SUBDIRS = ["inbox", "marked", "weknora", "archived"];
const HASH_RE = /^[0-9a-f]{12}$/;

function extractAid(stem) {
  const parts = stem.split("_");
  let idx = 0;
  if (parts.length > 1 && HASH_RE.test(parts[0])) idx = 1;
  return parts[idx] || "";
}

function collectAids(baseDir) {
  const aids = new Set();
  for (const sub of SUBDIRS) {
    const dir = path.join(baseDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const stem = f.slice(0, -3);
      const aid = extractAid(stem);
      if (aid) aids.add(aid);
    }
  }
  return [...aids];
}

function main() {
  const aids = collectAids(baseDir);
  console.log(JSON.stringify({ existing_aids: aids }, null, 2));
}

main();
