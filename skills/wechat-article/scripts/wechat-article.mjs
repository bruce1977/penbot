#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, asNumber, asBool, asList } from "./lib/args.mjs";
import { findProjectRoot, loadDotEnv, env } from "./lib/env.mjs";
import { loadConfig, findType, listTypes, getModelProfile, validateConfig, DEFAULT_CONFIG_PATH } from "./lib/config.mjs";
import { ensureDir, writeText, writeJson, readJson, exists, uniqueDir, relativeTo, timestamp, slugify } from "./lib/fsx.mjs";
import { createLogger } from "./lib/log.mjs";
import { createModelClient } from "./lib/models.mjs";
import { indexKnowledge, pickRecent, searchKnowledge, searchWeKnora, collectSources, buildTerms, formatSources } from "./lib/knowledge.mjs";
import {
  buildTopicPrompt,
  buildOutlinePrompt,
  buildDraftPrompt,
  buildScorePrompt,
  buildRevisePrompt,
  buildCorrectFallbackPrompt,
} from "./lib/prompts.mjs";
import {
  normalizeArticle,
  getTitle,
  countWords,
  parseImageMarkers,
  replaceImageMarkers,
  ensureImageMarkers,
  splitFrontmatter,
  buildFrontmatter,
  stripCodeFence,
  collectLocalImages,
} from "./lib/markdown.mjs";
import { createCorrector, applyCorrections } from "./lib/corrector.mjs";
import { generateImages, resolveImageCount, planImages } from "./lib/illustrate.mjs";
import { sendEmail, publishToWechat, markdownToHtml, emailShell, bodyOnly } from "./lib/publish.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = findProjectRoot(process.cwd());
const VERSION = "1.0.0";

const HELP = `wechat-article ${VERSION} — 微信公众号文章自动化管线

用法:
  node skills/wechat-article/scripts/wechat-article.mjs <command> [options]

命令:
  run                执行完整管线（选题 → 检索 → 纲要 → 初稿 → 核稿/评稿/修正 → 配图 → 发布）
  topics             列出知识库中的候选主题，不做生成
  kbs                列出 WeKnora 知识库（获取 kb_ids）
  topic              只做选题（自动选题，或 --topic 手动记录）
  sources            只收集相关资料（本地知识库 / WeKnora）
  outline            只生成纲要（需要 --topic 或 --topic-file，或复用输出目录里的选题）
  draft              只生成初稿（需要纲要在输出目录里，或 --outline-file）
  review             对已有稿件执行核稿/评稿/修正循环
  illustrate         为已有稿件生成并替换配图
  publish            发布已有稿件（邮件 / 公众号草稿）
  validate           校验配置文件
  doctor             检查环境与依赖

分步执行（推荐先 topic → sources → outline → draft，各步共用同一个 --output 目录）:
  node skills/wechat-article/scripts/wechat-article.mjs topic   --type ai-news --output output/wa/demo
  node skills/wechat-article/scripts/wechat-article.mjs sources --type ai-news --output output/wa/demo
  node skills/wechat-article/scripts/wechat-article.mjs outline --type ai-news --output output/wa/demo
  node skills/wechat-article/scripts/wechat-article.mjs draft   --type ai-news --output output/wa/demo

通用参数:
  --config <path>        配置文件，默认 ${DEFAULT_CONFIG_PATH}
  --type <id>            文章类型 id（run/topic/sources/outline/draft 必填）
  --topic <text>         手动指定主题（省略则自动选题；手动时跳过选题模型调用）
  --requirements <text>  手动补充写作要求
  --topic-file <path>    复用已有选题 JSON（如 01-topic.json）
  --sources-file <path>  复用已有素材 JSON（如 02-sources.json）
  --outline-file <path>  复用已有纲要 JSON（如 02-outline.json）
  --article <path>       已有稿件路径（review/illustrate/publish 用）
  --output <dir>         输出目录（分步执行时请复用同一目录；默认 output/wechat-article/<type>/<date>-<slug>）
  --model <profile>      覆盖写作模型 profile
  --review-model <p>     覆盖评稿模型 profile
  --rounds <n>           核稿-评稿-修正最大轮次（1-5，默认取配置）
  --knowledge-source <s> 覆盖知识来源：local | weknora | both
  --images <n>           配图数量（1-5）
  --stage <name>         run 的终止阶段：topic|sources|outline|draft|review|illustrate|publish
  --mock                 使用 mock 模型（不发真实请求，用于验证流程）
  --verbose              输出调试日志
  --help                 显示帮助

发布参数:
  --email / --no-email        覆盖邮件开关
  --to <address>              收件人（可多次或逗号分隔）
  --wechat / --no-wechat      覆盖公众号草稿开关
  --dry-run                   发布演练：不发邮件、不真正投递草稿
  --auto-publish              跳过 publish 的确认门槛（等价于配置 auto_publish=true）

示例:
  node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-insight
  node skills/wechat-article/scripts/wechat-article.mjs run --type ai-insight --mock
  node skills/wechat-article/scripts/wechat-article.mjs run --type ai-news --topic "某模型开源" --requirements "重点写对开发者的影响"
  node skills/wechat-article/scripts/wechat-article.mjs review --article output/wechat-article/ai-insight/20261019-x/article.md
  node skills/wechat-article/scripts/wechat-article.mjs publish --article output/.../article-final.md --to me@example.com
`;

