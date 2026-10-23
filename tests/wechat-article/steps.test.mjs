import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadSteps,
  normalizeSteps,
  parseHandler,
  getStep,
  stepNames,
  resolveStep,
  resolveStepPrompt,
  validateSteps,
} from "../../scripts/lib/steps.mjs";

const STEPS_FILE = "config/wechat-article/steps.yaml";

const MODELS = {
  "llm.local": { provider: "ollama", base_url: "http://local", model: "9b" },
  "llm.large": { provider: "ollama", base_url: "http://local", model: "35b" },
  "systemone.classifier": { provider: "systemone", base_url: "http://s", model: "jev" },
  "systemone.classifier-deep": { provider: "systemone", base_url: "http://s", model: "nimble" },
};

function inlineSteps(steps, defaults = {}) {
  return normalizeSteps({ version: 2, defaults, steps }, { config: { models: MODELS } });
}

test("steps.yaml lists the full pipeline in execution order", () => {
  const steps = loadSteps(STEPS_FILE);
  assert.equal(steps.steps.length, 13);
  assert.deepEqual(stepNames(steps), [
    "select_topic",
    "classify_type",
    "gather_materials",
    "outline",
    "bundle_draft_input",
    "draft_writing",
    "review",
    "revision",
    "scoring",
    "de_ai",
    "image_generation",
    "publish",
    "archive",
  ]);
  // 模型调用单源在节点 models.<调用名>：{ model_id, template, options }
  const select = getStep(steps, "select_topic");
  assert.equal(select.calls.select.model_id, "llm.local");
  assert.equal(select.calls.select.template, "llm");
  assert.equal(select.calls.select.options.retry_limit, 2);
  assert.equal(select.calls.select.options.timeout, 900000);
  assert.equal(select.calls.best.template, "systemone");
  assert.equal(select.calls.best.options.deep, "systemone.classifier-deep");
  assert.equal(select.calls.best.options.escalate_below, 0.65);
  const classify = getStep(steps, "classify_type");
  assert.equal(classify.calls.classify.model_id, "systemone.classifier");
  assert.equal(classify.calls.classify.options.min_confidence, 0.5);
  assert.equal(classify.calls.classify.options.escalate_below, 0.65);
  assert.deepEqual(getStep(steps, "gather_materials").calls, {});
  assert.deepEqual(getStep(steps, "image_generation").calls, {});
  assert.equal(getStep(steps, "outline").calls.outline.model_id, "llm.large");
  assert.equal(getStep(steps, "draft_writing").calls.draft.options.timeout, 1200000);
  assert.equal(getStep(steps, "revision").calls.revise.label, "revise");
  assert.equal(getStep(steps, "scoring").calls.check.template, "systemone");
  assert.equal(getStep(steps, "scoring").calls.check.model_id, "systemone.classifier");
  assert.equal(getStep(steps, "scoring").calls.check.options.deep, "systemone.classifier-deep");
  assert.equal(getStep(steps, "scoring").calls.check.options.min_confidence, 0.5);
  assert.equal(getStep(steps, "de_ai").stage, "polish");
  assert.equal(getStep(steps, "de_ai").calls.de_ai.options.retry_limit, 1);
  assert.equal(getStep(steps, "de_ai").artifacts.writes[0], "04-step/polished.md");
  assert.match(classify.source, /10-topic\.yaml$/);
  assert.match(getStep(steps, "outline").source, /20-draft\.yaml$/);
  assert.match(getStep(steps, "revision").source, /30-review\.yaml$/);
  assert.match(getStep(steps, "de_ai").source, /40-polish\.yaml$/);
  assert.match(getStep(steps, "image_generation").source, /50-illustrate\.yaml$/);
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
        "steps:",
        "  - phase-a.yaml",
        "  - file: phase-b.yaml",
        "    label: 覆盖标签",
        "  - step_name: d",
        "    handler: builtin:d",
        "",
      ].join("\n"),
    );

    const steps = loadSteps(path.join(dir, "steps.yaml"));
    assert.deepEqual(stepNames(steps), ["a", "b", "c", "d"]);
    assert.equal(getStep(steps, "c").label, "覆盖标签");
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
      ["phases:", "  topic: phase-topic.yaml", ""].join("\n"),
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
  assert.match(getStep(steps, "draft_writing").prompt.system, /栏目的作者/);
  assert.match(getStep(steps, "revision").prompt.retry, /上一稿不合格/);
  assert.match(getStep(steps, "revision").prompt.length_fix_expand, /优先在现有小节内补充/);
  assert.match(steps.prompts["review.check"].state, /\{\{total\}\}/);
  assert.match(steps.prompts["review.check"].instructions, /继续修改/);
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

