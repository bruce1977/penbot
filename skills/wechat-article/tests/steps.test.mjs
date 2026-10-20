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
  assert.equal(steps.steps.length, 14);
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
    "de_ai",
    "image_generation",
    "publish",
    "archive",
  ]);
  assert.equal(getStep(steps, "classify_type").model.provider, "systemone");
  assert.equal(getStep(steps, "classify_type").model.endpoint, "/v1/systemone");
  assert.equal(getStep(steps, "gather_materials").model.provider, "none");
  assert.equal(getStep(steps, "de_ai").stage, "polish");
  assert.equal(getStep(steps, "de_ai").artifacts.writes[0], "06-polished.md");
  assert.equal(getStep(steps, "image_generation").model.provider, "none");
  assert.match(getStep(steps, "classify_type").source, /10-topic\.yaml$/);
  assert.match(getStep(steps, "de_ai").source, /50-revision\.yaml$/);
  assert.match(getStep(steps, "publish").source, /60-publish\.yaml$/);
});

test("real steps.yaml passes validation", () => {
  const steps = loadSteps(STEPS_FILE);
  const report = validateSteps(steps);
  assert.deepEqual(report.errors, []);
});

test("steps.yaml expands phase files, file overrides and inline steps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-phases-"));
  try {
    fs.writeFileSync(
      path.join(dir, "phase-a.yaml"),
      [
        "steps:",
        "  - step_name: a",
        "    handler: builtin:a",
        "  - step_name: b",
        "    handler: builtin:b",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "phase-b.yaml"),
      ["step_name: c", "handler: builtin:c", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "steps.yaml"),
      [
        "defaults:",
        "  model:",
        "    PROVIDER: ollama",
        "    MODEL_NAME: base-model",
        "steps:",
        "  - phase-a.yaml",
        "  - file: phase-b.yaml",
        "    timeout: 1234",
        "  - step_name: d",
        "    handler: builtin:d",
        "",
      ].join("\n"),
    );

    const steps = loadSteps(path.join(dir, "steps.yaml"));
    assert.deepEqual(stepNames(steps), ["a", "b", "c", "d"]);
    assert.equal(getStep(steps, "c").timeout, 1234);
    assert.match(getStep(steps, "a").source, /phase-a\.yaml$/);
    assert.match(getStep(steps, "c").source, /phase-b\.yaml$/);
    assert.match(getStep(steps, "d").source, /steps\.yaml$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prompts/schemas use file-scoped ids and type overrides can switch ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-step-map-"));
  try {
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "schemas"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "prompts", "topic.yaml"),
      ["prompts:", "  a:", "    system: from-file", "  b:", "    user: b-user", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "prompts", "ai-news.yaml"),
      ["prompts:", "  a:", "    system: type-system", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "schemas", "topic.yaml"),
      [
        "schemas:",
        "  a:",
        "    input:",
        "      x: string",
        "    output:",
        "      y: number",
        "  b:",
        "    input:",
        "      z: boolean",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "schemas", "ai-news.yaml"),
      ["schemas:", "  a:", "    input:", "      z: string", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "phase-topic.yaml"),
      [
        "steps:",
        "  a:",
        "    handler: builtin:a",
        "    prompt: topic.a",
        "    schema: topic.a",
        "  b:",
        "    handler: builtin:b",
        "    prompt: topic.b",
        "    schema: topic.b",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "steps.yaml"),
      [
        "defaults:",
        "  model:",
        "    PROVIDER: ollama",
        "    MODEL_NAME: base",
        "phases:",
        "  topic: phase-topic.yaml",
        "",
      ].join("\n"),
    );

    const steps = loadSteps(path.join(dir, "steps.yaml"));
    assert.deepEqual(stepNames(steps), ["a", "b"]);
    assert.deepEqual(Object.keys(steps.prompts).sort(), ["ai-news.a", "topic.a", "topic.b"]);
    assert.deepEqual(Object.keys(steps.schemas).sort(), ["ai-news.a", "topic.a", "topic.b"]);
    assert.equal(getStep(steps, "a").prompt.system, "from-file");
    assert.equal(getStep(steps, "a").prompt_id, "topic.a");
    assert.equal(getStep(steps, "a").schema_id, "topic.a");
    assert.equal(getStep(steps, "a").input_format.x, "string");
    assert.equal(getStep(steps, "a").output_format.y, "number");
    assert.equal(getStep(steps, "b").prompt.user, "b-user");

    const type = {
      steps: {
        a: { prompt: "ai-news.a", schema: "ai-news.a" },
      },
    };
    const resolved = resolveStep("a", { steps, type });
    assert.equal(resolved.prompt.system, "type-system");
    assert.equal(resolved.input_format.z, "string");
    assert.equal(resolved.output_format.y, "number");

    const switched = resolveStep("a", { steps, type: { steps: { a: { prompt: "topic.b", schema: "topic.b" } } } });
    assert.equal(switched.prompt.user, "b-user");
    assert.equal(switched.input_format.z, "boolean");
    assert.equal(switched.output_format.y, "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real phase files load prompts and schemas by file-scoped id", () => {
  const steps = loadSteps(STEPS_FILE);
  const select = getStep(steps, "select_topic");
  assert.match(select.prompt.system, /选题编辑/);
  assert.equal(select.prompt_id, "topic.select_topic");
  assert.equal(select.schema_id, "topic.select_topic");
  assert.equal(select.input_format.type, "ArticleType");
  assert.equal(getStep(steps, "draft_writing").prompt.template, "prompts/draft.json");
  assert.equal(getStep(steps, "archive").output_format.removed, "boolean");
});

test("steps.yaml reports a missing phase file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-missing-phase-"));
  try {
    const file = path.join(dir, "steps.yaml");
    fs.writeFileSync(file, ["steps:", "  - missing.yaml", ""].join("\n"));
    assert.throws(() => loadSteps(file), /找不到步骤文件/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("step model ids resolve from config.models", () => {
  const steps = normalizeSteps(
    {
      defaults: { model: "llm.local" },
      steps: [
        { step_name: "a", handler: "builtin:a" },
        { step_name: "b", handler: "builtin:b", model: "llm.large" },
        { step_name: "c", handler: "builtin:c", model: "none" },
      ],
    },
    {
      config: {
        models: {
          "llm.local": { provider: "ollama", base_url: "http://local", model: "9b" },
          "llm.large": { provider: "ollama", base_url: "http://local", model: "35b" },
        },
      },
    },
  );
  assert.equal(getStep(steps, "a").model.model_name, "9b");
  assert.equal(getStep(steps, "b").model.model_name, "35b");
  assert.equal(getStep(steps, "c").model.provider, "none");
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

test("validateSteps rejects unknown prompt/schema ids in type overrides", () => {
  const steps = inlineSteps([{ step_name: "draft_writing", handler: "builtin:draft" }]);
  const report = validateSteps(steps, {
    types: [{
      id: "ai-news",
      steps: { draft_writing: { prompt: "ai-news.draft_writing", schema: "ai-news.draft_writing" } },
    }],
  });
  assert.ok(report.errors.some((line) => line.includes("提示词 id")));
  assert.ok(report.errors.some((line) => line.includes("数据结构 id")));
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
