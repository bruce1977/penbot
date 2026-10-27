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
  resolveCall,
  stepCallContract,
  validateSteps,
} from "../../scripts/lib/steps.mjs";
import { loadConfig } from "../../scripts/lib/config.mjs";
import { validateTemplateSchema } from "../../scripts/lib/template.mjs";

const STEPS_FILE = "config/wechat-article/steps.yaml";

const MODELS = {
  "llm.local": { provider: "ollama", base_url: "http://local", model: "9b" },
  "llm.large": { provider: "ollama", base_url: "http://local", model: "35b" },
  "systemone.classifier": { provider: "systemone", base_url: "http://s", model: "jev" },
  "systemone.classifier-deep": { provider: "systemone", base_url: "http://s", model: "nimble" },
};

function inlineSteps(steps, defaults = {}, schemas = {}, prompts = {}) {
  return normalizeSteps(
    { defaults, steps },
    { config: { models: MODELS }, prompts, schemas },
  );
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
  // 04 组稿：去 AI 化与配图同属一个阶段，两路并发
  assert.equal(getStep(steps, "de_ai").stage, "compose");
  assert.equal(getStep(steps, "image_generation").stage, "compose");
  assert.equal(getStep(steps, "de_ai").calls.de_ai.model_id, "llm.large");
  assert.equal(getStep(steps, "de_ai").calls.de_ai.options.timeout, 900000);
  // 闸门：三判据不合格最多重调 2 次（retry_limit=3 含首轮），重叠上限与提示词按档配置
  assert.equal(getStep(steps, "de_ai").calls.de_ai.options.retry_limit, 3);
  // 当前策略：去 AI 化保持打开，默认走最低档 light（效果满足后再往 standard/deep 抬）
  assert.equal(getStep(steps, "de_ai").handler_options.level, "light");
  assert.equal(getStep(steps, "de_ai").handler_options.levels.light.max_verbatim_overlap, 0.85);
  assert.equal(getStep(steps, "de_ai").handler_options.levels.standard.max_verbatim_overlap, 0.5);
  assert.equal(getStep(steps, "de_ai").calls.de_ai.levels.light.options.retry_limit, 1);
  assert.equal(getStep(steps, "de_ai").artifacts.writes[0], "04-step/polished.md");
  assert.deepEqual(getStep(steps, "image_generation").artifacts.writes, [
    "04-step/images.json",
    "04-step/composed.md",
    "04-step/images/",
    "04-result.json",
  ]);
  assert.match(classify.source, /10-topic\.yaml$/);
  assert.match(getStep(steps, "outline").source, /20-draft\.yaml$/);
  assert.match(getStep(steps, "revision").source, /30-review\.yaml$/);
  assert.match(getStep(steps, "de_ai").source, /40-compose\.yaml$/);
  assert.match(getStep(steps, "image_generation").source, /40-compose\.yaml$/);
  assert.match(getStep(steps, "publish").source, /50-publish\.yaml$/);
});

test("real steps.yaml passes validation", () => {
  const steps = loadSteps(STEPS_FILE);
  assert.deepEqual(validateSteps(steps).errors, []);
  // 入口的两份词汇表也参与校验：stage 只能取 --stage 的名字，
  // enabled 只能出现在入口真能跳过的节点上。
  const report = validateSteps(steps, {
    stages: ["topic", "draft", "review", "compose", "publish"],
    skippable: ["de_ai", "image_generation", "publish", "archive"],
  });
  assert.deepEqual(report.errors, []);
});

