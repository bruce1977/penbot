import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir } from "./fsx.mjs";

/**
 * Unified text model interface.
 *
 * Profiles come from config.models:
 *   { provider: "ollama" | "openai" | "opencode" | "mock", ... }
 *
 * All calls return plain text. JSON calls parse the first JSON value found.
 */
export function createModelClient(config, logger) {
  const cache = new Map();

  function getProfile(name) {
    const id = name || config.defaults?.model || "local";
    if (cache.has(id)) return cache.get(id);
    const raw = config.models?.[id];
    if (!raw) throw new Error(`Unknown model profile "${id}"`);
    const profile = { id, timeout_ms: 300000, temperature: 0.7, ...raw };
    // BASE_URL / MODEL_NAME / API_KEY may arrive under either spelling.
    profile.base_url = profile.base_url || profile.baseUrl || "";
    profile.model = profile.model || profile.model_name || profile.modelName || "";
    profile.api_key = profile.api_key || profile.apiKey || "";
    cache.set(id, profile);
    return profile;
  }

  async function complete(profileName, { system, prompt, format, temperature, maxTokens, label }) {
    const profile = getProfile(profileName);
    const started = Date.now();
    logger?.debug(`model ${profile.id} (${profile.provider}) -> ${label || "text"}`);
    let text;
    switch (profile.provider) {
      case "mock":
        text = mockResponse(prompt, format);
        break;
      case "ollama":
        text = await callOllama(profile, { system, prompt, format, temperature, maxTokens });
        break;
      case "openai":
        text = await callOpenAI(profile, { system, prompt, temperature, maxTokens, format });
        break;
      case "opencode":
        text = await callOpencode(profile, { system, prompt, label });
        break;
      default:
        throw new Error(`Unsupported model provider: ${profile.provider}`);
    }
    logger?.debug(`model ${profile.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars`);
    return text;
  }

  async function json(profileName, options) {
    const text = await complete(profileName, { ...options, format: "json" });
    return parseJsonFromText(text);
  }

  return { complete, json, getProfile };
}

async function callOllama(profile, { system, prompt, format, temperature, maxTokens }) {
  const base = (profile.base_url || "http://localhost:11434").replace(/\/+$/, "");
  const body = {
    model: profile.model,
    stream: false,
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
  const timer = setTimeout(() => controller.abort(), profile.timeout_ms || 300000);
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
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`Ollama returned empty content (model=${profile.model})`);
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(profile, { system, prompt, temperature, maxTokens, format }) {
  const base = (profile.base_url || "").replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base)
    ? base
    : base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
  const body = {
    model: profile.model,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    temperature: temperature ?? profile.temperature ?? 0.7,
    max_tokens: maxTokens ?? profile.max_tokens ?? 4096,
  };
  if (format === "json") body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeout_ms || 300000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (typeof content !== "string" || !content.trim()) throw new Error("OpenAI-compatible API returned empty content");
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
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
