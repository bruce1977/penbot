const fs = require("fs");
const path = require("path");

const TEMP_DIR = path.resolve(".temp");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node clean_dirs.js <dir1> [dir2] ...");
  console.error("  Only directories under .temp/ can be deleted.");
  process.exit(1);
}

let deletedCount = 0;

for (const dir of args) {
  const resolved = path.resolve(dir);

  if (!resolved.startsWith(TEMP_DIR)) {
    console.log(`SKIP (not under .temp/): ${dir}`);
    continue;
  }

  if (!fs.existsSync(resolved)) {
    console.log(`SKIP (not found): ${dir}`);
    continue;
  }

  fs.rmSync(resolved, { recursive: true, force: true });
  console.log(`DEL DIR: ${dir}`);
  deletedCount++;
}

console.log(`Cleanup complete. Deleted ${deletedCount} item(s).`);