test("validateSteps 拦住阶段表外的 stage 与关不掉的 enabled", () => {
  const steps = inlineSteps([
    { step_name: "a", handler: "builtin:a", stage: "sources" },
    { step_name: "b", handler: "builtin:b", stage: "topic", enabled: true },
    { step_name: "no_stage", handler: "builtin:no_stage", enabled: false },
    { step_name: "skip_me", handler: "builtin:skip_me", stage: "draft", enabled: false },
  ]);
  const report = validateSteps(steps, { stages: ["topic", "draft"], skippable: ["skip_me"] });
  assert.ok(report.errors.some((e) => e.includes('stage "sources"') && e.includes("topic|draft")), report.errors.join("；"));
  assert.ok(report.errors.some((e) => e.includes("步骤 no_stage 的 stage 未声明")), report.errors.join("；"));
  assert.ok(report.errors.some((e) => e.includes("步骤 b 写了 enabled") && e.includes("假开关")), report.errors.join("；"));
  assert.ok(!report.errors.some((e) => e.includes("步骤 skip_me")), report.errors.join("；"));

  // 类型层覆盖同样受约束：只能关入口支持跳过的节点
  const clean = inlineSteps([
    { step_name: "write", handler: "builtin:write", stage: "topic" },
    { step_name: "skip_me", handler: "builtin:skip_me", stage: "draft" },
  ]);
  const typed = validateSteps(clean, {
    types: [{ id: "ai-news", steps: { skip_me: { enabled: false } } }],
    skippable: ["skip_me"],
  });
  assert.deepEqual(typed.errors, []);
  const lying = validateSteps(clean, {
    types: [{ id: "ai-news", steps: { write: { enabled: false } } }],
    skippable: ["skip_me"],
  });
  assert.ok(lying.errors.some((e) => e.includes("类型 ai-news 覆盖步骤 write 的 enabled")), lying.errors.join("；"));
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
  // 多调用节点（写作 + 判断）不挂节点级 prompt/schema：每次调用自己声明
  const select = getStep(steps, "select_topic");
  assert.equal(select.prompt_id, "");
  assert.equal(select.schema_id, "");
  const write = stepCallContract(select, "select");
  assert.equal(write.prompt_id, "topic.select_topic");
  assert.match(write.prompt.system, /选题编辑/);
  assert.equal(write.schema_id, "topic.select_topic");
  assert.equal(write.input_format.type, "ArticleType");
  assert.equal(stepCallContract(select, "best").prompt_id, "topic.select_best");
  assert.equal(stepCallContract(getStep(steps, "scoring"), "check").prompt_id, "review.check");
  assert.match(getStep(steps, "draft_writing").prompt.system, /栏目的作者/);
  assert.match(getStep(steps, "revision").prompt.retry, /上一稿不合格/);
  assert.match(getStep(steps, "revision").prompt.length_fix_expand, /优先在现有小节内补充/);
  assert.match(steps.prompts["review.check"].state, /\{\{total\}\}/);
  assert.match(steps.prompts["review.check"].instructions, /继续修改/);
  // de_ai 的提示词按档放在 handler_options.levels，节点本身不挂 prompt
  assert.equal(getStep(steps, "de_ai").prompt_id, "");
  assert.deepEqual(Object.keys(getStep(steps, "de_ai").handler_options.levels), ["light", "standard", "deep"]);
  // 五步的 result 本体都挂 result_schema（可执行 DSL，形状必须与脚本真实写入的 NN-result.json 一致）
  const publishFormat = getStep(steps, "publish").result_output_format;
  assert.equal(publishFormat.status[0], "string");
  assert.equal(publishFormat["channels.email"], "boolean");
  assert.equal(publishFormat["wechat.success"], "boolean");
  assert.equal(getStep(steps, "archive").result_output_format["knowledge.ok"], "boolean");
  for (const [name, id] of [
    ["select_topic", "topic.result"],
    ["draft_writing", "draft.result"],
    ["scoring", "review.result"],
    ["image_generation", "compose.result"],
    ["publish", "publish.publish"],
  ]) {
    const step = getStep(steps, name);
    assert.equal(step.result_schema, id, `${name} 的 result_schema 应指向 ${id}`);
    assert.ok(Object.keys(step.result_output_format).length, `${name} 的 result 契约必须是可执行 DSL`);
    // 信封四件套 + files 地图是每份 result 的骨架，契约里必须写全
    for (const key of ["stage", "generated_at", "title", "type", "files"]) {
      assert.ok(step.result_output_format[key] || step.result_output_format[`${key}?`], `${id} 缺少信封字段 ${key}`);
    }
  }
  // 节点级 schema 只留给模型输出/中间产物：05 两个节点没有模型调用，不再挂 schema
  assert.equal(getStep(steps, "publish").schema, "");
  assert.equal(getStep(steps, "archive").schema, "");
});

