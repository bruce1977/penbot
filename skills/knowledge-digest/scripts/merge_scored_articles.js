const fs = require("fs");
const path = require("path");

const [,, configPath, analysisPath] = process.argv;

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function parseArgs() {
  if (!configPath || !analysisPath) {
    console.error("Usage: node merge_scored_articles.js <config-runtime> <analysis_report.json>");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const files = config.files || [];
  if (files.length === 0) {
    console.error("Error: config.files is empty");
    process.exit(1);
  }
  const topicGuidance = (config.settings && config.settings.topic_selection_guidance) || "";
  const topicCount = (config.settings && config.settings.topic_count) || null;
  return { config, files, topicGuidance, topicCount };
}

function extractMeta(fileObj) {
  const fpath = fileObj.path;
  const fname = path.basename(fpath);
  const nameNoExt = fname.replace(/\.md$/i, '');

  let aid = fileObj.aid || "";
  let title = fileObj.title || "";
  let accountName = fileObj.account_name || fileObj.account || "";
  let accountCategory = fileObj.account_category || fileObj.category || "";

  if (!aid || !title || !accountName) {
    const parts = nameNoExt.split('_');
    if (parts.length >= 2) {
      if (!aid) aid = parts[0];
      if (!accountName && parts.length >= 3) accountName = parts[2];
      if (!title) title = parts.slice(3).join('_') || nameNoExt;
    }
  }
  if (!title) title = nameNoExt;

  return {
    aid,
    title,
    account_name: accountName,
    account_category: accountCategory,
    file_path: fname,
    url: fileObj.url || "",
    cover: fileObj.cover || "",
    digest: fileObj.digest || "",
    create_time: fileObj.create_time || null,
    update_time: fileObj.update_time || null,
    fake_id: fileObj.fake_id || "",
    file_full_path: fpath,
  };
}

function readScore(metaPath) {
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return {
      score: typeof data.score === 'number' ? data.score : null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      summary: typeof data.summary === 'string' ? data.summary : null,
    };
  } catch {
    return null;
  }
}

function buildAnalysis(files) {
  const articles = [];

  files.forEach(fileObj => {
    const meta = extractMeta(fileObj);
    const metaFull = fileObj.path.replace(/\.md$/i, '.meta.json');
    const scoreData = readScore(metaFull);

    const article = {
      link: meta.url || "",
      score: scoreData ? scoreData.score : null,
      tags: scoreData ? scoreData.tags : [],
      summary: scoreData ? scoreData.summary : null,
      title: meta.title || "",
      account_name: meta.account_name || "",
      account_category: meta.account_category || "",
      digest: meta.digest || "",
      update_time: meta.update_time || null,
      file_path: meta.file_path || null,
      file_full_path: meta.file_full_path,
      aid: meta.aid || "",
    };

    if (!scoreData) {
      article.download_status = "失败";
    }

    articles.push(article);
  });

  return articles;
}

function writeReport(articles, topicGuidance, topicCount) {
  const output = {
    timestamp: fmtDate(Math.floor(Date.now() / 1000)),
    topic_count: topicCount,
    articles,
  };
  if (topicGuidance) {
    output.topic_selection_guidance = topicGuidance;
  }

  const dir = path.dirname(analysisPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(analysisPath, JSON.stringify(output, null, 2), "utf-8");

  const scoredCount = articles.filter(a => a.score !== null).length;
  const failedCount = articles.filter(a => a.download_status === "失败").length;
  console.log(`Merged ${articles.length} articles (${scoredCount} scored, ${failedCount} failed) -> ${analysisPath}`);
}

function main() {
  const { files, topicGuidance, topicCount } = parseArgs();
  const articles = buildAnalysis(files);
  writeReport(articles, topicGuidance, topicCount);
}

main();
