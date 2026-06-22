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
const API_PATH = "/api/public/v1";
if (!apiBase) {
  console.error("FATAL: env PB_WECHAT_MP_API_BASE is not set");
  process.exit(1);
}

const articles = JSON.parse(fs.readFileSync(articleListPath, "utf-8"));

// --- init lists ---
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const pendingPath = path.join(outDir, "list_pending.txt");
const failedPath = path.join(outDir, "list_failed.txt");

const allAids = Object.keys(articles);
fs.writeFileSync(pendingPath, allAids.join("\n") + "\n", "utf-8");
fs.writeFileSync(failedPath, "", "utf-8");
console.log(`Initialized pending list: ${allAids.length} articles`);

// --- download loop ---
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
  const url = `${apiBase}${API_PATH}/download?url=${encodeURIComponent(link)}&format=markdown`;
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

async function downloadAll() {
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
  return { successCount, failCount };
}

// --- report generation ---
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function generateReport() {
  const rawArticles = Object.values(articles);

  const reportArticles = rawArticles.map(a => {
    const fname = a.file_name;
    const exists = fname ? fs.existsSync(path.join(articlesDir, fname)) : false;
    const failed = failedReasons[a.aid];
    return {
      aid: a.aid,
      title: a.title,
      account_name: a.account_name,
      account_category: a.account_category,
      file_path: exists ? fname : null,
      url: a.link,
      cover: a.cover || "",
      digest: a.digest,
      create_time: a.create_time || null,
      update_time: a.update_time,
      fake_id: a.fake_id || "",
      exists,
      failed,
    };
  });

  const realSuccessCount = reportArticles.filter(a => a.exists && !a.failed).length;
  const realFailCount = reportArticles.length - realSuccessCount;

  const accountNames = [...new Set(reportArticles.map(a => a.account_name))];
  const accountDetails = accountNames.map(name => {
    const group = reportArticles.filter(a => a.account_name === name);
    const success = group.filter(a => a.exists).length;
    const fail = group.filter(a => !a.exists || a.failed).length;
    return {
      name,
      category: group[0].account_category,
      qualifying_count: group.length,
      success_count: success,
      fail_count: fail,
      status: fail === 0 ? "正常" : success === 0 ? "全部失败" : "部分失败",
    };
  });

  const failedArticles = reportArticles.filter(a => !a.exists || a.failed).map(a => ({
    title: a.title,
    account_name: a.account_name,
    reason: a.failed || (a.exists ? "文件不存在（list_failed.txt标记）" : "文件不存在"),
    url: a.url,
  }));

  const output = {
    timestamp: fmtDate(Math.floor(Date.now() / 1000)),
    summary: {
      accounts: accountNames.length,
      qualifying_articles: reportArticles.length,
      success_count: realSuccessCount,
      fail_count: realFailCount,
    },
    account_details: accountDetails,
    articles: reportArticles.map(a => ({
      index: reportArticles.indexOf(a) + 1,
      aid: a.aid,
      title: a.title,
      account_name: a.account_name,
      account_category: a.account_category,
      file_path: a.file_path,
      url: a.url,
      cover: a.cover || "",
      digest: a.digest,
      create_time: a.create_time || null,
      update_time: a.update_time,
      fake_id: a.fake_id || "",
      download_status: a.failed ? "失败" : a.exists ? "成功" : "失败",
    })),
  };

  if (failedArticles.length > 0) {
    output.failed = [
      {
        type: "文章下载失败",
        account: "",
        articles: failedArticles,
      },
    ];
  }

  const reportPath = path.join(articlesDir, `download_report_${new Date().toISOString().slice(0,10).replace(/-/g,"")}.json`);
  if (!fs.existsSync(articlesDir)) fs.mkdirSync(articlesDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Report generated: ${reportPath}`);
}

// --- main ---
async function main() {
  const { failCount } = await downloadAll();
  generateReport();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  saveState();
  process.exit(1);
});
