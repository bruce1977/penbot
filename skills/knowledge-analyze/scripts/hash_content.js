const fs = require("fs");
const { contentHash } = require("./lib/content_hash");

const [,, file] = process.argv;

if (!file) {
  console.error("Usage: node skills/knowledge-analyze/scripts/hash_content.js <file.md>");
  process.exit(1);
}

const content = fs.readFileSync(file, "utf-8");
console.log(contentHash(content));
