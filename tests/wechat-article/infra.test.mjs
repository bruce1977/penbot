// 基础设施测试：args / env / config / models / schema / 文章目录与续跑（不属于某个阶段步骤）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { parseArgs, asBool, asNumber, asList } from "../../scripts/lib/args.mjs";
import { walkFiles, readJson, writeBinary, writeJson, writeText } from "../../scripts/lib/fsx.mjs";
import { expandEnv } from "../../scripts/lib/env.mjs";
import {
  loadConfig,
  findType,
  normalizeConfig,
  normalizeWordLimit,
  normalizeImageCount,
  validateConfig,
  validateWarnings,
  deepMerge,
  getModelProfile,
  normalizeModelMap,
} from "../../scripts/lib/config.mjs";
import { parseJsonFromText, extractAgentText } from "../../scripts/lib/models.mjs";
import { getStep, loadSteps } from "../../scripts/lib/steps.mjs";
import {
  ARTIFACT,
  buildEnvelope,
  createArticle,
  detectStartStage,
  fileFromResult,
  listArticles,
  listWrittenArticles,
  openArticle,
  readArticleMeta,
  resetStageDir,
} from "../../scripts/lib/article-store.mjs";
import { tempDir, rawConfig } from "./helpers.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CONFIG_REL = "config/wechat-article/article-types.yaml";

/* ------------------------------------------------------------------ */
/* fsx 原子落盘                                                        */
/* ------------------------------------------------------------------ */

test("writeText/writeJson/writeBinary 原子落盘：不留 .tmp，重跑覆盖同一路径", () => {
  const root = tempDir("wa-fsx-");
  const resultFile = path.join(root, "01-step/01-result.json");
  writeJson(resultFile, { stage: "topic" });
  writeJson(resultFile, { stage: "draft" });
  assert.deepEqual(readJson(resultFile), { stage: "draft" });
  writeText(path.join(root, "02-step/draft.md"), "# 标题\n");
  writeBinary(path.join(root, "04-step/images/01.png"), Buffer.from("png"));
  assert.deepEqual(walkFiles(root, (file) => file.endsWith(".tmp")), []);
});

test("rename 失败时不留半截文件：抛错并清掉自己的 .tmp", () => {
  const root = tempDir("wa-fsx-fail-");
  const taken = path.join(root, "taken");
  fs.mkdirSync(taken);
  fs.writeFileSync(path.join(taken, "holder.txt"), "x", "utf8");
  assert.throws(() => writeText(taken, "新内容"));
  assert.equal(fs.existsSync(`${taken}.tmp`), false);
});

/* ------------------------------------------------------------------ */
/* 阶段重跑前的残留清理                                                  */
/* ------------------------------------------------------------------ */

test("resetStageDir 清掉上一趟中断的残留：留痕、轮次目录、本阶段中间产物与 result", () => {
  const root = tempDir("wa-reset-");
  for (const rel of [
    "03-step/api/3_1(2)-revise.json",
    "03-step/round-1/score.json",
    "03-step/reviewed.md",
    "03-result.json",
    "04-step/api/1_1-de_ai.json",
    "04-step/polished.md",
    "04-step/images/01_mock.png",
    "04-step/composed.md",
    "04-result.json",
    "05-step/final.md",
    "05-step/delivered.json",
  ]) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}", "utf8");
  }

  assert.deepEqual(resetStageDir(root, "review").sort(), [
    "03-result.json",
    "03-step/api",
    "03-step/round-1",
    "03-step/reviewed.md",
  ].sort());
  assert.equal(fs.existsSync(path.join(root, "04-step/polished.md")), true, "别阶段的产物不能顺手清");
  assert.equal(fs.existsSync(path.join(root, "05-step/final.md")), true);

  assert.deepEqual(resetStageDir(root, "compose").sort(), [
    "04-result.json",
    "04-step/api",
    "04-step/composed.md",
    "04-step/images",
    "04-step/polished.md",
  ].sort());

  // publish 不参与重置：05-step/delivered.json 是外部副作用的唯一凭据，清了就会重复投递。
  assert.deepEqual(resetStageDir(root, "publish"), []);
  assert.equal(fs.existsSync(path.join(root, "05-step/delivered.json")), true);
  assert.deepEqual(resetStageDir(root, "topic"), []);
});

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

