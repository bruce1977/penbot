const fs = require("fs");
const path = require("path");

const [,, markedDir, weknoraDir, profile, kbId] = process.argv;

if (!markedDir || !weknoraDir || !profile) {
  console.error("Usage: node sync_to_weknora.js <marked_dir> <weknora_dir> <profile> [kb_id]");
  console.error("  kb_id: optional override; otherwise read from {profile}/weknora.json, then KB.name==profile match");
  process.exit(1);
}

const apiBase = process.env.WEKNORA_BASE_URL;
const apiKey = process.env.WEKNORA_API_KEY;
if (!apiBase) {
  console.error("FATAL: env WEKNORA_BASE_URL is not set");
  process.exit(1);
}
if (!apiKey) {
  console.error("FATAL: env WEKNORA_API_KEY is not set");
  process.exit(1);
}

function profileConfigPath() {
  return path.join(path.dirname(markedDir), "weknora.json");
}

function loadProfileConfig() {
  const cfgFile = profileConfigPath();
  try {
    return JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
  } catch {
    const defaults = { kb_id: "", submit_interval_ms: 10000 };
    try {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
      console.log(`[weknora] created default config: ${cfgFile}`);
    } catch (err) {
      console.warn(`[weknora] failed to create default config: ${err.message}`);
    }
    return defaults;
  }
}

function writeKbIdBack(id) {
  const cfgFile = profileConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8")) || {};
    cfg.kb_id = id;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    console.log(`[weknora] wrote resolved kb_id to ${cfgFile}`);
  } catch {
    /* non-fatal */
  }
}

const profileConfig = loadProfileConfig();

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);
const SUBMIT_INTERVAL_MS = parseInt(profileConfig?.submit_interval_ms ?? process.env.SUBMIT_INTERVAL_MS ?? "10000", 10);

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function wkRequest(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(`HTTP ${res.status}: ${data.error?.message || data.message || res.statusText}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function findKbId() {
  if (kbId) return kbId;
  if (profileConfig?.kb_id) return String(profileConfig.kb_id).trim();
  const res = await wkRequest("GET", `${apiBase}/knowledge-bases`);
  const kb = (res.data || []).find(k => k.name === profile);
  if (!kb) {
    const names = (res.data || []).map(k => `"${k.name}"`).join(", ");
    throw new Error(`KB not found for profile "${profile}" (no kb_id in weknora.json and no KB named "${profile}"). Available: ${names || "(none)"}`);
  }
  writeKbIdBack(kb.id);
  return kb.id;
}

async function ensureTag(kbId, tagName) {
  const listRes = await wkRequest("GET", `${apiBase}/knowledge-bases/${kbId}/tags?page=1&page_size=200`);
  const tags = (listRes.data?.data) || [];
  const found = tags.find(t => t.name === tagName);
  if (found) return found.id;
  const created = await wkRequest("POST", `${apiBase}/knowledge-bases/${kbId}/tags`, { name: tagName });
  return created.data.id;
}

async function fetchExistingTitles(kbId) {
  const titles = new Set();
  let page = 1;
  const pageSize = 200;
  while (true) {
    const res = await wkRequest("GET", `${apiBase}/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=${pageSize}`);
    const items = res.data || [];
    for (const it of items) {
      if (it.title) titles.add(it.title);
    }
    if (items.length < pageSize) break;
    page++;
  }
  return titles;
}

function parseFrontmatter(content) {
  const t = content.trimStart();
  if (!t.startsWith("---")) return { title: "", hash: "", tags: [], body: t };
  const end = t.indexOf("---", 3);
  if (end === -1) return { title: "", hash: "", tags: [], body: t };
  const fm = t.slice(3, end).trim();
  const body = t.slice(end + 3).trimStart();
  let title = "", hash = "", tags = [];
  const lines = fm.split("\n");
  for (const line of lines) {
    const m = line.match(/^title:\s*(.+)$/);
    if (m) title = m[1].replace(/^"|"$/g, "").trim();
    const hashM = line.match(/^hash:\s*(.+)$/);
    if (hashM) hash = hashM[1].replace(/^"|"$/g, "").trim();
    const tagM = line.match(/^tags:\s*\[(.*)\]$/);
    if (tagM) {
      tags = tagM[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    }
  }
  return { title, hash, tags, body };
}

function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code === "EXDEV") {
      fs.writeFileSync(dst, fs.readFileSync(src));
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

async function main() {
  if (!fs.existsSync(markedDir)) {
    console.error(`Error: marked directory not found: ${markedDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(weknoraDir)) fs.mkdirSync(weknoraDir, { recursive: true });

  const kbId = await findKbId();
  console.log(`Using KB: ${kbId} (profile: ${profile}, submit interval: ${SUBMIT_INTERVAL_MS}ms)`);

  const existingTitles = await fetchExistingTitles(kbId);
  console.log(`[dedup] loaded ${existingTitles.size} existing titles from KB`);

  let synced = 0, skipped = 0, failed = 0;
  const files = fs.readdirSync(markedDir).filter(f => f.endsWith(".md")).sort();
  if (files.length === 0) { console.log("No .md files found in marked"); process.exit(0); }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const srcPath = path.join(markedDir, f);
    const dstPath = path.join(weknoraDir, f);
    try {
      const content = fs.readFileSync(srcPath, "utf-8");
      const { title, hash, tags, body } = parseFrontmatter(content);
      const finalTitle = title || f.replace(/\.md$/i, "");
      const submitTitle = hash ? `${hash}_${finalTitle}` : finalTitle;

      if (existingTitles.has(submitTitle)) {
        moveFile(srcPath, dstPath);
        console.log(`  SKIP ${f}: hash+title already exists in KB ("${submitTitle}")`);
        skipped++;
        continue;
      }

      const tagIds = [];
      for (const tag of tags) {
        tagIds.push(await ensureTag(kbId, tag));
      }
      const payload = { title: submitTitle, content: body, status: "publish" };
      if (tagIds.length > 0) payload.tag_ids = tagIds;

      await wkRequest("POST", `${apiBase}/knowledge-bases/${kbId}/knowledge/manual`, payload);
      existingTitles.add(submitTitle);

      moveFile(srcPath, dstPath);
      console.log(`  SYNCED ${f} (tags: ${tags.length}, submit title: "${submitTitle}")`);
      synced++;
    } catch (err) {
      console.error(`  FAIL ${f}: ${err.message}`);
      failed++;
    }
    if (i < files.length - 1) {
      console.log(`  waiting ${SUBMIT_INTERVAL_MS}ms before next submit...`);
      await delay(SUBMIT_INTERVAL_MS);
    }
  }

  console.log(`\nDone. ${synced} synced, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

const timeout = setTimeout(() => {
  console.error(`FATAL: script timed out after ${SCRIPT_TIMEOUT_MS}ms`);
  process.exitCode = 1;
}, SCRIPT_TIMEOUT_MS);

main().then(() => clearTimeout(timeout)).catch(err => {
  clearTimeout(timeout);
  console.error("FATAL:", err.message);
  process.exitCode = 1;
});
