const fs = require("fs");
const path = require("path");

const [,, markedDir, weknoraDir, profile, kbId] = process.argv;

if (!markedDir || !weknoraDir || !profile) {
  console.error("Usage: node sync_to_weknora.js <marked_dir> <weknora_dir> <profile> [kb_id]");
  console.error("  profile: config settings.name; KB matched by name==profile unless kb_id given");
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

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);

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
  const res = await wkRequest("GET", `${apiBase}/knowledge-bases`);
  const kb = (res.data || []).find(k => k.name === profile);
  if (!kb) {
    const names = (res.data || []).map(k => `"${k.name}"`).join(", ");
    throw new Error(`KB not found for profile "${profile}". Available: ${names || "(none)"}`);
  }
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

function parseFrontmatter(content) {
  const t = content.trimStart();
  if (!t.startsWith("---")) return { title: "", tags: [], body: t };
  const end = t.indexOf("---", 3);
  if (end === -1) return { title: "", tags: [], body: t };
  const fm = t.slice(3, end).trim();
  const body = t.slice(end + 3).trimStart();
  let title = "", tags = [];
  const lines = fm.split("\n");
  for (const line of lines) {
    const m = line.match(/^title:\s*(.+)$/);
    if (m) title = m[1].replace(/^"|"$/g, "").trim();
    const tagM = line.match(/^tags:\s*\[(.*)\]$/);
    if (tagM) {
      tags = tagM[1].split(",").map(s => s.replace(/^"|"$/g, "").trim()).filter(Boolean);
    }
  }
  return { title, tags, body };
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
  console.log(`Using KB: ${kbId} (profile: ${profile})`);

  const files = fs.readdirSync(markedDir).filter(f => f.endsWith(".md")).sort();
  if (files.length === 0) { console.log("No .md files found in marked"); process.exit(0); }

  let synced = 0, failed = 0;
  for (const f of files) {
    const srcPath = path.join(markedDir, f);
    try {
      const content = fs.readFileSync(srcPath, "utf-8");
      const { title, tags, body } = parseFrontmatter(content);
      const tagIds = [];
      for (const tag of tags) {
        tagIds.push(await ensureTag(kbId, tag));
      }
      const payload = { title: title || f.replace(/\.md$/i, ""), content: body };
      if (tagIds.length > 0) payload.tag_ids = tagIds;

      await wkRequest("POST", `${apiBase}/knowledge-bases/${kbId}/knowledge/manual`, payload);

      const dstPath = path.join(weknoraDir, f);
      moveFile(srcPath, dstPath);
      console.log(`  SYNCED ${f} (tags: ${tags.length})`);
      synced++;
    } catch (err) {
      console.error(`  FAIL ${f}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${synced} synced, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const timeout = setTimeout(() => {
  console.error(`FATAL: script timed out after ${SCRIPT_TIMEOUT_MS}ms`);
  process.exit(1);
}, SCRIPT_TIMEOUT_MS);

main().then(() => clearTimeout(timeout)).catch(err => {
  clearTimeout(timeout);
  console.error("FATAL:", err.message);
  process.exit(1);
});
