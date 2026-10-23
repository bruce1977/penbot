import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir } from "./fsx.mjs";
import { validateTemplateSchema } from "./template.mjs";

/**
 * Unified text model interface.
 *
 * Profiles come from config.models:
 *   { provider: "ollama" | "openai" | "opencode" | "mock", ... }
 *
 * All calls return plain text. JSON calls parse the first JSON value found.
 * LLM HTTP calls stream: Node fetch (undici) default headersTimeout/bodyTimeout
 * is 300s, and non-stream responses send no headers until generation finishes —
 * any call over 5 minutes would die with UND_ERR_HEADERS_TIMEOUT. Streaming also
 * gives a chunk gap guard (abort when data stalls > stream_idle_ms, default 120s),
 * so dead connections surface fast; profile.timeout_ms stays the overall cap.
 */
export function createModelClient(config, logger, recorder) {
  const cache = new Map();

  function getProfile(name) {
    const id = name || config.defaults?.model || "llm.local";
    if (cache.has(id)) return cache.get(id);
    let key = id;
    let raw = config.models?.[key];
    // 兼容旧写法：model: local → llm.local
    if (!raw && !String(id).includes(".")) {
      key = `llm.${id}`;
      raw = config.models?.[key];
    }
    if (!raw) throw new Error(`Unknown model id "${id}"`);
    const profile = { id: key, timeout_ms: 300000, temperature: 0.7, ...raw };
    // BASE_URL / MODEL_NAME / API_KEY may arrive under either spelling.
    profile.base_url = profile.base_url || profile.baseUrl || "";
    profile.model = profile.model || profile.model_name || profile.modelName || "";
    profile.api_key = profile.api_key || profile.apiKey || "";
    cache.set(id, profile);
    return profile;
  }

  async function complete(profileName, { system, prompt, format, temperature, maxTokens, timeout, label, slot, fallback }) {
    const profile = getProfile(profileName);
    const started = Date.now();
    logger?.debug(`model ${profile.id} (${profile.provider}) -> ${label || "text"}`);
    const record = (extra) => {
      // mock 不联网，没什么可审计的
      if (!recorder || profile.provider === "mock") return;
      recorder.record({
        label: label || profile.id,
        slot,
        fallback,
        provider: profile.provider,
        model: profile.model || profile.command || "mock",
        duration_ms: Date.now() - started,
        request: { system, prompt, format, temperature, max_tokens: maxTokens },
        ...extra,
      });
    };
    let text;
    try {
      switch (profile.provider) {
        case "mock":
          text = mockResponse(prompt, format);
          break;
        case "ollama":
          text = await callOllama(profile, { system, prompt, format, temperature, maxTokens, timeout });
          break;
        case "openai":
          text = await callOpenAI(profile, { system, prompt, temperature, maxTokens, format, timeout });
          break;
        case "opencode":
          text = await callOpencode(profile, { system, prompt, label });
          break;
        default:
          throw new Error(`Unsupported model provider: ${profile.provider}`);
      }
    } catch (error) {
      record({ response: "", error: error.message });
      throw error;
    }
    record({ response: text });
    logger?.debug(`model ${profile.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars`);
    return text;
  }

  async function json(profileName, options) {
    const text = await complete(profileName, { ...options, format: "json" });
    return parseJsonFromText(text);
  }

  /**
   * 带 schema 校验的 JSON 调用（schema = 紧凑 DSL，见 lib/template.mjs）。
   *   - 硬错误（字段缺失/类型不符/项数不足）→ 把失败原因加在原提示词前部重试；
   *     必须改动提示词文本，否则网关缓存会命中上次的错误输出原样返回。
   *     重试的区分交给 llm 日志的编号（NN-step/llm/M-label，M 按步骤内执行顺序递增）。
   *   - 越界 warnings 只记日志，不触发重试。
   *   - attempts 用尽仍失败 → throw，由调用方走既有降级路径。
   */
  async function jsonValidated(profileName, { system, prompt, schema, label, slot, attempts = 2, timeout, validate, temperature, maxTokens } = {}) {
    let failures = [];
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      const callLabel = `${label || profileName}${attempt > 1 ? `#retry${attempt - 1}` : ""}`;
      const callPrompt = failures.length
        ? `## 上次输出未通过校验，逐条改正后重新输出完整 JSON（字段名与类型必须与输出结构完全一致，不要只给片段）\n${failures
            .map((e, i) => `${i + 1}. ${e}`)
            .join("\n")}\n\n${prompt}`
        : prompt;
      const result = await json(profileName, { system, prompt: callPrompt, label, slot, timeout, temperature, maxTokens });
      const report = schema ? validateTemplateSchema(result, schema) : { ok: true, errors: [], warnings: [] };
      const errors = [...report.errors, ...(validate ? validate(result) || [] : [])];
      for (const warning of report.warnings) logger?.warn(`输出越界（${callLabel}）：${warning}`);
      if (errors.length === 0) return result;
      failures = errors;
      logger?.warn(`输出校验失败（${callLabel}）：${errors.join("；")}`);
    }
    throw new Error(`${label || profileName} 输出校验失败：${failures.join("；")}`);
  }

  return { complete, json, jsonValidated, getProfile };
}

