const fs = require("fs");
const path = require("path");

const [,, configPath, outputDir] = process.argv;

function parseArgs() {
  if (!configPath || !outputDir) {
    console.error("Usage: node check_cached_scores.js <config-runtime> <output_dir>");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const files = config.files || [];
  if (files.length === 0) {
    console.error("Error: config.files is empty");
    process.exit(1);
  }
  return { config, files };
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

  const metaFull = fpath.replace(/\.md$/i, '.meta.json');
  const meta = readMetaFile(metaFull);

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
    download_status: "成功",
    file_full_path: fpath,
    cached: meta !== null,
    score: meta ? meta.score : null,
    tags: meta ? meta.tags : [],
  };
}

function extractDate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}

function writeOutputs(allArticles, toScore, dateStr) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const toScorePath = path.join(outputDir, `articles_to_score_${dateStr}.json`);
  const wrap = { articles: toScore, timestamp: new Date().toISOString().slice(0,19).replace("T"," "), total: allArticles.length };
  fs.writeFileSync(toScorePath, JSON.stringify(wrap, null, 2), "utf-8");
  console.log(`To score: ${toScore.length}/${allArticles.length} -> ${toScorePath}`);
}

function main() {
  const { config, files } = parseArgs();
  const allArticles = files.map(extractMeta);
  const toScore = allArticles.filter(a => !a.cached);
  const dateStr = extractDate();
  writeOutputs(allArticles, toScore, dateStr);
}

main();
