const fs = require("fs");
const path = require("path");

// ─── Constants ───────────────────────────────────────────────────────────────

const DIRS = ["inbox", "marked", "weknora", "archive", "archived"];
const CONFIG_DIR = ".config";

const DEFAULT_CONFIG = {
    analyze: {
        source_folder: "inbox",
        target_folder: "marked",
        batch_size: 30,
    },
    weknora: {
        source_folder: "marked",
        target_folder: "weknora",
        kb_id: "",
        wiki_kb_id: "",
        score_threshold: 3.5,
        max_pages: 3,
        sync_enabled: true,
        custom_metas: {
            source: "$source",
            author: "$auther",
            aliases: "$aliases",
            score: "$score",
            channel: "wechat-mp",
        },
    },
    archive: {
        orginal_folder: "archived",
        target_folder: "marked",
        days: 90,
    },
};

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , baseDir] = process.argv;

if (!baseDir) {
    console.error("Usage: node init_start.js <base_dir>");
    console.error("  base_dir: knowledge base profile root (e.g. D:/knowledge/articles/ai)");
    process.exit(1);
}

// ─── Directory Creation ──────────────────────────────────────────────────────

let created = 0;

for (const d of DIRS) {
    const p = path.join(baseDir, d);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        console.log(`  CREATED ${d}/`);
        created++;
    }
}

// ─── Config Directory Creation ───────────────────────────────────────────────

const configDir = path.join(baseDir, CONFIG_DIR);
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`  CREATED ${CONFIG_DIR}/`);
    created++;
}

// ─── Config File Creation ────────────────────────────────────────────────────

const configPath = path.join(configDir, "config.json");
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log("  CREATED .config/config.json (default)");
    created++;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nDone. ${created} items created in ${baseDir}`);
