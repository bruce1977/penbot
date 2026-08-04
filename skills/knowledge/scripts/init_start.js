const fs = require("fs");
const path = require("path");

const [,, baseDir] = process.argv;

if (!baseDir) {
  console.error("Usage: node init_start.js <base_dir>");
  console.error("  base_dir: 知识库 profile 根目录（如 D:/knowledge/articles/ai）");
  process.exit(1);
}

const DIRS = ["inbox", "marked", "weknora", "archive"];
const DEFAULT_CONFIG = {
  weknora: { category_id: "", sync_enabled: true },
  archive: { days: 90 },
  analyze: { batch_size: 30 },
  sync: { submit_interval_ms: 10000 }
};

let created = 0;
for (const d of DIRS) {
  const p = path.join(baseDir, d);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
    console.log(`  CREATED ${d}/`);
    created++;
  }
}

const configPath = path.join(baseDir, "config.json");
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  console.log("  CREATED config.json (default)");
  created++;
}

console.log(`\nDone. ${created} items created in ${baseDir}`);
