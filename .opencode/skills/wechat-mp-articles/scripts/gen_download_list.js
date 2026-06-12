const fs = require("fs");
const path = require("path");

const [,, articleListPath, articlesDir, outDir] = process.argv;
if (!articleListPath || !articlesDir || !outDir) {
  console.error("Usage: node gen_download_list.js <article_list.json> <articles_dir> <out_dir>");
  process.exit(1);
}

const articles = Object.values(JSON.parse(fs.readFileSync(articleListPath, "utf-8")));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const pendingAids = articles.map(a => a.aid);

fs.writeFileSync(path.join(outDir, "list_pending.txt"), pendingAids.join("\n") + "\n", "utf-8");
fs.writeFileSync(path.join(outDir, "list_failed.txt"), "", "utf-8");

console.log(`list_pending.txt: ${pendingAids.length} articles`);
console.log(`list_failed.txt: initialized (empty)`);
