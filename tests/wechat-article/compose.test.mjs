// 组稿（04）阶段测试：de_ai 的档位选择与本地质量判据、重试耗尽后的择优排序、
// 配图通道顺序与限速处理、配图提示词/数据结构/开关三个配置点是否真驱动运行（不发真实请求）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { polishSignals, isBetterAttempt, deAiLevelConfig, composeBranches, finishComposeStage } from "../../scripts/wechat-article.mjs";
import { loadSteps, getStep, resolveCall } from "../../scripts/lib/steps.mjs";
import { loadConfig, featurePaths } from "../../scripts/lib/config.mjs";
import {
  generateImages,
  generateModelScope,
  resolveChannels,
  resolveImageCount,
  resolvePlanSlot,
  rateLimitBackoff,
  withImageExtension,
  validateImageRecords,
} from "../../scripts/comm/wechat-illustrate.mjs";
import { tempDir } from "./helpers.mjs";

const RANGE = { min: 40, max: 200 };
const SRC = "原稿里的第一句话足够长可以填满一个二十字窗口接着第二句写了 2023 年的 1000 万下载量最后是收尾段落";
// 与原稿不共享任何 20 字窗口的改写稿（数字换成另一种写法保留）
const GOOD = "换成完全不同的措辞之后每一句都重新组织过连段落顺序也调整了新的说法读起来更像人写的稿子其中提到 2023 与 1000 两项统计";
const COPY = SRC.replace("最后是收尾段落", "这里换掉了结尾的一句");

test("polishSignals 整篇照抄只报改写不足", () => {
  const signals = polishSignals(SRC, SRC, RANGE, 0.5);
  assert.equal(signals.echo, 1);
  assert.deepEqual(signals.lost_numbers, []);
  assert.deepEqual(signals.violations, ["改写不足：与原稿逐字重叠 100%（上限 50%）"]);
  assert.equal(signals.ok, false);
});

test("polishSignals 字数偏少与原稿数字丢失各自成一条违规", () => {
  const signals = polishSignals(SRC, "重新写过的短句子里没有把 2023 这个年份留住", RANGE, 0.5);
  assert.deepEqual(signals.lost_numbers, ["1000"]);
  assert.match(signals.violations.join("；"), /字数偏少.*要求 40-200/);
  assert.match(signals.violations.join("；"), /原稿数字丢失：1000/);
  assert.equal(signals.violations.length, 2);
});

test("polishSignals 对实质改写且保住数字的稿子放行", () => {
  const signals = polishSignals(SRC, GOOD, RANGE, 0.5);
  assert.deepEqual(signals.violations, []);
  assert.equal(signals.ok, true);
});

test("isBetterAttempt 违规条数相同时取离阈值更近的一版", () => {
  const copied = { attempt: 1, signals: polishSignals(SRC, SRC, RANGE, 0.5) };
  const nearCopy = { attempt: 2, signals: polishSignals(SRC, COPY, RANGE, 0.5) };
  assert.equal(copied.signals.violations.length, 1);
  assert.equal(nearCopy.signals.violations.length, 1);
  assert.ok(nearCopy.signals.echo < copied.signals.echo);
  assert.equal(isBetterAttempt(nearCopy, copied, RANGE, 0.5), true);
  const best = [copied, nearCopy].reduce((a, b) => (isBetterAttempt(b, a, RANGE, 0.5) ? b : a));
  assert.equal(best.attempt, 2);
});

test("isBetterAttempt 违规条数优先于离阈值的距离", () => {
  const twoViolations = { attempt: 1, signals: polishSignals(SRC, "重新写过的短句子里没有把 2023 这个年份留住", RANGE, 0.5) };
  const oneViolation = { attempt: 2, signals: polishSignals(SRC, SRC, RANGE, 0.5) };
  assert.equal(twoViolations.signals.violations.length, 2);
  assert.equal(isBetterAttempt(twoViolations, oneViolation, RANGE, 0.5), false);
  assert.equal(isBetterAttempt(oneViolation, twoViolations, RANGE, 0.5), true);
});

const STEPS = loadSteps("config/wechat-article/steps.yaml");
const levelCtx = (options = {}, type = null) => ({ config: { steps: STEPS }, type, options });

