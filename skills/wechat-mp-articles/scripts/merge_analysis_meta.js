const fs = require("fs");

const [,, downloadReportPath, analysisPath] = process.argv;

const FIELDS_TO_MERGE = ["title", "account_name", "account_category", "digest", "update_time", "file_path", "aid"];

function parseArgs() {
  if (!downloadReportPath || !analysisPath) {
    console.error("Usage: node merge_analysis_meta.js <download_report.json> <analysis_report.json>");
    process.exit(1);
  }
  const downloadReport = JSON.parse(fs.readFileSync(downloadReportPath, "utf-8"));
  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
  if (!analysis.articles) analysis.articles = [];
  return { downloadReport, analysis };
}

function buildMetaMap(downloadReport) {
  const metaMap = {};
  (downloadReport.articles || []).forEach(a => {
    const key = a.url || a.link;
    if (key) metaMap[key] = a;
  });
  return metaMap;
}

function mergeMetadata(analysis, metaMap) {
  let merged = 0;
  analysis.articles.forEach(a => {
    const key = a.link || a.url;
    const meta = metaMap[key];
    if (meta) {
      FIELDS_TO_MERGE.forEach(field => {
        if (!a[field] && meta[field] != null) a[field] = meta[field];
      });
      // carry over download_status if present
      if (meta.download_status) a.download_status = meta.download_status;
      merged++;
    }
  });
  return merged;
}

function injectFailedArticles(downloadReport, analysis) {
  const existingUrls = new Set(analysis.articles.map(a => a.link || a.url).filter(Boolean));
  let injected = 0;

  (downloadReport.articles || []).forEach(dl => {
    const url = dl.url || dl.link;
    if (!url || existingUrls.has(url)) return;

    const newArticle = {
      link: url,
      score: null,
      tags: [],
      download_status: "失败",
      title: dl.title || "",
      account_name: dl.account_name || "",
      account_category: dl.account_category || "",
      digest: dl.digest || "",
      update_time: dl.update_time || null,
      file_path: null,
      aid: dl.aid || "",
    };
    analysis.articles.push(newArticle);
    injected++;
  });

  return injected;
}

function main() {
  // Step 1: parse and load both JSON files
  const { downloadReport, analysis } = parseArgs();
  // Step 2: build metadata lookup by url/link
  const metaMap = buildMetaMap(downloadReport);
  // Step 3: merge download metadata into analysis articles
  const merged = mergeMetadata(analysis, metaMap);
  // Step 4: inject failed-download articles not already in analysis
  const injected = injectFailedArticles(downloadReport, analysis);
  // Step 5: write enriched analysis JSON
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`Merged metadata for ${merged} articles, injected ${injected} failed articles -> ${analysisPath}`);
}

main();