async function main() {
  const { command, options } = parseArgs();
  if (!command || options.help) {
    console.log(HELP);
    return;
  }

  loadDotEnv(PROJECT_ROOT);
  const configPath = path.resolve(PROJECT_ROOT, options.config || DEFAULT_CONFIG_PATH);
  const config = loadConfig(configPath, { root: PROJECT_ROOT });

  switch (command) {
    case "validate":
      return cmdValidate(config);
    case "doctor":
      return cmdDoctor(config, options);
    case "topics":
      return cmdTopics(config, options);
    case "kbs":
      return cmdListKbs(config, options);
    case "topic":
    case "sources":
    case "outline":
    case "draft":
    case "run":
      return cmdPipeline(config, options, command);
    case "review":
      return cmdReviewOnly(config, options);
    case "illustrate":
      return cmdIllustrateOnly(config, options);
    case "publish":
      return cmdPublishOnly(config, options);
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* validate / doctor                                                   */
/* ------------------------------------------------------------------ */

function cmdValidate(config) {
  const issues = validateConfig(config);
  const rows = config.types.map((type) => ({
    id: type.id,
    name: type.name,
    enabled: type.enabled,
    knowledge_dirs: type.knowledge_dirs.length,
    words: `${type.length.min}-${type.length.max}`,
    dimensions: type.scoring.dimensions.length,
    pass_score: type.scoring.pass_score,
    images: `${type.illustrations.min}-${type.illustrations.max}`,
  }));
  console.log(`配置文件：${config.__path}`);
  console.table(rows);
  if (issues.length) {
    console.error("\n发现问题：");
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("配置校验通过。");
  }
}

async function cmdDoctor(config, options) {
  const logger = createLogger({ verbose: true, label: "doctor" });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, status: ok ? "OK" : "FAIL", detail });

  add("Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  add("配置文件", fs.existsSync(config.__path), config.__path);

  for (const type of listTypes(config)) {
    const missing = type.knowledge_dirs.filter((dir) => !fs.existsSync(dir));
    add(`知识库 ${type.id}`, missing.length === 0, missing.length ? `缺失：${missing.join(", ")}` : `${type.knowledge_dirs.length} 个目录`);
  }

  // WeKnora remote knowledge source
  const wkTypes = config.types.filter((t) => t.knowledge.source !== "local");
  if (wkTypes.length === 0) {
    add("知识来源 WeKnora", true, "未启用（全部走本地目录）");
  } else {
    const wk = wkTypes[0].knowledge.weknora;
    if (!wk.base_url || !wk.api_key) {
      add("知识来源 WeKnora", false, "缺少 base_url 或 api_key");
    } else {
      try {
        const res = await fetch(`${wk.base_url.replace(/\/+$/, "")}/knowledge-bases`, {
          headers: { [wk.auth_header || "X-API-Key"]: wk.api_key, "X-Request-ID": String(Date.now()) },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        const kbs = data.data || [];
        const wanted = [...new Set(wkTypes.flatMap((t) => t.knowledge.weknora.kb_ids))];
        const known = new Set(kbs.map((k) => k.id));
        const missingKb = wanted.filter((id) => !known.has(id));
        add(
          "知识来源 WeKnora",
          res.ok && missingKb.length === 0,
          res.ok ? `${kbs.length} 个知识库${missingKb.length ? `，缺失 kb_id：${missingKb.join(", ")}` : ""}` : `HTTP ${res.status}`,
        );
      } catch (error) {
        add("知识来源 WeKnora", false, `${wk.base_url} 不可达：${error.message}`);
      }
    }
  }

  const modelIds = [...new Set(config.types.flatMap((t) => [t.model, t.review?.model]).filter(Boolean))];
  for (const id of modelIds) {
    if (options.mock) {
      add(`模型 ${id}`, true, "mock 模式跳过");
      continue;
    }
    const profile = getModelProfile(config, id);
    if (profile.provider === "ollama") {
      try {
        const res = await fetch(`${(profile.base_url || "http://localhost:11434").replace(/\/+$/, "")}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        const models = (data.models || []).map((m) => m.name || m.model);
        add(`模型 ${id}`, res.ok && models.includes(profile.model), `${profile.base_url} / ${profile.model}${models.includes(profile.model) ? "" : `（可用：${models.slice(0, 6).join(", ")}）`}`);
      } catch (error) {
        add(`模型 ${id}`, false, `${profile.base_url} 不可达：${error.message}`);
      }
    } else if (profile.provider === "opencode") {
      add(`模型 ${id}`, true, `agent CLI: ${profile.command || "opencode"}（运行时验证）`);
    } else if (profile.provider === "openai") {
      add(`模型 ${id}`, Boolean(profile.base_url && profile.model), `${profile.base_url} / ${profile.model}`);
    } else {
      add(`模型 ${id}`, true, profile.provider);
    }
  }

  const correct = config.defaults?.review?.correct_cn || {};
  if (correct.enabled !== false && correct.base_url) {
    try {
      const res = await fetch(`${correct.base_url.replace(/\/+$/, "")}${correct.endpoint || "/api/pipeline"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(correct.api_key ? { [correct.auth_header || "X-Auth-Key"]: correct.api_key } : {}),
        },
        body: JSON.stringify({ text: "这是一句用于连通性测试的中文。" }),
        signal: AbortSignal.timeout(20000),
      });
      add("核稿服务 correct-cn", res.ok, `${correct.base_url}${correct.endpoint} → HTTP ${res.status}`);
    } catch (error) {
      add("核稿服务 correct-cn", false, `${correct.base_url} → ${error.message}（将回退到模型校对）`);
    }
  } else {
    add("核稿服务 correct-cn", true, "未启用");
  }

  const ms = config.defaults?.illustrations?.modelscope;
  if (ms?.enabled !== false) add("配图 ModelScope", Boolean(ms?.api_key || env("PB_MODEL_API_KEY")), (ms?.api_key || env("PB_MODEL_API_KEY")) ? "已配置 key" : "缺少 PB_MODEL_API_KEY");
  const poll = config.defaults?.illustrations?.pollinations;
  add("配图 Pollinations", poll?.enabled !== false, poll?.base_url || "https://image.pollinations.ai");

  const email = config.defaults?.publish?.email;
  if (email?.enabled) add("邮件 Resend", Boolean(email.api_key || env("PB_RESEND_API_KEY")), (email.api_key || env("PB_RESEND_API_KEY")) ? "已配置 key" : "缺少 PB_RESEND_API_KEY");

  const wechat = config.defaults?.publish?.wechat;
  if (wechat?.enabled) {
    const hasId = Boolean(env("WECHAT_MP_APP_ID") || env("WECHAT_APP_ID"));
    add("公众号 Wenyan", hasId, hasId ? "已配置 WECHAT_MP_APP_ID" : "缺少 WECHAT_MP_APP_ID");
  }

  console.table(checks);
  const failed = checks.filter((c) => c.status === "FAIL");
  if (failed.length) {
    logger.warn(`${failed.length} 项检查未通过；管线会在这些环节降级或跳过。`);
    process.exitCode = 0; // doctor is diagnostic only
  }
}

/* ------------------------------------------------------------------ */
/* topics                                                              */
/* ------------------------------------------------------------------ */

async function cmdListKbs(config, options) {
  const wk = config.defaults?.knowledge?.weknora || {};
  const base = String(wk.base_url || "").replace(/\/+$/, "");
  if (!base) throw new Error("未配置 WeKnora base_url（在 config 或 WEKNORA_BASE_URL 中设置）");
  const headers = { "X-Request-ID": String(Date.now()) };
  if (wk.api_key) headers[wk.auth_header || "X-API-Key"] = wk.api_key;
  const res = await fetch(`${base}/knowledge-bases`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`WeKnora HTTP ${res.status}`);
  const data = await res.json();
  const rows = (data.data || []).map((kb) => ({ id: kb.id, name: kb.name, docs: kb.knowledge_count, type: kb.type }));
  console.table(rows);
  console.log(`\n共 ${rows.length} 个知识库（${base}）。把 id 填到 config 里对应类型的 knowledge.weknora.kb_ids。`);
}

async function cmdTopics(config, options) {
  const type = findType(config, requireOption(options, "type"));
  const logger = createLogger({ verbose: asBool(options.verbose), label: "topics" });
  const needLocal = type.knowledge.source === "local" || type.knowledge.source === "both";
  const notes = needLocal
    ? indexKnowledge(type, {
        logger,
        maxFileBytes: type.knowledge.max_file_bytes,
        cacheDir: path.join(PROJECT_ROOT, ".temp", "wechat-article"),
      })
    : [];
  const candidates = await buildCandidates({ type, logger }, notes);
  const recent = pickRecent(candidates, { days: type.topic.lookback_days || type.knowledge.lookback_days, limit: type.topic.candidates || 20 });
  const rows = recent.slice(0, 30).map((note, i) => ({
    "#": i + 1,
    date: note.date,
    title: note.title.slice(0, 48),
    tags: note.tags.slice(0, 4).join("、"),
    chars: note.length,
  }));
  console.table(rows);
  console.log(`\n共 ${candidates.length} 篇（来源 ${type.knowledge.source}），近 ${type.topic.lookback_days || type.knowledge.lookback_days} 天 ${recent.length} 篇。`);
  console.log(`提示：使用 --topic 手动指定主题，或运行 topic --type ${type.id} 自动选题。`);
}

/* ------------------------------------------------------------------ */
/* full pipeline                                                       */
/* ------------------------------------------------------------------ */

async function cmdPipeline(config, options, command) {
  const typeId = requireOption(options, "type");
  const type = findType(config, typeId);
  if (!type.enabled) throw new Error(`文章类型 ${type.id} 已禁用`);

  if (options["knowledge-source"] !== undefined) {
    const src = String(options["knowledge-source"]).toLowerCase();
    if (!["local", "weknora", "both"].includes(src)) throw new Error("--knowledge-source 只能是 local | weknora | both");
    type.knowledge = { ...type.knowledge, source: src };
  }

  const verbose = asBool(options.verbose);
  const mock = asBool(options.mock);
  const stopStage = command === "run" ? String(options.stage || "publish") : command;
  const resume = command !== "run";
  const stamp = timestamp();
  const outputRoot = path.resolve(PROJECT_ROOT, options.output || path.join(config.project.output_dir, type.id, `${stamp.date}-${slugify(options.topic || type.id)}`));
  ensureDir(outputRoot);
  const logger = createLogger({ file: path.join(outputRoot, "pipeline.log"), verbose, label: type.id });

  const ctx = {
    config,
    type,
    logger,
    outputDir: outputRoot,
    mock,
    stamp,
    options,
    state: {
      version: VERSION,
      type: type.id,
      typeName: type.name,
      startedAt: new Date().toISOString(),
      outputDir: outputRoot,
      mock,
      stages: {},
    },
  };

  logger.step(`管线启动：${type.name}（${type.id}）`);
  logger.info(`输出目录：${outputRoot}`);
  logger.info(`知识来源：${type.knowledge.source}${type.knowledge.source !== "local" ? `（WeKnora ${type.knowledge.weknora.kb_ids.length} 个知识库）` : ""}`);
  logger.info(`模型：写作=${options.model || type.model}，评稿=${options["review-model"] || type.review.model || type.model}`);

  try {
    const models = createModelClient(config, logger);
    ctx.models = models;

    // Stage 1: topic ---------------------------------------------------
    const needLocal = type.knowledge.source === "local" || type.knowledge.source === "both";
    const notes = needLocal
      ? indexKnowledge(type, { logger, maxFileBytes: type.knowledge.max_file_bytes, cacheDir: path.join(PROJECT_ROOT, ".temp", "wechat-article") })
      : [];
    if (needLocal && notes.length === 0) throw new Error(`知识库为空：${type.knowledge_dirs.join(", ")}`);
    ctx.notes = notes;

    const topic = await resolveTopic(ctx, notes, resume);
    ctx.topic = topic;
    writeJson(path.join(outputRoot, "01-topic.json"), topic);
    writeText(path.join(outputRoot, "01-topic.md"), renderTopicMarkdown(topic));
    logger.step(`选题完成：《${topic.title || topic.topic}》`);
    ctx.state.stages.topic = { ok: true, title: topic.title || topic.topic, reused: Boolean(ctx.topicReused) };
    if (stopStage === "topic") return finish(ctx);

    // Stage 2: sources -------------------------------------------------
    const sources = await resolveSources(ctx, topic, resume);
    ctx.sources = sources;
    const counts = sources.reduce((acc, s) => ({ ...acc, [s.origin || "local"]: (acc[s.origin || "local"] || 0) + 1 }), {});
    const breakdown = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" + ") || "none";
    logger.info(`收集到 ${sources.length} 篇素材（${breakdown}）：${sources.map((s) => s.title.slice(0, 24)).join(" / ") || "（无）"}`);
    writeJson(path.join(outputRoot, "02-sources.json"), sources);
    ctx.state.stages.sources = { ok: true, count: sources.length, source: type.knowledge.source };
    if (stopStage === "sources") return finish(ctx);

    // Stage 3: outline -------------------------------------------------
    const outline = await resolveOutline(ctx, sources, resume);
    ctx.outline = outline;
    writeJson(path.join(outputRoot, "02-outline.json"), outline);
    writeText(path.join(outputRoot, "02-outline.md"), renderOutlineMarkdown(outline));
    logger.step(`纲要完成：${(outline.outline || []).length} 个小节，${(outline.image_plan || []).length} 张配图`);
    ctx.state.stages.outline = { ok: true, sections: (outline.outline || []).length };
    if (stopStage === "outline") return finish(ctx);

    // Stage 3: draft ---------------------------------------------------
    let article = await generateDraft(ctx, sources, outline);
    const draftFile = path.join(outputRoot, "03-draft.md");
    writeText(draftFile, article);
    ctx.article = article;
    logger.step(`初稿完成：${countWords(article)} 字 → ${path.basename(draftFile)}`);
    ctx.state.stages.draft = { ok: true, words: countWords(article), file: draftFile };
    if (stopStage === "draft") return finish(ctx);

    // Stage 4: review loop --------------------------------------------
    const reviewed = await reviewLoop(ctx, article);
    article = reviewed.article;
    ctx.article = article;
    ctx.review = reviewed.history;
    const reviewedFile = path.join(outputRoot, "04-reviewed.md");
    writeText(reviewedFile, article);
    logger.step(`审稿完成：${reviewed.history.length} 轮，最终 ${reviewed.final.total ?? "n/a"} 分 → ${path.basename(reviewedFile)}`);
    ctx.state.stages.review = {
      ok: true,
      rounds: reviewed.history.length,
      score: reviewed.final.total,
      passed: reviewed.passed,
      file: reviewedFile,
    };
    if (stopStage === "review") return finish(ctx);

    // Stage 5: illustrations ------------------------------------------
    const illustrated = await illustrateArticle(ctx, article);
    article = illustrated.article;
    ctx.article = article;
    ctx.images = illustrated.images;
    const illustratedFile = path.join(outputRoot, "05-illustrated.md");
    writeText(illustratedFile, article);
    logger.step(`配图完成：${illustrated.images.filter((i) => i.success).length}/${illustrated.images.length} → ${path.basename(illustratedFile)}`);
    ctx.state.stages.illustrate = {
      ok: true,
      images: illustrated.images.map((i) => ({ index: i.index, success: i.success, pipeline: i.pipeline || null })),
      file: illustratedFile,
    };
    if (stopStage === "illustrate") return finish(ctx);

    // Stage 6: publish -------------------------------------------------
    const publishResult = await publishArticle(ctx, article, { stage: "final" });
    ctx.publish = publishResult;
    ctx.state.stages.publish = publishResult;

    return finish(ctx);
  } catch (error) {
    logger.error(`管线失败：${error.message}`);
    if (verbose && error.stack) console.error(error.stack);
    ctx.state.error = error.message;
    ctx.state.finishedAt = new Date().toISOString();
    writeJson(path.join(outputRoot, "state.json"), ctx.state);
    process.exitCode = 1;
  }
}

function finish(ctx) {
  ctx.state.finishedAt = new Date().toISOString();
  writeJson(path.join(ctx.outputDir, "state.json"), ctx.state);
  console.log("\n=== 管线完成 ===");
  console.log(`类型：${ctx.type.name}`);
  console.log(`输出：${ctx.outputDir}`);
  for (const [stage, value] of Object.entries(ctx.state.stages)) {
    console.log(`  ${stage.padEnd(10)} ${value.ok === false ? "失败" : "完成"}${value.title ? ` — ${value.title}` : ""}${value.count !== undefined ? ` — ${value.count} 篇` : ""}${value.score !== undefined ? ` — ${value.score} 分` : ""}`);
  }
  if (ctx.state.error) console.log(`错误：${ctx.state.error}`);
  return ctx.state;
}

/* ------------------------------------------------------------------ */
/* stage implementations                                               */
/* ------------------------------------------------------------------ */

async function resolveTopic(ctx, notes, resume) {
  const { options, logger, outputDir } = ctx;
  const file = options["topic-file"]
    ? path.resolve(PROJECT_ROOT, String(options["topic-file"]))
    : resume
      ? path.join(outputDir, "01-topic.json")
      : null;
  if (file && fs.existsSync(file)) {
    logger.info(`复用已有选题：${file}`);
    ctx.topicReused = true;
    return readJson(file);
  }
  const candidates = await buildCandidates(ctx, notes);
  return selectTopic(ctx, candidates);
}

async function buildCandidates(ctx, notes) {
  const { type, logger, mock } = ctx;
  if (notes.length || type.knowledge.source === "local" || mock) return notes;
  // WeKnora-only: use a keyword search to fetch candidate documents.
  const query = (type.topic.keywords || []).join(" ") || type.name;
  try {
    const hits = await searchWeKnora(type, query, { logger, limit: type.topic.candidates || 15 });
    const today = new Date().toISOString().slice(0, 10);
    return hits.map((hit) => {
      const excerpt = (hit.excerpts || []).join(" ");
      return {
        title: hit.title,
        date: hit.date || today,
        mtime: Date.now(),
        tags: hit.tags || [],
        summary: hit.summary || "",
        excerpt,
        length: excerpt.length,
      };
    });
  } catch (error) {
    logger.warn(`WeKnora 候选获取失败：${error.message}`);
    return [];
  }
}

async function resolveSources(ctx, topic, resume) {
  const { options, logger, outputDir, type } = ctx;
  const file = options["sources-file"]
    ? path.resolve(PROJECT_ROOT, String(options["sources-file"]))
    : resume
      ? path.join(outputDir, "02-sources.json")
      : null;
  if (file && fs.existsSync(file)) {
    logger.info(`复用已有素材：${file}`);
    return readJson(file);
  }
  return collectSources(type, { topic, notes: ctx.notes, logger, mock: ctx.mock });
}

async function resolveOutline(ctx, sources, resume) {
  const { options, logger, outputDir } = ctx;
  const file = options["outline-file"]
    ? path.resolve(PROJECT_ROOT, String(options["outline-file"]))
    : resume
      ? path.join(outputDir, "02-outline.json")
      : null;
  if (file && fs.existsSync(file)) {
    logger.info(`复用已有纲要：${file}`);
    return readJson(file);
  }
  return generateOutline(ctx, sources);
}

async function selectTopic(ctx, candidates) {
  const { type, logger, models, mock, options } = ctx;
  const manual = options.topic ? String(options.topic).trim() : "";
  const requirements = options.requirements ? String(options.requirements).trim() : "";

  const recent = pickRecent(candidates, {
    days: type.topic.lookback_days || type.knowledge.lookback_days,
    limit: type.topic.candidates || 12,
  });
  const fallbackCandidates = recent.length ? recent : candidates.slice(0, type.topic.candidates || 12);

  // Manual topic: skip the topic model entirely (one step instead of two).
  if (manual) {
    logger.info(`手动主题：${manual}（跳过选题模型）`);
    const keywords = (type.topic.keywords || []).slice(0, 6);
    return {
      topic: manual,
      title: manual,
      thesis: "",
      angle: "手动指定",
      rationale: requirements || "用户手动指定主题。",
      keywords: keywords.length ? keywords : buildTerms(manual).slice(0, 6),
      source_hints: fallbackCandidates.slice(0, 3).map((n) => n.title),
      title_candidates: [],
    };
  }

  logger.info(`自动选题：${fallbackCandidates.length} 篇候选参与`);

  if (mock) {
    return {
      topic: `（Mock）${type.name}测试主题`,
      title: `（Mock）${type.name}测试标题`,
      thesis: "这是 mock 选题，用于验证脚本流程。",
      angle: "流程验证",
      rationale: "mock 模式不调用模型。",
      keywords: type.topic.keywords?.slice(0, 4) || ["测试"],
      source_hints: fallbackCandidates.slice(0, 3).map((n) => n.title),
      title_candidates: [`（Mock）${type.name}测试标题`],
    };
  }

  const prompt = buildTopicPrompt({
    type,
    candidates: fallbackCandidates,
    mode: "auto",
    userRequirements: requirements,
  });
  const model = options.model || type.model;
  try {
    const result = await models.json(model, { ...prompt, label: "topic" });
    const topic = {
      topic: String(result.topic || "").trim(),
      title: String(result.title || result.topic || "").trim(),
      thesis: String(result.thesis || "").trim(),
      angle: String(result.angle || "").trim(),
      rationale: String(result.rationale || "").trim(),
      keywords: Array.isArray(result.keywords) ? result.keywords.map(String) : [],
      source_hints: Array.isArray(result.source_hints) ? result.source_hints.map(String) : [],
      title_candidates: Array.isArray(result.title_candidates) ? result.title_candidates.map(String) : [],
    };
    if (!topic.topic) topic.topic = fallbackCandidates[0]?.title || type.name;
    if (!topic.title) topic.title = topic.topic;
    return topic;
  } catch (error) {
    logger.warn(`选题模型失败（${error.message}），回退到规则选题`);
    const best = fallbackCandidates[0];
    return {
      topic: best?.title || type.name,
      title: best?.title || type.name,
      thesis: best?.summary || "",
      angle: "基于知识库最新文章",
      rationale: "模型不可用，采用最新文章作为主题。",
      keywords: type.topic.keywords?.slice(0, 4) || [],
      source_hints: fallbackCandidates.slice(0, 3).map((n) => n.title),
      title_candidates: [best?.title || type.name],
    };
  }
}

async function generateOutline(ctx, sources) {
  const { type, models, logger, topic, options, mock } = ctx;
  if (mock) {
    return {
      title: topic.title,
      alternatives: [`${topic.title}（备选）`],
      thesis: topic.thesis,
      audience: type.style.audience || "",
      hook: "mock 开篇场景",
      outline: [
        { heading: "开篇", points: ["mock 要点一"], source_indexes: [1], target_words: 300 },
        { heading: "展开", points: ["mock 要点二", "mock 要点三"], source_indexes: [1, 2], target_words: 900 },
        { heading: "结尾", points: ["mock 结论"], source_indexes: [], target_words: 300 },
      ],
      counterpoint: "mock 反方观点",
      takeaway: "mock 结论",
      image_plan: [
        { position: "cover", description: "一张用于验证流程的封面图", prompt: "abstract blue geometric network, minimal editorial illustration" },
        { position: "inline_1", description: "一张用于验证流程的正文配图", prompt: "abstract data flow lines, minimal editorial illustration" },
      ],
    };
  }

  const prompt = buildOutlinePrompt({
    type,
    topic,
    sources,
    userRequirements: options.requirements ? String(options.requirements) : "",
    maxChars: 16000,
  });
  const model = options.model || type.model;
  let outline;
  try {
    outline = await models.json(model, { ...prompt, label: "outline" });
  } catch (error) {
    logger.warn(`纲要模型失败（${error.message}），使用规则纲要`);
    outline = fallbackOutline(type, topic, sources);
  }
  outline.title = String(outline.title || topic.title || topic.topic).trim();
  outline.outline = Array.isArray(outline.outline) ? outline.outline : [];
  outline.image_plan = Array.isArray(outline.image_plan) ? outline.image_plan : [];
  if (outline.outline.length === 0) outline.outline = fallbackOutline(type, topic, sources).outline;
  const count = resolveImageCount(type, outline, { count: options.images ? asNumber(options.images) : undefined });
  outline.image_plan = planImages(outline, count, { cover: type.illustrations.cover !== false });
  return outline;
}

function fallbackOutline(type, topic, sources) {
  const sections = (type.style.structure?.length ? type.style.structure : ["开篇", "展开", "结尾"]).map((heading, i) => ({
    heading,
    points: sources[i] ? [`参考：${sources[i].title}`] : [],
    source_indexes: sources[i] ? [sources[i].index] : [],
    target_words: Math.round(type.length.target / Math.max(1, type.style.structure?.length || 3)),
  }));
  return {
    title: topic.title || topic.topic,
    alternatives: [],
    thesis: topic.thesis || "",
    audience: type.style.audience || "",
    hook: "",
    outline: sections,
    counterpoint: "",
    takeaway: "",
    image_plan: [],
  };
}

async function generateDraft(ctx, sources, outline) {
  const { type, models, logger, topic, options, mock } = ctx;
  if (mock) {
    const body = [
      "---",
      `title: ${outline.title}`,
      "---",
      "",
      `这是 ${type.name} 的 mock 初稿，用于验证脚本管线。`,
      "",
      "[[img:1|一张用于验证流程的示意图|abstract blue geometric network, minimal editorial illustration]]",
      "",
      "## 第一节",
      "",
      "Mock 内容用于测试选题、纲要、评稿、配图与发布流程，不代表真实写作质量。",
      "",
      "## 第二节",
      "",
      "如果你看到这篇文章，说明脚本的模型调用被替换成了 mock。",
      "",
      "[[img:2|第二张示意图|abstract data flow lines, minimal editorial illustration]]",
      "",
      "## 结尾",
      "",
      "流程验证结束。",
      "",
    ].join("\n");
    return normalizeArticle(body, { title: outline.title, type: type.id });
  }

  const prompt = buildDraftPrompt({ type, topic, outline, sources, maxChars: 18000 });
  const model = options.model || type.model;
  let article;
  try {
    article = await models.complete(model, { ...prompt, label: "draft", maxTokens: Math.max(4096, Math.round(type.length.max * 2)) });
  } catch (error) {
    logger.warn(`初稿模型失败（${error.message}），尝试分节生成`);
    article = await generateDraftBySections(ctx, sources, outline);
  }
  article = normalizeArticle(stripCodeFence(article), { title: outline.title, type: type.id });
  const count = resolveImageCount(type, outline, { count: options.images ? asNumber(options.images) : undefined });
  article = ensureImageMarkers(article, count);
  return article;
}

async function generateDraftBySections(ctx, sources, outline) {
  const { type, models, options, logger } = ctx;
  const model = options.model || type.model;
  const parts = [];
  for (const [i, section] of (outline.outline || []).entries()) {
    logger.info(`分节生成 ${i + 1}/${outline.outline.length}：${section.heading}`);
    const prompt = buildDraftPrompt({
      type,
      topic: ctx.topic,
      outline: { ...outline, outline: [section], image_plan: [] },
      sources,
      maxChars: 10000,
    });
    const text = await models.complete(model, {
      ...prompt,
      prompt: `${prompt.prompt}\n\n本次只写「${section.heading}」这一节，不要写其他小节，不要输出 frontmatter。`,
      label: `draft-section-${i + 1}`,
      maxTokens: 2048,
    });
    parts.push(stripCodeFence(text).replace(/^---[\s\S]*?---\s*/, "").trim());
  }
  return normalizeArticle(`# ${outline.title}\n\n${parts.join("\n\n")}`, { title: outline.title, type: type.id });
}

async function reviewLoop(ctx, article) {
  const { type, models, logger, options, mock } = ctx;
  const maxRounds = clamp(asNumber(options.rounds, type.review.max_rounds), 1, 5);
  const passScore = Number(type.review.pass_score ?? type.scoring.pass_score ?? 80);
  const history = [];
  let current = article;
  let final = null;
  let passed = false;

  for (let round = 1; round <= maxRounds; round += 1) {
    logger.step(`第 ${round}/${maxRounds} 轮：核稿 → 评稿 → 修正`);
    const roundDir = ensureDir(path.join(ctx.outputDir, `04-review/round-${round}`));
    writeText(path.join(roundDir, "before.md"), current);

    // 1) correct-cn (or LLM fallback)
    let correctResult;
    if (mock) {
      correctResult = { enabled: false, ok: true, skipped: true, issues: [], corrected_text: current };
    } else {
      const corrector = createCorrector(type.review.correct_cn, logger);
      correctResult = await corrector.check(current);
    }
    writeJson(path.join(roundDir, "correct.json"), {
      ok: correctResult.ok,
      skipped: Boolean(correctResult.skipped),
      error: correctResult.error || null,
      issues: correctResult.issues,
    });

    let afterCorrect = current;
    if (correctResult.ok && !correctResult.skipped) {
      const applied = applyCorrections(current, correctResult, { apply: type.review.correct_cn.apply || "issues" });
      afterCorrect = applied.text;
      if (applied.applied > 0) logger.info(`核稿修正 ${applied.applied} 处（${applied.mode}）`);
    } else if (correctResult.ok === false && type.review.correct_cn.fallback_llm !== false && !mock) {
      logger.info("核稿服务不可用，使用模型修复已发现的问题");
      afterCorrect = await llmCorrect(ctx, current, correctResult.issues);
    }
    writeText(path.join(roundDir, "after-correct.md"), afterCorrect);

    // 2) score
    const score = await scoreArticle(ctx, afterCorrect, round);
    writeJson(path.join(roundDir, "score.json"), score);
    logger.info(`评稿得分：${score.total ?? "n/a"}（通过线 ${passScore}）${score.verdict ? `，结论 ${score.verdict}` : ""}`);

    const entry = { round, correct: { ok: correctResult.ok, issues: correctResult.issues.length }, score };
    history.push(entry);
    final = score;

    const blocked = (score.issues || []).some((issue) => issue.severity === "high");
    if ((score.total ?? 0) >= passScore && !blocked) {
      passed = true;
      current = afterCorrect;
      logger.step(`第 ${round} 轮达标（${score.total} 分），结束审稿循环`);
      writeText(path.join(roundDir, "after-revise.md"), current);
      break;
    }

    // 3) revise
    if (round === maxRounds) {
      current = afterCorrect;
      logger.warn(`已达到最大轮次 ${maxRounds}，未达通过线，保留当前稿件`);
      writeText(path.join(roundDir, "after-revise.md"), current);
      break;
    }

    current = await reviseArticle(ctx, afterCorrect, score, round);
    writeText(path.join(roundDir, "after-revise.md"), current);
    writeText(path.join(ctx.outputDir, "04-review", `round-${round}-diff.md`), diffSummary(afterCorrect, current));
  }

  return { article: current, history, final: final || { total: null, issues: [] }, passed };
}

async function llmCorrect(ctx, article, issues) {
  const { type, models, options, logger } = ctx;
  const model = options.model || type.model;
  try {
    const prompt = buildCorrectFallbackPrompt({ article, issues });
    const text = await models.complete(model, { ...prompt, label: "correct-fallback" });
    const cleaned = stripCodeFence(text);
    const candidate = normalizeArticle(cleaned, { title: getTitle(article), type: type.id });
    const ratio = countWords(candidate) / Math.max(1, countWords(article));
    if (ratio < 0.7 || ratio > 1.3) {
      logger.warn(`模型校对结果长度异常（${(ratio * 100).toFixed(0)}%），保留原稿`);
      return article;
    }
    return candidate;
  } catch (error) {
    logger.warn(`模型校对失败：${error.message}`);
    return article;
  }
}

async function scoreArticle(ctx, article, round) {
  const { type, models, options, mock, logger } = ctx;
  if (mock) {
    return {
      dimensions: type.scoring.dimensions.map((d) => ({ id: d.id, name: d.name, score: 85, comment: "mock" })),
      total: 85,
      verdict: "pass",
      strengths: ["mock"],
      issues: [],
      must_fix: [],
      suggested_title: "",
      wordCount: countWords(article),
    };
  }

  const wordCount = countWords(article);
  const prompt = buildScorePrompt({ type, article, wordCount, round });
  const model = options["review-model"] || type.review.model || type.model;
  let result;
  try {
    result = await models.json(model, { ...prompt, label: `score-${round}` });
  } catch (error) {
    logger.warn(`评稿模型失败（${error.message}），使用规则评分`);
    return ruleBasedScore(type, article, wordCount);
  }
  return normalizeScore(type, result, wordCount);
}

export function normalizeScore(type, result, wordCount) {
  const dims = type.scoring.dimensions.map((dimension) => {
    const found = (result.dimensions || []).find((d) => d.id === dimension.id || d.name === dimension.name);
    return {
      id: dimension.id,
      name: dimension.name,
      weight: dimension.weight,
      score: clamp(Number(found?.score ?? 60), 0, 100),
      comment: String(found?.comment || ""),
    };
  });
  const weighted = dims.reduce((sum, d) => sum + d.score * d.weight, 0);
  const modelTotal = Number(result.total);
  const total = Number.isFinite(modelTotal) && modelTotal > 0 ? clamp(modelTotal, 0, 100) : Math.round(weighted * 10) / 10;
  const issues = (result.issues || []).map((issue) => ({
    severity: ["high", "medium", "low"].includes(issue.severity) ? issue.severity : "medium",
    dimension: issue.dimension || "",
    location: issue.location || "",
    problem: issue.problem || String(issue),
    fix: issue.fix || "",
  }));
  return {
    dimensions: dims,
    weighted: Math.round(weighted * 10) / 10,
    total: Math.round(total * 10) / 10,
    verdict: result.verdict === "pass" ? "pass" : total >= type.review.pass_score ? "pass" : "revise",
    strengths: Array.isArray(result.strengths) ? result.strengths.map(String) : [],
    issues,
    must_fix: Array.isArray(result.must_fix) ? result.must_fix.map(String) : [],
    suggested_title: String(result.suggested_title || ""),
    wordCount,
  };
}

export function ruleBasedScore(type, article, wordCount) {
  const { body } = splitFrontmatter(article);
  const paragraphs = body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim() && !p.startsWith("[[img:"));
  const longParagraphs = paragraphs.filter((p) => p.replace(/[^\n]/g, "").length > 5 || p.length > 220).length;
  const markers = parseImageMarkers(article).length;
  const inRange = wordCount >= type.length.min && wordCount <= type.length.max;
  const lengthScore = inRange ? 90 : Math.max(40, 90 - Math.abs(wordCount - type.length.target) / Math.max(1, type.length.target) * 80);
  const structureScore = clamp(100 - longParagraphs * 8, 40, 100);
  const imageScore = markers >= type.illustrations.min ? 90 : 50;
  const dims = type.scoring.dimensions.map((d) => {
    let score = 75;
    if (d.id.includes("length") || d.name.includes("篇幅")) score = lengthScore;
    else if (d.id.includes("structure") || d.name.includes("结构")) score = structureScore;
    else if (d.id.includes("read") || d.name.includes("表达")) score = structureScore;
    else if (d.id.includes("practical") || d.name.includes("可复现")) score = imageScore;
    return { id: d.id, name: d.name, weight: d.weight, score: Math.round(score), comment: "规则评分（模型不可用）" };
  });
  const weighted = dims.reduce((sum, d) => sum + d.score * d.weight, 0);
  return {
    dimensions: dims,
    weighted: Math.round(weighted * 10) / 10,
    total: Math.round(weighted * 10) / 10,
    verdict: weighted >= type.review.pass_score ? "pass" : "revise",
    strengths: [],
    issues: [
      ...(inRange ? [] : [{ severity: "high", dimension: "length", location: "全文", problem: `字数 ${wordCount} 不在 ${type.length.min}-${type.length.max} 区间`, fix: "扩充或压缩到目标字数" }]),
      ...(longParagraphs ? [{ severity: "medium", dimension: "structure", location: "全文", problem: `${longParagraphs} 个段落过长`, fix: "拆分超过 5 行的段落" }] : []),
    ],
    must_fix: inRange ? [] : ["调整篇幅到要求区间"],
    suggested_title: "",
    wordCount,
    ruleBased: true,
  };
}

async function reviseArticle(ctx, article, score, round) {
  const { type, models, options, mock, logger } = ctx;
  if (mock) return article;
  const model = options.model || type.model;
  const prompt = buildRevisePrompt({ type, article, review: score, round });
  try {
    const text = await models.complete(model, { ...prompt, label: `revise-${round}`, maxTokens: Math.max(4096, Math.round(type.length.max * 2)) });
    const candidate = normalizeArticle(stripCodeFence(text), { title: getTitle(article), type: type.id });
    const ratio = countWords(candidate) / Math.max(1, countWords(article));
    if (ratio < 0.55 || ratio > 1.6) {
      logger.warn(`修正稿长度异常（${(ratio * 100).toFixed(0)}%），保留原稿`);
      return article;
    }
    return ensureImageMarkers(candidate, parseImageMarkers(article).length || type.illustrations.min);
  } catch (error) {
    logger.warn(`修正模型失败：${error.message}`);
    return article;
  }
}

async function illustrateArticle(ctx, article) {
  const { type, logger, options, mock, outputDir, topic, outline } = ctx;
  const count = resolveImageCount(type, outline, { count: options.images ? asNumber(options.images) : undefined });
  const plans = planImages(outline, count, { cover: type.illustrations.cover !== false });
  const imagesDir = ensureDir(path.join(outputDir, "images"));

  if (mock) {
    // Create tiny placeholder PNGs so downstream publishing can be validated.
    const images = plans.map((plan) => {
      const file = path.join(imagesDir, `${String(plan.index).padStart(2, "0")}_mock.png`);
      if (!exists(file)) fs.writeFileSync(file, MOCK_PNG);
      return { ...plan, success: true, pipeline: "mock", file };
    });
    const replacements = new Map(images.map((image) => [image.index, relativeTo(outputDir, image.file)]));
    return { article: replaceImageMarkers(article, replacements, { onFailure: type.illustrations.on_failure }), images };
  }

  logger.step(`开始生成 ${plans.length} 张配图`);
  const images = await generateImages({
    plans,
    outputDir: imagesDir,
    config: type.illustrations,
    logger,
    topic: topic?.title || topic?.topic || "",
  });

  const replacements = new Map();
  for (const image of images) {
    if (image.success) replacements.set(image.index, relativeTo(outputDir, image.file));
  }
  writeJson(path.join(outputDir, "05-images.json"), images);
  const next = replaceImageMarkers(article, replacements, { onFailure: type.illustrations.on_failure || "comment" });
  return { article: next, images };
}

async function publishArticle(ctx, article, { stage = "final" } = {}) {
  const { type, logger, options, outputDir, stamp, mock } = ctx;
  const publishConfig = type.publish || {};
  const autoPublish = publishConfig.auto_publish === true || asBool(options["auto-publish"]);
  const dryRun = asBool(options["dry-run"]);

  const emailEnabled = options.email !== undefined ? asBool(options.email) : publishConfig.email?.enabled === true;
  const wechatEnabled = options.wechat !== undefined ? asBool(options.wechat) : publishConfig.wechat?.enabled === true;

  const title = getTitle(article, ctx.topic?.title || "未命名文章");
  const finalFile = path.join(outputDir, "article-final.md");
  writeText(finalFile, article);
  writeText(path.join(outputDir, "article.md"), article);

  const result = { email: null, wechat: null, finalFile, title };

  if (!emailEnabled && !wechatEnabled) {
    logger.info("发布环节未启用（email/wechat 均为 false），仅保留本地终稿");
    result.skipped = true;
    return result;
  }

  if (!autoPublish && !dryRun) {
    logger.warn("publish.auto_publish=false：已生成终稿但未自动发布。加 --auto-publish 或 --email/--wechat 显式触发。");
    result.skipped = true;
    result.reason = "auto_publish disabled";
    return result;
  }

  if (emailEnabled) {
    const to = asList(options.to).length ? asList(options.to) : publishConfig.email?.to || [];
    const html = emailShell(title, await markdownToHtml(bodyOnly(article)));
    const htmlFile = writeText(path.join(outputDir, "article-final.html"), html);
    result.email = dryRun
      ? { success: true, dryRun: true, to, htmlFile }
      : await sendEmail({
          to,
          subject: renderSubject(publishConfig.email?.subject || "{title}", { title, date: stamp.date, type: type.name }),
          html,
          images: collectLocalImages(article, outputDir).map((image) => image.file),
          config: publishConfig.email || {},
          logger,
        });
    result.email.htmlFile = htmlFile;
  }

  if (wechatEnabled) {
    result.wechat = await publishToWechat({
      markdownFile: finalFile,
      config: { ...publishConfig.wechat, dry_run: dryRun || publishConfig.wechat?.dry_run },
      logger,
      envFile: path.resolve(PROJECT_ROOT, publishConfig.wechat?.env_file || ".env"),
    });
  }

  writeJson(path.join(outputDir, "06-publish.json"), result);
  return result;
}

function renderSubject(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/* ------------------------------------------------------------------ */
/* standalone commands                                                 */
/* ------------------------------------------------------------------ */

async function cmdReviewOnly(config, options) {
  const articlePath = resolveArticlePath(options);
  const type = findType(config, options.type || inferTypeFromPath(config, articlePath) || requireOption(options, "type"));
  const outputDir = path.dirname(articlePath);
  const logger = createLogger({ file: path.join(outputDir, "review.log"), verbose: asBool(options.verbose), label: "review" });
  const models = createModelClient(config, logger);
  const ctx = {
    config,
    type,
    logger,
    models,
    mock: asBool(options.mock),
    options,
    outputDir,
    topic: { title: getTitle(fs.readFileSync(articlePath, "utf8")) },
  };
  const article = fs.readFileSync(articlePath, "utf8");
  const result = await reviewLoop(ctx, article);
  const out = path.join(outputDir, "04-reviewed.md");
  writeText(out, result.article);
  console.log(`审稿完成：${result.history.length} 轮，${result.final.total ?? "n/a"} 分 → ${out}`);
}

async function cmdIllustrateOnly(config, options) {
  const articlePath = resolveArticlePath(options);
  const type = findType(config, options.type || inferTypeFromPath(config, articlePath) || requireOption(options, "type"));
  const outputDir = path.dirname(articlePath);
  const logger = createLogger({ file: path.join(outputDir, "illustrate.log"), verbose: asBool(options.verbose), label: "illustrate" });
  const article = fs.readFileSync(articlePath, "utf8");
  const ctx = {
    config,
    type,
    logger,
    options,
    mock: asBool(options.mock),
    outputDir,
    topic: { title: getTitle(article) },
    outline: { title: getTitle(article), image_plan: [] },
  };
  const result = await illustrateArticle(ctx, article);
  const out = path.join(outputDir, "05-illustrated.md");
  writeText(out, result.article);
  console.log(`配图完成：${result.images.filter((i) => i.success).length}/${result.images.length} → ${out}`);
}

async function cmdPublishOnly(config, options) {
  const articlePath = resolveArticlePath(options);
  const type = findType(config, options.type || inferTypeFromPath(config, articlePath) || requireOption(options, "type"));
  const outputDir = path.dirname(articlePath);
  const logger = createLogger({ file: path.join(outputDir, "publish.log"), verbose: asBool(options.verbose), label: "publish" });
  const article = fs.readFileSync(articlePath, "utf8");
  const stamp = timestamp();
  const ctx = { config, type, logger, options, outputDir, stamp, topic: { title: getTitle(article) } };
  // Explicit invocation of `publish` counts as consent.
  const result = await publishArticle({ ...ctx, type: { ...type, publish: { ...type.publish, auto_publish: true } } }, article);
  console.log(JSON.stringify(result, null, 2));
  if (result.email?.success === false || result.wechat?.success === false) process.exitCode = 1;
}

function resolveArticlePath(options) {
  const article = options.article;
  if (!article || article === true) throw new Error("缺少 --article <path>");
  const resolved = path.resolve(PROJECT_ROOT, String(article));
  if (!fs.existsSync(resolved)) throw new Error(`稿件不存在：${resolved}`);
  return resolved;
}

function inferTypeFromPath(config, file) {
  const normalized = file.replace(/\\/g, "/");
  return config.types.find((type) => normalized.includes(`/${type.id}/`))?.id;
}

/* ------------------------------------------------------------------ */
/* rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function renderTopicMarkdown(topic) {
  return [
    `# ${topic.title || topic.topic}`,
    "",
    `- 主题：${topic.topic}`,
    `- 核心判断：${topic.thesis || ""}`,
    `- 切入角度：${topic.angle || ""}`,
    `- 选题理由：${topic.rationale || ""}`,
    `- 关键词：${(topic.keywords || []).join("、")}`,
    "",
    "## 备选标题",
    ...(topic.title_candidates || []).map((t) => `- ${t}`),
    "",
    "## 相关素材",
    ...(topic.source_hints || []).map((t) => `- ${t}`),
    "",
  ].join("\n");
}

function renderOutlineMarkdown(outline) {
  return [
    `# ${outline.title}`,
    "",
    `> ${outline.thesis || ""}`,
    "",
    `- 读者：${outline.audience || ""}`,
    `- 开篇钩子：${outline.hook || ""}`,
    "",
    "## 结构",
    ...(outline.outline || []).map(
      (section, i) => `${i + 1}. **${section.heading}**（约 ${section.target_words || "?"} 字）\n${(section.points || []).map((p) => `   - ${p}`).join("\n")}`,
    ),
    "",
    "## 反方观点",
    outline.counterpoint || "",
    "",
    "## 结论",
    outline.takeaway || "",
    "",
    "## 配图",
    ...(outline.image_plan || []).map((img) => `- ${img.position}：${img.description}\n  - prompt: ${img.prompt || ""}`),
    "",
  ].join("\n");
}

function diffSummary(before, after) {
  const beforeWords = countWords(before);
  const afterWords = countWords(after);
  return `# 修正摘要\n\n- 修正前：${beforeWords} 字\n- 修正后：${afterWords} 字\n- 变化：${afterWords - beforeWords} 字\n`;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`缺少参数 --${name}`);
  return String(value);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

main().catch((error) => {
  console.error(`\n错误：${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
