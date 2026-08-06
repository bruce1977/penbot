const fs = require("fs");
const path = require("path");
const { moveFile } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86400 * 1000;

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , srcDir, dstDir, daysStr] = process.argv;

if (!srcDir || !dstDir) {
    console.error("Usage: node archive_start.js <source_dir> <archive_dir> [days]");
    console.error("  days: file age threshold in days (default 90), based on file mtime");
    process.exit(1);
}

const DAYS = daysStr ? parseInt(daysStr, 10) : 90;
if (isNaN(DAYS) || DAYS < 0) {
    console.error(`Error: invalid days "${daysStr}"`);
    process.exit(1);
}

const cutoff = Date.now() - DAYS * MS_PER_DAY;

// ─── Directory Validation ────────────────────────────────────────────────────

if (!fs.existsSync(srcDir)) {
    console.error(`Error: source directory not found: ${srcDir}`);
    process.exit(1);
}

if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

// ─── Main Processing ─────────────────────────────────────────────────────────

const files = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

if (files.length === 0) {
    console.log("No .md files found");
    process.exit(0);
}

let archived = 0;
let kept = 0;

for (const f of files) {
    const srcPath = path.join(srcDir, f);
    const stat = fs.statSync(srcPath);

    if (stat.mtimeMs < cutoff) {
        moveFile(srcPath, path.join(dstDir, f));
        console.log(`  ARCHIVED ${f} (mtime ${stat.mtime.toISOString().slice(0, 10)})`);
        archived++;
    } else {
        kept++;
    }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nDone. ${archived} archived, ${kept} kept (threshold ${DAYS} days)`);