test("de_ai 默认档位取节点 handler_options.level，每档的提示词与重叠上限一一对应", () => {
  // 当前策略：功能打开但用最低档先跑（40-compose.yaml handler_options.level: light）。
  assert.equal(getStep(STEPS, "de_ai").handler_options.level, "light");
  assert.deepEqual(deAiLevelConfig(levelCtx()), { level: "light", prompt: "revision.de_ai_light", maxOverlap: 0.85 });
  assert.deepEqual(deAiLevelConfig(levelCtx({ "de-ai-level": "standard" })), { level: "standard", prompt: "revision.de_ai", maxOverlap: 0.5 });
  assert.deepEqual(deAiLevelConfig(levelCtx({ "de-ai-level": "deep" })), { level: "deep", prompt: "revision.de_ai_deep", maxOverlap: 0.35 });
  for (const id of ["revision.de_ai_light", "revision.de_ai", "revision.de_ai_deep"]) {
    const block = STEPS.prompts[id];
    assert.match(block.system, /Markdown 文章/);
    assert.match(block.user, /\{\{article\}\}/);
    assert.match(block.user, /\[\[img:N\]\]/);
    assert.match(block.user, /\{\{length\.min\}\}-\{\{length\.max\}\}/);
  }
});

test("de_ai 档位可被类型层与命令行覆盖，未定义的档位直接抛错", () => {
  const deepType = { steps: { de_ai: { handler_options: { level: "deep" } } } };
  assert.equal(deAiLevelConfig(levelCtx({}, deepType)).level, "deep");
  // 命令行 > 类型层
  assert.equal(deAiLevelConfig(levelCtx({ "de-ai-level": "light" }, deepType)).level, "light");
  // 类型层指定提示词 id 时优先于档位自带的 prompt
  const promptType = { steps: { de_ai: { prompt: "revision.revision" } } };
  assert.equal(deAiLevelConfig(levelCtx({}, promptType)).prompt, "revision.revision");
  assert.throws(() => deAiLevelConfig(levelCtx({ "de-ai-level": "off" })), /未在 handler_options\.levels 里定义/);
  assert.throws(() => deAiLevelConfig({ config: { steps: { steps: [] } }, type: null, options: {} }), /缺少 handler_options\.level/);
});

test("档位覆盖采样参数：light 只试一轮，deep 提高温度", () => {
  const call = getStep(STEPS, "de_ai").calls.de_ai;
  assert.equal(resolveCall(call, null, "light").options.retry_limit, 1);
  assert.equal(resolveCall(call, null, "standard").options.retry_limit, 3);
  assert.equal(resolveCall(call, null, "deep").options.temperature, 0.9);
  assert.equal(resolveCall(call, null, "deep").options.retry_limit, 3);
});

test("配图通道按 primary → fallback 串行，写了 primary 就不再自动带其他通道", () => {
  assert.deepEqual(resolveChannels({}).map((c) => c.name), ["modelscope", "pollinations"]);
  assert.deepEqual(resolveChannels({ primary: "modelscope", fallback: ["pollinations"] }).map((c) => c.name), ["modelscope", "pollinations"]);
  assert.deepEqual(resolveChannels({ primary: "pollinations" }).map((c) => c.name), ["pollinations"]);
  assert.deepEqual(resolveChannels({ primary: "modelscope", fallback: ["pollinations"], pollinations: { enabled: false } }).map((c) => c.name), ["modelscope"]);
  assert.throws(() => resolveChannels({ primary: "stable-diffusion" }), /未知配图通道/);
});

test("顶层 negative_prompt 落到通道参数，通道段写了同名键才覆盖", () => {
  const [modelscope] = resolveChannels({ negative_prompt: "共享默认", modelscope: { model: "x" } });
  assert.equal(modelscope.options.negative_prompt, "共享默认");
  const [own] = resolveChannels({ negative_prompt: "共享默认", modelscope: { negative_prompt: "通道自己的" } });
  assert.equal(own.options.negative_prompt, "通道自己的");
});

test("rateLimitBackoff 只认限速报错并按 Retry after 退避，上限 120 秒", () => {
  assert.equal(rateLimitBackoff('download HTTP 402: {"error":{"code":"FREE_LIMIT","message":"1 image every 45 seconds per IP. Retry after 29s"}}'), 29000);
  assert.equal(rateLimitBackoff('download HTTP 503: {"error":{"code":"SERVICE_UNAVAILABLE","message":"at its limit right now"}}'), 45000);
  assert.equal(rateLimitBackoff('download HTTP 402: Retry after 9999s'), 120000);
  assert.equal(rateLimitBackoff("missing ModelScope API key"), 0);
  assert.equal(rateLimitBackoff("download HTTP 404: not found"), 0);
});

