const fs = require("fs");
const path = require("path");

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: node clean_dirs.js <dir1> [dir2] ...");
  process.exit(1);
}

let deletedCount = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.log(`SKIP (not found): ${dir}`);
    continue;
  }

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    console.error(`FAIL readdir: ${dir} (${e.message})`);
    continue;
  }

  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fp, { recursive: true, force: true });
      console.log(`DEL DIR: ${fp}`);
    } else {
      fs.unlinkSync(fp);
      console.log(`DEL FILE: ${fp}`);
    }
    deletedCount++;
  }
}

console.log(`Cleanup complete. Deleted ${deletedCount} item(s).`);
