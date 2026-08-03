const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SCRIPTS_DIR = __dirname;
const FILE_TIMEOUT_MS = 300000;
const BATCH_TIMEOUT_MS = 3600000;

const [,, sourceDir, targetDir, batchSizeArg] = process.argv;

if (!sourceDir || !targetDir) {
  console.error("Usage: node analyze_batch.js <source_dir> <target_dir> [batch_size]");
  process.exit(1);
}

const BATCH_SIZE = Number(batchSizeArg) || 30;

function runScript(scriptPath, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("node", [scriptPath, ...args], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        let output = {};
        try { output = JSON.parse(stdout); } catch { output = { status: "error", error: err.message }; }
        resolve(output);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { resolve({ status: "error", error: "invalid JSON output" }); }
    });
  });
}

function extractDate(filename) {
  const parts = filename.replace(/\.md$/, "").split("_");
  if (parts.length >= 3 && /^\d{8}$/.test(parts[2])) return parts[2];
  return "99999999";
}

function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("---", 3);
  if (end === -1) return content;
  return content.slice(end + 3).replace(/^\n/, "");
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
    const da = extractDate(a);
    const db = extractDate(b);
    return da < db ? -1 : da > db ? 1 : a.localeCompare(b);
  });

  return { sorted, batch: sorted.slice(0, BATCH_SIZE) };
}

async function processFile(f) {
  const filePath = path.join(sourceDir, f);
  const t0 = Date.now();

  // 预处理：剥离 frontmatter，写临时文件供子脚本使用
  const raw = fs.readFileSync(filePath, "utf-8");
  const clean = stripFrontmatter(raw);
  const tmpPath = path.join(sourceDir, `${Date.now()}_${path.basename(filePath)}`);
  fs.writeFileSync(tmpPath, clean, "utf-8");

  try {
    console.log(`\n[${f}] meta+rate 并发开始`);

    const [metaResult, rateResult] = await Promise.all([
      runScript(path.join(SCRIPTS_DIR, "extract_meta.js"), [tmpPath], FILE_TIMEOUT_MS),
      runScript(path.join(SCRIPTS_DIR, "extract_rate.js"), [tmpPath], FILE_TIMEOUT_MS),
    ]);

    console.log(`[${f}] meta=${metaResult.status} rate=${rateResult.status} (${Date.now() - t0}ms)`);

    if (metaResult.status !== "ok" && metaResult.status !== "skip") {
      return { file: f, status: "failed", error: metaResult.error };
    }

    // merge：输出合并后的完整内容
    console.log(`[${f}] merge 开始`);
    const mergeResult = await runScript(
      path.join(SCRIPTS_DIR, "merge_to_marked.js"),
      [tmpPath],
      30000,
    );
    console.log(`[${f}] merge=${mergeResult.status} (${Date.now() - t0}ms)`);

    if (mergeResult.status !== "ok") {
      return { file: f, status: "failed", error: mergeResult.error || mergeResult.reason };
    }

    // 主流程负责：写入目标目录 + 清理源目录
    const dstName = `${mergeResult.hash}_${f}`;
    const dstPath = path.join(targetDir, dstName);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(dstPath, mergeResult.merged, "utf-8");

    const base = f.slice(0, -3);
    fs.unlinkSync(filePath);
    const metaPath = path.join(sourceDir, `${base}.meta.json`);
    const ratePath = path.join(sourceDir, `${base}.rate.json`);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    if (fs.existsSync(ratePath)) fs.unlinkSync(ratePath);

    return { file: f, status: "done", dstName, ms: Date.now() - t0 };
  } finally {
    // 清理源目录下的临时文件（.md + .meta.json + .rate.json）
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    const tmpBase = path.basename(tmpPath, ".md");
    const tmpMetaPath = path.join(sourceDir, `${tmpBase}.meta.json`);
    const tmpRatePath = path.join(sourceDir, `${tmpBase}.rate.json`);
    if (fs.existsSync(tmpMetaPath)) fs.unlinkSync(tmpMetaPath);
    if (fs.existsSync(tmpRatePath)) fs.unlinkSync(tmpRatePath);
  }
}

async function runBatch(batch) {
  const results = [];
  const batchStart = Date.now();

  for (const f of batch) {
    if (Date.now() - batchStart > BATCH_TIMEOUT_MS) {
      console.log(`\n=== Batch timeout reached, stopping ===`);
      break;
    }
    try {
      results.push(await processFile(f));
    } catch (err) {
      results.push({ file: f, status: "failed", error: err.message });
    }
  }

  return results;
}

function printSummary(results, sorted, batch) {
  const done = results.filter(r => r.status === "done").length;
  const skipped = results.filter(r => r.status === "skip").length;
  const failed = results.filter(r => r.status === "failed").length;
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);

  console.log(`\n=== Summary ===`);
  console.log(`Done: ${done}, Skipped: ${skipped}, Failed: ${failed}`);
  if (results.length > 0) {
    console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s, Avg: ${(totalMs / results.length / 1000).toFixed(1)}s/file`);
  }
  console.log(`Remaining: ${sorted.length - batch.length} files`);

  if (failed > 0) {
    console.log(`\nFailed files:`);
    results.filter(r => r.status === "failed").forEach(r => console.log(`  ${r.file}: ${r.error}`));
  }
}

async function main() {
  const { sorted, batch } = selectBatch(path.resolve(sourceDir));

  console.log(`=== Batch: ${batch.length}/${sorted.length} files ===`);
  console.log(`=== Timeout: ${FILE_TIMEOUT_MS / 1000}s/file, ${BATCH_TIMEOUT_MS / 1000}s/batch ===\n`);

  const results = await runBatch(batch);
  printSummary(results, sorted, batch);
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});