test("免费档返回 JPEG 时落盘扩展名跟着 content-type 走", () => {
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(withImageExtension("images/01_pollinations.png", "image/jpeg", jpegMagic), "images/01_pollinations.jpg");
  assert.equal(withImageExtension("images/01_pollinations.png", "", Buffer.from([0xff, 0xd8])), "images/01_pollinations.jpg");
  assert.equal(withImageExtension("images/01_modelscope.png", "image/png", Buffer.from([0x89, 0x50])), "images/01_modelscope.png");
});

/* ------------------------------------------------------------------ */
/* 04 配图：配置点必须真驱动运行                                        */
/* ------------------------------------------------------------------ */

const CONFIG = loadConfig(featurePaths("wechat-article").config, { root: process.cwd() });

test("image_generation 的提示词与数据结构都取自配置（代码不留副本）", () => {
  const step = getStep(STEPS, "image_generation");
  assert.equal(step.prompt_id, "revision.image_generation");
  assert.match(step.prompt.user, /\{\{subject\}\}/);
  assert.match(step.prompt.user, /\{\{composition\}\}/);
  assert.ok(Array.isArray(step.output_format.images), "schema 的 output 应是可校验的紧凑 DSL");
});

test("配图模板缺失时 generateImages 直接抛错，不静默用代码里的副本", async () => {
  await assert.rejects(
    () => generateImages({ plans: [{ index: 1, description: "封面" }], outputDir: tempDir("penbot-illustrate-"), config: {} }),
    /缺少配图提示词模板/,
  );
});

test("04-step/images.json 按节点 schema 校验，缺字段报得出来", () => {
  const schema = getStep(STEPS, "image_generation").output_format;
  const good = [{
    index: 1,
    position: "cover",
    scene: "wechat-cover",
    description: "封面画面说明",
    prompt: "a wide banner",
    success: true,
    pipeline: "modelscope",
    file: "01_modelscope.png",
    attempts: [{ pipeline: "modelscope", ok: true, error: null }],
  }];
  assert.deepEqual(validateImageRecords(good, schema), { checked: true, ok: true, errors: [], warnings: [] });
  const bad = validateImageRecords([{ index: 2, position: "inline_1", prompt: "", success: false }], schema);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("；"), /images\[0\]\.scene 缺失/);
  assert.match(bad.errors.join("；"), /images\[0\]\.prompt 不能为空/);
  // 没配 schema = 如实报告「没校验过」，不假装通过
  assert.deepEqual(validateImageRecords(good, undefined), { checked: false, ok: true, errors: [], warnings: [] });
});

test("配图只有封面/正文两种尺寸，尺寸与构图说明单源在 illustrations.scenes", () => {
  const scenes = CONFIG.defaults.illustrations.scenes;
  assert.deepEqual(Object.keys(scenes), ["wechat-cover", "article-inline"]);
  for (const [name, scene] of Object.entries(scenes)) {
    assert.ok(Number(scene.width) > 0 && Number(scene.height) > 0, `${name} 缺尺寸`);
    assert.ok(String(scene.composition || "").length > 0, `${name} 缺构图说明（进 {{composition}}）`);
  }
});

test("04 两条分支的开关只看节点 enabled，type 层可覆盖", () => {
  assert.deepEqual(composeBranches(levelCtx()), { deAi: true, images: true });
  const off = { steps: { de_ai: { enabled: false }, image_generation: { enabled: false } } };
  assert.deepEqual(composeBranches(levelCtx({}, off)), { deAi: false, images: false });
  assert.deepEqual(composeBranches(levelCtx({}, { steps: { image_generation: { enabled: false } } })), { deAi: true, images: false });
});

/* ------------------------------------------------------------------ */
/* 04 复检：降级留痕、封面归属、张数默认、轮询报错、产物如实记录          */
/* ------------------------------------------------------------------ */

test("主通道之后的降级通道带 fallback 标记，降级留痕才会落 _F", () => {
  const [primary, backup] = resolveChannels({ modelscope: {}, pollinations: {} });
  assert.equal(primary.fallback, false);
  assert.equal(backup.fallback, true);
  // 首选被 enabled:false 摘掉后，接手的第一个通道不是降级
  const [only] = resolveChannels({ modelscope: { enabled: false }, pollinations: {} });
  assert.equal(only.name, "pollinations");
  assert.equal(only.fallback, false);
});