test("parseArgs handles values, flags, --no-flags and repeats", () => {
  const { command, args, options } = parseArgs([
    "run",
    "--type",
    "ai-news",
    "--mock",
    "--no-email",
    "--to",
    "a@x.com",
    "--to=b@y.com",
    "extra",
  ]);
  assert.equal(command, "run");
  assert.deepEqual(args, ["extra"]);
  assert.equal(options.type, "ai-news");
  assert.equal(options.mock, true);
  assert.equal(options.email, false);
  assert.deepEqual(options.to, ["a@x.com", "b@y.com"]);
});

test("asBool / asNumber / asList normalize option values", () => {
  assert.equal(asBool(undefined, true), true);
  assert.equal(asBool("false"), false);
  assert.equal(asBool("yes"), true);
  assert.equal(asNumber("12", 3), 12);
  assert.equal(asNumber(undefined, 3), 3);
  assert.deepEqual(asList("a, b;c"), ["a", "b", "c"]);
});

/* ------------------------------------------------------------------ */
/* env                                                                 */
/* ------------------------------------------------------------------ */

test("expandEnv resolves ${VAR} and ${VAR:-default}", () => {
  process.env.WA_TEST_VAR = "real";
  assert.equal(expandEnv("${WA_TEST_VAR}"), "real");
  assert.equal(expandEnv("${WA_TEST_MISSING:-fallback}"), "fallback");
  assert.equal(expandEnv("${WA_TEST_MISSING}"), "");
  assert.deepEqual(expandEnv(["${WA_TEST_VAR}", { k: "${WA_TEST_MISSING:-d}" }]), ["real", { k: "d" }]);
  delete process.env.WA_TEST_VAR;
});

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

test("parseJsonFromText handles fenced, embedded and invalid input", () => {
  assert.deepEqual(parseJsonFromText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonFromText('前言 {"a":{"b":2}} 后缀'), { a: { b: 2 } });
  assert.throws(() => parseJsonFromText("no json here"));
});

test("extractAgentText concatenates NDJSON text parts and raises errors", () => {
  const stdout = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "text", part: { text: "第一段" } }),
    JSON.stringify({ type: "text", part: { text: "第二段" } }),
  ].join("\n");
  assert.equal(extractAgentText(stdout), "第一段\n第二段");

  const err = JSON.stringify({ type: "error", error: { message: "boom" } });
  assert.throws(() => extractAgentText(err), /boom/);

  assert.equal(extractAgentText("纯文本输出"), "纯文本输出");
});

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

test("normalizeConfig normalizes weights, dirs and numeric ranges", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  // expandEnv 之后这些值都是字符串；加载期归成数字，缺值不注入默认。
  raw.defaults.review.max_rounds = "3";
  raw.defaults.knowledge = { max_sources: "8", excerpt_chars: "1800", max_file_bytes: 400000 };
  raw.defaults.illustrations = { min: "1", max: "5" };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.id, "t1");
  const [a, b] = type.scoring.dimensions;
  assert.equal(a.weight, 0.25);
  assert.equal(b.weight, 0.75);
  assert.equal(path.isAbsolute(type.knowledge_dirs[0]), true);
  assert.equal(type.review.max_rounds, 3);
  assert.equal(type.illustrations.min, 1);
  assert.equal(type.illustrations.max, 5);
  assert.equal(type.knowledge.max_sources, 8);

  // 没写就没有：加载期铺同值默认等于允许 defaults.yaml 说谎（改了配置不生效）。
  const bare = normalizeConfig(rawConfig(dir), dir).types[0];
  assert.equal(bare.review.max_rounds, undefined);
  assert.equal(bare.knowledge.max_sources, undefined);
  assert.equal(bare.illustrations.min, undefined);
  // 通过线只解析一次：scoring.pass_score 是 review.pass_score 的别名，不是第二条链。
  assert.equal(type.scoring.pass_score, type.review.pass_score);
});

test("defaults.publish 只留渠道参数，投递开关单源在 steps 节点", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.publish = {
    email: { to: ["a@x.com"] },
    wechat: { theme: "default" },
  };
  const config = normalizeConfig(raw, dir);
  // 渠道参数按类型合并；开关不在这段里生成（否则就有了第二个读取口）。
  const publish = config.types[0].publish;
  assert.deepEqual(publish.email.to, ["a@x.com"]);
  assert.equal(publish.email.enabled, undefined);
  assert.equal(publish.wechat.enabled, undefined);
  assert.equal(publish.auto_publish, undefined);
});

