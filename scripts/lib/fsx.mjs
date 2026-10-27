import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/**
 * 原子落盘：先写同目录 `<file>.tmp` 再 rename 替换。
 * 管线随时可能被中断（超时杀进程/断电），裸 writeFileSync 会留下半截 JSON
 * 或半截终稿——续跑时要么读崩，要么把撕裂的 composed.md 发出去。
 * 同卷 rename 是原子的，读者只会看到旧版或新版；崩溃残留的 `*.tmp` 由 watcher 清扫。
 */
function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return file;
}

export function writeText(file, text) {
  return atomicWrite(file, text);
}

/** 二进制产物（配图、mock PNG）同样原子落盘：半截 PNG 会让发布侧 mime 与内容不符。 */
export function writeBinary(file, buffer) {
  return atomicWrite(file, buffer);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`, { cause: error });
  }
}

export function writeJson(file, value) {
  return atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

export function exists(file) {
  return fs.existsSync(file);
}

export function walkFiles(root, predicate, options = {}) {
  const { skipDirs = [".obsidian", ".git", "node_modules", ".trash"] } = options;
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && skipDirs.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && predicate(full, entry)) {
        out.push(full);
      }
    }
  }
  return out;
}

export function slugify(input, fallback = "article") {
  const text = String(input || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "-")
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (text || fallback).slice(0, 64);
}

export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    iso: date.toISOString(),
  };
}

export function uniqueDir(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function relativeTo(fromDir, target) {
  return path.relative(fromDir, target).split(path.sep).join("/");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
