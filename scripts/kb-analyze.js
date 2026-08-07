#!/usr/bin/env node
/**
 * Standalone script entry point for the knowledge-base "analysis" sub-flow.
 * Does not depend on opencode / skill / agent.
 *
 * Usage:
 *   node scripts/kb-analyze.js <profile> [batchSize]
 *   npm run kb:analyze -- ai 10
 *
 * Directory convention (overridable via env vars):
 *   PB_KNOWLEDGE_BASE_PATH  article root dir (required)
 *   -> <KB_ARTICLES_DIR>/<profile>/inbox   input (raw .md to analyze)
 *   -> <KB_ARTICLES_DIR>/<profile>/marked  output (final .md with frontmatter)
 *
 * Config file:
 *   <KB_ARTICLES_DIR>/<profile>/config.json  (optional)
 *   Analyze-specific overrides: source_folder, target_folder, batch_size
 *
 * Env vars (read by lib/llm.js, all optional, all have defaults):
 *   KB_LLM_BASE_URL    default http://localhost:11434/v1
 *   KB_LLM_MODEL       default qwen2.5:3b (shared meta/rate model)
 *   KB_LLM_META_MODEL / KB_LLM_RATE_MODEL  override model per stage
 *   KB_LLM_TIMEOUT_MS  per-request timeout, default 120000
 *   KB_LLM_NUM_CTX     (currently hardcoded 8192 in lib/llm.js; change there if needed)
 *
 * To load the above from .env: npx dotenv-cli -e .env -- node scripts/kb-analyze.js ai
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const profile = process.argv[2];
const cliBatchSize = process.argv[3];

if (!profile) {
  console.error("Usage: node scripts/kb-analyze.js <profile> [batchSize]");
  console.error("  e.g. node scripts/kb-analyze.js ai 10");
  process.exit(1);
}

const base = process.env.PB_KNOWLEDGE_BASE_PATH;
if (!base) {
  console.error("Error: env PB_KNOWLEDGE_BASE_PATH is not set");
  process.exit(1);
}

const configPath = path.join(base, profile, "config.json");
if (!fs.existsSync(configPath)) {
  console.error(`Error: config file not found: ${configPath}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e) {
  console.error(`Error: failed to parse ${configPath}: ${e.message}`);
  process.exit(1);
}

if (!cfg.analyze) {
  console.error(`Error: missing "analyze" section in ${configPath}`);
  process.exit(1);
}

const sourceFolder = cfg.analyze.source_folder || "inbox";
const targetFolder = cfg.analyze.target_folder || "marked";
let batchSize = cfg.analyze.batch_size != null ? cfg.analyze.batch_size : 30;

if (cliBatchSize != null) batchSize = Number(cliBatchSize);

const sourceDir = path.join(base, profile, sourceFolder);
const targetDir = path.join(base, profile, targetFolder);

// Resolve the real analyze_start.js (located at skills/knowledge/scripts/)
const analyze = path.resolve(
  __dirname,
  "..",
  "skills",
  "knowledge",
  "scripts",
  "analyze_start.js"
);

console.log(`=== KB analyze: profile=${profile} batchSize=${batchSize} ===`);

const res = spawnSync(process.execPath, [analyze, sourceDir, targetDir, String(batchSize)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status == null ? 1 : res.status);
