// 调用落地（NN-step/api/）测试：缓冲/flush、覆盖写、子步骤号+label 编号、非模型 API 用 provider、models 客户端成对记录
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRecorder } from "../../scripts/lib/io-record.mjs";
import { createModelClient } from "../../scripts/lib/models.mjs";
import { tempDir } from "./helpers.mjs";

/** 模拟 <article>/NN-step：调用留痕写进步骤目录内的 api/。 */
function stepDir(prefix, nn) {
  const article = tempDir(prefix);
  const dir = path.join(article, `${nn}-step`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * ollama 端点参数：字段集合与 config/models.yaml 的 llm.* 一致——models.mjs 不再留
 * 代码副本（timeout/temperature/num_ctx/max_tokens/stream_idle_ms 缺一个就抛错点名配置）。
 */
const OLLAMA_PROFILE = {
  provider: "ollama",
  base_url: "http://x",
  model: "t",
  timeout_ms: 600000,
  temperature: 0.7,
  num_ctx: 32768,
  max_tokens: 4096,
  stream_idle_ms: 120000,
};

function readLog(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "api", name), "utf8"));
}

function logFiles(dir) {
  const api = path.join(dir, "api");
  return fs.existsSync(api) ? fs.readdirSync(api) : [];
}

test("recorder buffers until setStepDir, then flushes request+response pairs into NN-step/api/", () => {
  const dir = stepDir("wa-rec-", "01");
  const recorder = createRecorder();
  recorder.record({ label: "topic.select_best", provider: "systemone", model: "tev1", request: { a: 1 }, response: "r1", duration_ms: 5 });
  assert.deepEqual(logFiles(dir), []);
  recorder.setStepDir(dir);
  const rec = readLog(dir, "topic.select_best.tev1.json");
  assert.equal(rec.request.a, 1);
  assert.equal(rec.response, "r1");
  assert.equal(rec.error, undefined);
  assert.equal(rec.step, "01");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("recorder overwrites same label+model and ignores key material", () => {
  const dir = stepDir("wa-rec3-", "01");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  recorder.record({ label: "x", provider: "openai", model: "m", request: { prompt: "第一版" }, response: "a" });
  recorder.record({ label: "x", provider: "openai", model: "m", request: { prompt: "第二版" }, response: "b" });
  assert.deepEqual(logFiles(dir), ["x.m.json"]);
  assert.equal(readLog(dir, "x.m.json").request.prompt, "第二版");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("带 slot 的记录按 子步骤号_轮次(尝试)-label(_F) 编号：主号=步骤内固定子步骤号，轮次=逻辑调用，尝试=单次调用内重复", () => {
  const dir = stepDir("wa-rec-slot-", "03");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  // 03 步的子步骤：1=核稿（正常走 correct-api，只有 LLM 兜底才留痕）2=修正 3=评稿 4=判定
  recorder.record({ label: "correct-fallback", slot: "01", fallback: true, provider: "ollama", model: "t", request: {}, response: "a" });
  recorder.record({ label: "revise", slot: "02", provider: "ollama", model: "t", request: {}, response: "b" });
  recorder.record({ label: "revise", slot: "02", attempt: 2, provider: "ollama", model: "t", request: {}, response: "b2" }); // 同一轮字数不合格重试
  recorder.record({ label: "score", slot: "03", provider: "ollama", model: "t", request: {}, response: "c" });
  recorder.record({ label: "revise", slot: "02", provider: "ollama", model: "t", request: {}, response: "d" }); // 下一轮
  recorder.record({ label: "score", slot: "03", provider: "ollama", model: "t", request: {}, response: "e" });
  recorder.record({ label: "review_check", slot: "04", provider: "systemone", model: "t", request: {}, response: "f" });
  assert.deepEqual(logFiles(dir).sort(), [
    "1_1-correct-fallback_F.t.json",
    "2_1(2)-revise.t.json",
    "2_1-revise.t.json",
    "2_2-revise.t.json",
    "3_1-score.t.json",
    "3_2-score.t.json",
    "4_1-review_check.t.json",
  ]);
  const rec = readLog(dir, "2_2-revise.t.json");
  assert.equal(rec.step, "03"); // 步骤号只进 JSON / 目录，不进文件名
  assert.equal(rec.slot, "02");
  assert.equal(rec.label, "revise");
  assert.equal(readLog(dir, "2_1(2)-revise.t.json").response, "b2");

  // 换到另一步骤目录：子步骤号各自独立，轮次在新步骤内从 1 重新计
  const dir2 = stepDir("wa-rec-slot2-", "05");
  recorder.setStepDir(dir2);
  recorder.record({ label: "illustrate", slot: "01", provider: "ollama", model: "t", request: {}, response: "g" });
  assert.deepEqual(logFiles(dir2), ["1_1-illustrate.t.json"]);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.rmSync(path.dirname(dir2), { recursive: true, force: true });
});

test("createModelClient records ollama request+response and error paths", async () => {
  const dir = stepDir("wa-rec4-", "02");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  const restore = globalThis.fetch;
  try {
    // ollama 走流式：stub 返回 NDJSON chunk 流（每 chunk 一段 content）
    const streamBody = (...lines) => {
      const encoder = new TextEncoder();
      const chunks = lines.map((line) => encoder.encode(line));
      let i = 0;
      return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) };
    };
    globalThis.fetch = async (url, init) => {
      if (init.body.includes("boom")) return { ok: false, status: 500, text: async () => "kaboom" };
      return {
        ok: true,
        status: 200,
        body: streamBody(
          '{"message":{"role":"assistant","content":"答复"},"done":false}\n',
          '{"message":{"content":"内容"},"done":true}\n',
        ),
      };
    };
    const config = { models: { "llm.t": OLLAMA_PROFILE } };
    const client = createModelClient(config, null, recorder);
    const text = await client.complete("llm.t", { prompt: "你好", label: "outline.build" });
    assert.equal(text, "答复内容");
    const rec = readLog(dir, "outline.build.t.json");
    assert.equal(rec.provider, "ollama");
    assert.equal(rec.request.prompt, "你好");
    assert.equal(rec.response, "答复内容");
    assert.equal(rec.duration_ms >= 0, true);

    await assert.rejects(client.complete("llm.t", { prompt: "boom", label: "outline.build" }));
    const errRec = readLog(dir, "outline.build.t.json");
    assert.match(errRec.error, /HTTP 500/);
    assert.equal(errRec.response, "");

    // mock provider 不落盘
    const mockClient = createModelClient({ models: { "llm.m": { provider: "mock" } } }, null, recorder);
    await mockClient.complete("llm.m", { prompt: "p", label: "mock.label" });
    assert.equal(fs.existsSync(path.join(dir, "api", "mock.label.mock.json")), false);
  } finally {
    globalThis.fetch = restore;
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("jsonValidated retries with failure reasons prepended, then throws when exhausted", async () => {
  const restore = globalThis.fetch;
  try {
    const streamBody = (content) => {
      const encoder = new TextEncoder();
      let sent = false;
      return {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: encoder.encode(`{"message":{"content":${JSON.stringify(content)}},"done":true}\n`) };
          },
        }),
      };
    };
    const schema = { title: "string", sections: ["array", 1], "sections[].heading": "string" };
    const responses = [
      '{"title":"甲"}', // 缺 sections → 硬错误
      '{"title":"甲","sections":[{"heading":"一"}]}', // 修复成功
    ];
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body).messages.at(-1).content);
      return { ok: true, status: 200, body: streamBody(responses.shift() ?? '{"note":1}') };
    };
    const client = createModelClient({ models: { "llm.t": OLLAMA_PROFILE } }, null, null);
    const result = await client.jsonValidated("llm.t", { prompt: "原始提示词", schema, label: "outline" });
    assert.deepEqual(result.sections, [{ heading: "一" }]);
    assert.equal(bodies.length, 2);
    // 修复重试：失败原因加在原提示词前部（改文本才能避开网关缓存命中）
    assert.match(bodies[1], /^## 上次输出未通过校验/);
    assert.match(bodies[1], /sections 缺失/);
    assert.match(bodies[1], /\n\n原始提示词$/);

    // attempts 用尽仍失败 → throw，错误里带最后一次失败原因
    globalThis.fetch = async (url, init) => ({ ok: true, status: 200, body: streamBody('{"title":"只有标题"}') });
    await assert.rejects(
      client.jsonValidated("llm.t", { prompt: "p", schema, label: "outline", attempts: 2 }),
      /outline 输出校验失败：.*sections 缺失/,
    );
  } finally {
    globalThis.fetch = restore;
  }
});