test("投递开关单源在 steps/50-publish.yaml 的 publish.handler_options", () => {
  const config = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
  const publish = getStep(loadSteps("config/wechat-article/steps.yaml", { root: PROJECT_ROOT }), "publish");
  // 默认全开 = auto 模式一路发布到底（要停投递就在这里关）。
  assert.deepEqual(publish.handler_options, { auto_publish: true, email: true, wechat: true });
  // 三个 PB_* 投递开关已删除：同一件事只留配置这一个口。
  assert.equal(config.defaults.publish.auto_publish, undefined);
  assert.equal(config.defaults.publish.email.enabled, undefined);
  assert.equal(config.defaults.publish.wechat.enabled, undefined);
  const defaultsText = fs.readFileSync(path.join(PROJECT_ROOT, "config/wechat-article/defaults.yaml"), "utf8");
  assert.doesNotMatch(defaultsText, /PB_(AUTO_PUBLISH|EMAIL_ENABLED|WECHAT_ENABLED)/);
});

test("PB_* 抬起的可变阈值在加载期归成数字/布尔", () => {
  const lifted = {
    PB_REVIEW_ROUNDS: "2",
    PB_PASS_SCORE: "90",
    PB_KNOWLEDGE_MAX_SOURCES: "5",
    PB_WEB_SEARCH_ENABLED: "false",
    PB_IMAGE_CONCURRENCY: "1",
  };
  for (const [key, value] of Object.entries(lifted)) process.env[key] = value;
  try {
    const config = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
    // doctor 读 defaults 段：这里的口径必须和类型合并后的值一致，且都是真类型。
    assert.equal(config.defaults.review.max_rounds, 2);
    assert.equal(config.defaults.illustrations.concurrency, 1);
    for (const type of config.types) {
      // 一个 PB_PASS_SCORE 统一四类：不设时各类型吃自己的 ${PB_PASS_SCORE:-78|82}。
      assert.equal(type.review.max_rounds, 2, type.id);
      assert.equal(type.review.pass_score, 90, type.id);
      assert.equal(type.scoring.pass_score, 90, type.id);
      assert.equal(type.knowledge.max_sources, 5, type.id);
      // weknora.match_count 不在 defaults.yaml 写死，由 max_sources 推导。
      assert.equal(type.knowledge.weknora.match_count, 5, type.id);
      // "false" 必须归成真布尔，否则真值判断会把它当成开。
      assert.equal(type.knowledge["web-search"].enabled, false, type.id);
      assert.equal(type.illustrations.concurrency, 1, type.id);
    }
  } finally {
    for (const key of Object.keys(lifted)) delete process.env[key];
  }
  const base = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
  const news = findType(base, "ai-news");
  assert.equal(news.review.max_rounds, 3);
  assert.equal(news.review.pass_score, 78);
  assert.equal(findType(base, "tech-explainer").review.pass_score, 82);
  assert.equal(news.knowledge["web-search"].enabled, true);
  assert.equal(news.illustrations.concurrency, 2);
  assert.equal(news.knowledge.weknora.match_count, 8);
});

test("类型文件不复制 defaults 的轮次与裸通过线（同值副本会掩盖 .env）", () => {
  const typesDir = path.join(PROJECT_ROOT, "config", "wechat-article", "types");
  for (const file of fs.readdirSync(typesDir).filter((name) => name.endsWith(".yaml"))) {
    const text = fs.readFileSync(path.join(typesDir, file), "utf8");
    assert.doesNotMatch(text, /^\s*max_rounds:/m, `${file} 的轮次单源 defaults.yaml`);
    assert.doesNotMatch(text, /^pass_score:\s*\d+\s*$/m, `${file} 的 pass_score 要写成 env 形式`);
  }
});

test("env 抬起的不是数字就抛错，不静默退回默认值", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.review = { max_rounds: "three" };
  assert.throws(() => normalizeConfig(raw, dir), /review\.max_rounds 必须是数字/);
  const raw2 = rawConfig(dir);
  raw2.types[0].pass_score = "很高";
  assert.throws(() => normalizeConfig(raw2, dir), /pass_score 必须是数字/);
});