/**
 * NDJSON 逐行解析：每行一个完整 JSON 对象（Ollama /api/chat 流式格式），
 * 每块数据到达都重置 idleMs 空闲计时（连接僵死快速报错），done:true 提前结束。
 * 返回 content 拼接文本；跨块边界的不完整行在流结束后尝试解析一次。
 */
async function readNdjsonContent(res, { idleMs }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let stalled = false;
  let idleTimer = null;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, idleMs);
  };
  const handle = (line) => {
    if (!line.trim()) return false;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof event?.message?.content === "string") content += event.message.content;
    return event?.done === true;
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stalled) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      let finished = false;
      for (const line of lines) {
        if (handle(line)) { finished = true; break; }
      }
      if (finished) break;
      arm();
    }
  } finally {
    clearTimeout(idleTimer);
  }
  if (stalled) throw new Error(`模型流式响应中断：${idleMs}ms 无数据（idle timeout）`);
  if (buffer) handle(buffer);
  return content;
}

async function callOllama(profile, { system, prompt, format, temperature, maxTokens, timeout }) {
  const cap = Number(timeout) > 0 ? Number(timeout) : profile.timeout_ms || 300000;
  const base = (profile.base_url || "http://localhost:11434").replace(/\/+$/, "");
  const body = {
    model: profile.model,
    stream: true,
    think: false,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    options: {
      temperature: temperature ?? profile.temperature ?? 0.7,
      num_ctx: profile.num_ctx || 32768,
      num_predict: maxTokens ?? profile.max_tokens ?? 4096,
    },
  };
  if (format === "json") body.format = "json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cap);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    const content = await readNdjsonContent(res, {
      idleMs: profile.stream_idle_ms || 120000,
    });
    if (!content.trim()) {
      throw new Error(`Ollama returned empty content (model=${profile.model})`);
    }
    return content.trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Ollama 请求超时（${cap}ms 总限时）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(profile, { system, prompt, temperature, maxTokens, format, timeout }) {
  const cap = Number(timeout) > 0 ? Number(timeout) : profile.timeout_ms || 300000;
  const base = (profile.base_url || "").replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base)
    ? base
    : base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
  const body = {
    model: profile.model,
    stream: true,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    temperature: temperature ?? profile.temperature ?? 0.7,
    max_tokens: maxTokens ?? profile.max_tokens ?? 4096,
  };
  if (format === "json") body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cap);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    const content = await readSseContent(res, { idleMs: profile.stream_idle_ms || 120000 });
    if (!content.trim()) throw new Error("OpenAI-compatible API returned empty content");
    return content.trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OpenAI 请求超时（${cap}ms 总限时）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** SSE 逐行解析（OpenAI chat completions 流式：`data: {...}`，[DONE] 结束）。 */
async function readSseContent(res, { idleMs }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let stalled = false;
  let idleTimer = null;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, idleMs);
  };
  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return true;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return false;
    }
    const delta = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.text;
    if (typeof delta === "string") content += delta;
    return false;
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stalled) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      let finished = false;
      for (const line of lines) {
        if (handle(line)) { finished = true; break; }
      }
      if (finished) break;
      arm();
    }
  } finally {
    clearTimeout(idleTimer);
  }
  if (stalled) throw new Error(`模型流式响应中断：${idleMs}ms 无数据（idle timeout）`);
  if (buffer) handle(buffer);
  return content;
}

