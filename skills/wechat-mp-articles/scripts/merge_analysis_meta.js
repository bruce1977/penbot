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
      merged++;
    }
  });
  return merged;
}

function main() {
  // Step 1: parse and load both JSON files
  const { downloadReport, analysis } = parseArgs();
  // Step 2: build metadata lookup by url/link
  const metaMap = buildMetaMap(downloadReport);
  // Step 3: merge download metadata into analysis articles
  const merged = mergeMetadata(analysis, metaMap);
  // Step 4: write enriched analysis JSON
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`Merged metadata for ${merged} articles -> ${analysisPath}`);
}

main();
