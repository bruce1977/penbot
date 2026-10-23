// LLM/API 请求落地：每次调用把 request + response 成对写进 <文章>/NN-step/llm/M-label(_F).<model>.json。
//
// 规则（2026-10-22 确认）：
//   - 调用留痕放回所属步骤目录：<stepDir>/llm/，步骤号由目录名（NN-step）自带；
//   - 文件名 `M-label(_F).<model>.json`：M = 本步骤内实际执行顺序的递增编号
//     （第 1 次调用 1-，重试/下一轮依次 +1，直接可读先后次序）；label = 代码固化的
//     调用名（LLM_SLOT：topic/outline/draft/score…），slot 编号仍记在 JSON 的 slot 字段；
//     降级兜底调用尾部标 `_F`；slot 省略时退回旧命名 `<label>.<model>.json`（不编号）；
//   - 文件名不带时间戳，重跑覆盖同 M 编号（同步骤调用次数变少时旧的高编号文件可能残留，属预期）；
//   - 只记逻辑请求体（模型、提示词、参数）与原始响应文本，绝不落 URL header / API key；
//   - 步骤目录建立前先缓冲，setStepDir 后统一 flush；
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

/** 从 `NN-step` 目录名解析步骤号；解析不出返回空。 */
function stepFromDir(dir) {
  const match = /(\d{2})-step$/i.exec(path.basename(String(dir || "")));
  return match ? match[1] : "";
}

export function createRecorder() {
  let stepDir = null;
  let step = "";
  const pending = [];
  const counters = new Map();

  function fileName(rec) {
    const model = safeName(rec.model);
    if (!rec.slot) return [safeName(rec.label), model].filter(Boolean).join(".") + ".json";
    // 编号按「步骤内执行顺序」递增：同一步骤所有调用共享一个计数器。
    const minor = (counters.get(step) || 0) + 1;
    counters.set(step, minor);
    const stem = `${minor}-${safeName(rec.label)}${rec.fallback ? "_F" : ""}`;
    return [stem, model].filter(Boolean).join(".") + ".json";
  }

  function write(rec) {
    if (!stepDir) return;
    const dir = path.join(stepDir, "llm");
    ensureDir(dir);
    writeJson(path.join(dir, fileName(rec)), {
      ts: rec.ts || new Date().toISOString(),
      step: step || undefined,
      label: rec.label,
      slot: rec.slot || undefined,
      fallback: rec.fallback || undefined,
      provider: rec.provider,
      model: rec.model,
      duration_ms: rec.duration_ms,
      request: rec.request,
      response: rec.response,
      error: rec.error,
    });
  }

  return {
    /**
     * 切换当前步骤：<article>/NN-step（步骤号从目录名解析，或显式传 step）；
     * 调用留痕落 <NN-step>/llm/，之前缓冲的记录立即落盘。
     */
    setStepDir(dir, stepNumber) {
      const resolved = dir ? path.resolve(dir) : null;
      step = String(stepNumber || (resolved ? stepFromDir(resolved) : "") || "");
      stepDir = resolved || null;
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
