const fs = require("fs");
const path = require("path");
const { sleep, moveFile } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , sourceDir, targetDir, kbId, submitIntervalArg] = process.argv;

if (!sourceDir || !targetDir || !kbId) {
    console.error("Usage: node weknora_start_to_sync.js <source_dir> <target_dir> <kb_id> [submit_interval_ms]");
    console.error("  source_dir:        directory of final docs with frontmatter (e.g. marked/)");
    console.error("  target_dir:        destination for synced articles (moved here after import)");
    console.error("  kb_id:             WeKnora knowledge base ID");
    console.error("  submit_interval_ms: delay between submissions (default 6000)");
    process.exit(1);
}

const SUBMIT_INTERVAL_MS = submitIntervalArg ? parseInt(submitIntervalArg, 10) : 6000;

// ─── Environment Variables ───────────────────────────────────────────────────

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

// ─── API Request Helper ──────────────────────────────────────────────────────

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

// ─── Tag Management ──────────────────────────────────────────────────────────

async function ensureTag(tagName) {
    const listRes = await wkRequest("GET", `${apiBase}/knowledge-bases/${kbId}/tags?page=1&page_size=200`);
    const tags = (listRes.data?.data) || [];
    const found = tags.find((t) => t.name === tagName);

    if (found) return found.id;

    const created = await wkRequest("POST", `${apiBase}/knowledge-bases/${kbId}/tags`, { name: tagName });
    return created.data.id;
}

// ─── Dedup Helpers ───────────────────────────────────────────────────────────

async function fetchExistingHashes() {
    const hashes = new Set();
    let page = 1;
    const pageSize = 200;

    while (true) {
        const res = await wkRequest("GET", `${apiBase}/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=${pageSize}`);
        const items = res.data || [];

        for (const it of items) {
            // Title format: {hash}_{title} — extract hash prefix
            if (it.title) {
                const sep = it.title.indexOf("_");
                if (sep > 0 && sep <= 16) {
                    const prefix = it.title.slice(0, sep);
                    if (/^[a-f0-9]{8,}$/i.test(prefix)) {
                        hashes.add(prefix);
                    }
                }
            }
        }

        if (items.length < pageSize) break;
        page++;
    }

    return hashes;
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

function parseFrontmatter(content) {
    const t = content.trimStart();
    if (!t.startsWith("---")) return { title: "", hash: "", tags: [], body: t };

    const end = t.indexOf("---", 3);
    if (end === -1) return { title: "", hash: "", tags: [], body: t };

    const fm = t.slice(3, end).trim();
    const body = t.slice(end + 3).trimStart();

    let title = "";
    let hash = "";
    let tags = [];

    for (const line of fm.split("\n")) {
        const m = line.match(/^title:\s*(.+)$/);
        if (m) title = m[1].replace(/^"|"$/g, "").trim();

        const hashM = line.match(/^hash:\s*(.+)$/);
        if (hashM) hash = hashM[1].replace(/^"|"$/g, "").trim();

        const tagM = line.match(/^tags:\s*\[(.*)\]$/);
        if (tagM) {
            tags = tagM[1].split(",")
                .map((s) => s.trim().replace(/^"|"$/g, ""))
                .filter(Boolean);
        }
    }

    return { title, hash, tags, body };
}

// ─── Main Flow ───────────────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(sourceDir)) {
        console.error(`Error: source directory not found: ${sourceDir}`);
        process.exit(1);
    }

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    console.log(`Using KB: ${kbId} (submit interval: ${SUBMIT_INTERVAL_MS}ms)`);

    const existingHashes = await fetchExistingHashes();
    console.log(`[dedup] loaded ${existingHashes.size} existing hashes from KB`);

    const duplDir = path.join(sourceDir, "dupl");
    if (!fs.existsSync(duplDir)) fs.mkdirSync(duplDir, { recursive: true });

    const files = fs.readdirSync(sourceDir)
        .filter((f) => f.endsWith(".md"))
        .sort();

    if (files.length === 0) {
        console.log("No .md files found in source directory");
        process.exit(0);
    }

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const srcPath = path.join(sourceDir, f);
        const dstPath = path.join(targetDir, f);
        const duplPath = path.join(duplDir, f);

        try {
            const content = fs.readFileSync(srcPath, "utf-8");
            const { title, hash, tags, body } = parseFrontmatter(content);
            const finalTitle = title || f.replace(/\.md$/i, "");
            const submitTitle = hash ? `${hash}_${finalTitle}` : finalTitle;

            // Dedup: skip if hash already exists in KB.
            if (hash && existingHashes.has(hash)) {
                moveFile(srcPath, duplPath);
                console.log(`  DUP ${f}: hash "${hash}" already exists in KB`);
                skipped++;
                continue;
            }

            // Create/reuse tags.
            const tagIds = [];
            for (const tag of tags) {
                tagIds.push(await ensureTag(tag));
            }

            // Import article.
            const payload = { title: submitTitle, content: body, status: "publish" };
            if (tagIds.length > 0) payload.tag_ids = tagIds;
            await wkRequest("POST", `${apiBase}/knowledge-bases/${kbId}/knowledge/manual`, payload);

            // Import succeeded: update local dedup set + move file.
            if (hash) existingHashes.add(hash);
            moveFile(srcPath, dstPath);
            console.log(`  SYNCED ${f} (tags: ${tags.length}, title: "${submitTitle}")`);
            synced++;
        } catch (err) {
            console.error(`  FAIL ${f}: ${err.message}`);
            failed++;
        }

        // Submit interval (no wait after the last item).
        if (i < files.length - 1) {
            await sleep(SUBMIT_INTERVAL_MS);
        }
    }

    console.log(`\nDone. ${synced} synced, ${skipped} skipped, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

// ─── Timeout Guard & Entry Point ─────────────────────────────────────────────

const timeout = setTimeout(() => {
    console.error(`FATAL: script timed out after ${SCRIPT_TIMEOUT_MS}ms`);
    process.exitCode = 1;
}, SCRIPT_TIMEOUT_MS);

main().then(() => clearTimeout(timeout)).catch((err) => {
    clearTimeout(timeout);
    console.error("FATAL:", err.message);
    process.exitCode = 1;
});
