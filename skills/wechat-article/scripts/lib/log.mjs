import fs from "node:fs";
import path from "node:path";

export function createLogger({ file, verbose = false, label = "wechat-article" } = {}) {
  const start = Date.now();
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  function emit(level, message, extra) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const stamp = new Date().toISOString().slice(11, 19);
    const suffix = extra ? ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : "";
    const line = `[${stamp} +${elapsed}s] [${level}] [${label}] ${message}${suffix}`;
    if (level === "error") console.error(line);
    else if (level === "warn" || verbose || level === "step") console.log(line);
    else console.log(line);
    if (file) {
      try {
        fs.appendFileSync(file, `${line}\n`, "utf8");
      } catch {
        /* logging must never break the pipeline */
      }
    }
  }

  return {
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
    step: (message, extra) => emit("step", message, extra),
    debug: (message, extra) => {
      if (verbose) emit("debug", message, extra);
    },
    file,
  };
}
