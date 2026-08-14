const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { NodeHtmlMarkdown } = require("node-html-markdown");

const [,, articleListPath, articlesDir, outDir] = process.argv;

const CONCURRENCY = 5;
const API_PATH = "/api/public/v1";
const MAX_RETRIES_IO = 3;
const MAX_RETRIES_INVALID = 2;
const MAX_RETRIES_FALLBACK = 2;
const IO_RETRY_DELAY_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const DOWNLOAD_SCRIPT_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_SCRIPT_TIMEOUT_MS || "300000", 10);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Drop WeChat scraping residue: injected CSS, reader UI buttons, and
// javascript:void(0) links, keeping content from the cover image onward.
function cleanContent(text) {
  // Keep only content starting at the cover image marker (drops head CSS).
  const idx = text.indexOf("![cover_image]");
  const body = idx > 0 ? text.slice(idx) : text;

  // Drop lines that contain CSS rule blocks.
  const cssLineRe = /(?:^|\s)(?:[#.]|(?:[a-z]+\s*)?[a-z]{2,}\s)\S*\{[^}]*;[^}]*\}/;
  return body
    // Drop javascript:void(0) links (keep link text), incl. escaped parens.
    .replace(/\[([^\]]*)\]\(javascript:void[\\(]*[^)]*[)\\]*;?\)*/gi, "$1")
    // Drop reader UI button lines.
    .replace(/^\s*在小说阅读器读本章\s*$/gm, "")
    .replace(/^\s*在小说阅读器中沉浸阅读\s*$/gm, "")
    .replace(/^\s*去阅读\s*$/gm, "")
    .split("\n")
    .filter((line) => !cssLineRe.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trim();
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

async function downloadOne(apiBase, aid, link, fpath) {
  const url = `${apiBase}${API_PATH}/download?url=${encodeURIComponent(link)}&format=markdown`;
  const resp = await axios.get(url, { responseType: "text", timeout: DOWNLOAD_TIMEOUT_MS });
  const text = resp.data;
  if (!text || typeof text !== "string") {
    throw new Error(`Empty or invalid response: ${JSON.stringify(text).slice(0, 200)}`);
  }
  const cleaned = cleanContent(text);
  const dir = path.dirname(fpath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fpath, cleaned, "utf-8");
}

async function fallbackDownload(link, fpath) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const resp = await axios.get(link, {
    responseType: "text",
    timeout: DOWNLOAD_TIMEOUT_MS,
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    maxRedirects: 5,
  });
  const html = resp.data;
  if (!html || typeof html !== "string" || html.length < 100) {
    throw new Error(`Fallback HTML too short or empty: ${(html || "").length} chars`);
  }
  const md = NodeHtmlMarkdown.translate(html, { useInlineLinks: false });
  const withCover = "![cover_image]\n\n" + md;
  const cleaned = cleanContent(withCover);
  const dir = path.dirname(fpath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fpath, cleaned, "utf-8");
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
    return { ok: true, reason: null };
  }

  let attempts = 0;
  async function attemptApiDownload() {
    attempts++;
    for (let ioRetry = 1; ioRetry <= MAX_RETRIES_IO; ioRetry++) {
      try {
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        await downloadOne(apiBase, aid, link, fpath);
        const result = checkArticle(articles, articlesDir, aid);
        if (result.code === 0) return true;
        if (result.code === 2 && attempts < MAX_RETRIES_INVALID) {
          if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
          return attemptApiDownload();
        }
        return false;
      } catch (err) {
        console.error(`  IO_ERROR (attempt ${ioRetry}/${MAX_RETRIES_IO}): ${err.message}`);
        if (ioRetry < MAX_RETRIES_IO) await sleep(IO_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  const apiOk = await attemptApiDownload();
  if (apiOk) return { ok: true, reason: null };

  for (let retry = 1; retry <= MAX_RETRIES_FALLBACK; retry++) {
    try {
      if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
      await fallbackDownload(link, fpath);
      const result = checkArticle(articles, articlesDir, aid);
      if (result.code === 0) return { ok: true, reason: null };
      if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    } catch (err) {
      console.error(`  FALLBACK_ERROR (attempt ${retry}/${MAX_RETRIES_FALLBACK}): ${err.message}`);
      if (retry < MAX_RETRIES_FALLBACK) await sleep(IO_RETRY_DELAY_MS);
    }
  }

  return { ok: false, reason: "API+Fallback均失败" };
}

async function downloadAll(apiBase, articlesDir, articles) {
  const pendingAids = Object.keys(articles);
  const failedReasons = {};

  let successCount = 0;
  let failCount = 0;

  while (pendingAids.length > 0) {
    const batch = pendingAids.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(aid => processOne(apiBase, articlesDir, articles, aid).then(r => ({ aid, ...r }))));

    for (const { aid, ok, reason } of results) {
      if (ok) {
        successCount++;
      } else {
        failCount++;
        failedReasons[aid] = reason || "网络/IO错误";
      }
    }
  }

  return { successCount, failCount, failedReasons };
}

function generateDownloadList(articles, articlesDir, outDir, failedReasons) {
  const rawArticles = Object.values(articles);
  const filesList = [];

  for (const a of rawArticles) {
    const fname = a.file_name;
    const fpath = fname ? path.join(articlesDir, fname) : null;
    const exists = fpath ? fs.existsSync(fpath) : false;
    const err = failedReasons[a.aid];
    if (exists && !err) {
      filesList.push(fname);
    }
  }

  const list = {
    base_path: path.resolve(articlesDir),
    files: filesList,
  };

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const listPath = path.join(outDir, "download_list.json");
  fs.writeFileSync(listPath, JSON.stringify(list, null, 2), "utf-8");
  const failCount = Object.keys(failedReasons).length;
  console.log(`Downloaded ${filesList.length}/${rawArticles.length} articles`);
  if (failCount > 0) {
    console.warn(`Failed: ${failCount} articles`);
  }
  return failCount;
}

async function main() {
  const { apiBase, articles } = parseArgs();
  const total = Object.keys(articles).length;
  if (total === 0) {
    console.warn("WARN: article list is empty — nothing to download");
    const flagPath = path.join(outDir, ".NO_ARTICLES");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(flagPath, JSON.stringify({ time: new Date().toISOString(), reason: "empty_article_list" }), "utf-8");
    console.log("NO_ARTICLES: true");
    process.exit(0);
  }
  initDirectories(articlesDir, outDir);
  const { failCount, failedReasons } = await downloadAll(apiBase, articlesDir, articles);
  const nFailed = generateDownloadList(articles, articlesDir, outDir, failedReasons);
  process.exit(nFailed > 0 ? 1 : 0);
}

const dlTimeout = setTimeout(() => {
  console.error(`FATAL: download script timed out after ${DOWNLOAD_SCRIPT_TIMEOUT_MS}ms`);
  process.exit(1);
}, DOWNLOAD_SCRIPT_TIMEOUT_MS);

main().then(() => clearTimeout(dlTimeout)).catch(err => {
  clearTimeout(dlTimeout);
  console.error("FATAL:", err.message);
  process.exit(1);
});
