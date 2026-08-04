const fs = require("fs");
const path = require("path");
const extractMeta = require("./analyze_extract_meta");
const extractRate = require("./analyze_extract_rate");
const mergeToMarked = require("./analyze_merge");
const { stripFrontmatter } = require("./lib/llm");

const BATCH_TIMEOUT_MS = 3600000;

const [, , sourceDir, targetDir, batchSizeArg] = process.argv;
if (!sourceDir || !targetDir) {
  console.error("Usage: node analyze_start.js <source_dir> <target_dir> [batch_size]");
  process.exit(1);
}
const BATCH_SIZE = Number(batchSizeArg) || 30;

// Derive the publish date (YYYYMMDD) embedded in the filename so batches run oldest-first.
function extractDate(filename) {
  const parts = filename.replace(/\.md$/, "").split("_");
  return parts.length >= 3 && /^\d{8}$/.test(parts[2]) ? parts[2] : "99999999";
}

function selectBatch(absSource) {
  if (!fs.existsSync(absSource)) {
    console.error(`Error: source directory not found: ${absSource}`);
    process.exit(1);
  }
  const allFiles = fs.readdirSync(absSource).filter(f => f.endsWith(".md"));
  if (allFiles.length === 0) {
    console.log("No .md files in source directory");
    process.exit(0);
  }
  const sorted = allFiles.sort((a, b) => {
    const da = extractDate(a), db = extractDate(b);
    return da < db ? -1 : da > db ? 1 : a.localeCompare(b);
  });
  return { sorted, batch: sorted.slice(0, BATCH_SIZE) };
}

async function processFile(f) {
  const filePath = path.join(sourceDir, f);
  const base = f.slice(0, -3);
  const t0 = Date.now();

  // Cache check: if both .meta.json and .rate.json exist next to the original file,
  // extraction was already done (e.g. previous interrupted run). Skip straight to merge.
  const metaPath = path.join(sourceDir, `${base}.meta.json`);
  const ratePath = path.join(sourceDir, `${base}.rate.json`);
  const cacheReady = fs.existsSync(metaPath) && fs.existsSync(ratePath);

  // Hand a frontmatter-stripped body to the extractors via a temp file.
  const clean = stripFrontmatter(fs.readFileSync(filePath, "utf-8"));
  const tmpPath = path.join(sourceDir, `${Date.now()}_${path.basename(filePath)}`);
  fs.writeFileSync(tmpPath, clean, "utf-8");

  try {
    let metaResult, rateResult;

    if (cacheReady) {
      // Cache hit: reuse existing .meta.json / .rate.json
      metaResult = { status: "skip", file: f };
      rateResult = { status: "skip", file: f };
    } else {
      // Cache miss: run extraction concurrently, write cache to sourceDir (next to original file)
      [metaResult, rateResult] = await Promise.all([
        extractMeta.processFile(tmpPath, sourceDir, base),
        extractRate.processFile(tmpPath, sourceDir, base),
      ]);
    }

    // A genuine error (not a cached-json reuse) aborts the file.
    if (metaResult.status === "error") return { file: f, status: "failed", error: `meta: ${metaResult.error}`, ms: Date.now() - t0 };
    if (rateResult.status === "error") return { file: f, status: "failed", error: `rate: ${rateResult.error}`, ms: Date.now() - t0 };

    const mergeResult = await mergeToMarked.processFile(filePath, targetDir);
    if (mergeResult.status !== "ok") return { file: f, status: "failed", error: mergeResult.error || mergeResult.reason, ms: Date.now() - t0 };

    // merge_to_marked already wrote the target file (${hash}_${title}.md); clean up source.
    fs.unlinkSync(filePath);
    [".meta.json", ".rate.json"].forEach(suf => {
      const p = path.join(sourceDir, `${base}${suf}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    return { file: f, status: "done", target: mergeResult.targetPath, ms: Date.now() - t0 };
  } finally {
    // Always remove the temp file.
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function runBatch(batch) {
  const results = [];
  const batchStart = Date.now();
  const width = String(batch.length).length;

  for (let i = 0; i < batch.length; i++) {
    if (Date.now() - batchStart > BATCH_TIMEOUT_MS) {
      console.log(`Batch timeout reached, stopping (${i}/${batch.length} processed)`);
      break;
    }
    const f = batch[i];
    const r = await processFile(f).catch(err => ({ file: f, status: "failed", error: err.message, ms: 0 }));
    const mark = r.status === "done" ? "OK " : r.status === "skip" ? "SKIP" : "ERR ";
    const tail = r.status === "done" && r.target
      ? ` → ${path.basename(r.target)}`
      : (r.status === "failed" ? `  ${r.error}` : "");
    console.log(`[${String(i + 1).padStart(width)}/${batch.length}] ${mark} ${f}  ${((r.ms || 0) / 1000).toFixed(0)}s${tail}`);
    results.push(r);
  }
  return results;
}

function printSummary(results, sorted, batch) {
  const done = results.filter(r => r.status === "done").length;
  const skipped = results.filter(r => r.status === "skip").length;
  const failed = results.filter(r => r.status === "failed").length;
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
  const avg = results.length ? (totalMs / results.length / 1000).toFixed(1) : "0.0";
  console.log(`\n=== Summary: done ${done}, skipped ${skipped}, failed ${failed} | total ${(totalMs / 1000).toFixed(1)}s, avg ${avg}s/file ===`);
  console.log(`Remaining: ${sorted.length - batch.length} files`);
  results.filter(r => r.status === "failed").forEach(r => console.log(`  ERR ${r.file}: ${r.error}`));
}

async function main() {
  const { sorted, batch } = selectBatch(path.resolve(sourceDir));
  console.log(`=== Knowledge analysis: ${batch.length}/${sorted.length} files (timeout ${BATCH_TIMEOUT_MS / 1000}s) ===`);
  const results = await runBatch(batch);
  printSummary(results, sorted, batch);
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
