#!/usr/bin/env node
/**
 * Standalone script entry point for the knowledge-base "archive" sub-flow.
 * Does not depend on opencode / skill / agent.
 *
 * Usage:
 *   node scripts/kb-archive.js <profile> [days]
 *   npm run kb:archive -- ai 60
 *
 * Directory convention (overridable via env vars):
 *   PB_KNOWLEDGE_BASE_PATH  article root dir (required)
 *   -> <KB_ARTICLES_DIR>/<profile>/archived  input (files older than threshold)
 *   -> <KB_ARTICLES_DIR>/<profile>/marked    output (archived files moved here)
 *
 * Config file (required):
 *   <KB_ARTICLES_DIR>/<profile>/config.json
 *   Archive-specific: orginal_folder, target_folder, days
 *
 * To load the above from .env: npx dotenv-cli -e .env -- node scripts/kb-archive.js ai
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const profile = process.argv[2];
const cliDays = process.argv[3];

if (!profile) {
  console.error("Usage: node scripts/kb-archive.js <profile> [days]");
  console.error("  e.g. node scripts/kb-archive.js ai 60");
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

if (!cfg.archive) {
  console.error(`Error: missing "archive" section in ${configPath}`);
  process.exit(1);
}

const sourceFolder = cfg.archive.orginal_folder || "archived";
const targetFolder = cfg.archive.target_folder || "marked";
let days = cfg.archive.days != null ? cfg.archive.days : 90;

if (cliDays != null) days = Number(cliDays);

const sourceDir = path.join(base, profile, sourceFolder);
const targetDir = path.join(base, profile, targetFolder);

// Resolve the real archive_start.js (located at skills/knowledge/scripts/)
const archive = path.resolve(
  __dirname,
  "..",
  "skills",
  "knowledge",
  "scripts",
  "archive_start.js"
);

console.log(`=== KB archive: profile=${profile} days=${days} ===`);

const res = spawnSync(process.execPath, [archive, sourceDir, targetDir, String(days)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status == null ? 1 : res.status);
