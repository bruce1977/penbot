const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [,, articlesDir, outDirArg, analysisPath, configArg, dateSuffix, articleListPath] = process.argv;
if (!articlesDir || !outDirArg) {
  console.error("Usage: node gen_summary_report.js <articles_dir> <output_dir> [analysis_json] [config_path] [date_suffix] [article_list_json]");
  process.exit(1);
}
const dateTag = dateSuffix || new Date().toISOString().slice(0,10).replace(/-/g, "");

const configPath = configArg || path.join(__dirname, "..", "config.json");
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); }
catch { config = { accounts: [], settings: {} }; }

let outDir = outDirArg;
const namePrefix = (config.settings && config.settings.name) || "";
if (namePrefix) {
  const pDir = path.dirname(outDirArg);
  const bDir = path.basename(outDirArg);
  outDir = path.join(pDir, namePrefix, bDir);
}
const acctCategory = {};
(config.accounts || []).forEach(a => { acctCategory[a.name] = a.category || "未分类"; });

// Load article metadata from JSON (primary source)
let articleMeta = {};
if (articleListPath) {
  try { articleMeta = JSON.parse(fs.readFileSync(articleListPath, "utf-8")); } catch {}
}

// Scan .md files for file list only, parse nothing
const allFiles = [];
function scanDir(dir) {
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) scanDir(fp);
      else if (e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("~") && !e.name.startsWith("download_report_") && !e.name.startsWith("summary_")) allFiles.push(fp);
    });
  } catch {}
}
scanDir(articlesDir);

// Build articles list from metadata JSON
const articles = [];
Object.entries(articleMeta).forEach(([aid, meta]) => {
  const date = meta.update_time ? new Date(meta.update_time * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
  const file = allFiles.find(f => path.basename(f).startsWith(aid + "_"));
  articles.push({
    aid,
    file: file ? path.relative(articlesDir, file).replace(/\\/g, "/") : null,
    title: meta.title || "",
    url: meta.link || "",
    account: meta.account_name || "",
    date,
    digest: meta.digest || "",
    score: "-",
    category: acctCategory[meta.account_name] || meta.account_category || "未分类",
  });
});
articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

// Load tags from analysis JSON
if (analysisPath) {
  try {
    const ad = JSON.parse(safeRead(analysisPath));
    const tagMap = {};
    (ad.articles || []).forEach(a => { if (a.link) tagMap[a.link] = (a.tags || []); });
    articles.forEach(a => { a.tags = tagMap[a.url] || []; });
    // Also backfill scores from enhanced analysis
    (ad.articles || []).forEach(a => {
      if (a.link && a.score) {
        const match = articles.find(x => x.url === a.link);
        if (match) match.score = a.score;
      }
    });
  } catch (e) { console.error("Failed to load analysis JSON: " + e.message); }
}
articles.forEach(a => { if (!a.tags) a.tags = []; });

function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; } }

// Group by account
const byAccount = {};
articles.forEach(a => {
  if (!byAccount[a.account]) byAccount[a.account] = { name: a.account, category: a.category, articles: [] };
  byAccount[a.account].articles.push(a);
});

// Dates
const dates = articles.map(a => a.date).filter(Boolean).sort();

// Read topic files
const topics = [];
if (fs.existsSync(outDir)) {
  fs.readdirSync(outDir).filter(f => f.startsWith("topic_") && f.endsWith(".md")).sort().forEach(f => {
    const c = safeRead(path.join(outDir, f));
    const titleMatch = c.match(/^# (.+)$/m);
    const articleCount = (c.match(/\| \d+ \| \d{4}-\d{2}-\d{2} \|/g) || []).length;
    const accounts = new Set();
    (c.match(/\| \d+ \| \d{4}-\d{2}-\d{2} \| (.+?) \|/g) || []).forEach(m => {
      const a = m.replace(/\| \d+ \| \d{4}-\d{2}-\d{2} \| /, "").replace(/\s*\|.*$/, "").trim();
      if (a) accounts.add(a);
    });
    const heatMatch = c.match(/\| 热度[：:](.+?)\s+\|/);
    const heat = heatMatch ? heatMatch[1].trim() : "中";
    const overviewMatch = c.match(/## 主题概述\s*\n\s*\n(.+?)\n\s*\n---/s);
    const overview = overviewMatch ? overviewMatch[1].trim().replace(/\n/g, " ") : "";
    topics.push({ title: titleMatch ? titleMatch[1].trim() : f.replace(/^topic_/, "").replace(/\.md$/, ""), file: f, article_count: articleCount, account_count: accounts.size, heat, overview });
  });
}

// Tag frequency
const tagFreq = {};
articles.forEach(a => (a.tags || []).forEach(t => { if (!tagFreq[t]) tagFreq[t] = { count: 0, accounts: new Set() }; tagFreq[t].count++; tagFreq[t].accounts.add(a.account); }));

const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

const scored = articles.filter(a => a.score !== "-" && parseInt(a.score) >= 4);

const categoryCount = new Set(articles.map(a => a.category)).size;
const data = {
  timestamp: ts,
  article_count: articles.length,
  account_count: Object.keys(byAccount).length,
  category_count: categoryCount,
  earliest_date: dates[0] || "",
  latest_date: dates[dates.length - 1] || "",
  topics,
  account_summary: Object.values(byAccount).map(acct => {
    const scores = acct.articles.map(a => parseInt(a.score)).filter(s => !isNaN(s));
    return { name: acct.name, category: acct.category, article_count: acct.articles.length, best_score: scores.length > 0 ? Math.max(...scores) : "-" };
  }),
  tags_summary: Object.entries(tagFreq).sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([tag, info]) => ({ tag, count: info.count, accounts: [...info.accounts].join("、") })),
  article_list: articles.map((a, i) => ({ index: i + 1, date: (a.date || "").substring(0, 10), account: a.account, category: a.category, title: a.title, url: a.url, digest: a.digest, score: a.score, tags: (a.tags || []).join(", ") || "-" })),
  highlights: scored.slice(0, 5).map(h => ({ source: h.account, title: h.title, url: h.url, reason: "质量评分 " + h.score, tags: (h.tags || []).join("、") })),
};

const tmpl = fs.readFileSync(path.join(__dirname, "..", "templates", "template_summary.md"), "utf-8");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "summary_report_" + dateTag + ".md");
fs.writeFileSync(outPath, Mustache.render(tmpl, data), "utf-8");
console.log(outPath);
