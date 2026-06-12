const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node clean_dirs.js <dir1> [dir2] ...");
  console.error("  Only directories whose name starts with '~' can be deleted.");
  process.exit(1);
}

let deletedCount = 0;

for (const dir of args) {
  const baseName = path.basename(dir);

  if (!baseName.startsWith("~")) {
    console.log(`SKIP (not ~-prefixed): ${dir}`);
    continue;
  }

  if (!fs.existsSync(dir)) {
    console.log(`SKIP (not found): ${dir}`);
    continue;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`DEL DIR: ${dir}`);
  deletedCount++;
}

console.log(`Cleanup complete. Deleted ${deletedCount} item(s).`);
