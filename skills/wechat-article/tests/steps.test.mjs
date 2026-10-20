import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadSteps,
  normalizeSteps,
  normalizeModel,
  parseHandler,
  getStep,
  stepNames,
  resolveStep,
  resolveStepPrompt,
  validateSteps,
  formatModelLabel,
} from "../scripts/lib/steps.mjs";

const STEPS_FILE = "skills/wechat-article/config/steps.yaml";

function inlineSteps(steps, defaults = {}) {
  return normalizeSteps({
    version: 1,
    defaults: {
      retry_limit: 2,
      timeout: 600000,
      model: { PROVIDER: "ollama", BASE_URL: "http://local", MODEL_NAME: "base-model" },
      ...defaults,
    },
    steps,
  });
}

test("steps.yaml lists the full pipeline in execution order", () => {
  const steps = loadSteps(STEPS_FILE);
  assert.equal(steps.steps.length, 13);
  assert.deepEqual(stepNames(steps), [
    "classify_type",
    "select_topic",
    "gather_materials",
    "outline",
    "bundle_draft_input",
    "draft_writing",
    "length_adjust",
    "review",
    "scoring",
    "revision",
    "image_generation",
    "publish",
    "archive",
  ]);
  assert.equal(getStep(steps, "classify_type").model.provider, "systemone");
  assert.equal(getStep(steps, "classify_type").model.endpoint, "/v1/systemone");
  assert.equal(getStep(steps, "gather_materials").model.provider, "none");
  assert.equal(getStep(steps, "image_generation").model.provider, "image");
});

test("real steps.yaml passes validation", () => {
  const steps = loadSteps(STEPS_FILE);
  const report = validateSteps(steps);
  assert.deepEqual(report.errors, []);
});

test("model fields inherit defaults and per-step overrides win", () => {
  const steps = inlineSteps([
    {
      step_name: "draft_writing",
      handler: "builtin:write_draft",
      model: { MODEL_NAME: "large-model", temperature: 0.3 },
    },
  ]);
  const model = getStep(steps, "draft_writing").model;
  assert.equal(model.provider, "ollama");
  assert.equal(model.base_url, "http://local");
  assert.equal(model.model_name, "large-model");
  assert.equal(model.temperature, 0.3);
});

test("provider: none drops inherited model fields", () => {
  const steps = inlineSteps([
    { step_name: "bundle", handler: "builtin:bundle", model: { PROVIDER: "none" } },
  ]);
  assert.deepEqual(getStep(steps, "bundle").model, { provider: "none" });
});

test("opencode provider keeps command and agent", () => {
  const steps = inlineSteps([
    {
      step_name: "review",
      handler: "builtin:review",
      model: { PROVIDER: "opencode", AGENT: "wechat-article-writer", MODEL_NAME: "" },
    },
  ]);
  const model = getStep(steps, "review").model;
  assert.equal(model.provider, "opencode");
  assert.equal(model.command, "opencode");
  assert.equal(model.agent, "wechat-article-writer");
  assert.equal(formatModelLabel(model), "opencode:wechat-article-writer");
});

test("parseHandler accepts builtin, script and HTTP forms", () => {
  const builtin = parseHandler("builtin:select_topic");
  assert.equal(builtin.kind, "builtin");
  assert.equal(builtin.entry, "select_topic");

  const script = parseHandler("scripts/steps/topic.mjs", "D:/repo");
  assert.equal(script.kind, "script");
  assert.equal(script.path, path.resolve("D:/repo", "scripts/steps/topic.mjs"));

  const http = parseHandler("https://example.com/api/step");
  assert.equal(http.kind, "http");
  assert.equal(http.url, "https://example.com/api/step");

  const object = parseHandler({ kind: "http", url: "https://example.com/x" });
  assert.equal(object.kind, "http");
});

test("type prompt overrides beat steps.yaml defaults", () => {
  const steps = inlineSteps([
    {
      step_name: "draft_writing",
      handler: "builtin:write_draft",
      prompt: { system: "default-system", user: "default-user" },
    },
  ]);
  const type = {
    id: "ai-news",
    steps: { draft_writing: { prompt: { system: "type-system" } } },
    prompts: { draft_extra: "type-extra" },
  };
  const prompt = resolveStepPrompt("draft_writing", { steps, type });
  assert.equal(prompt.system, "type-system");
  assert.equal(prompt.user, "default-user");
  assert.equal(prompt.extra, "type-extra");
});

test("resolveStep merges type-level model, timeout and retry", () => {
  const steps = inlineSteps([
    { step_name: "scoring", handler: "builtin:score", timeout: 5000, retry_limit: 2 },
  ]);
  const resolved = resolveStep("scoring", {
    steps,
    type: {
      id: "ai-news",
      steps: { scoring: { model: { MODEL_NAME: "judge-model" }, timeout: 9000, retry_limit: 0 } },
    },
  });
  assert.equal(resolved.model.model_name, "judge-model");
  assert.equal(resolved.model.provider, "ollama");
  assert.equal(resolved.timeout, 9000);
  assert.equal(resolved.retry_limit, 0);
});

test("normalizeModel resolves named profiles", () => {
  const profile = normalizeModel("large", {}, {
    large: { PROVIDER: "ollama", BASE_URL: "http://x", MODEL_NAME: "35b" },
  });
  assert.equal(profile.model_name, "35b");
  assert.equal(profile.base_url, "http://x");
});

test("validateSteps catches duplicates, bad handlers and unknown deps", () => {
  const steps = inlineSteps([
    { step_name: "a", handler: "builtin:first", depends_on: ["ghost"] },
    { step_name: "a", handler: "nope", timeout: 0 },
  ]);
  const report = validateSteps(steps);
  assert.ok(report.errors.some((line) => line.includes("步骤名重复")));
  assert.ok(report.errors.some((line) => line.includes("依赖了不存在的步骤")));
  assert.ok(report.errors.some((line) => line.includes("timeout")));
});

test("validateSteps warns about unknown type overrides", () => {
  const steps = inlineSteps([{ step_name: "draft_writing", handler: "builtin:draft" }]);
  const report = validateSteps(steps, { types: [{ id: "ai-news", steps: { ghost: {} } }] });
  assert.ok(report.warnings.some((line) => line.includes("未知步骤")));
});

test("loadSteps expands environment variables in model fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-steps-"));
  const file = path.join(dir, "steps.yaml");
  const previous = process.env.WA_STEPS_TEST_MODEL;
  process.env.WA_STEPS_TEST_MODEL = "env-model";
  try {
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "defaults:",
        "  model:",
        "    PROVIDER: ollama",
        '    BASE_URL: "http://env"',
        '    MODEL_NAME: "${WA_STEPS_TEST_MODEL:-fallback}"',
        "steps:",
        "  - step_name: demo",
        "    handler: builtin:demo",
        "",
      ].join("\n"),
    );
    const steps = loadSteps(file);
    assert.equal(getStep(steps, "demo").model.model_name, "env-model");
  } finally {
    if (previous === undefined) delete process.env.WA_STEPS_TEST_MODEL;
    else process.env.WA_STEPS_TEST_MODEL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
