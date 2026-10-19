import fs from "node:fs";
import path from "node:path";

/** Find the project root by walking up until package.json or .git is found. */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Minimal .env loader. Existing process.env values always win. */
export function loadDotEnv(root = findProjectRoot()) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return { file, loaded: 0 };
  let loaded = 0;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return { file, loaded };
}

/** Read an environment variable, optionally required. */
export function env(name, fallback = "", { required = false } = {}) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (required) throw new Error(`Missing required environment variable: ${name}`);
    return fallback;
  }
  return value;
}

/** Expand ${VAR} and ${VAR:-default} references inside config strings. */
export function expandEnv(value) {
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = expandEnv(child);
    return out;
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const current = process.env[name];
    return current === undefined || current === "" ? (fallback ?? "") : current;
  });
}