test("第 1 张才归封面场景（index 从 1 起，不是从 0）", () => {
  assert.deepEqual(resolvePlanSlot({ index: 1 }), { scene: "wechat-cover", position: "cover" });
  assert.deepEqual(resolvePlanSlot({ index: 2 }), { scene: "article-inline", position: "inline_2" });
  // planImages 已经写好 scene/position 时以配置产物为准
  assert.deepEqual(resolvePlanSlot({ index: 1, scene: "article-inline", position: "inline_1" }), { scene: "article-inline", position: "inline_1" });
});

test("配图张数：--images > 纲要规划 > 类型 image_count.default > min", () => {
  const type = { illustrations: { min: 2, max: 4, count: 3 } };
  // 纲要没排出配图时用类型默认张数，不再悄悄退回 min
  assert.equal(resolveImageCount(type, { image_plan: [] }), 3);
  // 纲要排了 2 张就出 2 张：default 不越过模型的小节规划
  assert.equal(resolveImageCount(type, { image_plan: [{ description: "a" }, { description: "b" }] }), 2);
  assert.equal(resolveImageCount(type, { image_plan: [] }, { count: 4 }), 4);
  assert.equal(resolveImageCount(type, { image_plan: [] }, { count: 9 }), 4);
});

test("ModelScope 轮询报错当场抛出，不白等满 max_polls", async () => {
  const original = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/images/generations")) return { ok: true, status: 200, json: async () => ({ task_id: "t-1" }) };
    polls += 1;
    return { ok: false, status: 404, json: async () => ({ error: "task not found" }) };
  };
  try {
    await assert.rejects(
      () => generateModelScope({
        prompt: "p",
        size: { width: 900, height: 383 },
        outputDir: tempDir("penbot-ms-"),
        index: 1,
        config: { api_key: "k", base_url: "http://example.test", model: "test/Z-Image", timeout_ms: 5000, poll_interval_ms: 1, max_polls: 5 },
      }),
      /poll HTTP 404/,
    );
    assert.equal(polls, 1, "第一次轮询失败就该抛出并降级，不该把 5 次轮询全睡完");
  } finally {
    globalThis.fetch = original;
  }
});

test("配图通道参数与尺寸场景单源 defaults.yaml，缺字段抛错点名配置路径", async () => {
  const partial = { api_key: "k", base_url: "http://x", model: "m", timeout_ms: 1000, poll_interval_ms: 1 };
  await assert.rejects(
    () => generateModelScope({ prompt: "p", size: { width: 900, height: 383 }, outputDir: tempDir("penbot-ms-"), index: 1, config: partial }),
    /缺少配图通道参数：defaults\.yaml illustrations\.modelscope\.max_polls/,
  );
  // 尺寸只在 illustrations.scenes 里定义：代码里的 DEFAULT_SCENES 副本已删
  await assert.rejects(
    () => generateImages({
      plans: [{ index: 1, description: "封面" }],
      outputDir: tempDir("penbot-img-"),
      config: { scenes: {}, primary: "modelscope", modelscope: { ...partial, max_polls: 1 } },
      promptTemplate: "{{subject}}",
    }),
    /缺少配图尺寸：defaults\.yaml illustrations\.scenes/,
  );
});

test("04-result.json 如实记录：回退稿不冒充 polished.md，规划数与分支开关无关", () => {
  const dir = tempDir("penbot-compose-result-");
  finishComposeStage({ outputDir: dir, config: { steps: STEPS }, topic: { title: "标题" }, type: { id: "t" } }, {
    article: "# 终稿",
    images: [],
    planned: 2,
    imagesSkipped: true,
    imagesValidation: null,
    polish: { ok: false, skipped: false, fallback: true, mock: false, model: null, words: 100, attempts: 1, gate: null, level: null, error: "模型不可用" },
  });
  const json = JSON.parse(fs.readFileSync(path.join(dir, "04-result.json"), "utf8"));
  assert.equal(json.files.polished, null, "de_ai 回退时 polished.md 里没有润色稿，不该指向它");
  assert.equal(json.images_planned, 2, "配图分支关闭不改变纲要规划的张数");
  assert.equal(json.images_success, 0);
  assert.equal(json.images_skipped, true);
  assert.equal(json.images_validation, null);
  // compose.result 契约真跑在落盘的那份产物上（不是装饰）：字段形状必须过校验
  assert.deepEqual(json.validation, { checked: true, ok: true, errors: [], warnings: [] }, json.validation?.errors?.join("；"));
  assert.ok(fs.existsSync(path.join(dir, "04-step", "composed.md")), "composed.md 才是 04 的终稿");
});