/**
 * Call an agent CLI that prints the answer.
 *
 * Default: `opencode run --format json --file <prompt-file> <instruction>`.
 * The JSON event stream is parsed and concatenated text parts are returned.
 * Any other CLI can be configured via profile.command with {prompt_file}
 * placeholder, or it will receive the prompt on stdin.
 */
async function callOpencode(profile, { system, prompt, label }) {
  const command = profile.command || "opencode";
  const workdir = profile.workdir || process.cwd();
  const tempDir = ensureDir(path.join(os.tmpdir(), "penbot-wechat-article"));
  const promptFile = path.join(tempDir, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  const fullPrompt = system ? `# 系统指令\n\n${system}\n\n# 任务\n\n${prompt}` : prompt;
  fs.writeFileSync(promptFile, fullPrompt, "utf8");

  const args = [];
  const instruction = profile.instruction || `请完成附件 ${path.basename(promptFile)} 中的任务，严格按其中的输出格式返回，不要添加额外解释。`;
  if (profile.args && Array.isArray(profile.args)) {
    args.push(...profile.args.map((a) => String(a).replace("{prompt_file}", promptFile)));
    args.push(instruction);
  } else {
    args.push("run", "--format", "json", "--file", promptFile);
    if (profile.agent) args.push("--agent", profile.agent);
    if (profile.model) args.push("--model", profile.model);
    if (profile.auto !== false) args.push("--auto");
    args.push(instruction);
  }

  const started = Date.now();
  const result = await runProcess(command, args, {
    cwd: workdir,
    timeoutMs: profile.timeout_ms || 600000,
    stdin: profile.args ? prompt : undefined,
    env: { ...process.env, ...(profile.env || {}) },
  });

  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* ignore */
  }

  if (result.code !== 0) {
    throw new Error(`Agent CLI exited ${result.code}: ${(result.stderr || result.stdout).slice(0, 800)}`);
  }

  const text = extractAgentText(result.stdout);
  if (!text.trim()) {
    throw new Error(`Agent CLI returned no text (${label || "task"}), stdout: ${result.stdout.slice(0, 400)}`);
  }
  return text.trim();
}

/** Extract assistant text from `opencode run --format json` NDJSON, or raw text. */
export function extractAgentText(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return "";
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  if (lines.length === 0) return raw;

  const texts = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "text" && typeof event.part?.text === "string") {
        texts.push(event.part.text);
      } else if (event?.type === "error") {
        throw new Error(event.error?.message || "agent error event");
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return texts.length ? texts.join("\n") : raw;
}

function runProcess(command, args, { cwd, timeoutMs, stdin, env }) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    // Close stdin when we do not pipe input: some CLIs (e.g. `opencode run`)
    // block forever waiting for EOF on an open pipe.
    const stdio = stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = isWin
      ? spawn(command, args, { cwd, env, shell: true, windowsHide: true, stdio })
      : spawn(command, args, { cwd, env, windowsHide: true, stdio });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

/** Parse the first JSON object/array found in model output. */
export function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty model response");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean);
  for (const candidate of candidates) {
    const direct = tryJson(candidate);
    if (direct !== undefined) return direct;
    const start = candidate.search(/[[{]/);
    if (start !== -1) {
      const end = findMatching(candidate, start);
      if (end !== -1) {
        const parsed = tryJson(candidate.slice(start, end + 1));
        if (parsed !== undefined) return parsed;
      }
    }
  }
  throw new Error(`No JSON found in model response: ${raw.slice(0, 300)}`);
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function findMatching(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function mockResponse(prompt, format) {
  if (format === "json") {
    return JSON.stringify({
      title: "（Mock）示例文章",
      thesis: "这是 mock 模型返回的内容，用于在没有模型时验证脚本流程。",
      outline: [{ heading: "开篇", points: ["mock 要点一", "mock 要点二"] }],
      scores: {},
      issues: [],
      revised: "",
    });
  }
  return [
    "---",
    "title: （Mock）示例文章",
    "---",
    "",
    "这是 mock 模型生成的正文，用于验证管线脚本。",
    "",
    "[[img:1|一张用于验证流程的示意图]]",
    "",
    "## 第一节",
    "",
    "Mock 内容仅用于测试流程，不代表真实写作质量。",
    "",
  ].join("\n");
}