test("loadConfig reads the YAML base config and config/types/*.yaml", () => {
  const config = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
  assert.equal(config.types.length, 4);
  const news = findType(config, "ai-news");
  assert.equal(news.name, "AI 资讯快评");
  assert.deepEqual([news.length.min, news.length.max], [1500, 2000]);
  assert.equal(news.illustrations.position_format, "[[img:{index}]]");
  assert.equal(news.knowledge.source, "local");
  assert.equal(news.knowledge_dirs.length, 1);
  assert.equal(news.scoring.pass_score, 78);
  assert.ok(news.scoring.dimensions.every((d) => d.weight > 0 && d.weight <= 1));
  assert.equal(config.classifier.enabled, true);
  assert.equal(config.classifier.default_type, "ai-news");
  assert.equal(config.classifier.question, "article_type");
  assert.equal(config.classifier.topic_question, "topic_pick");
  assert.equal(config.classifier.check_question, "review_check");
  assert.equal(path.isAbsolute(config.project.base_output_folder), true);
  // 渠道参数从 defaults.publish 透传；投递开关不在这段（单源在 steps 节点 handler_options）。
  assert.equal(config.types[0].publish.auto_publish, undefined);
  assert.equal(config.types[0].publish.email.enabled, undefined);
  assert.equal(config.types[0].publish.wechat.enabled, undefined);
  assert.ok(config.types[0].publish.email.to.length > 0);
});

test("models.yaml groups llm / systemone and resolves model ids", () => {
  const config = loadConfig(DEFAULT_CONFIG_REL, { root: PROJECT_ROOT });
  assert.equal(config.models["llm.local"].provider, "ollama");
  assert.equal(config.models["llm.remote"].provider, "openai");
  assert.equal(config.models["systemone.classifier"].provider, "systemone");
  // 两段式判断：一次轻量 + 二次重模型，两个独立节点；
  // classifier 在 defaults.yaml 只剩行为参数，模型 id 配在 steps 节点。
  assert.ok(config.models["systemone.classifier"].model, "一次模型名应解析出来");
  assert.ok(!String(config.models["systemone.classifier"].model).includes("${"), "一次模型名应完成环境变量展开");
  assert.equal(config.models["systemone.classifier-deep"].provider, "systemone");
  assert.ok(!String(config.models["systemone.classifier-deep"].model).includes("${"), "二次模型名应完成环境变量展开");
  assert.equal(getModelProfile(config, "llm.local").provider, "ollama");
  // 旧写法仍然兼容：local → llm.local
  assert.equal(getModelProfile(config, "local").id, "llm.local");
});

test("normalizeModelMap flattens groups and keeps legacy flat models", () => {
  const models = normalizeModelMap({
    models: { legacy: { provider: "mock" } },
    model_groups: {
      llm: { local: { BASE_URL: "http://x", MODEL_NAME: "9b" } },
      opencode: { writer: { command: "opencode" } },
      systemone: { classifier: { base_url: "http://s", model: "jev" } },
    },
  });
  assert.equal(models.legacy.provider, "mock");
  assert.equal(models["llm.local"].provider, "ollama");
  assert.equal(models["llm.local"].base_url, "http://x");
  assert.equal(models["llm.local"].model, "9b");
  assert.equal(models["opencode.writer"].provider, "opencode");
  assert.equal(models["systemone.classifier"].provider, "systemone");
});

