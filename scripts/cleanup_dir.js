const fs = require("fs");
const path = require("path");

const [,, targetDir] = process.argv;
const DRY_RUN = process.env.CLEANUP_DRY_RUN === "true" || process.argv.includes("--dry-run");

if (!targetDir) {
  console.error("Usage: node cleanup_dir.js <target_dir> [--dry-run]");
  console.error("  Recursively deletes target_dir. Use --dry-run or CLEANUP_DRY_RUN=true to preview.");
  process.exit(1);
}

const resolved = path.resolve(targetDir);

if (!fs.existsSync(resolved)) {
  console.log(`Not found: ${resolved}`);
  process.exit(0);
}

const baseName = path.basename(resolved);
const parentName = path.basename(path.dirname(resolved));
if (baseName === "" || baseName === "." || baseName === ".." || baseName === ".temp" || baseName === "output") {
  console.error(`Safety check failed: refusing to delete ${resolved}`);
  process.exit(1);
}

if (DRY_RUN) {
  let count = 0;
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); count++; } else { count++; }
    }
  }
  walk(resolved);
  console.log(`[DRY RUN] Would delete ${count} items in ${resolved}`);
  process.exit(0);
}

try {
  fs.rmSync(resolved, { recursive: true, force: true });
  console.log(`Deleted: ${resolved}`);
} catch (err) {
  console.error(`Delete failed ${resolved}: ${err.message}`);
  process.exit(1);
}
