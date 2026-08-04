const crypto = require("crypto");

const HASH_ROUNDS = 3;
const HASH_LENGTH = 12;

function contentHash(content) {
  let h = content;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = crypto.createHash("sha256").update(h).digest("hex");
  }
  return h.slice(0, HASH_LENGTH);
}

module.exports = { contentHash, HASH_ROUNDS, HASH_LENGTH };