test("真实注册表：每个模型调用都从配置解析出提示词（运行期无代码默认文案）", () => {
  const steps = loadSteps(STEPS_FILE);
  const levels = getStep(steps, "de_ai").handler_options.levels;
  const seen = [];
  for (const name of stepNames(steps)) {
    if (name === "de_ai") continue;
    const step = getStep(steps, name);
    for (const label of Object.keys(step.calls || {})) {
      const contract = stepCallContract(step, label);
      // 其余调用必须在节点/调用级配置里自带 prompt id
      assert.ok(contract.prompt_id, `节点 ${name} 的调用 ${label} 没有配置里的 prompt id`);
      assert.ok(steps.prompts[contract.prompt_id], `节点 ${name}.${label} 的 prompt id ${contract.prompt_id} 不在注册表`);
      const text = Object.values(contract.prompt).join("");
      assert.ok(text.trim().length > 20, `节点 ${name}.${label} 的提示词块为空`);
      seen.push(`${label}=${contract.prompt_id}`);
    }
  }
  // 逐调用声明的判断文案也是配置点（历史上只存在于代码注释里）
  assert.ok(seen.includes("best=topic.select_best"), seen.join(" "));
  assert.ok(seen.includes("check=review.check"), seen.join(" "));
  assert.ok(seen.includes("classify=topic.classify_type"), seen.join(" "));
  // de_ai 三档提示词各自可解析，且都不是空块
  for (const level of Object.values(levels)) {
    const block = steps.prompts[level.prompt];
    assert.ok(block?.system && block?.user, `档位提示词 ${level.prompt} 缺 system/user`);
  }
});

test("条件文案没有抄回代码：注册表里的整句在渲染代码里查不到", () => {
  const steps = loadSteps(STEPS_FILE);
  const code = [
    "scripts/lib/prompts.mjs",
    "scripts/lib/draft-input.mjs",
    "scripts/lib/models.mjs",
    "scripts/wechat-article.mjs",
  ]
    .map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"))
    .join("\n")
    // 注释里允许复述配置（说明是哪句），比对时把注释与占位符都摘掉
    .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, "");
  const groups = {
    "topic.select_topic": ["audience_line", "mode_line_auto", "mode_line_manual", "dedupe_rule_with_history", "dedupe_rule_no_history", "length_range"],
    "outline.outline": ["no_materials", "image_plan_default", "image_plan_range", "requirements_block"],
    "revision.revision": [
      "review_basis_reviewed",
      "review_basis_first_round",
      "no_issue_line",
      "retry_reason_call_failed",
      "retry_fix_call_failed",
      "retry_reason_expand",
      "retry_reason_condense",
      "length_fix_expand",
      "length_fix_condense",
    ],
    "draft.draft_writing": ["no_image_hint", "section_only", "requirements_block"],
  };
  for (const [id, keys] of Object.entries(groups)) {
    for (const key of keys) {
      const sentence = String(steps.prompts[id]?.[key] || "");
      assert.ok(sentence.trim(), `注册表 ${id} 缺少条件文案 ${key}`);
      const literal = sentence.replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, "");
      if (literal.length < 8) continue;
      assert.ok(!code.includes(literal.slice(0, 12)), `代码里出现了 ${id}.${key} 的句子：${literal.slice(0, 12)}`);
    }
  }
  // agent CLI 通道的任务句同理：models.yaml 的 instruction 没配就抛错，代码不铺副本
  assert.doesNotMatch(code, /请完成附件/);
});

