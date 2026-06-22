const fs = require("fs");
const axios = require("axios");

const KEEP = [
  "aid", "title", "cover", "link", "digest",
  "update_time", "appmsgid", "itemidx", "create_time",
  "fake_id", "account_name", "account_category"
];

const [,, configPath, dateStr, outputPath] = process.argv;
if (!configPath || !dateStr || !outputPath) {
  console.error("Usage: node fetch_and_prepare.js <config.json> <date YYYY-MM-DD> <output.json>");
  process.exit(1);
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

function targetFilename(aid, updateTime, accountName, title) {
  const d = new Date(updateTime * 1000);
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${aid}_${dateStr}_${sanitize(accountName)}_${sanitize(title)}.md`;
}

// --- Select accounts (rotation algorithm) ---

function seededShuffle(arr, seed) {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = ((s * 1664525 + 1013904223) & 0x7fffffff) >>> 0;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function selectAccounts(config, dateStr) {
  const maxAccounts = config.settings.max_accounts || 5;
  const enabledAccounts = (config.accounts || [])
    .filter(a => a.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  const total = enabledAccounts.length;
  if (total === 0) {
    console.error("No enabled accounts found in config");
    process.exit(1);
  }

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    console.error(`Invalid date: "${dateStr}". Expected format: YYYY-MM-DD`);
    process.exit(1);
  }

  const msPerDay = 86400000;
  const epoch = new Date("2020-01-01");
  const daysSinceEpoch = Math.floor((date - epoch) / msPerDay);

  const numGroups = Math.ceil(total / maxAccounts);
  const cycleIndex = Math.floor(daysSinceEpoch / numGroups);
  const groupIndex = daysSinceEpoch % numGroups;

  const ordered = cycleIndex === 0
    ? enabledAccounts
    : seededShuffle(enabledAccounts, cycleIndex);

  const start = groupIndex * maxAccounts;
  const end = Math.min(start + maxAccounts, total);
  let selected = ordered.slice(start, end);

  if (selected.length < maxAccounts && total >= maxAccounts) {
    const needed = maxAccounts - selected.length;
    const wrap = ordered.slice(0, needed);
    selected = selected.concat(wrap);
  }

  console.log(`Selected ${selected.length}/${total} accounts for ${dateStr}`);
  return selected;
}

// --- Fetch articles ---

const apiBase = process.env.PB_WECHAT_MP_API_BASE;
const API_PATH = "/api/public/v1";
if (!apiBase) {
  console.error("FATAL: env PB_WECHAT_MP_API_BASE is not set");
  process.exit(1);
}

const apiClient = axios.create({
  baseURL: `${apiBase}${API_PATH}`,
  headers: { "X-Auth-Key": process.env.PB_WECHAT_MP_AUTH_KEY || "" },
});

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const settings = config.settings || {};
const maxArticles = settings.max_articles_per_account || 5;
const daysToFilter = settings.days_to_filter || 0;

const accounts = selectAccounts(config, dateStr);

const cutoff = daysToFilter > 0
  ? Math.floor(Date.now() / 1000) - daysToFilter * 86400
  : 0;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function fetchSingleAccount(fakeid, name, category) {
  const res = await apiClient.get("/article", { params: { fakeid, size: maxArticles } });
  let articles = res.data?.articles || [];
  articles = articles.filter(a => a.is_deleted !== true);
  if (cutoff > 0) {
    articles = articles.filter(a => a.update_time >= cutoff);
  }
  return articles.map(a => {
    const enriched = { ...a, fake_id: fakeid, account_name: name, account_category: category };
    const cleaned = {};
    for (const k of KEEP) {
      if (k in enriched) cleaned[k] = enriched[k];
    }
    cleaned.file_name = targetFilename(cleaned.aid, cleaned.update_time, cleaned.account_name, cleaned.title);
    return cleaned;
  });
}

async function main() {
  console.log(`Fetching article lists for ${accounts.length} accounts...`);
  const allArticles = [];
  const chunks = chunkArray(accounts, 10);

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(a => fetchSingleAccount(a.fake_id, a.name, a.category))
    );
    for (const articles of results) {
      allArticles.push(...articles);
    }
  }

  const keyed = Object.fromEntries(allArticles.map(a => [a.aid, a]));
  console.log(`Total articles fetched: ${allArticles.length}`);
  fs.writeFileSync(outputPath, JSON.stringify(keyed, null, 2), "utf-8");
  console.log(`Written to ${outputPath}`);
}

main().catch(err => {
  console.error("FATAL:", err.response?.data || err.message);
  process.exit(1);
});
