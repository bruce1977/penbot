// LLM/API 请求落地：每次调用把 request + response 成对写进 NN-step/llm/<label>.<model>.json。
//
// 规则（2026-10-21 确认）：
//   - 文件名不带时间戳，同 label+model 重复写覆盖；
//   - 只记逻辑请求体（模型、提示词、参数）与原始响应文本，绝不落 URL header / API key；
//   - 文章目录建立前先缓冲，setStepDir 指向 NN-step 后统一 flush；
//   - 调用方不传 recorder 时行为与没有本模块完全一致。
import path from "node:path";
import { ensureDir, writeJson } from "./fsx.mjs";

const MAX_PENDING = 500;

function safeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 60);
}

export function createRecorder() {
  let stepDir = null;
  const pending = [];

  function write(rec) {
    if (!stepDir) return;
    const dir = ensureDir(path.join(stepDir, "llm"));
    const name = [safeName(rec.label), safeName(rec.model)].filter(Boolean).join(".") + ".json";
    writeJson(path.join(dir, name), {
      ts: rec.ts || new Date().toISOString(),
      label: rec.label,
      provider: rec.provider,
      model: rec.model,
      duration_ms: rec.duration_ms,
      request: rec.request,
      response: rec.response,
      error: rec.error,
    });
  }

  return {
    /** 切换当前步骤目录（如 <article>/01-step）；之前缓冲的记录立即落盘。 */
    setStepDir(dir) {
      stepDir = dir || null;
      if (stepDir) {
        while (pending.length) write(pending.shift());
      }
    },
    record(rec) {
      if (!rec || !rec.label) return;
      if (stepDir) write(rec);
      else if (pending.length < MAX_PENDING) pending.push(rec);
    },
  };
}
