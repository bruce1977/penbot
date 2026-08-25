#!/usr/bin/env node
/**
 * Standalone script entry point for the knowledge-base "weknora sync" sub-flow.
 * Does not depend on opencode / skill / agent.
 *
 * Usage:
 *   node scripts/kb-weknora.js <profile> [submit_interval_ms]
 *   npm run kb:weknora -- ai 10000
 *
 * Directory convention (overridable via env vars):
 *   PB_KNOWLEDGE_BASE_PATH  article root dir (required)
 *   -> <KB_ARTICLES_DIR>/<profile>/marked   input (final .md with frontmatter)
 *   -> <KB_ARTICLES_DIR>/<profile>/weknora  output (synced articles moved here)
 *
 * Config file (required):
 *   <KB_ARTICLES_DIR>/<profile>/.config/config.json
 *   Weknora-specific: source_folder, target_folder, kb_id, submit_interval_ms
 *
 * Env vars:
 *   WEKNORA_BASE_URL   WeKnora API base URL (required)
 *   WEKNORA_API_KEY    WeKnora API key (required)
 *
 * To load the above from .env: npx dotenv-cli -e .env -- node scripts/kb-weknora.js ai
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const profile = process.argv[2];
const cliSubmitInterval = process.argv[3];

if (!profile) {
  console.error("Usage: node scripts/kb-weknora.js <profile> [submit_interval_ms]");
  console.error("  e.g. node scripts/kb-weknora.js ai 10000");
  process.exit(1);
}

const base = process.env.PB_KNOWLEDGE_BASE_PATH;
if (!base) {
  console.error("Error: env PB_KNOWLEDGE_BASE_PATH is not set");
  process.exit(1);
}

const configPath = path.join(base, profile, ".config", "config.json");
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

if (!cfg.weknora) {
  console.error(`Error: missing "weknora" section in ${configPath}`);
  process.exit(1);
}

const sourceFolder = cfg.weknora.source_folder || "marked";
const targetFolder = cfg.weknora.target_folder || "weknora";
const kbId = cfg.weknora.kb_id;
let submitIntervalMs = cfg.weknora.submit_interval_ms != null ? cfg.weknora.submit_interval_ms : 6000;

if (cliSubmitInterval != null) submitIntervalMs = Number(cliSubmitInterval);

if (!kbId) {
  console.error(`Error: missing "kb_id" in weknora section of ${configPath}`);
  process.exit(1);
}

const sourceDir = path.join(base, profile, sourceFolder);
const targetDir = path.join(base, profile, targetFolder);

// Resolve the real weknora_start_to_sync.js (located at skills/knowledge/scripts/)
const sync = path.resolve(
  __dirname,
  "..",
  "skills",
  "knowledge",
  "scripts",
  "weknora_start_to_sync.js"
);

console.log(`=== KB weknora: profile=${profile} kb_id=${kbId} submit_interval=${submitIntervalMs}ms ===`);

const res = spawnSync(process.execPath, [sync, sourceDir, targetDir, kbId, String(submitIntervalMs)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status == null ? 1 : res.status);
