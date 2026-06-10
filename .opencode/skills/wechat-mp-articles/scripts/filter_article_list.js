const fs = require("fs");

const KEEP = [
  "aid", "title", "cover", "link", "digest",
  "update_time", "appmsgid", "itemidx", "create_time",
  "fake_id", "account_name", "account_category"
];

const [,, input, configPath, output] = process.argv;
if (!input || !configPath || !output) {
  console.error("Usage: node filter_article_list.js <raw_mcp_output.json> <config.json> <output.json>");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const accountMap = Object.fromEntries(
  config.accounts.filter(a => a.enabled).map(a => [a.fake_id, { name: a.name, category: a.category }])
);

const raw = JSON.parse(fs.readFileSync(input, "utf-8"));
const articles = Array.isArray(raw.articles) ? raw.articles : Array.isArray(raw) ? raw : Object.values(raw);

const enriched = articles.map(a => ({
  ...a,
  account_name: accountMap[a.fake_id]?.name || "未知",
  account_category: accountMap[a.fake_id]?.category || "未分类"
}));

const cleaned = Object.fromEntries(
  enriched.map(a => [a.aid, Object.fromEntries(KEEP.filter(k => k in a).map(k => [k, a[k]]))])
);

fs.writeFileSync(output, JSON.stringify(cleaned, null, 2), "utf-8");
console.log(`Cleaned ${articles.length} articles -> ${output}`);
