// 请求落地（NN-step/llm/）测试：缓冲/flush、覆盖写、models 客户端成对记录
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRecorder } from "../scripts/lib/io-record.mjs";
import { createModelClient } from "../scripts/lib/models.mjs";
import { tempDir } from "./helpers.mjs";

function readRecord(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "llm", name), "utf8"));
}

test("recorder buffers until setStepDir, then flushes request+response pairs", () => {
  const dir = tempDir("wa-rec-");
  const recorder = createRecorder();
  recorder.record({ label: "topic.select_best", provider: "systemone", model: "tev1", request: { a: 1 }, response: "r1", duration_ms: 5 });
  assert.equal(fs.existsSync(path.join(dir, "llm")), false);
  recorder.setStepDir(dir);
  const rec = readRecord(dir, "topic.select_best.tev1.json");
  assert.equal(rec.request.a, 1);
  assert.equal(rec.response, "r1");
  assert.equal(rec.error, undefined);
  // 目录切走后继续直写新目录
  const dir2 = tempDir("wa-rec2-");
  recorder.setStepDir(dir2);
  recorder.record({ label: "draft", provider: "ollama", model: "qwen3.5:9b", request: {}, response: "text" });
  assert.ok(fs.existsSync(path.join(dir2, "llm", "draft.qwen3.5_9b.json")));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("recorder overwrites same label+model and ignores key material", () => {
  const dir = tempDir("wa-rec3-");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  recorder.record({ label: "x", provider: "openai", model: "m", request: { prompt: "第一版" }, response: "a" });
  recorder.record({ label: "x", provider: "openai", model: "m", request: { prompt: "第二版" }, response: "b" });
  const files = fs.readdirSync(path.join(dir, "llm"));
  assert.deepEqual(files, ["x.m.json"]);
  assert.equal(readRecord(dir, "x.m.json").request.prompt, "第二版");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createModelClient records ollama request+response and error paths", async () => {
  const dir = tempDir("wa-rec4-");
  const recorder = createRecorder();
  recorder.setStepDir(dir);
  const restore = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      if (init.body.includes("boom")) return { ok: false, status: 500, text: async () => "kaboom" };
      return { ok: true, status: 200, json: async () => ({ message: { content: "答复内容" } }) };
    };
    const config = { models: { "llm.t": { provider: "ollama", base_url: "http://x", model: "t" } } };
    const client = createModelClient(config, null, recorder);
    const text = await client.complete("llm.t", { prompt: "你好", label: "outline.build" });
    assert.equal(text, "答复内容");
    const rec = readRecord(dir, "outline.build.t.json");
    assert.equal(rec.provider, "ollama");
    assert.equal(rec.request.prompt, "你好");
    assert.equal(rec.response, "答复内容");
    assert.equal(rec.duration_ms >= 0, true);

    await assert.rejects(client.complete("llm.t", { prompt: "boom", label: "outline.build" }));
    const errRec = readRecord(dir, "outline.build.t.json");
    assert.match(errRec.error, /HTTP 500/);
    assert.equal(errRec.response, "");

    // mock provider 不落盘
    const mockClient = createModelClient({ models: { "llm.m": { provider: "mock" } } }, null, recorder);
    await mockClient.complete("llm.m", { prompt: "p", label: "mock.label" });
    assert.equal(fs.existsSync(path.join(dir, "llm", "mock.label.mock.json")), false);
  } finally {
    globalThis.fetch = restore;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