test("端点参数单源 config/models.yaml：缺字段抛错点名，不静默用代码里的副本", async () => {
  const incomplete = { ...OLLAMA_PROFILE };
  delete incomplete.temperature;
  const client = createModelClient({ models: { "llm.t": incomplete } }, null, null);
  await assert.rejects(client.complete("llm.t", { prompt: "p" }), /模型 llm\.t 缺少 temperature：config\/models\.yaml/);
  // 调用方必须点名模型：这里不兜 llm.local，否则配置想指 35b、代码悄悄用 9b
  await assert.rejects(client.complete(undefined, { prompt: "p" }), /模型调用没有指定模型 id/);
});

test("非模型 API 调用（核稿/配图/邮件）同样落 api/：无 model 时服务段用 provider，轮次按 label 连续计", () => {
  const dir = stepDir("wa-rec-api-", "03");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  recorder.record({ label: "correct", slot: "01", provider: "correct-cn", request: { text: "在坐" }, response: '{"has_issues":true}' });
  recorder.record({ label: "correct", slot: "01", attempt: 2, provider: "correct-cn", request: { text: "在坐" }, error: "HTTP 500" });
  recorder.record({ label: "illustrate", slot: "01", provider: "modelscope", request: { index: 1 }, response: "01_modelscope.png" });
  recorder.record({ label: "illustrate", slot: "01", provider: "pollinations", request: { index: 1 }, response: "01_pollinations.png" });
  recorder.record({ label: "illustrate", slot: "01", provider: "modelscope", request: { index: 2 }, response: "02_modelscope.png" });
  assert.deepEqual(logFiles(dir).sort(), [
    "1_1(2)-correct.correct-cn.json",
    "1_1-correct.correct-cn.json",
    "1_1-illustrate.modelscope.json",
    "1_2-illustrate.pollinations.json",
    "1_3-illustrate.modelscope.json",
  ]);
  assert.equal(readLog(dir, "1_1-correct.correct-cn.json").request.text, "在坐");
  assert.equal(readLog(dir, "1_1(2)-correct.correct-cn.json").error, "HTTP 500");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("轮次按 label 计数：同一调用跨轮次换模型不重置，尝试号跟随该轮次", () => {
  const dir = stepDir("wa-rec-rounds-", "03");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  recorder.record({ label: "revise", slot: "03", provider: "ollama", model: "qwen3.5_9b", request: { round: 1 }, response: "第1轮" });
  recorder.record({ label: "revise", slot: "03", provider: "ollama", model: "qwen3.6_35b", request: { round: 2 }, response: "第2轮" });
  recorder.record({ label: "revise", slot: "03", attempt: 2, provider: "ollama", model: "qwen3.6_35b", request: { round: 2, retry: true }, response: "第2轮重试" });
  recorder.record({ label: "revise", slot: "03", provider: "ollama", model: "qwen3.6_35b", request: { round: 3 }, response: "第3轮" });
  assert.deepEqual(logFiles(dir).sort(), [
    "3_1-revise.qwen3.5_9b.json",
    "3_2(2)-revise.qwen3.6_35b.json",
    "3_2-revise.qwen3.6_35b.json",
    "3_3-revise.qwen3.6_35b.json",
  ]);
  assert.equal(readLog(dir, "3_2(2)-revise.qwen3.6_35b.json").request.retry, true);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("编号来自进程内计数器而非已有文件名：新 recorder 重跑同一目录从 1 开始并覆盖", () => {
  const dir = stepDir("wa-rec-fresh-", "03");
  const first = createRecorder();
  first.setStepDir(dir);
  first.record({ label: "revise", slot: "03", provider: "ollama", model: "t", request: { run: 1 }, response: "旧" });
  first.record({ label: "revise", slot: "03", attempt: 2, provider: "ollama", model: "t", request: { run: 1, retry: true }, response: "旧重试" });
  assert.deepEqual(logFiles(dir).sort(), ["3_1(2)-revise.t.json", "3_1-revise.t.json"]);

  // 新进程/新 recorder 不扫描目录里已有的 3_1、3_1(2)：轮次和尝试都重新从 1 起，同名覆盖。
  const second = createRecorder();
  second.setStepDir(dir);
  second.record({ label: "revise", slot: "03", provider: "ollama", model: "t", request: { run: 2 }, response: "新" });
  assert.deepEqual(logFiles(dir).sort(), ["3_1(2)-revise.t.json", "3_1-revise.t.json"]);
  assert.equal(readLog(dir, "3_1-revise.t.json").request.run, 2);
  assert.equal(readLog(dir, "3_1-revise.t.json").response, "新");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
