const fs = require("fs");
const path = require("path");

const [,, articleListPath, outPath, articlesDirArg] = process.argv;
if (!articleListPath || !outPath) {
  console.error("Usage: node gen_download_report.js <article_list.json> <output.json> [articles_dir]");
  process.exit(1);
}

const articlesDir = articlesDirArg || path.dirname(outPath);

// Build map of existing filenames keyed by aid (prefix before second "_")
const existingFiles = {};
for (const f of fs.readdirSync(articlesDir).filter(f => f.endsWith(".md"))) {
  const idx = f.indexOf("_", f.indexOf("_") + 1);
  if (idx > 0) existingFiles[f.substring(0, idx)] = f;
}

// Read filtered article list
const rawArticles = Object.values(JSON.parse(fs.readFileSync(articleListPath, "utf-8")));

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

const articles = rawArticles.map(a => {
  const existing = existingFiles[a.aid];
  return {
    aid: a.aid,
    title: a.title,
    account_name: a.account_name,
    account_category: a.account_category,
    file_path: existing || null,
    url: a.link,
    digest: a.digest,
    update_time: a.update_time,
    exists: !!existing,
  };
});

const successCount = articles.filter(a => a.exists).length;
const failCount = articles.filter(a => !a.exists).length;

const accountNames = [...new Set(articles.map(a => a.account_name))];
const accountDetails = accountNames.map(name => {
  const group = articles.filter(a => a.account_name === name);
  const success = group.filter(a => a.exists).length;
  const fail = group.filter(a => !a.exists).length;
  return {
    name,
    category: group[0].account_category,
    qualifying_count: group.length,
    success_count: success,
    fail_count: fail,
    status: fail === 0 ? "正常" : success === 0 ? "全部失败" : "部分失败",
  };
});

const failedArticles = articles.filter(a => !a.exists).map(a => ({
  title: a.title,
  account_name: a.account_name,
  reason: "文件不存在",
  url: a.url,
}));

const output = {
  timestamp: fmtDate(Math.floor(Date.now() / 1000)),
  summary: {
    accounts: accountNames.length,
    qualifying_articles: articles.length,
    success_count: successCount,
    fail_count: failCount,
  },
  account_details: accountDetails,
  articles: articles.map(a => ({
    index: articles.indexOf(a) + 1,
    aid: a.aid,
    title: a.title,
    account_name: a.account_name,
    account_category: a.account_category,
    file_path: a.file_path,
    url: a.url,
    digest: a.digest,
    update_time: a.update_time,
    download_status: a.exists ? "成功" : "失败",
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

const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
console.log(outPath);
