const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [,, articlesDir, outDirArg, analysisPath, configArg, articleListPath] = process.argv;
if (!articlesDir || !outDirArg || !analysisPath) {
  console.error("Usage: node gen_topic_report.js <articles_dir> <output_dir> <analysis_json> [config_path] [article_list_json]");
  process.exit(1);
}

const configPath = configArg || path.join(__dirname, "..", "config.json");
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); }
catch { config = { accounts: [], settings: {} }; }

const topicCount = (config.settings && config.settings.topic_count) || 3;
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

// Scan .md files for existence only
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

function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; } }

// Build articles list from metadata JSON, enriched with file existence
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

// ---- Dedup (title-based) ----
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}
function cleanTitle(t) { return t.replace(/[「」『』""''【】《》（）\s]/g, "").toLowerCase(); }
const threshold = 0.8;
const dupGroups = [];
const checked = new Set();
articles.forEach((a, i) => {
  if (checked.has(i)) return;
  const group = [i]; checked.add(i);
  const ti = cleanTitle(a.title);
  articles.forEach((b, j) => {
    if (i === j || checked.has(j)) return;
    if (1 - levenshtein(ti, cleanTitle(b.title)) / Math.max(ti.length, 1) > threshold) { group.push(j); checked.add(j); }
  });
  if (group.length > 1) dupGroups.push(group);
});
const dedupMap = {};
dupGroups.forEach(g => {
  g.sort((x, y) => (articles[x].date || "").localeCompare(articles[y].date || ""));
  g.slice(1).forEach(i => { dedupMap[articles[i].url] = { dupOf: articles[g[0]].url, dupTitle: articles[g[0]].title }; });
});
console.log("Dedup: " + dupGroups.length + " group(s), " + Object.keys(dedupMap).length + " article(s) marked as duplicate");

// ---- Read analysis JSON ----
const analysisRaw = safeRead(analysisPath);
let analysisData;
try { analysisData = JSON.parse(analysisRaw); } catch { analysisData = null; }

// Score backfill — write score into a companion JSON file instead of .md header
let backfilled = 0;
const scoreMap = {};
if (analysisData) {
  (analysisData.articles || []).forEach(a => { if (a.link) scoreMap[a.link] = String(a.score); });
  articles.forEach(a => {
    if (a.url && scoreMap[a.url] != null) {
      a.score = scoreMap[a.url] + "/5";
      backfilled++;
    }
  });
}
console.log("Score backfilled: " + backfilled + " articles");

// Load tags
const articleTags = {};
if (analysisData) (analysisData.articles || []).forEach(a => { if (a.link) articleTags[a.link] = (a.tags || []); });
articles.forEach(a => { a.tags = articleTags[a.url] || []; });

// ---- Rank tags ----
function tagRankData(tag) {
  const matched = articles.filter(a => (a.tags || []).includes(tag));
  const accountCount = new Set(matched.map(a => a.account)).size;
  const scores = matched.map(a => { const s = parseInt(a.score); return isNaN(s) ? 0 : s; });
  const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  return { count: matched.length, accounts: accountCount, avgScore };
}
const tagFreq = {};
articles.forEach(a => (a.tags || []).forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; }));
const rankedTags = Object.keys(tagFreq).map(t => ({ tag: t, ...tagRankData(t) })).sort((a, b) => {
  if (b.count !== a.count) return b.count - a.count;
  if (b.accounts !== a.accounts) return b.accounts - a.accounts;
  return b.avgScore - a.avgScore;
}).slice(0, topicCount).map(x => x.tag);

// Build topics
const topics = rankedTags.map(tag => {
  const matched = articles.filter(a => (a.tags || []).includes(tag));
  return { tag, topicTitle: tag, articles: matched, accounts: new Set(matched.map(a => a.account)) };
});

// ---- Generate reports ----
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const tmpl = fs.readFileSync(path.join(__dirname, "..", "templates", "template_topic.md"), "utf-8");
const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

let generated = 0;
const usedNames = new Set();
topics.forEach((topic, ti) => {
  const articleCount = topic.articles.length;
  const accountCount = topic.accounts.size;
  let heat = "中";
  if (articleCount >= 5 && accountCount >= 2) heat = "高";
  else if (articleCount <= 2) heat = "低";
  const accountsList = [...topic.accounts].join("、");
  const others = topics.filter((c, j) => j !== ti);

  const data = {
    topic_title: topic.topicTitle,
    timestamp: ts,
    heat,
    article_count: articleCount,
    account_count: accountCount,
    topic_overview: "本主题涵盖 " + articleCount + " 篇文章，来自 " + accountsList + " 等 " + accountCount + " 个公众号，内容涉及 " + topic.topicTitle + " 领域。",
    articles: topic.articles.map((a, i) => ({
      index: i + 1,
      date: (a.date || "").substring(0, 10),
      account: a.account,
      tag: topic.tag,
      title: a.title,
      url: a.url,
      digest: a.digest,
      relevance: "-",
    })),
    related_topics: others.map(o => ({ name: o.topicTitle, relation: "关联 " + o.articles.length + " 篇文章，来自 " + o.accounts.size + " 个公众号" })),
    insights: [],
  };

  let safeName = topic.topicTitle.replace(/[\\/:*?"<>|]/g, "_");
  if (usedNames.has(safeName)) {
    let i = 2;
    while (usedNames.has(safeName + "_" + i)) i++;
    safeName = safeName + "_" + i;
  }
  usedNames.add(safeName);
  const outPath = path.join(outDir, "topic_" + safeName + ".md");
  fs.writeFileSync(outPath, Mustache.render(tmpl, data), "utf-8");
  console.log(outPath);
  generated++;
});

console.error("Generated " + generated + " topic report(s) (topic_count=" + topicCount + ").");

// Write enhanced analysis JSON
const enhanced = {
  timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
  total: articles.length,
  dedup: { groupCount: dupGroups.length, affected: Object.keys(dedupMap).length, groups: dupGroups.map(g => g.map(i => ({ title: articles[i].title, account: articles[i].account }))) },
  articles: articles.map(a => ({
    link: a.url,
    title: a.title,
    account: a.account,
    category: a.category,
    score: a.score,
    tags: a.tags,
    dedup: dedupMap[a.url] || null,
    file: a.file,
  })),
};
fs.writeFileSync(analysisPath, JSON.stringify(enhanced, null, 2), "utf-8");
console.log("Enhanced analysis saved: " + analysisPath);
