const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CONCURRENCY = 5;
const [,, articleListPath, articlesDir, outDir] = process.argv;
if (!articleListPath || !articlesDir || !outDir) {
  console.error("Usage: node download_articles.js <article_list.json> <articles_dir> <out_dir>");
  process.exit(1);
}

const apiBase = process.env.PB_WECHAT_MP_API_BASE;
if (!apiBase) {
  console.error("FATAL: env PB_WECHAT_MP_API_BASE is not set");
  process.exit(1);
}

const articles = JSON.parse(fs.readFileSync(articleListPath, "utf-8"));

const pendingPath = path.join(outDir, "list_pending.txt");
const failedPath = path.join(outDir, "list_failed.txt");

let pendingAids = fs.readFileSync(pendingPath, "utf-8").trim().split("\n").filter(Boolean);
let failedLines = fs.readFileSync(failedPath, "utf-8").trim().split("\n").filter(Boolean);
const failedReasons = Object.fromEntries(failedLines.map(l => {
  const [aid, ...rest] = l.split("|");
  return [aid, rest.join("|") || "未知错误"];
}));

function saveState() {
  fs.writeFileSync(pendingPath, pendingAids.join("\n") + "\n", "utf-8");
  fs.writeFileSync(failedPath, Object.entries(failedReasons).map(([k, v]) => `${k}|${v}`).join("\n") + "\n", "utf-8");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadOne(aid, link, fpath) {
  const url = `${apiBase}/download?url=${encodeURIComponent(link)}&format=markdown`;
  console.log(`  GET ${url}`);
  const resp = await axios.get(url, { responseType: "text", timeout: 30000 });
  const text = resp.data;
  if (!text || typeof text !== "string") {
    throw new Error(`Empty or invalid response: ${JSON.stringify(text).slice(0, 200)}`);
  }
  const dir = path.dirname(fpath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fpath, text, "utf-8");
  console.log(`  Written ${fpath} (${text.length} bytes)`);
}

function checkArticle(aid) {
  const article = articles[aid];
  if (!article) return { code: 1, reason: "UNKNOWN" };
  const fname = article.file_name;
  if (!fname) return { code: 1, reason: "NO_FILE_NAME" };
  const fpath = path.join(articlesDir, fname);
  if (!fs.existsSync(fpath)) return { code: 1, reason: "MISSING" };
  const content = fs.readFileSync(fpath, "utf-8");
  if (!content.includes("![cover_image]")) return { code: 2, reason: "INVALID" };
  return { code: 0, reason: "VALID" };
}


async function processOne(aid) {
  const article = articles[aid];
  if (!article) return { ok: false, reason: "未知 aid" };
  const { link, file_name: fname } = article;
  if (!link) return { ok: false, reason: "无链接" };

  const fpath = path.join(articlesDir, fname || `${aid}.md`);

  // Skip if file already exists and is valid
  const existingCheck = checkArticle(aid);
  if (existingCheck.code === 0) {
    console.log(`  SKIP ${aid} (already exists and valid)`);
    return { ok: true, reason: null };
  }

  const maxRetriesIO = 3;
  const maxRetriesInvalid = 2;
  let attempts = 0;

  async function attemptDownload() {
    attempts++;
    for (let ioRetry = 1; ioRetry <= maxRetriesIO; ioRetry++) {
      try {
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        await downloadOne(aid, link, fpath);
        const result = checkArticle(aid);
        if (result.code === 0) return true;
        if (result.code === 2 && attempts < maxRetriesInvalid) {
          console.log(`  INVALID_CONTENT, retry ${attempts}/${maxRetriesInvalid}...`);
          if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
          return attemptDownload();
        }
        return false;
      } catch (err) {
        console.error(`  IO_ERROR (attempt ${ioRetry}/${maxRetriesIO}): ${err.message}`);
        if (ioRetry < maxRetriesIO) await sleep(10000);
      }
    }
    return false;
  }

  return { ok: await attemptDownload(), reason: null };
}

async function main() {
  console.log(`Pending: ${pendingAids.length} articles, concurrency=${CONCURRENCY}`);

  let successCount = 0;
  let failCount = 0;

  while (pendingAids.length > 0) {
    const batch = pendingAids.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(aid => processOne(aid).then(r => ({ aid, ...r }))));

    for (const { aid, ok, reason } of results) {
      if (ok) {
        successCount++;
        delete failedReasons[aid];
      } else {
        failCount++;
        failedReasons[aid] = reason || "网络/IO错误";
      }
      console.log(`  [${ok ? "OK" : "FAIL"}] ${aid}  (success=${successCount}, fail=${failCount})`);
    }

    saveState();
    console.log(`Batch done, remaining=${pendingAids.length}`);
  }

  console.log(`\nDone. success=${successCount}, fail=${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  saveState();
  process.exit(1);
});
