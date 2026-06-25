const fs = require("fs");
const path = require("path");

const [,, downloadReportPath, articlesDir, outputDir] = process.argv;

function parseArgs() {
  if (!downloadReportPath || !articlesDir || !outputDir) {
    console.error("Usage: node check_cached_scores.js <download_report.json> <articles_dir> <output_dir>");
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(downloadReportPath, "utf-8"));
  return { report };
}

function readMetaFile(metaPath) {
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return {
      score: typeof data.score === 'number' ? data.score : null,
      tags: Array.isArray(data.tags) ? data.tags : [],
    };
  } catch {
    return null;
  }
}

function classifyArticle(a) {
  if (!a.file_path) return { kind: 'toScore', data: a };

  const metaFull = path.join(articlesDir, a.file_path.replace(/\.md$/i, '.meta.json'));
  if (!fs.existsSync(metaFull)) return { kind: 'toScore', data: a };

  const meta = readMetaFile(metaFull);
  if (!meta) return { kind: 'toScore', data: a };

  return { kind: 'cached', data: { ...a, score: meta.score, tags: meta.tags } };
}

function pickFields(a) {
  return {
    index: a.index, aid: a.aid, title: a.title, account_name: a.account_name,
    account_category: a.account_category, file_path: a.file_path, url: a.url,
    cover: a.cover || "", digest: a.digest, create_time: a.create_time || null,
    update_time: a.update_time, fake_id: a.fake_id || "",
    download_status: a.download_status || "成功",
  };
}

function extractDate(filePath) {
  const m = filePath.match(/download_report_(\d{8})\.json$/);
  return m ? m[1] : new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function writeOutputs(toScore, dateStr, reportMeta) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const toScorePath = path.join(outputDir, `articles_to_score_${dateStr}.json`);

  const wrap = (items) => ({ articles: items, timestamp: reportMeta.timestamp, summary: reportMeta.summary });
  fs.writeFileSync(toScorePath, JSON.stringify(wrap(toScore), null, 2), "utf-8");

  console.log(`To score: ${toScore.length} -> ${toScorePath}`);
}

function main() {
  const { report } = parseArgs();

  const toScore = [];

  (report.articles || []).forEach(a => {
    const { kind, data } = classifyArticle(a);
    if (kind !== 'cached') {
      toScore.push(pickFields(a));
    }
  });

  const dateStr = extractDate(downloadReportPath);
  writeOutputs(toScore, dateStr, report);
}

main();
