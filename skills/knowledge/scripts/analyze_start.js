const fs = require("fs");
const path = require("path");
const extractMeta = require("./analyze_extract_meta");
const extractRate = require("./analyze_extract_rate");
const { generateYamlHeader, sanitizeTitle, loadJSON } = require("./analyze_frontmatter");
const { stripFrontmatter } = require("./lib/llm");
const { contentHash } = require("./lib/content_hash");

const BATCH_TIMEOUT_MS = 3600000;
const SEPARATOR = "-".repeat(60);

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

async function processFile(f, index, total) {
  const filePath = path.join(sourceDir, f);
  const base = f.slice(0, -3);
  const t0 = Date.now();
  const prefix = `[${String(index + 1).padStart(String(total).length)}/${total}]`;

  console.log(`${prefix} Processing: ${f}`);
  console.log(SEPARATOR);

  // Step 1: Strip existing frontmatter
  console.log(`${prefix} Step 1: Stripping existing frontmatter`);
  const rawContent = fs.readFileSync(filePath, "utf-8");
  const cleanBody = stripFrontmatter(rawContent);

  // Step 2: Compute content hash
  console.log(`${prefix} Step 2: Computing content hash`);
  const hash = contentHash(cleanBody);
  console.log(`${prefix} hash: ${hash}`);

  // Step 3 & 4: Extract metadata and rate content (parallel)
  console.log(`${prefix} Step 3 & 4: Extracting metadata and rating content (parallel)`);
  const metaPath = path.join(sourceDir, `${hash}.meta.json`);
  const ratePath = path.join(sourceDir, `${hash}.rate.json`);

  const metaTask = fs.existsSync(metaPath)
      ? Promise.resolve({ status: "skip", file: f })
      : extractMeta.processFile(cleanBody, metaPath, f);

  const rateTask = fs.existsSync(ratePath)
      ? Promise.resolve({ status: "skip", file: f })
      : extractRate.processFile(cleanBody, ratePath, f);

  const [metaResult, rateResult] = await Promise.all([metaTask, rateTask]);

  if (metaResult.status === "error") {
    console.log(`${prefix} Metadata extraction failed: ${metaResult.error}`);
    return { file: f, status: "failed", error: `meta: ${metaResult.error}`, ms: Date.now() - t0 };
  }
  if (rateResult.status === "error") {
    console.log(`${prefix} Rating failed: ${rateResult.error}`);
    return { file: f, status: "failed", error: `rate: ${rateResult.error}`, ms: Date.now() - t0 };
  }

  // Step 5: Generate YAML header
  console.log(`${prefix} Step 5: Generating YAML header`);
  const meta = loadJSON(metaPath);
  const rate = loadJSON(ratePath);
  if (!meta) {
    return { file: f, status: "failed", error: "failed to load meta.json", ms: Date.now() - t0 };
  }
  const yamlHeader = generateYamlHeader(meta, rate, hash);

  // Step 6: Create target file with YAML header and content
  console.log(`${prefix} Step 6: Creating target file`);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${hash}_${sanitizeTitle(meta.title)}.md`);
  const fileContent = `${yamlHeader}\n\n${cleanBody}`;
  fs.writeFileSync(targetPath, fileContent, "utf-8");

  // Step 7: Cleanup intermediate files
  console.log(`${prefix} Step 7: Cleaning up intermediate files`);
  [`${hash}.meta.json`, `${hash}.rate.json`].forEach(filename => {
    const p = path.join(sourceDir, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  console.log(`${prefix} Completed: ${f} → ${path.basename(targetPath)}`);
  console.log(SEPARATOR);

  return { file: f, status: "done", target: targetPath, ms: Date.now() - t0 };
}

async function runBatch(batch) {
  const results = [];
  const batchStart = Date.now();

  for (let i = 0; i < batch.length; i++) {
    if (Date.now() - batchStart > BATCH_TIMEOUT_MS) {
      console.log(`Batch timeout reached, stopping (${i}/${batch.length} processed)`);
      break;
    }
    const f = batch[i];
    const r = await processFile(f, i, batch.length).catch(err => ({ file: f, status: "failed", error: err.message, ms: 0 }));
    const mark = r.status === "done" ? "OK" : r.status === "skip" ? "SKIP" : "ERR";
    const tail = r.status === "done" && r.target
      ? ` -> ${path.basename(r.target)}`
      : (r.status === "failed" ? `  ${r.error}` : "");
    console.log(`${mark} ${f}  ${((r.ms || 0) / 1000).toFixed(0)}s${tail}`);
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

  console.log("\n" + "=".repeat(60));
  console.log("Processing Summary");
  console.log("=".repeat(60));
  console.log(`Done: ${done} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s | Avg: ${avg}s/file`);
  console.log(`Remaining: ${sorted.length - batch.length} files`);

  if (failed > 0) {
    console.log("\nFailed files:");
    results.filter(r => r.status === "failed")
        .forEach(r => console.log(`  ERR ${r.file}: ${r.error}`));
  }
  console.log("=".repeat(60));
}

async function main() {
  const { sorted, batch } = selectBatch(path.resolve(sourceDir));
  console.log("\n" + "=".repeat(60));
  console.log("Knowledge Document Analysis");
  console.log("=".repeat(60));
  console.log(`Source: ${sourceDir}`);
  console.log(`Target: ${targetDir}`);
  console.log(`Batch size: ${batch.length}/${sorted.length}`);
  console.log(`Timeout: ${BATCH_TIMEOUT_MS / 1000}s`);
  console.log("=".repeat(60) + "\n");

  const results = await runBatch(batch);
  printSummary(results, sorted, batch);
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
