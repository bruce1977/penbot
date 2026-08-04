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
 *   KB_ARTICLES_DIR  article root dir, default D:\knowledge\articles
 *   -> <KB_ARTICLES_DIR>/<profile>/inbox   input (raw .md to analyze)
 *   -> <KB_ARTICLES_DIR>/<profile>/marked  output (final .md with frontmatter)
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
const path = require("path");

const profile = process.argv[2];
const batchSize = process.argv[3] || "30";

if (!profile) {
  console.error("Usage: node scripts/kb-analyze.js <profile> [batchSize]");
  console.error("  e.g. node scripts/kb-analyze.js ai 10");
  process.exit(1);
}

const base = process.env.KB_ARTICLES_DIR || "D:\\knowledge\\articles";
const sourceDir = path.join(base, profile, "inbox");
const targetDir = path.join(base, profile, "marked");

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
