const fs = require("fs");
const path = require("path");

const [,, articleListPath, articlesDir, failedListPath, outPath] = process.argv;
if (!articleListPath || !articlesDir || !outPath) {
  console.error("Usage: node gen_download_report.js <article_list.json> <articles_dir> <list_failed.txt> <output.json>");
  console.error("  <list_failed.txt> is optional, pass '-' to skip");
  process.exit(1);
}

// Read filtered article list
const rawArticles = Object.values(JSON.parse(fs.readFileSync(articleListPath, "utf-8")));

// Read list_failed.txt (explicit param)
const failedReasons = {};
if (failedListPath && failedListPath !== "-" && fs.existsSync(failedListPath)) {
  for (const line of fs.readFileSync(failedListPath, "utf-8").trim().split("\n").filter(Boolean)) {
    const [aid, ...rest] = line.split("|");
    failedReasons[aid] = rest.join("|") || "未知错误";
  }
}

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

const articles = rawArticles.map(a => {
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

const successCount = articles.filter(a => a.exists && !a.failed).length;
const failCount = articles.length - successCount;

const accountNames = [...new Set(articles.map(a => a.account_name))];
const accountDetails = accountNames.map(name => {
  const group = articles.filter(a => a.account_name === name);
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

const failedArticles = articles.filter(a => !a.exists || a.failed).map(a => ({
  title: a.title,
  account_name: a.account_name,
  reason: a.failed || (a.exists ? "文件不存在（list_failed.txt标记）" : "文件不存在"),
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

const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
console.log(outPath);
