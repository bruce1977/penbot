// 基础设施测试：args / env / config / models / schema / 文章目录与续跑（不属于某个阶段步骤）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { parseArgs, asBool, asNumber, asList } from "../../scripts/lib/args.mjs";
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
import {
  ARTIFACT,
  createArticle,
  detectStartStage,
  listArticles,
  listWrittenArticles,
  openArticle,
  readArticleMeta,
} from "../../scripts/lib/article-store.mjs";
import { tempDir, rawConfig } from "./helpers.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CONFIG_REL = "config/wechat-article/article-types.yaml";

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
  const config = normalizeConfig(rawConfig(dir), dir);
  const type = config.types[0];
  assert.equal(type.id, "t1");
  const [a, b] = type.scoring.dimensions;
  assert.equal(a.weight, 0.25);
  assert.equal(b.weight, 0.75);
  assert.equal(path.isAbsolute(type.knowledge_dirs[0]), true);
  assert.equal(type.review.max_rounds, 3);
  assert.equal(type.illustrations.min, 1);
  assert.equal(type.illustrations.max, 5);
  assert.equal(type.knowledge.max_sources, 8);
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
      version: 2,
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
  raw.defaults.knowledge = { weknora: { base_url: "http://wk/api/v1", api_key: "k" } };
  raw.types[0].knowledge = { source: "weknora", weknora: { kb_ids: "kb1" } };
  const type = normalizeConfig(raw, dir).types[0];
  assert.equal(type.knowledge.source, "weknora");
  assert.deepEqual(type.knowledge.weknora.kb_ids, ["kb1"]);
  assert.equal(type.knowledge.weknora.base_url, "http://wk/api/v1");
  assert.equal(type.knowledge.weknora.auth_header, "X-API-Key");
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
  assert.equal(detectStartStage(dir), "illustrate");
  write(ARTIFACT.illustrated);
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

test("01-result.json 驱动文章元信息与已写清单（旧 01-topic.json 回退）", () => {
  const config = storeConfig();
  const { dir } = createArticle(config, { title: "新布局文章", type: { id: "ai-news" } });
  fs.writeFileSync(
    path.join(dir, ARTIFACT.topic),
    JSON.stringify({
      step: "topic",
      title: "新布局文章",
      topic: "一句话主题",
      type: { id: "ai-insight", source: "classifier", confidence: 0.8 },
      picked: { index: 1 },
      generated_at: "2026-10-20T02:00:00.000Z",
    }),
    "utf8",
  );
  const meta = readArticleMeta(dir);
  assert.equal(meta.title, "新布局文章");
  assert.equal(meta.type, "ai-insight");

  const written = listWrittenArticles(config).filter((w) => w.title === "新布局文章");
  assert.equal(written.length, 1);
  assert.equal(written[0].type, "ai-insight");
  assert.equal(written[0].date, "2026-10-20");

  const legacyDir = createArticle(config, { title: "旧布局文章", type: { id: "ai-news" } }).dir;
  fs.writeFileSync(path.join(legacyDir, "01-topic.json"), JSON.stringify({ title: "旧布局文章", topic: "旧主题", type: "ai-news" }), "utf8");
  const legacy = readArticleMeta(legacyDir);
  assert.equal(legacy.title, "旧布局文章");
  assert.equal(legacy.type, "ai-news");
});
