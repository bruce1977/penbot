const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [,, articlesDir, outDirArg, analysisPath, configArg, dateSuffix] = process.argv;

const TEMPLATE_FILE = path.join(__dirname, "..", "templates", "template_summary.md");
const TOP_TAGS_COUNT = 10;

function esc(str) { return (str || "").replace(/\|/g, "\u4e28").replace(/\[/g, "\u3014").replace(/\]/g, "\u3015").replace(/\(/g, "\uff08").replace(/\)/g, "\uff09"); }
function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; } }
function fmtDate(ts) { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function nowStamp() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")} ${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`; }

function parseArgs() {
  if (!articlesDir || !outDirArg || !configArg) {
    console.error("Usage: node gen_summary_report.js <articles_dir> <output_dir> [analysis_json] <config_path> [date_suffix]");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configArg, "utf-8"));
  const namePrefix = (config.settings && config.settings.name) || "";
  if (!namePrefix) {
    console.error("Error: config.settings.name is empty");
    process.exit(1);
  }
  const dateTag = dateSuffix || new Date().toISOString().slice(0,10).replace(/-/g, "");
  return { config, dateTag };
}

function buildCategoryLookup(config) {
  const lookup = {};
  (config.accounts || []).forEach(a => { lookup[a.name] = a.category || "未分类"; });
  return lookup;
}

function loadArticles(analysisPath, articlesDir, acctCategory) {
  const articles = [];
  if (!analysisPath) return articles;
  try {
    const ad = JSON.parse(safeRead(analysisPath));
    (ad.articles || []).forEach(meta => {
      if (!meta.link && !meta.url) return;
      const date = meta.update_time ? fmtDate(meta.update_time) : "";
      const fname = meta.file_name || meta.file_path;
      const file = fname && fs.existsSync(path.join(articlesDir, fname)) ? path.join(articlesDir, fname) : null;
      const tags = meta.tags || [];
      articles.push({
        aid: meta.aid || "",
        file: file ? path.relative(articlesDir, file).replace(/\\/g, "/") : null,
        title: (meta.title || "").replace(/\|/g, "丨").trim(),
        url: meta.link || meta.url || "",
        account: meta.account || meta.account_name || "",
        date,
        digest: meta.digest || "",
        score: meta.score != null ? (String(meta.score).includes("/") ? String(meta.score) : String(meta.score) + "/5") : "-",
        category: acctCategory[meta.account || meta.account_name] || meta.category || meta.account_category || "未分类",
        tags,
      });
    });
  } catch (e) { console.error("Failed to load analysis JSON: " + e.message); }
  return articles;
}

function sortArticles(articles) {
  articles.sort((a, b) => {
    const aScore = parseInt(a.score) || 0;
    const bScore = parseInt(b.score) || 0;
    if (bScore !== aScore) return bScore - aScore;
    return (b.date || "").localeCompare(a.date || "");
  });
}

function groupByAccount(articles) {
  const byAccount = {};
  articles.forEach(a => {
    if (!byAccount[a.account]) byAccount[a.account] = { name: a.account, category: a.category, articles: [] };
    byAccount[a.account].articles.push(a);
  });
  return byAccount;
}

function computeDates(articles) {
  return articles.map(a => a.date).filter(Boolean).sort();
}

function buildTagFrequency(articles) {
  const tagFreq = {};
  articles.forEach(a => (a.tags || []).forEach(t => {
    if (!tagFreq[t]) tagFreq[t] = { count: 0, accounts: new Set() };
    tagFreq[t].count++;
    tagFreq[t].accounts.add(a.account);
  }));
  return tagFreq;
}

function loadTopics(outDir) {
  const topics = [];
  if (!fs.existsSync(outDir)) return topics;
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
    topics.push({ title: esc(titleMatch ? titleMatch[1].trim() : f.replace(/^topic_/, "").replace(/\.md$/, "")), file: f, article_count: articleCount, account_count: accounts.size, heat, overview: esc(overview) });
  });
  return topics;
}

function buildTemplateData(articles, byAccount, dates, topics, tagFreq, config, ts) {
  const categoryCount = new Set(articles.map(a => a.category)).size;
  const topN = config.settings.top_n_articles || 5;
  const scored = articles.filter(a => a.score !== "-" && parseInt(a.score) >= 4);
  return {
    timestamp: ts,
    article_count: articles.length,
    account_count: Object.keys(byAccount).length,
    category_count: categoryCount,
    earliest_date: dates[0] || "",
    latest_date: dates[dates.length - 1] || "",
    topics,
    account_summary: Object.values(byAccount).map(acct => {
      const scores = acct.articles.map(a => parseInt(a.score)).filter(s => !isNaN(s));
      return { name: esc(acct.name), category: esc(acct.category), article_count: acct.articles.length, best_score: scores.length > 0 ? Math.max(...scores) : "-" };
    }),
    tags_summary: Object.entries(tagFreq).sort((a, b) => b[1].count - a[1].count).slice(0, TOP_TAGS_COUNT).map(([tag, info]) => ({ tag: esc(tag), count: info.count, accounts: esc([...info.accounts].join("、")) })),
    article_list: articles.map((a, i) => ({ index: i + 1, date: (a.date || "").substring(0, 10), account: esc(a.account), category: esc(a.category), title: esc(a.title), url: esc(a.url), digest: esc(a.digest), score: a.score, tags: esc((a.tags || []).join(", ")) || "-" })),
    highlights: scored.slice(0, topN).map(h => ({ source: esc(h.account), title: esc(h.title), url: esc(h.url), reason: "质量评分 " + h.score, tags: esc((h.tags || []).join("、")) })),
  };
}

function renderReport(data, outDir, dateTag) {
  const tmpl = fs.readFileSync(TEMPLATE_FILE, "utf-8");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "summary_report_" + dateTag + ".md");
  fs.writeFileSync(outPath, Mustache.render(tmpl, data), "utf-8");
  console.log(outPath);
}

function main() {
  // 步骤 1: 解析命令行参数与配置文件
  const { config, dateTag } = parseArgs();
  const acctCategory = buildCategoryLookup(config);
  // 步骤 2: 加载并排序文章数据
  const articles = loadArticles(analysisPath, articlesDir, acctCategory);
  sortArticles(articles);
  // 步骤 3: 分组统计
  const byAccount = groupByAccount(articles);
  const dates = computeDates(articles);
  const tagFreq = buildTagFrequency(articles);
  // 步骤 4: 加载主题报告
  const topics = loadTopics(outDirArg);
  // 步骤 5: 组装模板数据并渲染
  const ts = nowStamp();
  const data = buildTemplateData(articles, byAccount, dates, topics, tagFreq, config, ts);
  renderReport(data, outDirArg, dateTag);
}

main();
