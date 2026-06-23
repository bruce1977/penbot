const fs = require("fs");
const path = require("path");
const axios = require("axios");

const [,, articleListPath, articlesDir, outDir] = process.argv;

const CONCURRENCY = 5;
const API_PATH = "/api/public/v1";
const MAX_RETRIES_IO = 3;
const MAX_RETRIES_INVALID = 2;
const IO_RETRY_DELAY_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 30000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function cleanContent(text) {
  const idx = text.indexOf("![cover_image]");
  if (idx > 0) {
    return text.slice(idx);
  }
  return text;
}

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function parseArgs() {
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
  return { apiBase, articles };
}

function initDirectories(articlesDir, outDir) {
  if (!fs.existsSync(articlesDir)) fs.mkdirSync(articlesDir, { recursive: true });
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
}

function initLists(outDir, articles) {
  const pendingPath = path.join(outDir, "list_pending.txt");
  const failedPath = path.join(outDir, "list_failed.txt");
  const allAids = Object.keys(articles);
  fs.writeFileSync(pendingPath, allAids.join("\n") + "\n", "utf-8");
  fs.writeFileSync(failedPath, "", "utf-8");
  console.log(`Initialized pending list: ${allAids.length} articles`);
  return { pendingPath, failedPath };
}

function loadState(pendingPath, failedPath) {
  const pendingAids = fs.readFileSync(pendingPath, "utf-8").trim().split("\n").filter(Boolean);
  const failedLines = fs.readFileSync(failedPath, "utf-8").trim().split("\n").filter(Boolean);
  const failedReasons = Object.fromEntries(failedLines.map(l => {
    const [aid, ...rest] = l.split("|");
    return [aid, rest.join("|") || "未知错误"];
  }));
  return { pendingAids, failedReasons };
}

function saveState(pendingPath, failedPath, pendingAids, failedReasons) {
  fs.writeFileSync(pendingPath, pendingAids.join("\n") + "\n", "utf-8");
  fs.writeFileSync(failedPath, Object.entries(failedReasons).map(([k, v]) => `${k}|${v}`).join("\n") + "\n", "utf-8");
}

async function downloadOne(apiBase, aid, link, fpath) {
  const url = `${apiBase}${API_PATH}/download?url=${encodeURIComponent(link)}&format=markdown`;
  console.log(`  GET ${url}`);
  const resp = await axios.get(url, { responseType: "text", timeout: DOWNLOAD_TIMEOUT_MS });
  const text = resp.data;
  if (!text || typeof text !== "string") {
    throw new Error(`Empty or invalid response: ${JSON.stringify(text).slice(0, 200)}`);
  }
  const cleaned = cleanContent(text);
  const dir = path.dirname(fpath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fpath, cleaned, "utf-8");
  console.log(`  Written ${fpath} (${cleaned.length} bytes)`);
}

function checkArticle(articles, articlesDir, aid) {
  const article = articles[aid];
  if (!article) return { code: 1, reason: "UNKNOWN" };
  const fname = article.file_name;
  if (!fname) return { code: 1, reason: "NO_FILE_NAME" };
  const fpath = path.join(articlesDir, fname);
  if (!fs.existsSync(fpath)) return { code: 1, reason: "MISSING" };
  const content = fs.readFileSync(fpath, "utf-8");
  const ci = content.indexOf("![cover_image]");
  if (ci === -1) return { code: 2, reason: "INVALID" };
  if (ci > 0) return { code: 2, reason: "DIRTY_HEADER" };
  return { code: 0, reason: "VALID" };
}

