// API 调用落地：每次外部调用（大模型 + 非模型服务）把 request + response 成对写进 <文章>/NN-step/api/子步骤号_轮次(尝试)-label(_F).<服务>.json。
//
// 规则（2026-10-23 确认）：
//   - 调用留痕放回所属步骤目录：<stepDir>/api/，**步骤号由目录名（NN-step）提供，不进文件名**；
//   - 文件名 `子步骤号_轮次(尝试)-label(_F).<服务>.json`：
//       子步骤号 = 该调用在本步骤内的固定序号（入口 API_SLOT 的 id，去零填充），跨运行稳定，
//         与执行顺序一致：03-step 里 1=错别字 2=敏感词 3=修正 4=评稿 5=判定 → `3_1-revise`、`4_1-score`；
//       轮次 = 流程循环次数：该子步骤在本步骤内第几次「逻辑调用」（attempt=1 时递增，
//         如 2_1-revise → 2_2-revise）；按 label 计数，换模型/换 provider 不重置；
//       尝试 = 单次调用内的重复（校验失败重试/升级二判/重试请求），>1 时以 (N) 标注：2_1(2)-revise，
//         由调用方传 attempt（缺省 1），是本次调用自己的重试序号；轮次不变；
//         编号全程来自进程内计数器与调用方入参，不扫描已有文件名；
//     label = 代码固化的调用名（topic/outline/revise/score/review_check/correct…），同一步骤内不重复；
//     服务段 = 模型名（`qwen3.5_9b`），非模型 API 没有模型时退回 provider（`correct-cn`）；
//     降级兜底调用尾部标 `_F`；slot 省略时退回旧命名 `<label>.<服务>.json`（不编号）；
//   - 文件名不带时间戳，重跑覆盖同路径（同步骤调用次数变少时旧的高编号文件可能残留，属预期）；
//   - 只记逻辑请求体（模型、提示词、参数、查询文本）与原始响应文本，
//     **绝不落鉴权信息：请求 URL 里的 key/token、header、Authorization、API key 一律不写**；
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
    // 服务段：模型调用用模型名，非模型 API（核稿/配图/邮件…）没有模型时用 provider
    const service = safeName(rec.model || rec.provider);
    if (!rec.slot) return [safeName(rec.label), service].filter(Boolean).join(".") + ".json";
    // 主号 = 子步骤号（API_SLOT 固化 id，去零填充）；轮次 = 该子步骤在本步骤内第几次逻辑调用
    // （attempt=1 时递增，按 label 计数；换模型不重置）；attempt > 1 = 单次调用内的重复，
    // 由调用方传入本次调用的重试序号，(N) 标注、轮次不变。
    const label = safeName(rec.label);
    const digits = String(rec.slot).replace(/\D/g, "");
    const sub = safeName(digits ? String(Number(digits)) : rec.slot);
    const key = `${step}|${sub}|${label}|${rec.fallback ? "F" : ""}`;
    const attempt = Math.max(1, Number(rec.attempt) || 1);
    const state = counters.get(key) || { round: 0 };
    if (attempt === 1) state.round += 1;
    else if (state.round === 0) state.round = 1;
    counters.set(key, state);
    const minor = attempt > 1 ? `${state.round}(${attempt})` : String(state.round);
    const stem = `${sub}_${minor}-${label}${rec.fallback ? "_F" : ""}`;
    return [stem, service].filter(Boolean).join(".") + ".json";
  }

  function write(rec) {
    if (!stepDir) return;
    const dir = path.join(stepDir, "api");
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
     * 调用留痕落 <NN-step>/api/，之前缓冲的记录立即落盘。
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
