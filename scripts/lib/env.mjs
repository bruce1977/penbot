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

/**
 * 把配置值归一成布尔。expandEnv 替换出来的一律是字符串，而读取端混用 `=== true`
 * 与真值判断——不归一就会让 "false" 在真值判断里当成开。
 */
export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled"].includes(text)) return false;
  if (["true", "1", "yes", "on", "enabled"].includes(text)) return true;
  return fallback;
}

/**
 * 把配置值归一成数字（env 抬起的阈值都是字符串）。
 * 写了值但不是数字就抛错：静默退回默认值等于允许配置说谎，也会把
 * PB_REVIEW_ROUNDS=three 这样的笔误变成一次没人察觉的降级。
 */
export function toNumber(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label || "配置值"} 必须是数字，实际是 ${JSON.stringify(value)}`);
  return n;
}

/**
 * 必填配置项：缺失或空串直接抛错，报错里点名配置路径（口径同 models.mjs#needProfile、
 * classify.mjs#needEndpointParam）。
 * Why：读取端铺一份和配置同值的兜底默认（`|| 30000`、`?? 2`、`|| "/api/correct"`）
 * 等于允许配置说谎——改了 defaults.yaml 不生效，而且没人知道这一次跑的到底是哪个值。
 * 0 与 false 是合法取值（`retries: 0` = 不做 HTTP 重试），只有 null/undefined/空串算没配。
 */
export function needConfig(value, where) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`缺少配置项 ${where}：必填参数不留代码默认值`);
  }
  return typeof value === "string" ? value.trim() : value;
}

/** needConfig + 数字归一（.env 抬起的值经 expandEnv 后是字符串）。 */
export function needNumber(value, where) {
  return toNumber(needConfig(value, where), where);
}