test("loadConfig accepts a types map keyed by type id", () => {
  const dir = tempDir("wa-types-map-");
  const typesDir = path.join(dir, "types");
  fs.mkdirSync(typesDir, { recursive: true });
  fs.writeFileSync(
    path.join(typesDir, "t1.yaml"),
    stringifyYaml({
      id: "file-id",
      type: "T1",
      knowledge_base_path: dir,
      style: { persona: "p", tone: "t", audience: "a" },
      word_limit: "100-200",
      pass_score: 80,
      scoring_criteria: [{ id: "a", name: "A", weight: 1 }],
      image_count: 1,
      topic: {},
    }),
  );
  fs.writeFileSync(
    path.join(dir, "article-types.yaml"),
    stringifyYaml({
      types: {
        "t1": "t1.yaml",
        "t2": { file: "t1.yaml", type: "T2" },
      },
    }),
  );

  const config = loadConfig(path.join(dir, "article-types.yaml"), { root: dir });
  assert.deepEqual(config.types.map((type) => type.id), ["t1", "t2"]);
  assert.equal(config.types[0].name, "T1");
  assert.equal(config.types[1].name, "T2");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("类型层的 review.model 是加载期错误：审稿环节的模型调用单源在 steps 节点", () => {
  const dir = tempDir("wa-review-model-");
  try {
    const base = rawConfig(dir);
    const withModel = { ...base, types: [{ ...base.types[0], review: { model: "llm.local" } }] };
    assert.throws(() => normalizeConfig(withModel, process.cwd()), /review\.model 已废弃/);
    // 正常类型（不写 review.model）继续加载
    assert.equal(normalizeConfig(base, process.cwd()).types.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads defaults.yaml before the article-types registry", () => {
  const dir = tempDir("wa-split-");
  const typesDir = path.join(dir, "types");
  fs.mkdirSync(typesDir, { recursive: true });
  fs.writeFileSync(
    path.join(typesDir, "t1.yaml"),
    stringifyYaml({
      id: "t1",
      type: "T1",
      knowledge_base_path: dir,
      style: { persona: "p", tone: "t", audience: "a" },
      word_limit: "100-200",
      pass_score: 80,
      scoring_criteria: [{ id: "a", name: "A", weight: 1 }],
      image_count: 1,
      topic: {},
    }),
  );
  fs.writeFileSync(
    path.join(dir, "defaults.yaml"),
    stringifyYaml({
      project: { base_output_folder: "out" },
      models: { local: { provider: "mock" } },
      classifier: { enabled: false, default_type: "t1" },
      defaults: { model: "local", review: {}, knowledge: {}, illustrations: {}, publish: {} },
    }),
  );
  fs.writeFileSync(path.join(dir, "article-types.yaml"), stringifyYaml({ types: ["t1"] }));

  const config = loadConfig(path.join(dir, "article-types.yaml"), { root: dir });
  assert.equal(config.types.length, 1);
  assert.equal(config.types[0].id, "t1");
  assert.equal(config.classifier.default_type, "t1");
  assert.equal(config.__defaults_path, path.join(dir, "defaults.yaml"));
  assert.equal(config.__path, path.join(dir, "article-types.yaml"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfig still works when defaults.yaml is absent", () => {
  const dir = tempDir("wa-nodefaults-");
  const typesDir = path.join(dir, "types");
  fs.mkdirSync(typesDir, { recursive: true });
  fs.writeFileSync(
    path.join(typesDir, "t1.yaml"),
    stringifyYaml({
      id: "t1",
      type: "T1",
      knowledge_base_path: dir,
      style: { persona: "p", tone: "t", audience: "a" },
      word_limit: "100-200",
      pass_score: 80,
      scoring_criteria: [{ id: "a", name: "A", weight: 1 }],
      image_count: 1,
      topic: {},
    }),
  );
  fs.writeFileSync(path.join(dir, "article-types.yaml"), stringifyYaml({ types: ["t1"] }));

  const config = loadConfig(path.join(dir, "article-types.yaml"), { root: dir });
  assert.equal(config.types.length, 1);
  assert.equal(config.__defaults_path, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("word_limit and image_count accept YAML shorthands", () => {
  assert.deepEqual(normalizeWordLimit("800-1300"), { min: 800, max: 1300, target: 1050 });
  assert.deepEqual(normalizeWordLimit("1500"), { min: 1500, max: 1500, target: 1500 });
  assert.deepEqual(normalizeWordLimit({ min: 1000, max: 2000, target: 1400 }), { min: 1000, max: 2000, target: 1400 });
  assert.deepEqual(normalizeImageCount("1-3"), { min: 1, max: 3 });
  assert.deepEqual(normalizeImageCount(2), { min: 2, max: 2, count: 2 });
  assert.deepEqual(normalizeImageCount({ min: 1, max: 5, default: 3, cover: false }), { min: 1, max: 5, count: 3, cover: false });
  assert.deepEqual(normalizeImageCount(undefined), {});
});

test("normalizeConfig maps YAML-style type fields into the runtime shape", () => {
  const dir = tempDir("wa-cfg-yaml-");
  const config = normalizeConfig(
    {
      defaults: { review: { pass_score: 80 }, illustrations: { style: "扁平插画" } },
      models: { local: { provider: "mock" } },
      types: [
        {
          id: "t1",
          type: "测试类型",
          knowledge_base_path: ["./kb"],
          style: "冷静的观察者",
          word_limit: "500-800",
          pass_score: 70,
          scoring_criteria: [
            { id: "a", name: "A", weight: 1 },
            { id: "b", name: "B", weight: 3 },
          ],
          image_count: { min: 1, max: 4, default: 2 },
          image_position_format: "<<img:{index}>>",
        },
      ],
    },
    dir,
  );
  const type = config.types[0];
  assert.equal(type.name, "测试类型");
  assert.equal(type.style.persona, "冷静的观察者");
  assert.deepEqual(type.length, { min: 500, max: 800, target: 650 });
  assert.equal(type.scoring.pass_score, 70);
  assert.deepEqual(type.scoring.dimensions.map((d) => d.weight), [0.25, 0.75]);
  assert.equal(type.illustrations.style, "扁平插画");
  assert.equal(type.illustrations.count, 2);
  assert.equal(type.illustrations.position_format, "<<img:{index}>>");
  assert.equal(type.knowledge.source, "local");
  assert.equal(path.isAbsolute(type.knowledge_dirs[0]), true);
});

test("validateWarnings flags missing classify call, bad default_type and deep", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.classifier = { enabled: true, default_type: "missing" };
  raw.types[0].knowledge = { "web-search": { enabled: true } };

  // 1) steps 已加载但 classify_type 没有 classify 调用
  const config = normalizeConfig(raw, dir);
  config.steps = { steps: [{ step_name: "classify_type", calls: {} }] };
  let warnings = validateWarnings(config);
  assert.ok(warnings.some((w) => w.includes("models.classify")));
  assert.ok(warnings.some((w) => w.includes("default_type")));
  assert.ok(warnings.some((w) => w.includes("web-search")));

  // 2) classify 调用配了但模型没有 base_url；deep 指向未定义模型
  raw.models = { ...raw.models, "systemone.c": { provider: "systemone" } };
  const withCall = normalizeConfig(raw, dir);
  withCall.steps = {
    steps: [{
      step_name: "classify_type",
      calls: {
        classify: { label: "classify", model_id: "systemone.c", template: "systemone", options: { deep: "systemone.ghost" } },
      },
    }],
  };
  warnings = validateWarnings(withCall);
  assert.ok(warnings.some((w) => w.includes("base_url")));
  assert.ok(warnings.some((w) => w.includes("二次判断")));
});

test("validateConfig reports missing knowledge dirs and unknown models", () => {
  const missing = path.join(os.tmpdir(), "wa-does-not-exist-" + Date.now());
  const config = normalizeConfig(rawConfig(missing), os.tmpdir());
  config.types[0].model = "ghost";
  const issues = validateConfig(config);
  assert.ok(issues.some((i) => i.includes("知识库目录不存在")));
  assert.ok(issues.some((i) => i.includes('model "ghost"')));
});

test("normalizeConfig resolves knowledge.source and WeKnora defaults", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  // auth_header / timeout_ms 单源 defaults.yaml：加载期不再注入 "X-API-Key"/30000 副本，
  // 缺了由 knowledge.mjs 在真正发请求前抛错点名配置路径。
  raw.defaults.knowledge = {
    weknora: { base_url: "http://wk/api/v1", api_key: "k", auth_header: "X-API-Key", timeout_ms: 30000 },
  };
  raw.types[0].knowledge = { source: "weknora", weknora: { kb_ids: "kb1" } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "weknora");
  assert.deepEqual(type.knowledge.weknora.kb_ids, ["kb1"]);
  assert.equal(type.knowledge.weknora.base_url, "http://wk/api/v1");
  assert.equal(type.knowledge.weknora.auth_header, "X-API-Key");
  assert.equal(type.knowledge.weknora.timeout_ms, 30000);
  // match_count 是继承（与本地检索同一个上限），不是同值默认。
  assert.equal(type.knowledge.weknora.match_count, undefined);

  const bare = normalizeConfig(rawConfig(dir), dir).types[0];
  assert.equal(bare.knowledge.weknora.auth_header, undefined);
  assert.equal(bare.knowledge.weknora.timeout_ms, undefined);
});

test("normalizeConfig degrades a WeKnora source when base_url is missing", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "local");
  assert.ok(type.knowledge.weknora.disabled_reason);
});

test("validateConfig flags a WeKnora source without kb_ids", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "weknora" };
  const issues = validateConfig(normalizeConfig(raw, dir));
  assert.ok(issues.some((i) => i.includes("kb_ids")));
});

test("use_weknora=false 把所有类型压回本地目录", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { use_weknora: "false", weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const config = normalizeConfig(raw, dir);
  assert.equal(config.defaults.knowledge.use_weknora, false);
  assert.equal(config.types[0].knowledge.source, "local");
  assert.equal(config.types[0].knowledge.weknora.enabled, false);
  assert.match(config.types[0].knowledge.weknora.disabled_reason, /use_weknora/);
  assert.deepEqual(validateConfig(config), []);
});

test("use_weknora 默认开启，显式 true 保留远端来源", () => {
  const dir = tempDir("wa-cfg-");
  const raw = rawConfig(dir);
  raw.defaults.knowledge = { use_weknora: true, weknora: { base_url: "http://wk", api_key: "k" } };
  raw.types[0].knowledge = { source: "both", weknora: { kb_ids: ["kb1"] } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "both");
  assert.equal(type.knowledge.weknora.enabled, true);
});

test("deepMerge merges nested objects and replaces arrays", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

/* ------------------------------------------------------------------ */
/* article store / resume                                              */
/* ------------------------------------------------------------------ */

function storeConfig(prefix = "wa-store-") {
  const root = tempDir(prefix);
  return { __root: root, project: { base_output_folder: path.join(root, "articles") } };
}

test("normalizeConfig resolves base_output_folder against the project root", () => {
  const config = normalizeConfig({ project: { base_output_folder: "out/wa" }, types: [] }, path.join("C:", "proj"));
  assert.equal(config.project.base_output_folder, path.resolve("C:/proj", "out/wa"));
});

test("createArticle uses the title slug, creates draft/ and published/, and never overwrites", () => {
  const config = storeConfig();
  const type = { id: "ai-news", name: "AI 资讯" };
  const first = createArticle(config, { title: "AI 测试 文章", type });
  const second = createArticle(config, { title: "AI 测试 文章", type });

  assert.equal(first.slug, "AI-测试-文章");
  assert.equal(second.slug, "AI-测试-文章-2");
  assert.ok(fs.existsSync(path.join(config.project.base_output_folder, "draft")));
  assert.ok(fs.existsSync(path.join(config.project.base_output_folder, "published")));
  assert.ok(fs.existsSync(first.dir));
  assert.ok(fs.existsSync(second.dir));
});

test("detectStartStage follows the artifact chain, publish status decides archive", () => {
  const config = storeConfig();
  const { dir } = createArticle(config, { title: "断点续跑", type: { id: "ai-news" } });
  const write = (name, content = "{}") => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  };
  assert.equal(detectStartStage(dir), "topic");
  write(ARTIFACT.topic);
  assert.equal(detectStartStage(dir), "draft");
  // 合并后的 draft 阶段：纲要 / 初稿输入 / 初稿正文都只是阶段内进度
  write(ARTIFACT.outline);
  assert.equal(detectStartStage(dir), "draft");
  write(ARTIFACT.draftInput);
  assert.equal(detectStartStage(dir), "draft");
  write(ARTIFACT.draftMd);
  assert.equal(detectStartStage(dir), "draft");
  write(ARTIFACT.draft);
  assert.equal(detectStartStage(dir), "review");
  write(ARTIFACT.reviewed);
  assert.equal(detectStartStage(dir), "review");
  write(ARTIFACT.review);
  assert.equal(detectStartStage(dir), "compose");
  // 组稿阶段内：润色稿只是分支进度，composed.md 才算 04 完成
  write(ARTIFACT.polished);
  assert.equal(detectStartStage(dir), "compose");
  write(ARTIFACT.composed);
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.final);
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.publish, JSON.stringify({ status: "skipped" }));
  assert.equal(detectStartStage(dir), "publish");
  write(ARTIFACT.publish, JSON.stringify({ status: "published" }));
  assert.equal(detectStartStage(dir), "archive");
});

test("openArticle auto-selects the only article and refuses to guess between several", () => {
  const config = storeConfig();
  const first = createArticle(config, { title: "第一篇", type: { id: "ai-news" } });
  assert.equal(openArticle(config).slug, first.slug);

  const second = createArticle(config, { title: "第二篇", type: { id: "ai-news" } });
  assert.throws(() => openArticle(config), /--article/);
  assert.equal(openArticle(config, "第二篇").slug, second.slug);
  assert.ok(listArticles(config).length === 2);
});

test("01-result.json 的信封驱动文章元信息与已写清单", () => {
  const config = storeConfig();
  const { dir } = createArticle(config, { title: "新布局文章", type: { id: "ai-news" } });
  fs.writeFileSync(
    path.join(dir, ARTIFACT.topic),
    JSON.stringify({
      stage: "topic",
      generated_at: "2026-10-20T02:00:00.000Z",
      title: "新布局文章",
      topic: "一句话主题",
      type: "ai-insight",
      files: { topicMd: "01-step/topic.md", proposal: null },
      sources: [],
    }),
    "utf8",
  );
  const meta = readArticleMeta(dir);
  assert.equal(meta.title, "新布局文章");
  assert.equal(meta.type, "ai-insight");
  assert.equal(meta.startedAt, "2026-10-20T02:00:00.000Z");

  const written = listWrittenArticles(config).filter((w) => w.title === "新布局文章");
  assert.equal(written.length, 1);
  assert.equal(written[0].type, "ai-insight");
  assert.equal(written[0].date, "2026-10-20");
});

test("buildEnvelope 只从上一步的 result 顺延 title/type，并把 files 累积下去", () => {
  const dir = tempDir("wa-env-");
  fs.writeFileSync(
    path.join(dir, ARTIFACT.topic),
    JSON.stringify({ stage: "topic", title: "T", type: "ai-news", files: { topicMd: "01-step/topic.md" } }),
    "utf8",
  );
  const draft = buildEnvelope(dir, "draft", { files: { draft: "02-step/draft.md" } });
  assert.equal(draft.stage, "draft");
  assert.ok(draft.generated_at);
  // 01 已给出的标题与类型不许被后续步骤改写
  assert.equal(draft.title, "T");
  assert.equal(draft.type, "ai-news");
  assert.deepEqual(draft.files, { topicMd: "01-step/topic.md", draft: "02-step/draft.md" });

  // 独立命令可以只有散落稿件（没有上一步 result）：这时才吃调用方给的兜底值
  const orphan = tempDir("wa-env-");
  const review = buildEnvelope(orphan, "review", { title: "散落稿", type: "ai-insight", files: { reviewed: "03-step/reviewed.md" } });
  assert.equal(review.title, "散落稿");
  assert.equal(review.type, "ai-insight");
  assert.deepEqual(review.files, { reviewed: "03-step/reviewed.md" });
  for (const d of [dir, orphan]) fs.rmSync(d, { recursive: true, force: true });
});

test("fileFromResult 从上一步的 result#files 取产物路径，取不到返回 null", () => {
  const dir = tempDir("wa-files-");
  fs.writeFileSync(
    path.join(dir, ARTIFACT.draft),
    JSON.stringify({ stage: "draft", files: { draft: "02-step/draft.md", outline: "02-step/outline.json" } }),
    "utf8",
  );
  // 相对文章根目录的路径原样返回，由调用方 join(dir, rel)
  assert.equal(fileFromResult(dir, "draft", "draft"), "02-step/draft.md");
  assert.equal(fileFromResult(dir, "draft", "outline"), "02-step/outline.json");
  // 地图里没有这个键 / 这一步还没跑 → null，调用方决定怎么回退
  assert.equal(fileFromResult(dir, "draft", "reviewed"), null);
  assert.equal(fileFromResult(dir, "review", "reviewed"), null);
  // 空串不算路径（配置说谎时不能把 "" 当成有效产物）
  fs.writeFileSync(path.join(dir, ARTIFACT.draft), JSON.stringify({ files: { draft: "" } }), "utf8");
  assert.equal(fileFromResult(dir, "draft", "draft"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
