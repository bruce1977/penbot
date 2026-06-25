const fs = require("fs");
const path = require("path");

const [,, downloadReportPath, articlesDir, analysisPath, configPath] = process.argv;

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function parseArgs() {
  if (!downloadReportPath || !articlesDir || !analysisPath) {
    console.error("Usage: node merge_scored_articles.js <download_report.json> <articles_dir> <analysis_report.json> [config.json]");
    process.exit(1);
  }
  const downloadReport = JSON.parse(fs.readFileSync(downloadReportPath, "utf-8"));
  let topicGuidance = "";
  let topicCount = null;
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      topicGuidance = (cfg.settings && cfg.settings.topic_selection_guidance) || "";
      topicCount = (cfg.settings && cfg.settings.topic_count) || null;
    } catch { /* ignore */ }
  }
  return { downloadReport, topicGuidance, topicCount };
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

function buildAnalysis(downloadReport, articlesDir) {
  const articles = [];

  (downloadReport.articles || []).forEach(dl => {
    let score = null;
    let tags = [];
    let summary = null;
    let downloadStatus = dl.download_status || "成功";

    if (dl.file_path) {
      const metaName = dl.file_path.replace(/\.md$/i, '.meta.json');
      const metaFull = path.join(articlesDir, metaName);
      const meta = readScore(metaFull);
      if (meta) {
        score = meta.score;
        tags = meta.tags;
        summary = meta.summary;
      }
    }

    if (downloadStatus !== "成功" && score === null) {
      downloadStatus = "失败";
    }

    const article = {
      link: dl.url || "",
      score,
      tags,
      summary,
      title: dl.title || "",
      account_name: dl.account_name || "",
      account_category: dl.account_category || "",
      digest: dl.digest || "",
      update_time: dl.update_time || null,
      file_path: dl.file_path || null,
      aid: dl.aid || "",
    };

    if (downloadStatus === "失败") {
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
  const { downloadReport, topicGuidance, topicCount } = parseArgs();
  const articles = buildAnalysis(downloadReport, articlesDir);
  writeReport(articles, topicGuidance, topicCount);
}

main();