test("models.<label> normalizes to calls with template and options", () => {
  const steps = inlineSteps([
    {
      step_name: "draft_writing",
      handler: "builtin:write_draft",
      models: {
        draft: { id: "llm.large", options: { retry_limit: 3, timeout: 60000, temperature: 0.3, max_tokens: 4096 } },
      },
    },
  ]);
  const call = getStep(steps, "draft_writing").calls.draft;
  assert.deepEqual(call, {
    label: "draft",
    model_id: "llm.large",
    template: "llm",
    options: { retry_limit: 3, timeout: 60000, temperature: 0.3, max_tokens: 4096 },
  });
});

test("models.<label> accepts a bare model id shorthand", () => {
  const steps = inlineSteps([
    { step_name: "a", handler: "builtin:a", models: { draft: "llm.local" } },
  ]);
  const call = getStep(steps, "a").calls.draft;
  assert.equal(call.model_id, "llm.local");
  assert.equal(call.template, "llm");
  assert.deepEqual(call.options, {});
});

test("steps without models have empty calls", () => {
  const steps = inlineSteps([{ step_name: "bundle", handler: "builtin:bundle" }]);
  assert.deepEqual(getStep(steps, "bundle").calls, {});
});

test("legacy flat model/retry_limit/timeout fields are hard errors", () => {
  for (const legacy of [
    { model: "llm.local" },
    { retry_limit: 2 },
    { timeout: 5000 },
  ]) {
    assert.throws(
      () => inlineSteps([{ step_name: "a", handler: "builtin:a", ...legacy }]),
      /已废弃的扁平字段/,
    );
  }
  for (const key of ["model", "retry_limit", "timeout"]) {
    assert.throws(() => inlineSteps([], { [key]: 1 }), /defaults/);
  }
});

test("normalizeCalls rejects malformed models entries", () => {
  const build = (models) => () => inlineSteps([{ step_name: "a", handler: "builtin:a", models }]);
  assert.throws(build("llm.local"), /models 必须是对象/);
  assert.throws(build({ "Bad-Label": "llm.local" }), /调用名不合法/);
  assert.throws(build({ draft: {} }), /必须是 \{ id, options \}/);
  assert.throws(build({ draft: { id: "gpt.x" } }), /已定义模板/);
  assert.throws(build({ draft: { id: "llm.ghost" } }), /未在 config\/models\.yaml 定义/);
  assert.throws(build({ draft: { id: "llm.local", options: "x" } }), /options 必须是对象/);
});

test("options whitelist per template: llm vs systemone", () => {
  // llm 模板不接受 systemone 参数
  assert.throws(
    () => inlineSteps([
      { step_name: "a", handler: "builtin:a", models: { draft: { id: "llm.local", options: { deep: "systemone.classifier" } } } },
    ]),
    /不支持参数 deep；可用：retry_limit \/ timeout \/ temperature \/ max_tokens/,
  );
  // systemone 模板不接受 llm 参数
  assert.throws(
    () => inlineSteps([
      { step_name: "a", handler: "builtin:a", models: { classify: { id: "systemone.classifier", options: { timeout: 5000 } } } },
    ]),
    /不支持参数 timeout；可用：deep \/ escalate_below \/ min_confidence/,
  );
});

