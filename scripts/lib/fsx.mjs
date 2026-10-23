import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
  return file;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  return file;
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
