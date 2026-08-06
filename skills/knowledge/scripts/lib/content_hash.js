const crypto = require("crypto");

// ─── Constants ───────────────────────────────────────────────────────────────

const HASH_ROUNDS = 3;
const HASH_LENGTH = 12;

// ─── Hash Computation ────────────────────────────────────────────────────────

// Compute a stable content hash by iterating SHA-256 multiple times.
// Multiple rounds increase collision resistance for short hashes.
function contentHash(content) {
    let h = content;
    for (let i = 0; i < HASH_ROUNDS; i++) {
        h = crypto.createHash("sha256").update(h).digest("hex");
    }
    return h.slice(0, HASH_LENGTH);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { contentHash, HASH_ROUNDS, HASH_LENGTH };
