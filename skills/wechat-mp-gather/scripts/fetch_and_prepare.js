const fs = require("fs");
const axios = require("axios");

const KEEP = [
  "aid", "title", "cover", "link", "digest",
  "update_time", "appmsgid", "itemidx", "create_time",
  "fake_id", "account_name", "account_category"
];
const API_PATH = "/api/public/v1";

const REQUEST_TIMEOUT_MS = parseInt(process.env.FETCH_REQUEST_TIMEOUT_MS || "30000", 10);
const SCRIPT_TIMEOUT_MS = parseInt(process.env.FETCH_SCRIPT_TIMEOUT_MS || "120000", 10);
const MAX_RETRIES = parseInt(process.env.FETCH_MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = parseInt(process.env.FETCH_RETRY_DELAY_MS || "15000", 10);

const [,, configPath, outputPath, skipAidsPath] = process.argv;
if (!configPath || !outputPath) {
  console.error("Usage: node fetch_and_prepare.js <config.json> <output.json> [skip_aids.json]");
  process.exit(1);
}

let skipAids = null;
if (skipAidsPath) {
  try {
    const raw = fs.readFileSync(skipAidsPath, "utf-8");
    const parsed = JSON.parse(raw);
    skipAids = new Set(parsed.existing_aids || parsed.aids || parsed);
  } catch (e) {
    console.error(`WARN: failed to read skip aids from ${skipAidsPath}: ${e.message}`);
  }
}

const _now = new Date();
const y = String(_now.getFullYear()), m = String(_now.getMonth() + 1).padStart(2, "0"), d0 = String(_now.getDate()).padStart(2, "0");

const apiBase = process.env.PB_WECHAT_MP_API_BASE;
if (!apiBase) {
  console.error("FATAL: env PB_WECHAT_MP_API_BASE is not set");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const settings = config.settings || {};
const maxArticles = settings.max_articles_per_account || 5;
const daysToFilter = settings.days_to_filter || 0;
const maxAccounts = settings.max_accounts || 5;

const cutoff = daysToFilter > 0
  ? Math.floor(Date.now() / 1000) - daysToFilter * 86400
  : 0;

const apiClient = axios.create({
  baseURL: `${apiBase}${API_PATH}`,
  headers: { "X-Auth-Key": process.env.PB_WECHAT_MP_AUTH_KEY || "" },
  timeout: REQUEST_TIMEOUT_MS,
});

function cleanTitle(raw) {
  const firstLine = (raw || "").split("\n")[0].trim();
  return firstLine.slice(0, 120).trim();
}

function sanitizeForFilename(s) {
  const chinesePunct = {
    "，": ",", "。": ".", "！": "!", "？": "?", "：": ":", "；": ";",
    "“": "\"", "”": "\"", "‘": "'", "’": "'",
    "【": "[", "】": "]", "（": "(", "）": ")",
    "《": "<", "》": ">", "——": "-", "…": "...",
    "·": "-", "～": "~", "、": ",",
  };
  let result = s;
  for (const [cn, en] of Object.entries(chinesePunct)) {
    result = result.split(cn).join(en);
  }
  return result.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

function targetFilename(aid, updateTime, accountName, title) {
  const d = new Date(updateTime * 1000);
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${aid}_${dateStr}_${sanitizeForFilename(accountName)}_${sanitizeForFilename(title)}.md`;
}

function selectAccounts(config, maxAccounts) {
  const accounts = (config.accounts || []).filter(a => a.enabled !== false);

  const total = accounts.length;
  if (total === 0) {
    console.error("No enabled accounts found in config");
    process.exit(1);
  }

  const day = parseInt(d0, 10);
  const lastDigit = day % 10;
  const isOdd = day % 2 === 1;

  const p1 = new Set();
  const p2 = new Set();

  for (let i = 0; i < accounts.length; i++) {
    const idx = i + 1;
    if (idx % 10 === lastDigit) {
      p1.add(i);
    } else if ((idx % 2 === 1) === isOdd) {
      p2.add(i);
    }
  }

  const selected = [];
  for (const i of p1) {
    if (selected.length >= maxAccounts) break;
    selected.push(accounts[i]);
  }
  for (const i of p2) {
    if (selected.length >= maxAccounts) break;
    selected.push(accounts[i]);
  }
  for (let i = 0; i < accounts.length && selected.length < maxAccounts; i++) {
    if (!p1.has(i) && !p2.has(i)) {
      selected.push(accounts[i]);
    }
  }

  return selected;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchSingleAccount(fakeid, name, category) {
  const maxRetries = MAX_RETRIES;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await apiClient.get("/article", { params: { fakeid, size: maxArticles } });
      const body = res.data;
      const ret = body?.base_resp?.ret;
      if (ret === 200013) {
        const msg = body.base_resp.err_msg || "freq control";
        if (attempt < maxRetries) {
          console.warn(`  RATE_LIMIT (${name}): ${msg}, retry ${attempt}/${maxRetries} after ${RETRY_DELAY_MS}ms`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        console.error(`  RATE_LIMIT (${name}): ${msg}, exhausted retries`);
        return [];
      }
      let articles = body?.articles || [];
      articles = articles.filter(a => a.is_deleted !== true);
      if (cutoff > 0) {
        articles = articles.filter(a => a.update_time >= cutoff);
      }
      return articles.map(a => {
        const enriched = { ...a, fake_id: fakeid, account_name: name, account_category: category };
        enriched.title = cleanTitle(enriched.title);
        const cleaned = {};
        for (const k of KEEP) {
          if (k in enriched) cleaned[k] = enriched[k];
        }
        cleaned.file_name = targetFilename(cleaned.aid, cleaned.update_time, cleaned.account_name, cleaned.title);
        return cleaned;
      });
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`  ERROR (${name}): ${err.message}, retry ${attempt}/${maxRetries} after ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
      } else {
        console.error(`  ERROR (${name}): ${err.message}, exhausted retries`);
        return [];
      }
    }
  }
  return [];
}

async function main() {
  const selectedAccounts = selectAccounts(config, maxAccounts);

  const batchSize = maxAccounts;
  const allArticles = [];
  const chunks = chunkArray(selectedAccounts, batchSize);

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(a => fetchSingleAccount(a.fake_id, a.name, a.category))
    );
    for (const articles of results) {
      allArticles.push(...articles);
    }
  }

  const filtered = skipAids ? allArticles.filter(a => !skipAids.has(a.aid)) : allArticles;
  const keyed = Object.fromEntries(filtered.map(a => [a.aid, a]));
  fs.writeFileSync(outputPath, JSON.stringify(keyed, null, 2), "utf-8");
  const skipped = allArticles.length - filtered.length;
  console.log(`Fetched ${filtered.length} articles from ${selectedAccounts.length} accounts${skipped > 0 ? ` (${skipped} skipped by dedup)` : ""}`);
}

const timeout = setTimeout(() => {
  console.error(`FATAL: script timed out after ${SCRIPT_TIMEOUT_MS}ms`);
  process.exit(1);
}, SCRIPT_TIMEOUT_MS);

main().then(() => clearTimeout(timeout)).catch(err => {
  clearTimeout(timeout);
  console.error("FATAL:", err.response?.data || err.message);
  process.exit(1);
});
