/**
 * Small argument parser.
 * Supports: --key value, --key=value, --flag, --no-flag, -h.
 * Repeated options become arrays.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      let key;
      let value;
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (key.startsWith("no-")) {
        key = key.slice(3);
        value = false;
      }
      if (key in options) {
        options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
      } else {
        options[key] = value;
      }
      continue;
    }
    positional.push(arg);
  }

  return { command: positional[0], args: positional.slice(1), options };
}

export function asNumber(value, fallback) {
  if (value === undefined || value === null || value === true || value === false) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.toLowerCase());
  return Boolean(value);
}

export function asList(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(asList);
  return String(value)
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