test("normalizeCalls validates option values", () => {
  const build = (options, id = "llm.local") => () => inlineSteps([
    { step_name: "a", handler: "builtin:a", models: { c: { id, options } } },
  ]);
  assert.throws(build({ retry_limit: 0 }), /retry_limit 必须是 ≥1/);
  assert.throws(build({ timeout: -1 }), /timeout 必须大于 0/);
  assert.throws(build({ temperature: "abc" }), /temperature 必须是数字/);
  assert.throws(build({ deep: "llm.local" }, "systemone.classifier"), /deep 必须是 systemone/);
  assert.throws(build({ deep: "systemone.ghost" }, "systemone.classifier"), /未在 config\/models\.yaml 定义/);
  assert.throws(build({ escalate_below: 1.5 }, "systemone.classifier"), /escalate_below 必须在 0-1/);
  // 合法通过
  const steps = inlineSteps([
    {
      step_name: "a",
      handler: "builtin:a",
      models: { best: { id: "systemone.classifier", options: { deep: "systemone.classifier-deep", escalate_below: 0.65 } } },
    },
  ]);
  assert.equal(getStep(steps, "a").calls.best.options.deep, "systemone.classifier-deep");
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

test("resolveStep merges enabled/handler_options but never model calls", () => {
  const steps = inlineSteps([
    {
      step_name: "scoring",
      handler: "builtin:score",
      models: { score: { id: "llm.local", options: { retry_limit: 2 } } },
      handler_options: { a: 1, nested: { x: 1 } },
    },
  ]);
  const resolved = resolveStep("scoring", {
    steps,
    type: {
      id: "ai-news",
      steps: {
        scoring: {
          enabled: false,
          handler_options: { b: 2, nested: { y: 2 } },
          model: "llm.large",
          timeout: 9000,
          retry_limit: 0,
        },
      },
    },
  });
  assert.equal(resolved.enabled, false);
  assert.deepEqual(resolved.handler_options, { a: 1, b: 2, nested: { x: 1, y: 2 } });
  // 模型调用单源在节点：type 层的 model/timeout/retry_limit 不生效
  assert.equal(resolved.calls.score.model_id, "llm.local");
  assert.equal(resolved.calls.score.options.retry_limit, 2);
});

test("validateSteps catches duplicates, bad handlers and unknown deps", () => {
  const steps = inlineSteps([
    { step_name: "a", handler: "builtin:", depends_on: ["ghost"] },
    { step_name: "a", handler: "builtin:b" },
  ]);
  const report = validateSteps(steps);
  assert.ok(report.errors.some((line) => line.includes("步骤名重复")));
  assert.ok(report.errors.some((line) => line.includes("依赖了不存在的步骤")));
  assert.ok(report.errors.some((line) => line.includes("缺少 handler entry")));
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

test("loadSteps expands environment variables in step files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-steps-"));
  const file = path.join(dir, "steps.yaml");
  const previous = process.env.WA_STEPS_TEST_TEMP;
  process.env.WA_STEPS_TEST_TEMP = "0.4";
  try {
    fs.writeFileSync(
      path.join(dir, "models.yaml"),
      ["models:", "  llm:", "    local:", "      provider: ollama", "      base_url: http://env", "      model: env-model", ""].join("\n"),
    );
    fs.writeFileSync(
      file,
      [
        "version: 2",
        "steps:",
        "  demo:",
        "    handler: builtin:demo",
        "    models:",
        "      draft:",
        "        id: llm.local",
        "        options:",
        '          temperature: "${WA_STEPS_TEST_TEMP:-0.1}"',
        "",
      ].join("\n"),
    );
    const steps = loadSteps(file);
    assert.equal(getStep(steps, "demo").calls.draft.options.temperature, 0.4);
  } finally {
    if (previous === undefined) delete process.env.WA_STEPS_TEST_TEMP;
    else process.env.WA_STEPS_TEST_TEMP = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
