// 请求落地（NN-step/llm/）测试：缓冲/flush、覆盖写、步骤内执行序编号、models 客户端成对记录
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRecorder } from "../../scripts/lib/io-record.mjs";
import { createModelClient } from "../../scripts/lib/models.mjs";
import { tempDir } from "./helpers.mjs";

/** 模拟 <article>/NN-step：调用留痕写进步骤目录内的 llm/。 */
function stepDir(prefix, nn) {
  const article = tempDir(prefix);
  const dir = path.join(article, `${nn}-step`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readLog(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "llm", name), "utf8"));
}

function logFiles(dir) {
  const llm = path.join(dir, "llm");
  return fs.existsSync(llm) ? fs.readdirSync(llm) : [];
}

test("recorder buffers until setStepDir, then flushes request+response pairs into NN-step/llm/", () => {
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

test("带 slot 的记录按 步骤内执行序-label(_F) 编号，编号随实际调用顺序递增", () => {
  const dir = stepDir("wa-rec-slot-", "03");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  recorder.record({ label: "length-condense", slot: "03", provider: "ollama", model: "t", request: {}, response: "a" });
  recorder.record({ label: "score", slot: "05", provider: "ollama", model: "t", request: {}, response: "b" });
  recorder.record({ label: "length-condense", slot: "03", provider: "ollama", model: "t", request: {}, response: "c" }); // 下一轮
  recorder.record({ label: "score", slot: "05", provider: "ollama", model: "t", request: {}, response: "d" });
  recorder.record({ label: "correct-fallback", slot: "04", fallback: true, provider: "ollama", model: "t", request: {}, response: "e" });
  assert.deepEqual(logFiles(dir).sort(), [
    "1-length-condense.t.json",
    "2-score.t.json",
    "3-length-condense.t.json",
    "4-score.t.json",
    "5-correct-fallback_F.t.json",
  ]);
  const rec = readLog(dir, "3-length-condense.t.json");
  assert.equal(rec.step, "03");
  assert.equal(rec.slot, "03");
  assert.equal(rec.label, "length-condense");

  // 换到另一步骤目录：编号在新步骤内从 1 重新计
  const dir2 = stepDir("wa-rec-slot2-", "05");
  recorder.setStepDir(dir2);
  recorder.record({ label: "illustrate", slot: "01", provider: "ollama", model: "t", request: {}, response: "f" });
  assert.deepEqual(logFiles(dir2), ["1-illustrate.t.json"]);
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
    const config = { models: { "llm.t": { provider: "ollama", base_url: "http://x", model: "t" } } };
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
    assert.equal(fs.existsSync(path.join(dir, "llm", "mock.label.mock.json")), false);
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
    const client = createModelClient({ models: { "llm.t": { provider: "ollama", base_url: "http://x", model: "t" } } }, null, null);
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
