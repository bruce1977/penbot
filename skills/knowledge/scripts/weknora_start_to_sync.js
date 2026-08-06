const fs = require("fs");
const path = require("path");
const { sleep, titleKey, moveFile } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);
const SUBMIT_INTERVAL_MS = parseInt(process.env.SUBMIT_INTERVAL_MS || "10000", 10);

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , sourceDir, targetDir, categoryId] = process.argv;

if (!sourceDir || !targetDir || !categoryId) {
    console.error("Usage: node weknora_start_to_sync.js <source_dir> <target_dir> <category_id>");
    console.error("  source_dir:  directory of final docs with frontmatter (e.g. marked/)");
    console.error("  target_dir:  destination for synced articles (moved here after import)");
    console.error("  category_id: WeKnora knowledge base category ID");
    process.exit(1);
}

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
    const listRes = await wkRequest("GET", `${apiBase}/knowledge-bases/${categoryId}/tags?page=1&page_size=200`);
    const tags = (listRes.data?.data) || [];
    const found = tags.find((t) => t.name === tagName);

    if (found) return found.id;

    const created = await wkRequest("POST", `${apiBase}/knowledge-bases/${categoryId}/tags`, { name: tagName });
    return created.data.id;
}

// ─── Dedup Helpers ───────────────────────────────────────────────────────────

async function fetchExistingTitles() {
    const titles = new Set();
    const keys = new Set();
    let page = 1;
    const pageSize = 200;

    while (true) {
        const res = await wkRequest("GET", `${apiBase}/knowledge-bases/${categoryId}/knowledge?page=${page}&page_size=${pageSize}`);
        const items = res.data || [];

        for (const it of items) {
            if (it.title) {
                titles.add(it.title);
                keys.add(titleKey(it.title));
            }
        }

        if (items.length < pageSize) break;
        page++;
    }

    return { titles, keys };
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

    console.log(`Using KB: ${categoryId} (submit interval: ${SUBMIT_INTERVAL_MS}ms)`);

    const { titles: existingTitles, keys: existingKeys } = await fetchExistingTitles();
    console.log(`[dedup] loaded ${existingTitles.size} existing titles from KB`);

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

        try {
            const content = fs.readFileSync(srcPath, "utf-8");
            const { title, hash, tags, body } = parseFrontmatter(content);
            const finalTitle = title || f.replace(/\.md$/i, "");
            const submitTitle = hash ? `${hash}_${finalTitle}` : finalTitle;

            // Dedup: skip if normalized title key already exists.
            if (existingKeys.has(titleKey(submitTitle))) {
                moveFile(srcPath, dstPath);
                console.log(`  SKIP ${f}: already exists in KB ("${submitTitle}")`);
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
            await wkRequest("POST", `${apiBase}/knowledge-bases/${categoryId}/knowledge/manual`, payload);

            // Import succeeded: update local dedup sets + move file.
            existingTitles.add(submitTitle);
            existingKeys.add(titleKey(submitTitle));
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
