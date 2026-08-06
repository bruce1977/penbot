const fs = require("fs");
const path = require("path");
const extractMeta = require("./analyze_extract_meta");
const extractRate = require("./analyze_extract_rate");
const { generateYamlHeader, sanitizeTitle, loadJSON } = require("./analyze_frontmatter");
const { stripFrontmatter, getLlmStats } = require("./lib/llm");
const { contentHash } = require("./lib/content_hash");
const { writeJsonFile } = require("./lib/common");

// ─── Config ──────────────────────────────────────────────────────────────────
const [, , sourceDir, targetDir, batchSizeArg] = process.argv;
if (!sourceDir || !targetDir) {
    console.error("Usage: node analyze_start.js <source_dir> <target_dir> [batch_size]");
    process.exit(1);
}

const BATCH_SIZE = Number(batchSizeArg) || 30;
const BATCH_TIMEOUT_MS = 3600000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const pad = (n, len) => String(n).padStart(len, " ");
const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function cleanupFiles(files) {
    for (const file of files) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

// ─── File Selection ──────────────────────────────────────────────────────────
function selectFiles() {
    const dir = path.resolve(sourceDir);
    if (!fs.existsSync(dir)) {
        console.error(`Error: source directory not found: ${dir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
    if (files.length === 0) {
        console.log("No .md files in source directory");
        process.exit(0);
    }

    const dateOf = (name) => name.replace(/\.md$/, "").split("_")[2] || "";
    return files.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

// ─── File Processing ─────────────────────────────────────────────────────────
async function processFile(filename) {
    const filePath = path.join(sourceDir, filename);
    const fileStart = Date.now();

    const track = async (phase, fn) => {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            console.log(`... ${phase.padEnd(10)} ${fmtMs(Date.now() - start)}`);
        }
    };

    // PREP: read file and compute hash
    const cleanBody = await track("PREP", () => {
        const raw = fs.readFileSync(filePath, "utf-8");
        return stripFrontmatter(raw);
    });

    const hash = contentHash(cleanBody);
    const metaPath = path.join(sourceDir, `${hash}.meta.json`);
    const ratePath = path.join(sourceDir, `${hash}.rate.json`);

    try {
        // META: extract metadata
        if (!fs.existsSync(metaPath)) {
            await track("META", () => extractMeta.processFile(cleanBody, metaPath));
            const meta = loadJSON(metaPath);
            meta.source = filename;
            writeJsonFile(metaPath, meta);
        }

        // RATE: extract rating
        if (!fs.existsSync(ratePath)) {
            await track("RATE", () => extractRate.processFile(cleanBody, ratePath));
        }

        // ASSEMBLE: generate output file
        await track("ASSEMBLE", () => {
            const meta = loadJSON(metaPath);
            if (!meta) throw new Error(`failed to load ${metaPath}`);

            const rate = loadJSON(ratePath);
            if (!rate) throw new Error(`failed to load ${ratePath}`);

            const metaHeader = generateYamlHeader(meta, rate, hash);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetFile = path.join(targetDir, `${hash}_${sanitizeTitle(meta.title)}.md`);
            if (fs.existsSync(targetFile)) {
                fs.unlinkSync(targetFile, { force: true });
            }
            fs.writeFileSync(targetFile, `${metaHeader}\n\n${cleanBody}`, "utf-8");
        });

        const ms = Date.now() - fileStart;
        console.log(`... Processed file: ${filename}, spent ${fmtMs(ms)}`);

        return { status: "done", ms };
    } finally {
        // Clean up intermediate files
        cleanupFiles([metaPath, ratePath]);
    }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(results) {
    const entries = Object.values(results);
    const done = entries.filter((r) => r.status === "done").length;
    const failed = entries.length - done;
    const totalMs = entries.reduce((sum, r) => sum + (r.ms || 0), 0);
    const avg = entries.length ? (totalMs / entries.length / 1000).toFixed(1) : "0.0";
    const llm = getLlmStats();

    console.log([
        "",
        "=".repeat(60),
        `Done: ${done}  Failed: ${failed}  Total: ${fmtMs(totalMs)}  Avg: ${avg}s/file`,
        `LLM: ${llm.calls} calls, ${llm.retries} retries`,
        "=".repeat(60),
    ].join("\n"));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    // Get all eligible files from source directory
    const allFiles = selectFiles();
    const batch = allFiles.slice(0, BATCH_SIZE);

    console.log(`\nKnowledge Analysis  ${batch.length}/${allFiles.length} files  timeout ${BATCH_TIMEOUT_MS / 1000}s`);

    // Process each file
    const results = {};
    const batchStart = Date.now();
    for (const filename of batch) {
        // Check timeout
        if (Date.now() - batchStart > BATCH_TIMEOUT_MS) {
            console.log("\nBatch timeout reached, stopping");
            break;
        }

        console.log(`\n[${pad(Object.keys(results).length + 1, String(batch.length).length)}/${batch.length}] ${filename}`);

        try {
            // Process file
            results[filename] = await processFile(filename);

            // Delete source file on success
            if (results[filename].status === "done") {
                fs.unlinkSync(path.join(sourceDir, filename));
            }
        } catch (err) {
            console.error(`... Processing ${filename} failed, details: ${err.message}`);

            results[filename] = { status: "failed", error: err.message, ms: 0 };
        }
    }

    // Print summary report
    printSummary(results);
}

main().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
});
