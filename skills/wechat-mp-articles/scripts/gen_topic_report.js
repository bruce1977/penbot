const fs = require("fs");
const path = require("path");
const Mustache = require("mustache");

const [,, articlesDir, outDirArg, analysisPath, configArg, topicPath] = process.argv;

const TEMPLATE_FILE = path.join(__dirname, "..", "templates", "template_topic.md");
const DEDUP_THRESHOLD = 0.8;

function esc(str) { return (str || "").replace(/\|/g, "\u4e28").replace(/\[/g, "\u3014").replace(/\]/g, "\u3015").replace(/\(/g, "\uff08").replace(/\)/g, "\uff09"); }
function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; } }
function fmtDate(ts) { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function nowStamp() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")} ${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`; }
function cleanTitle(t) { return t.replace(/[「」『』""''【】《》（）\s]/g, "").toLowerCase(); }
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

function parseArgs() {
  if (!articlesDir || !outDirArg || !analysisPath || !configArg || !topicPath) {
    console.error("Usage: node gen_topic_report.js <articles_dir> <output_dir> <analysis_json> <config_path> <analysis_topic_json>");
    process.exit(1);
  }
  if (!fs.existsSync(topicPath)) {
    console.error("Error: analysis_topic.json not found: " + topicPath);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configArg, "utf-8"));
  const namePrefix = (config.settings && config.settings.name) || "";
  if (!namePrefix) {
    console.error("Error: config.settings.name is empty");
    process.exit(1);
  }
  return { config };
}

function buildCategoryLookup(config) {
  const lookup = {};
  (config.accounts || []).forEach(a => { lookup[a.name] = a.category || "未分类"; });
  return lookup;
}

function loadArticles(analysisPath, articlesDir, acctCategory) {
  const analysisRaw = safeRead(analysisPath);
  let analysisData;
  try { analysisData = JSON.parse(analysisRaw); } catch { analysisData = { articles: [] }; }

  const articles = [];
  (analysisData.articles || []).forEach(meta => {
    if (!meta.link && !meta.url) return;
    const date = meta.update_time ? fmtDate(meta.update_time) : "";
    const fname = meta.file_name || meta.file_path;
    const file = fname && fs.existsSync(path.join(articlesDir, fname)) ? path.join(articlesDir, fname) : null;
    articles.push({
      aid: meta.aid || "",
      file: file ? path.relative(articlesDir, file).replace(/\\/g, "/") : null,
      title: meta.title || "",
      url: meta.link || meta.url || "",
      account: meta.account || meta.account_name || "",
      date,
      digest: meta.digest || "",
      score: meta.score != null ? (String(meta.score).includes("/") ? String(meta.score) : String(meta.score) + "/5") : "-",
      category: acctCategory[meta.account || meta.account_name] || meta.category || meta.account_category || "未分类",
      tags: meta.tags || [],
      update_time: meta.update_time,
      file_path: meta.file_path,
      account_name: meta.account_name,
      account_category: meta.account_category,
    });
  });
  return articles;
}

function deduplicateArticles(articles) {
  const dupGroups = [];
  const checked = new Set();
  articles.forEach((a, i) => {
    if (checked.has(i)) return;
    const group = [i]; checked.add(i);
    const ti = cleanTitle(a.title);
    articles.forEach((b, j) => {
      if (i === j || checked.has(j)) return;
      if (1 - levenshtein(ti, cleanTitle(b.title)) / Math.max(ti.length, 1) > DEDUP_THRESHOLD) { group.push(j); checked.add(j); }
    });
    if (group.length > 1) dupGroups.push(group);
  });
  const dedupMap = {};
  dupGroups.forEach(g => {
    g.sort((x, y) => (articles[x].date || "").localeCompare(articles[y].date || ""));
    g.slice(1).forEach(i => { dedupMap[articles[i].url] = { dupOf: articles[g[0]].url, dupTitle: articles[g[0]].title }; });
  });
  console.log("Dedup: " + dupGroups.length + " group(s), " + Object.keys(dedupMap).length + " article(s) marked as duplicate");
  return { dedupMap, dupGroups };
}

function buildTopics(topicPath, articles) {
  const topicData = JSON.parse(fs.readFileSync(topicPath, "utf-8"));
  if (!topicData.topics || topicData.topics.length === 0) {
    console.error("Error: analysis_topic.json has no topics defined");
    process.exit(1);
  }
  return topicData.topics.map(t => {
    const matched = articles.filter(a => (a.tags || []).includes(t.name));
    return {
      tag: t.name,
      topicTitle: t.name,
      articles: matched,
      accounts: new Set(matched.map(a => a.account)),
      reasoning: t.reasoning || "",
      topic_overview: t.topic_overview || "",
      insights: t.insights || [],
    };
  });
}

function generateTopicReports(topics, outDir) {
  const tmpl = fs.readFileSync(TEMPLATE_FILE, "utf-8");
  const ts = nowStamp();
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
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
      topic_reasoning: topic.reasoning,
      timestamp: ts,
      heat,
      article_count: articleCount,
      account_count: accountCount,
      topic_overview: topic.topic_overview || ("本主题涵盖 " + articleCount + " 篇文章，来自 " + accountsList + " 等 " + accountCount + " 个公众号，内容涉及 " + topic.topicTitle + " 领域。"),
      articles: topic.articles.map((a, i) => ({
        index: i + 1,
        date: (a.date || "").substring(0, 10),
        account: esc(a.account),
        tag: topic.tag,
        title: esc(a.title),
        url: esc(a.url),
        digest: esc(a.digest),
        relevance: "-",
      })),
      related_topics: others.map(o => ({ name: o.topicTitle, relation: "关联 " + o.articles.length + " 篇文章，来自 " + o.accounts.size + " 个公众号" })),
      insights: topic.insights,
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

  console.error("Generated " + generated + " topic report(s).");
  return generated;
}

function writeEnhancedAnalysis(analysisPath, articles, dedupMap, dupGroups) {
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
      update_time: a.update_time,
      aid: a.aid,
      digest: a.digest,
      file_path: a.file_path,
      account_name: a.account_name,
      account_category: a.account_category,
    })),
  };
  fs.writeFileSync(analysisPath, JSON.stringify(enhanced, null, 2), "utf-8");
  console.log("Enhanced analysis saved: " + analysisPath);
}

function main() {
  // Step 1: parse command line args and config
  const { config } = parseArgs();
  const acctCategory = buildCategoryLookup(config);
  // Step 2: load and deduplicate articles
  const articles = loadArticles(analysisPath, articlesDir, acctCategory);
  const { dedupMap, dupGroups } = deduplicateArticles(articles);
  // Step 3: build topic data from analysis_topic.json
  const topics = buildTopics(topicPath, articles);
  // Step 4: generate topic markdown reports
  generateTopicReports(topics, outDirArg);
  // Step 5: write enhanced analysis JSON with dedup metadata
  writeEnhancedAnalysis(analysisPath, articles, dedupMap, dupGroups);
}

main();
