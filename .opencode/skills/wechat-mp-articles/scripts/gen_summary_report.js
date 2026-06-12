const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [,, articlesDir, outDirArg, analysisPath, configArg, dateSuffix] = process.argv;
if (!articlesDir || !outDirArg) {
  console.error("Usage: node gen_summary_report.js <articles_dir> <output_dir> [analysis_json] [config_path] [date_suffix]");
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

function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; } }

// Build articles list from enriched analysis JSON (metadata merged by merge_analysis_meta.js)
const articles = [];
if (analysisPath) {
  try {
    const ad = JSON.parse(safeRead(analysisPath));
    (ad.articles || []).forEach(meta => {
      if (!meta.link && !meta.url) return;
      const aid = meta.aid || "";
      const date = meta.update_time ? new Date(meta.update_time * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
      const fname = meta.file_name || meta.file_path;
      const file = fname && fs.existsSync(path.join(articlesDir, fname)) ? path.join(articlesDir, fname) : null;
      articles.push({
        aid,
        file: file ? path.relative(articlesDir, file).replace(/\\/g, "/") : null,
        title: meta.title || "",
        url: meta.link || meta.url || "",
        account: meta.account_name || "",
        date,
        digest: meta.digest || "",
        score: meta.score != null ? String(meta.score) + "/5" : "-",
        category: acctCategory[meta.account_name] || meta.account_category || "未分类",
        tags: meta.tags || [],
      });
    });
  } catch (e) { console.error("Failed to load analysis JSON: " + e.message); }
}
articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
articles.forEach(a => { if (!a.tags) a.tags = []; });

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
