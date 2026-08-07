const fs = require("fs");
const path = require("path");

// ─── Validation Rules ────────────────────────────────────────────────────────

const MIN_FILE_SIZE = 1024;        // 1KB
const MIN_TEXT_LENGTH = 200;       // 纯文本最少 200 字符
const MIN_CHINESE_RATIO = 0.1;    // 中文字符占比 >= 10%

// ─── Content Cleaning ────────────────────────────────────────────────────────

// Strip HTML tags, CSS blocks, JS blocks, and Markdown code fences.
function cleanContent(raw) {
    let s = raw;
    s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    s = s.replace(/#[^{]*\{[^}]*\}/g, "");
    s = s.replace(/```[\s\S]*?```/g, "");
    s = s.replace(/`[^`]+`/g, "");
    s = s.replace(/!\[.*?\]\(.*?\)/g, "");
    s = s.replace(/\[([^\]]*)\]\(.*?\)/g, "$1");
    s = s.replace(/[-*_]{3,}/g, "");
    s = s.replace(/#+\s*/g, "");
    return s.trim();
}

// ─── Validation Logic ────────────────────────────────────────────────────────

function validateMd(filePath) {
    const errors = [];

    // 1. File size check
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_FILE_SIZE) {
        errors.push(`file too small: ${stat.size} bytes < ${MIN_FILE_SIZE}`);
        return errors; // skip further checks
    }

    // 2. Content cleaning
    const raw = fs.readFileSync(filePath, "utf-8");
    const cleaned = cleanContent(raw);

    // 3. Text length check
    if (cleaned.length < MIN_TEXT_LENGTH) {
        errors.push(`text too short: ${cleaned.length} chars < ${MIN_TEXT_LENGTH}`);
    }

    // 4. Chinese character ratio check
    const chineseChars = cleaned.match(/[\u4e00-\u9fa5]/g) || [];
    const ratio = chineseChars.length / cleaned.length;
    if (ratio < MIN_CHINESE_RATIO) {
        errors.push(`chinese ratio too low: ${(ratio * 100).toFixed(1)}% < ${MIN_CHINESE_RATIO * 100}%`);
    }

    return errors;
}

// ─── Move Invalid File ───────────────────────────────────────────────────────

function moveToError(filePath, errorDir) {
    if (!fs.existsSync(errorDir)) {
        fs.mkdirSync(errorDir, { recursive: true });
    }

    const basename = path.basename(filePath);
    const dest = path.join(errorDir, basename);

    // Avoid overwrite: append timestamp if exists
    if (fs.existsSync(dest)) {
        const ext = path.extname(basename);
        const name = path.basename(basename, ext);
        const dest2 = path.join(errorDir, `${name}_${Date.now()}${ext}`);
        fs.renameSync(filePath, dest2);
        return dest2;
    }

    fs.renameSync(filePath, dest);
    return dest;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { validateMd, moveToError, cleanContent };
