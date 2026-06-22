const fs = require("fs");
const path = require("path");

const [,, downloadReportPath, analysisPath] = process.argv;
if (!downloadReportPath || !analysisPath) {
  console.error("Usage: node merge_analysis_meta.js <download_report.json> <analysis_report.json>");
  process.exit(1);
}

const downloadReport = JSON.parse(fs.readFileSync(downloadReportPath, "utf-8"));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));

if (!analysis.articles) analysis.articles = [];

// Build metadata lookup keyed by url/link
const metaMap = {};
(downloadReport.articles || []).forEach(a => {
  const key = a.url || a.link;
  if (key) metaMap[key] = a;
});

let merged = 0;
analysis.articles.forEach(a => {
  const key = a.link || a.url;
  const meta = metaMap[key];
  if (meta) {
    a.title = a.title || meta.title || "";
    a.account_name = a.account_name || meta.account_name || "";
    a.account_category = a.account_category || meta.account_category || "";
    a.digest = a.digest || meta.digest || "";
    a.update_time = a.update_time || meta.update_time || null;
    a.file_path = a.file_path || meta.file_path || "";
    a.aid = a.aid || meta.aid || "";
    merged++;
  }
});

fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf-8");
console.log(`Merged metadata for ${merged} articles -> ${analysisPath}`);