test("判断调用（systemone）不支持 rounds/levels：运行时不传轮次与档位", () => {
  assert.throws(
    () =>
      inlineSteps([
        {
          step_name: "classify_type",
          handler: "builtin:classify_type",
          models: { classify: { id: "systemone.classifier", rounds: { 1: { id: "systemone.classifier-deep" } } } },
        },
      ]),
    /不支持 rounds/,
  );
  assert.throws(
    () =>
      inlineSteps([
        {
          step_name: "classify_type",
          handler: "builtin:classify_type",
          models: { classify: { id: "systemone.classifier", levels: { fast: { options: { escalate_below: 0.5 } } } } },
        },
      ]),
    /不支持 levels/,
  );
  // llm 调用照旧允许（revision 按轮次、de_ai 按档位）
  const ok = inlineSteps([
    {
      step_name: "revision",
      handler: "builtin:revise_article",
      models: { revise: { id: "llm.large", rounds: { 1: { options: { temperature: 0.1 } } } } },
    },
  ]);
  assert.equal(getStep(ok, "revision").calls.revise.rounds[1].options.temperature, 0.1);
});

test("真实注册表：提示词与数据结构 id 都被引用（没有无人使用的契约条目）", () => {
  const steps = loadSteps(STEPS_FILE);
  const config = loadConfig("config/wechat-article/article-types.yaml", { root: process.cwd() });
  const used = { prompt: new Set(), schema: new Set() };
  const take = (kind, id) => {
    if (typeof id === "string" && id) used[kind].add(id);
  };
  for (const name of stepNames(steps)) {
    const step = getStep(steps, name);
    take("prompt", step.prompt_id);
    take("schema", step.schema_id);
    take("schema", step.result_schema);
    for (const call of Object.values(step.calls || {})) {
      take("prompt", call.prompt_id);
      take("schema", call.schema_id);
    }
    // de_ai 的档位提示词也是引用点
    for (const level of Object.values(step.handler_options?.levels || {})) take("prompt", level.prompt);
  }
  for (const type of config.types) {
    for (const override of Object.values(type.steps || {})) {
      take("prompt", override.prompt);
      take("schema", override.schema);
    }
  }
  assert.deepEqual(Object.keys(steps.prompts).filter((id) => !used.prompt.has(id)), [], "有提示词条目没被任何节点引用");
  assert.deepEqual(Object.keys(steps.schemas).filter((id) => !used.schema.has(id)), [], "有数据结构条目没被任何节点引用");
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

test("models.<label>.rounds overrides model/options per round", () => {
  const steps = inlineSteps([
    {
      step_name: "revision",
      handler: "builtin:revise_article",
      models: {
        revise: {
          id: "llm.large",
          options: { timeout: 900000, temperature: 0.2 },
          rounds: {
            1: { id: "llm.local", options: { temperature: 0.1 } },
            2: { options: { timeout: 60000 } },
          },
        },
      },
    },
  ]);
  const call = getStep(steps, "revision").calls.revise;
  assert.equal(call.rounds[1].model_id, "llm.local");
  assert.deepEqual(call.rounds[1].options, { temperature: 0.1 });
  // 省略 id 表示继承默认模型
  assert.equal(call.rounds[2].model_id, "");
  assert.deepEqual(call.rounds[2].options, { timeout: 60000 });

  assert.deepEqual(resolveCall(call, 1), {
    model_id: "llm.local",
    options: { timeout: 900000, temperature: 0.1 },
  });
  assert.deepEqual(resolveCall(call, 2), {
    model_id: "llm.large",
    options: { timeout: 60000, temperature: 0.2 },
  });
  // 未配置的轮次回落调用默认
  assert.deepEqual(resolveCall(call, 3), {
    model_id: "llm.large",
    options: { timeout: 900000, temperature: 0.2 },
  });
  assert.deepEqual(resolveCall(call), {
    model_id: "llm.large",
    options: { timeout: 900000, temperature: 0.2 },
  });
});

test("rounds rejects invalid keys, templates and fields", () => {
  const build = (rounds) => () => inlineSteps([
    {
      step_name: "revision",
      handler: "builtin:revise_article",
      models: { revise: { id: "llm.large", rounds } },
    },
  ]);
  assert.throws(build("x"), /rounds 必须是对象/);
  assert.throws(build({ 0: { id: "llm.local" } }), /轮次键必须是从 1 起的整数/);
  assert.throws(build({ first: { id: "llm.local" } }), /轮次键必须是从 1 起的整数/);
  assert.throws(build({ 1: {} }), /至少写 id 或一个 options 字段/);
  assert.throws(build({ 1: { id: "llm.ghost" } }), /未在 config\/models\.yaml 定义/);
  assert.throws(build({ 1: { id: "systemone.classifier" } }), /必须与默认调用使用同一模板/);
  assert.throws(build({ 1: { options: { deep: "systemone.classifier" } } }), /不支持参数 deep/);
  assert.throws(build({ 1: { id: "llm.local", timeout: 1000 } }), /不支持字段 timeout/);
});

test("call entries reject unknown fields", () => {
  assert.throws(
    () => inlineSteps([
      { step_name: "a", handler: "builtin:a", models: { draft: { id: "llm.local", option: { temperature: 0.1 } } } },
    ]),
    /不支持字段 option/,
  );
});

test("models.<label>.levels overrides model/options per 档位", () => {
  const steps = inlineSteps([
    {
      step_name: "de_ai",
      handler: "builtin:de_ai",
      models: {
        de_ai: {
          id: "llm.large",
          options: { timeout: 900000, retry_limit: 3, temperature: 0.2 },
          levels: {
            light: { options: { retry_limit: 1 } },
            deep: { id: "llm.local", options: { temperature: 0.9 } },
          },
        },
      },
    },
  ]);
  const call = getStep(steps, "de_ai").calls.de_ai;
  // 省略 id = 继承默认模型；只覆盖写出的 options 键
  assert.deepEqual(call.levels.light, { model_id: "", options: { retry_limit: 1 } });
  assert.deepEqual(call.levels.deep, { model_id: "llm.local", options: { temperature: 0.9 } });

  assert.deepEqual(resolveCall(call, null, "light"), {
    model_id: "llm.large",
    options: { timeout: 900000, retry_limit: 1, temperature: 0.2 },
  });
  assert.deepEqual(resolveCall(call, null, "deep"), {
    model_id: "llm.local",
    options: { timeout: 900000, retry_limit: 3, temperature: 0.9 },
  });
  // 未配置的档位 / 不传档位 = 节点默认
  assert.deepEqual(resolveCall(call, null, "ghost"), resolveCall(call));
  assert.deepEqual(resolveCall(call), {
    model_id: "llm.large",
    options: { timeout: 900000, retry_limit: 3, temperature: 0.2 },
  });
  // 轮次比档位更贴近本次运行，最后应用
  const withRounds = { ...call, rounds: { 1: { options: { temperature: 0.05 } } } };
  assert.deepEqual(resolveCall(withRounds, 1, "deep"), {
    model_id: "llm.local",
    options: { timeout: 900000, retry_limit: 3, temperature: 0.05 },
  });
});

test("levels rejects invalid names, empty overrides and other templates", () => {
  const build = (levels) => () => inlineSteps([
    {
      step_name: "de_ai",
      handler: "builtin:de_ai",
      models: { de_ai: { id: "llm.large", levels } },
    },
  ]);
  assert.throws(build("x"), /levels 必须是对象/);
  assert.throws(build({ Light: { options: { retry_limit: 1 } } }), /档位名不合法/);
  assert.throws(build({ light: {} }), /至少写 id 或一个 options 字段/);
  assert.throws(build({ light: { id: "systemone.classifier" } }), /必须与默认调用使用同一模板/);
  assert.throws(build({ light: { options: { deep: 1 } } }), /不支持参数 deep/);
  assert.throws(build({ light: { id: "llm.local", timeout: 1000 } }), /不支持字段 timeout/);
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

test("多调用节点逐调用声明提示词，节点级 prompt/schema 是加载期错误", () => {
  const node = (extra = {}) => [
    {
      step_name: "a",
      handler: "builtin:a",
      ...extra,
      models: {
        write: { id: "llm.local", prompt: { system: "s", user: "u" }, schema: "topic.a" },
        judge: { id: "systemone.classifier", prompt: { state: "st" } },
      },
    },
  ];
  const steps = inlineSteps(node(), {}, { "topic.a": { input: { i: "string" }, output: { o: "number" } } });
  // 运行期按调用名取契约：写作调用吃自己的 schema，判定调用只吃自己的提示词
  assert.equal(stepCallContract(getStep(steps, "a"), "write").prompt.system, "s");
  assert.equal(stepCallContract(getStep(steps, "a"), "write").output_format.o, "number");
  assert.equal(stepCallContract(getStep(steps, "a"), "judge").prompt.state, "st");
  assert.deepEqual(stepCallContract(getStep(steps, "a"), "judge").output_format, {});

  // 节点级标量会被第二个调用误继承 → 加载期抛错
  assert.throws(() => inlineSteps(node({ prompt: { system: "n", user: "n" } }), {}, { "topic.a": { output: {} } }), /节点级 prompt 会被其他调用误继承/);
  assert.throws(() => inlineSteps(node({ schema: { input: {}, output: {} } }), {}, { "topic.a": { output: {} } }), /节点级 schema 会被其他调用误继承/);
  // 漏声明的调用没有兜底：静默拿到别人的文案比报错更糟
  assert.throws(
    () => inlineSteps([
      { step_name: "a", handler: "builtin:a", models: { write: { id: "llm.local", prompt: { system: "s", user: "u" } }, judge: { id: "systemone.classifier" } } },
    ]),
    /models\.judge\.prompt 必须单独声明/,
  );
  // 单调用节点：节点级与调用级只能写一处
  assert.throws(
    () => inlineSteps([
      { step_name: "a", handler: "builtin:a", prompt: { system: "n", user: "n" }, models: { write: { id: "llm.local", prompt: { system: "s", user: "u" } } } },
    ]),
    /提示词声明了两处/,
  );
});

test("parseHandler accepts builtin, script and HTTP forms", () => {  const builtin = parseHandler("builtin:select_topic");
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

test("result_schema：条目没有 output DSL / 挂在不落 result 的节点上都是配置说谎", () => {
  const schemas = {
    "a.result": { output: { stage: ["string", 1] } },
    "b.note": { input: { x: "string" } },
  };
  const node = (extra) => ({
    step_name: "write_result",
    handler: "builtin:write_result",
    artifacts: { writes: ["01-result.json"] },
    ...extra,
  });

  const ok = inlineSteps([node({ result_schema: "a.result" })], {}, schemas);
  assert.deepEqual(validateSteps(ok).errors, []);
  assert.equal(getStep(ok, "write_result").result_output_format.stage[0], "string");
  // 没有模型调用的节点：result 契约的 input 段同时充当输入形状文档，避免"未声明 input_format"的假警告
  assert.equal(getStep(ok, "write_result").input_format.x, undefined);

  assert.throws(
    () => inlineSteps([node({ result_schema: "b.note" })], {}, schemas),
    /没有 output DSL/,
  );
  assert.throws(
    () => inlineSteps([node({ result_schema: "nope.missing" })], {}, schemas),
    /不存在的数据结构 id/,
  );

  const orphan = inlineSteps(
    [{ step_name: "middle", handler: "builtin:middle", artifacts: { writes: ["01-step/x.json"] }, result_schema: "a.result" }],
    {},
    schemas,
  );
  assert.match(validateSteps(orphan).errors.join("；"), /artifacts\.writes 里没有 NN-result\.json/);
});

test("五份 result 契约都真跑得起来：形状偏离时逐项点名", () => {
  const steps = loadSteps(STEPS_FILE);
  const contract = (name) => getStep(steps, name).result_output_format;

  const topic = validateTemplateSchema({ stage: "topic", generated_at: "x", title: "", type: "ai-news", files: {}, sources: "[]" }, contract("select_topic"));
  assert.ok(topic.errors.includes("title 不能为空"), topic.errors.join("；"));
  assert.ok(topic.errors.includes("files.topicMd 缺失"), topic.errors.join("；"));
  assert.ok(topic.errors.includes("sources 应为数组"), topic.errors.join("；"));

  const review = validateTemplateSchema(
    { stage: "review", generated_at: "x", title: "T", type: "t", files: { reviewed: "03-step/reviewed.md" }, rounds: [], final: {}, passed: "yes", pass_score: 78 },
    contract("scoring"),
  );
  assert.ok(review.errors.includes("rounds 至少 1 项（实际 0）"), review.errors.join("；"));
  assert.ok(review.errors.includes("passed 应为布尔值"), review.errors.join("；"));

  const compose = validateTemplateSchema(
    { stage: "compose", generated_at: "x", title: "T", type: "t", files: { images: "04-step/images.json", composed: "04-step/composed.md" }, polish: { skipped: false, fallback: false, mock: false, words: 10 }, images_planned: "2", images_success: 0, images_skipped: false },
    contract("image_generation"),
  );
  assert.ok(compose.errors.includes("polish.ok 缺失"), compose.errors.join("；"));
  assert.ok(compose.errors.includes("images_planned 应为数字"), compose.errors.join("；"));
  // files.polished 为 null（关档/回退）是合法形状，不算缺失
  assert.ok(!compose.errors.some((e) => e.includes("polished")), compose.errors.join("；"));

  const draft = validateTemplateSchema(
    { stage: "draft", generated_at: "x", title: "T", type: "t", files: { outline: "02-step/outline.json", outlineMd: "02-step/outline.md", draftInput: "02-step/draft-input.json", draft: "02-step/draft.md" }, sections: 3, images_planned: 0, words: 1500 },
    contract("draft_writing"),
  );
  assert.deepEqual(draft.errors, [], draft.errors.join("；"));
});

test("04 两条分支的开关与档位由 .env 抬起，enabled 字符串归成真布尔", () => {
  const lifted = { PB_DE_AI_ENABLED: "false", PB_IMAGES_ENABLED: "0", PB_DE_AI_LEVEL: "deep" };
  for (const [key, value] of Object.entries(lifted)) process.env[key] = value;
  try {
    const steps = loadSteps(STEPS_FILE);
    const deAi = getStep(steps, "de_ai");
    // "false"/"0" 必须是真布尔 false——`!== false` 判会把字符串当成开，等于假开关。
    assert.equal(deAi.enabled, false);
    assert.equal(getStep(steps, "image_generation").enabled, false);
    assert.equal(deAi.handler_options.level, "deep");
    assert.equal(deAi.enabled_declared, true);
  } finally {
    for (const key of Object.keys(lifted)) delete process.env[key];
  }
  const steps = loadSteps(STEPS_FILE);
  assert.equal(getStep(steps, "de_ai").enabled, true);
  assert.equal(getStep(steps, "de_ai").handler_options.level, "light");
  // type 层覆盖写出来的 env 字符串同样归一（缺省时吃节点值）。
  assert.equal(resolveStep("de_ai", { steps, type: { steps: { de_ai: { enabled: "false" } } } }).enabled, false);
  assert.equal(resolveStep("de_ai", { steps, type: { steps: { de_ai: {} } } }).enabled, true);
});