async function processOne(apiBase, articlesDir, articles, aid) {
  const article = articles[aid];
  if (!article) return { ok: false, reason: "未知 aid" };
  const { link, file_name: fname } = article;
  if (!link) return { ok: false, reason: "无链接" };
  const fpath = path.join(articlesDir, fname || `${aid}.md`);

  const existingCheck = checkArticle(articles, articlesDir, aid);
  if (existingCheck.code === 0) {
    console.log(`  SKIP ${aid} (already exists and valid)`);
    return { ok: true, reason: null };
  }

  let attempts = 0;
  async function attemptDownload() {
    attempts++;
    for (let ioRetry = 1; ioRetry <= MAX_RETRIES_IO; ioRetry++) {
      try {
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        await downloadOne(apiBase, aid, link, fpath);
        const result = checkArticle(articles, articlesDir, aid);
        if (result.code === 0) return true;
        if (result.code === 2 && attempts < MAX_RETRIES_INVALID) {
          console.log(`  INVALID_CONTENT, retry ${attempts}/${MAX_RETRIES_INVALID}...`);
          if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
          return attemptDownload();
        }
        return false;
      } catch (err) {
        console.error(`  IO_ERROR (attempt ${ioRetry}/${MAX_RETRIES_IO}): ${err.message}`);
        if (ioRetry < MAX_RETRIES_IO) await sleep(IO_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  return { ok: await attemptDownload(), reason: null };
}

async function downloadAll(apiBase, articlesDir, articles, pendingPath, failedPath) {
  const { pendingAids, failedReasons } = loadState(pendingPath, failedPath);
  console.log(`Pending: ${pendingAids.length} articles, concurrency=${CONCURRENCY}`);

  let successCount = 0;
  let failCount = 0;

  while (pendingAids.length > 0) {
    const batch = pendingAids.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(aid => processOne(apiBase, articlesDir, articles, aid).then(r => ({ aid, ...r }))));

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

    saveState(pendingPath, failedPath, pendingAids, failedReasons);
    console.log(`Batch done, remaining=${pendingAids.length}`);
  }

  console.log(`\nDone. success=${successCount}, fail=${failCount}`);
  return { successCount, failCount, failedReasons };
}

function generateReport(articles, articlesDir, failedReasons) {
  const rawArticles = Object.values(articles);
  const reportArticles = rawArticles.map(a => {
    const fname = a.file_name;
    const exists = fname ? fs.existsSync(path.join(articlesDir, fname)) : false;
    const failed = failedReasons[a.aid];
    return {
      aid: a.aid, title: a.title, account_name: a.account_name, account_category: a.account_category,
      file_path: exists ? fname : null, url: a.link, cover: a.cover || "", digest: a.digest,
      create_time: a.create_time || null, update_time: a.update_time, fake_id: a.fake_id || "",
      exists, failed,
    };
  });

  const realSuccessCount = reportArticles.filter(a => a.exists && !a.failed).length;
  const realFailCount = reportArticles.length - realSuccessCount;

  const accountNames = [...new Set(reportArticles.map(a => a.account_name))];
  const accountDetails = accountNames.map(name => {
    const group = reportArticles.filter(a => a.account_name === name);
    const success = group.filter(a => a.exists).length;
    const fail = group.filter(a => !a.exists || a.failed).length;
    return { name, category: group[0].account_category, qualifying_count: group.length, success_count: success, fail_count: fail, status: fail === 0 ? "正常" : success === 0 ? "全部失败" : "部分失败" };
  });

  const failedArticles = reportArticles.filter(a => !a.exists || a.failed).map(a => ({
    title: a.title, account_name: a.account_name, reason: a.failed || (a.exists ? "文件不存在（list_failed.txt标记）" : "文件不存在"), url: a.url,
  }));

  const output = {
    timestamp: fmtDate(Math.floor(Date.now() / 1000)),
    summary: { accounts: accountNames.length, qualifying_articles: reportArticles.length, success_count: realSuccessCount, fail_count: realFailCount },
    account_details: accountDetails,
    articles: reportArticles.map((a, i) => ({
      index: i + 1, aid: a.aid, title: a.title, account_name: a.account_name, account_category: a.account_category,
      file_path: a.file_path, url: a.url, cover: a.cover || "", digest: a.digest,
      create_time: a.create_time || null, update_time: a.update_time, fake_id: a.fake_id || "",
      download_status: a.failed ? "失败" : a.exists ? "成功" : "失败",
    })),
  };

  if (failedArticles.length > 0) {
    output.failed = [{ type: "文章下载失败", account: "", articles: failedArticles }];
  }

  const reportPath = path.join(articlesDir, `download_report_${new Date().toISOString().slice(0,10).replace(/-/g,"")}.json`);
  if (!fs.existsSync(articlesDir)) fs.mkdirSync(articlesDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Report generated: ${reportPath}`);
}

async function main() {
  // 步骤 1: 解析命令行参数与配置文件
  const { apiBase, articles } = parseArgs();
  // 步骤 2: 初始化目录和任务列表
  initDirectories(articlesDir, outDir);
  const { pendingPath, failedPath } = initLists(outDir, articles);
  // 步骤 3: 批量下载文章（含重试）
  const { failCount, failedReasons } = await downloadAll(apiBase, articlesDir, articles, pendingPath, failedPath);
  // 步骤 4: 生成下载报告
  generateReport(articles, articlesDir, failedReasons);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
