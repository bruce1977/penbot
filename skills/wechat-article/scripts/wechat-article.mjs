#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, asNumber, asBool, asList } from "./lib/args.mjs";
import { findProjectRoot, loadDotEnv, env } from "./lib/env.mjs";
import { loadConfig, findType, listTypes, getModelProfile, validateConfig, DEFAULT_CONFIG_PATH } from "./lib/config.mjs";
import { ensureDir, writeText, writeJson, readJson, readText, exists, uniqueDir, relativeTo, timestamp, slugify } from "./lib/fsx.mjs";
import { createLogger } from "./lib/log.mjs";
import { createModelClient } from "./lib/models.mjs";
import { ARTIFACT, createArticle, detectStartStage, openArticle, pickArticleFile, stageIndex } from "./lib/article-store.mjs";
import { archiveArticle } from "./lib/archive.mjs";
import { indexKnowledge, pickRecent, searchKnowledge, searchWeKnora, collectSources, buildTerms, formatSources, extractExcerpts } from "./lib/knowledge.mjs";
import {
  buildTopicPrompt,
  buildOutlinePrompt,
  buildDraftPrompt,
  buildLengthPrompt,
  buildScorePrompt,
  buildRevisePrompt,
  buildCorrectFallbackPrompt,
} from "./lib/prompts.mjs";
import {
  normalizeArticle,
  getTitle,
  countWords,
  lengthAction,
  parseImageMarkers,
  replaceImageMarkers,
  normalizeImageMarkers,
  ensureSectionHeadings,
  parseOutlineMarkdown,
  splitFrontmatter,
  buildFrontmatter,
  stripCodeFence,
  collectLocalImages,
} from "./lib/markdown.mjs";
import { createCorrector, applyCorrections } from "./lib/corrector.mjs";
import { buildDraftInput, normalizeDraftInput, validateDraftInput, loadDraftTemplate, summarizeDraftInput } from "./lib/draft-input.mjs";
import { generateImages, resolveImageCount, planImages } from "./lib/illustrate.mjs";
import { sendEmail, publishToWechat, markdownToHtml, emailShell, bodyOnly, derivePublishStatus } from "./lib/publish.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = findProjectRoot(process.cwd());
const VERSION = "1.0.0";
/** 写初稿前必须准备好的东西：标题 + 大纲 + 相关资料（schema 见 config/prompts/draft.json）。 */
const DRAFT_INPUT_FILE = ARTIFACT.draftInput;

const HELP = `wechat-article ${VERSION} — 微信公众号文章自动化管线

用法:
  node skills/wechat-article/scripts/wechat-article.mjs <command> [options]

文章目录（根目录由 BASE_OUTPUT_FOLDER 决定，默认 output/wechat-article）:
  draft/<slug>/           一篇文章一个目录，所有中间产物和终稿都在里面
  published/              发布成功后归档的 <YYYYMMDD>-<slug>.zip

命令:
  auto               入口 1：从知识库最新文档自动选题 + 自动纲要，然后往下写
  manual             入口 2：用你给的标题 + 提纲，直接往下写（跳过选题与纲要模型）
  run                完整管线（等价 auto，保留兼容）
  topics             列出候选文章；加 --count N --output <目录> 则生成 N 个候选主题（含提纲）的 Markdown
  kbs                列出 WeKnora 知识库（获取 kb_ids）
  topic              只做选题（自动选题，或 --topic 手动记录）
  sources            只收集相关资料（本地知识库）
  outline            只生成纲要（复用文章目录里的选题）
  bundle             把标题 + 大纲 + 相关资料写成 04-draft-input.json
  draft              只生成初稿（读 04-draft-input.json，或 --input 指定一份）
  review             对已有稿件执行核稿/评稿/修正循环
  illustrate         为已有稿件生成并替换配图
  publish            发布已有稿件（邮件 / 公众号草稿）
  validate           校验配置文件（加 --input <file> 可同时校验初稿输入）
  doctor             检查环境与依赖

阶段产物（存在即完成；续跑时看最后一个产物决定从哪继续）:
  01-topic.json/.md → 02-sources.json → 03-outline.json/.md → 04-draft-input.json
  → 05-draft.md → 06-reviewed.md → 07-illustrated.md → 08-final.md → 09-publish.json
  另：06-review/round-N/、images/、state.json、pipeline.log

两个入口（后续步骤完全一致，都可用 --stage 提前停止）:
  # 入口 1：自动选题 + 自动纲要
  node skills/wechat-article/scripts/wechat-article.mjs auto --type ai-news --stage draft

  # 入口 2：手动标题 + 提纲（提纲用「## 小节」+「- 要点」；也可直接给 03-outline.json）
  node skills/wechat-article/scripts/wechat-article.mjs manual --type ai-news --title "文章标题" --outline-file outline.md

中断续跑（从最后一个产物继续，不会重复已完成阶段）:
  node skills/wechat-article/scripts/wechat-article.mjs auto --article <slug>
  node skills/wechat-article/scripts/wechat-article.mjs draft --article <slug>

分步执行（都在同一篇文章目录里追加产物）:
  node skills/wechat-article/scripts/wechat-article.mjs topic   --type ai-news
  node skills/wechat-article/scripts/wechat-article.mjs sources --article <slug>
  node skills/wechat-article/scripts/wechat-article.mjs outline --article <slug>
  node skills/wechat-article/scripts/wechat-article.mjs draft   --article <slug>

通用参数:
  --config <path>        配置文件，默认 ${DEFAULT_CONFIG_PATH}
  --type <id>            文章类型 id（也可在 .env 设置 PB_ARTICLE_TYPE）
  --article <slug>       选择/续跑 draft 下的文章；latest = 最近一篇；分步命令省略时自动选中唯一一篇
  --file <path>          review/illustrate/publish 直接指定稿件文件（也可继续用 --article <path>）
  --slug <name>          新建文章时覆盖目录名（默认取标题的 slug）
  --title <text>         手动入口的文章标题
  --outline-file <path>  手动入口的提纲文件（.md 或 .json）；分步时也可复用自动生成的 03-outline.json
  --outline <text>       手动入口的内联提纲（Markdown 或 JSON）
  --topic <text>         手动指定主题（省略则自动选题；手动时跳过选题模型调用）
  --requirements <text>  手动补充写作要求
  --topic-file <path>    复用已有选题 JSON（如 01-topic.json）
  --sources-file <path>  复用已有素材 JSON（如 02-sources.json）
  --input <path>         初稿输入 JSON（标题 + 大纲 + 资料）；draft / run 可用，跳过前置步骤
  --model <profile>      覆盖写作模型 profile
  --review-model <p>     覆盖评稿模型 profile
  --rounds <n>           核稿-评稿-修正最大轮次（1-5，默认取配置）
  --length-attempts <n>  初稿篇幅自动扩写/压缩的最大次数（默认 2）
  --knowledge-source <s> 覆盖知识来源：local | weknora | both
  --images <n>           配图数量（1-5）
  --count <n>            topics：生成多少个候选主题（含提纲，1-10）
  --md                   topics：把候选主题以 Markdown 打印到终端
  --stage <name>         终止阶段：topic|sources|outline|bundle|draft|review|illustrate|publish
  --mock                 使用 mock 模型（不发真实请求，用于验证流程）
  --verbose              输出调试日志
  --help                 显示帮助

注意：文章根目录只认 BASE_OUTPUT_FOLDER（环境变量 / 配置），--output 已取消。

发布与归档:
  --email / --no-email        覆盖邮件开关
  --to <address>              收件人（可多次或逗号分隔）
  --wechat / --no-wechat      覆盖公众号草稿开关
  --dry-run                   发布演练：不发邮件、不真正投递草稿
  --auto-publish              跳过 publish 的确认门槛（等价于配置 auto_publish=true）

  只有至少一个渠道真实投递成功（status=published）才会归档：
  终稿复制到类型配置的 knowledge_dir → 整个文章目录打包到 published/ → 删除 draft/<slug>/。
  未启用发布、演练、失败都会留在 draft/ 里，可以修好后重跑。

示例:
  node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-insight
  node skills/wechat-article/scripts/wechat-article.mjs run --type ai-insight --mock
  node skills/wechat-article/scripts/wechat-article.mjs run --type ai-news --topic "某模型开源" --requirements "重点写对开发者的影响"
  node skills/wechat-article/scripts/wechat-article.mjs draft --input output/wa-demo/04-draft-input.json
  node skills/wechat-article/scripts/wechat-article.mjs review --article my-article-slug
  node skills/wechat-article/scripts/wechat-article.mjs publish --article my-article-slug --to me@example.com

提示词与初稿校验规则：skills/wechat-article/config/prompts/draft.json（prompt + schema）
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
      return cmdValidate(config, options);
    case "doctor":
      return cmdDoctor(config, options);
    case "topics":
      return cmdTopics(config, options);
    case "kbs":
      return cmdListKbs(config, options);
    case "auto":
    case "manual":
    case "topic":
    case "sources":
    case "outline":
    case "draft":
    case "bundle":
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

function cmdValidate(config, options = {}) {
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

  // 可选：校验一份初稿输入（标题 + 大纲 + 资料）
  const inputArg = options.input || options["draft-input"];
  if (inputArg) {
    const file = path.resolve(PROJECT_ROOT, String(inputArg));
    if (!fs.existsSync(file)) {
      console.error(`\n初稿输入不存在：${file}`);
      process.exitCode = 1;
      return;
    }
    const raw = readJson(file);
    const input = normalizeDraftInput(raw);
    const inputType = config.types.find((t) => t.id === input.type);
    const report = validateDraftInput(raw, { schema: loadDraftTemplate(config.__dir).schema, type: inputType });
    console.log(`\n初稿输入：${file}`);
    for (const line of summarizeDraftInput(input)) console.log(`  ${line}`);
    for (const warning of report.warnings) console.warn(`  [warn] ${warning}`);
    for (const error of report.errors) console.error(`  [error] ${error}`);
    if (report.ok) console.log("初稿输入校验通过。");
    else process.exitCode = 1;
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
  const weknoraEnabled = config.defaults?.knowledge?.use_weknora !== false;
  if (!weknoraEnabled) {
    add("知识来源 WeKnora", true, "已关闭（use_weknora=false），仅使用本地知识库目录");
  } else if (wkTypes.length === 0) {
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
          headers: profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : undefined,
          signal: AbortSignal.timeout(8000),
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
  const msKey = ms?.api_key || env("PB_MODEL_IMAGE_API_KEY") || env("PB_MODEL_API_KEY");
  if (ms?.enabled !== false) add("配图 ModelScope", Boolean(msKey), msKey ? "已配置 key" : "缺少 PB_MODEL_IMAGE_API_KEY");
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
  if (config.defaults?.knowledge?.use_weknora === false) {
    console.log("提示：WeKnora 已关闭（use_weknora=false / PB_USE_WEKNORA=false），此命令仅用于查看远端知识库列表，不影响管线。");
  }
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
  const type = findType(config, resolveTypeId(options));
  applyKnowledgeSource(config, type, options);
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

  const count = clamp(options.count ?? options.n ?? 0, 0, 10);
  const wantsProposals = count > 0 || Boolean(options.output) || asBool(options.md);

  if (!wantsProposals) {
    const rows = recent.slice(0, 30).map((note, i) => ({
      "#": i + 1,
      date: note.date,
      title: note.title.slice(0, 48),
      tags: note.tags.slice(0, 4).join("、"),
      chars: note.length,
    }));
    console.table(rows);
    console.log(`\n共 ${candidates.length} 篇（来源 ${type.knowledge.source}），近 ${type.topic.lookback_days || type.knowledge.lookback_days} 天 ${recent.length} 篇。`);
    console.log(`提示：加 --count 3 --output output 可以生成 3 个候选主题（含提纲）的 Markdown；或运行 topic --type ${type.id} 自动选题。`);
    return;
  }

  const total = count > 0 ? count : 3;
  const models = createModelClient(config, logger);
  const pool = recent.length ? recent : candidates;
  const proposals = await generateProposals({
    type,
    pool,
    count: total,
    models,
    logger,
    mock: asBool(options.mock),
    options,
  });

  const markdown = renderProposalsMarkdown({ type, proposals, poolSize: pool.length, source: type.knowledge.source });
  if (!options.output) {
    console.log(markdown);
    return;
  }
  const file = resolveProposalFile(String(options.output), type);
  ensureDir(path.dirname(file));
  writeText(file, markdown);
  logger.step(`已生成 ${proposals.length} 个候选主题（含提纲）：${file}`);
  console.log(file);
}

/**
 * Ground a proposal outline in real material: a topic alone is too thin to
 * produce a specific outline. Score notes by topic keywords / source_hints,
 * then pull the most relevant paragraphs from the top matches.
 */
function topicSourcesFromPool(topic, pool) {
  const terms = [
    ...new Set(
      [...(topic.keywords || []), ...buildTerms(topic.topic || ""), ...buildTerms(topic.thesis || "")]
        .map((t) => String(t).trim())
        .filter((t) => t.length >= 2),
    ),
  ].slice(0, 14);
  const hints = (topic.source_hints || []).map((h) => String(h).replace(/[《》]/g, "").trim()).filter(Boolean);

  const scored = pool.map((note) => {
    const haystack = String(note.haystack || `${note.title}\n${note.summary || ""}\n${note.body || ""}`).toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term.toLowerCase())) score += 1;
    for (const hint of hints) if (note.title.includes(hint) || hint.includes(note.title.slice(0, 18))) score += 5;
    return { note, score };
  });
  scored.sort((a, b) => b.score - a.score || (b.note.mtime || 0) - (a.note.mtime || 0));
  const matched = scored.filter((s) => s.score > 0).slice(0, 3).map((s) => s.note);
  const picked = matched.length ? matched : pool.slice(0, 3);

  return picked.map((note, i) => {
    const excerpts = extractExcerpts(note.body || "", terms, 1400, 2);
    if (excerpts.length === 0 && note.summary) excerpts.push(note.summary);
    if (excerpts.length === 0) {
      const plain = String(note.body || "").replace(/\s+/g, " ").trim();
      if (plain) excerpts.push(plain.slice(0, 600));
    }
    return {
      index: i + 1,
      title: note.title,
      file: note.file,
      date: note.date,
      tags: note.tags || [],
      summary: note.summary || "",
      excerpts,
    };
  });
}

function normalizeTopic(raw) {
  const topic = {
    topic: String(raw?.topic || "").trim(),
    title: String(raw?.title || raw?.topic || "").trim(),
    thesis: String(raw?.thesis || "").trim(),
    angle: String(raw?.angle || "").trim(),
    rationale: String(raw?.rationale || "").trim(),
    keywords: Array.isArray(raw?.keywords) ? raw.keywords.map(String) : [],
    source_hints: Array.isArray(raw?.source_hints) ? raw.source_hints.map(String) : [],
    title_candidates: Array.isArray(raw?.title_candidates) ? raw.title_candidates.map(String) : [],
  };
  if (!topic.topic) topic.topic = topic.title;
  if (!topic.title) topic.title = topic.topic;
  return topic;
}

/** Step 1 of the pipeline: pick N topics, then give each one an outline (no article retrieval). */
async function generateProposals({ type, pool, count, models, logger, mock, options }) {
  const requirements = options.requirements ? String(options.requirements) : "";

  if (mock) {
    return Array.from({ length: count }, (_, i) => ({
      ...normalizeTopic({
        topic: `（Mock）主题 ${i + 1}`,
        title: `（Mock）${type.name}候选标题 ${i + 1}`,
        thesis: `这是第 ${i + 1} 个 mock 选题，用于验证流程。`,
        angle: "流程验证",
        rationale: "mock 模式不调用模型。",
        keywords: ["测试"],
        source_hints: pool.slice(0, 2).map((n) => n.title),
      }),
      outline: [
        { heading: "开篇", points: ["mock 要点一"], target_words: Math.round(type.length.target / 3) },
        { heading: "展开", points: ["mock 要点二", "mock 要点三"], target_words: Math.round(type.length.target / 3) },
        { heading: "结尾", points: ["mock 结论"], target_words: Math.round(type.length.target / 3) },
      ],
    }));
  }

  let rawTopics = [];
  const prompt = buildTopicPrompt({ type, candidates: pool, mode: "auto", userRequirements: requirements, count });
  try {
    const result = await models.json(options.model || type.model, { ...prompt, label: "topic" });
    rawTopics = Array.isArray(result.topics) ? result.topics : [result];
  } catch (error) {
    logger.warn(`选题模型失败（${error.message}），改用知识库最新文章作为候选`);
    rawTopics = pool.slice(0, count).map((n) => ({
      topic: n.title,
      title: n.title,
      thesis: n.summary || "",
      angle: "基于知识库最新文章",
      rationale: "模型不可用，直接采用候选文章。",
      source_hints: [n.title],
    }));
  }

  const topics = rawTopics.map(normalizeTopic).filter((t) => t.topic).slice(0, count);
  for (const note of pool) {
    if (topics.length >= count) break;
    if (topics.some((t) => t.topic === note.title)) continue;
    topics.push(
      normalizeTopic({
        topic: note.title,
        title: note.title,
        thesis: note.summary || "",
        angle: "基于知识库最新文章",
        source_hints: [note.title],
      }),
    );
  }

  const out = [];
  for (let i = 0; i < topics.length; i += 1) {
    const topic = topics[i];
    logger.info(`生成提纲 ${i + 1}/${topics.length}：《${topic.title}》`);
    out.push({ ...topic, outline: await generateProposalOutline({ type, topic, pool, models, logger, options, requirements }) });
  }
  return out;
}

async function generateProposalOutline({ type, topic, pool, models, logger, options, requirements }) {
  const sources = topicSourcesFromPool(topic, pool);
  logger.info(`  参考素材：${sources.map((s) => s.title).join(" / ") || "（无）"}`);
  const prompt = buildOutlinePrompt({ type, topic, sources, userRequirements: requirements, maxChars: 10000 });

  let outline;
  try {
    outline = await models.json(options.model || type.model, { ...prompt, label: "outline" });
  } catch (error) {
    logger.warn(`提纲模型失败（${error.message}），使用规则提纲`);
    return fallbackOutline(type, topic, sources).outline;
  }
  const sections = Array.isArray(outline.outline) ? outline.outline : [];
  if (sections.length === 0) return fallbackOutline(type, topic, sources).outline;
  return sections.map((section, i) => ({
    heading: String(section.heading || `第 ${i + 1} 节`).trim(),
    points: Array.isArray(section.points) ? section.points.map(String) : [],
    target_words: asNumber(section.target_words) || 0,
  }));
}

function renderProposalsMarkdown({ type, proposals, poolSize, source }) {
  const stamp = timestamp();
  const shown = `${stamp.date.slice(0, 4)}-${stamp.date.slice(4, 6)}-${stamp.date.slice(6, 8)} ${stamp.time.slice(0, 2)}:${stamp.time.slice(2, 4)}`;
  const lines = [
    `# ${type.name} · 候选主题与提纲`,
    "",
    `- 生成时间：${shown}`,
    `- 知识来源：${source}`,
    `- 参与候选：${poolSize} 篇`,
    `- 目标篇幅：${type.length.min}-${type.length.max} 字`,
    "",
  ];

  proposals.forEach((proposal, i) => {
    lines.push("---", "", `## 主题 ${i + 1}：${proposal.title}`, "");
    lines.push(`- **核心判断**：${proposal.thesis || "（未给出）"}`);
    if (proposal.angle) lines.push(`- **切入角度**：${proposal.angle}`);
    if (proposal.rationale) lines.push(`- **为什么现在写**：${proposal.rationale}`);
    if (proposal.keywords.length) lines.push(`- **关键词**：${proposal.keywords.join("、")}`);

    const hints = [...new Set(proposal.source_hints.map((t) => String(t).replace(/[《》]/g, "").trim()).filter(Boolean))];
    if (hints.length) lines.push(`- **素材线索**：${hints.map((t) => `《${t}》`).join(" ")}`);

    if (proposal.title_candidates.length) {
      lines.push("", "**备选标题**", "");
      proposal.title_candidates.forEach((title, n) => lines.push(`${n + 1}. ${title}`));
    }
    lines.push("", "**提纲**", "");
    proposal.outline.forEach((section, n) => {
      lines.push(`${n + 1}. **${section.heading}**${section.target_words ? `（约 ${section.target_words} 字）` : ""}`);
      section.points.forEach((point) => lines.push(`   - ${stripSourceRefs(point)}`));
      lines.push("");
    });
  });

  lines.push("---", "");
  lines.push("选定一个主题后，把该主题整段（从 `## 主题 N` 到下一个 `---` 之前）另存为 `outline.md`，再执行：");
  lines.push("```bash");
  lines.push(`node skills/wechat-article/scripts/wechat-article.mjs manual --type ${type.id} --title "标题" --outline-file outline.md --stage draft`);
  lines.push("```");
  return `${lines.join("\n")}\n`;
}

/** Drop source-reference markers the outline model likes to append, e.g. "（素材 2）". */
function stripSourceRefs(text) {
  return String(text || "")
    .replace(/[（(]\s*(?:素材|来源|资料)\s*[:：]?\s*\d+\s*[)）]/g, "")
    .replace(/[（(]\s*综合判断\s*[)）]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** --output may be a directory (auto filename) or a .md file path. */
function resolveProposalFile(outputArg, type) {
  const target = path.resolve(PROJECT_ROOT, outputArg);
  const ext = path.extname(target).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return target;
  const stamp = timestamp();
  return path.join(target, `topics-${type.id}-${stamp.date}.md`);
}

/* ------------------------------------------------------------------ */
/* full pipeline                                                       */
/* ------------------------------------------------------------------ */

async function cmdPipeline(config, options, command) {
  const entryTitle = assertEntryInputs(options, command);
  if (options.output !== undefined) {
    throw new Error("--output 已取消：文章根目录由环境变量 BASE_OUTPUT_FOLDER 决定；用 --article <slug> 选择或续跑某篇文章");
  }

  // 先定位文章目录，这样 --type 也可以从 state.json 里推断。
  const selector = options.article && options.article !== true ? String(options.article) : "";
  const existing = selector ? openArticle(config, selector) : null;
  const typeId = resolveTypeId(options, existing?.article?.type);
  const type = findType(config, typeId);
  if (!type.enabled) throw new Error(`文章类型 ${type.id} 已禁用`);

  applyKnowledgeSource(config, type, options);

  const verbose = asBool(options.verbose);
  const mock = asBool(options.mock);
  const fullPipeline = ["run", "auto", "manual"].includes(command);
  const manualEntry = command === "manual";
  const bundleOnly = command === "bundle";
  const stopStage = fullPipeline ? String(options.stage || "publish") : command;
  const inputArg = options.input || options["draft-input"];
  const inputProvided = Boolean(inputArg);
  if (inputProvided && !["draft", "run"].includes(command)) {
    throw new Error("--input 只用于 draft / run：给它一份 04-draft-input.json（标题 + 大纲 + 资料）");
  }
  // Entry 2: the user supplies the title (and outline); the topic model is skipped.
  if (manualEntry && !options.topic && entryTitle) options.topic = entryTitle;

  const stamp = timestamp();
  const inputFile = inputProvided ? path.resolve(PROJECT_ROOT, String(inputArg)) : "";
  if (inputProvided && !fs.existsSync(inputFile)) throw new Error(`--input 不存在：${inputFile}`);

  // 文章目录：--article <slug> 指定/续跑；manual 与 --input 直接新建；
  // 其余分步命令要求 draft/ 下已有文章（只有一篇时自动选中）。
  const stepCommands = ["sources", "outline", "bundle", "draft", "review", "illustrate", "publish"];
  let article = existing;
  if (article) {
    // 续跑已有文章，后面按最后一个产物判断从哪开始。
  } else if (manualEntry) {
    article = createArticle(config, { title: entryTitle, slug: options.slug, type, entry: command });
  } else if (inputProvided) {
    article = createArticle(config, { title: readJson(inputFile).title || "", slug: options.slug, type, entry: command });
  } else if (stepCommands.includes(command)) {
    article = openArticle(config);
  }

  let logger = createLogger({
    file: article ? path.join(article.dir, ARTIFACT.log) : undefined,
    verbose,
    label: type.id,
  });

  const previousState = article ? readJsonSafe(path.join(article.dir, ARTIFACT.state)) : null;
  const ctx = {
    config,
    type,
    logger,
    verbose,
    outputDir: article?.dir || "",
    draftTemplate: loadDraftTemplate(config.__dir),
    mock,
    stamp,
    options,
    state: {
      version: VERSION,
      article: article ? { ...article.article, title: article.article.title || entryTitle } : null,
      type: type.id,
      typeName: type.name,
      startedAt: new Date().toISOString(),
      outputDir: article?.dir || "",
      mock,
      stages: { ...(previousState?.stages || {}) },
    },
  };

  /** 选题之后才知道标题，目录名（slug）要等这时才能确定。 */
  function bindArticle(created) {
    article = created;
    ctx.outputDir = created.dir;
    ctx.state.outputDir = created.dir;
    ctx.state.article = { ...created.article, title: created.article.title || ctx.topic?.title || "" };
    logger = createLogger({ file: path.join(created.dir, ARTIFACT.log), verbose, label: type.id });
    ctx.logger = logger;
    ctx.models = createModelClient(config, logger);
    writeJson(path.join(created.dir, ARTIFACT.state), ctx.state);
    logger.info(`文章目录：${created.dir}`);
  }

  logger.step(`管线启动：${type.name}（${type.id}）`);
  logger.info(`入口：${manualEntry ? "手动（标题 + 提纲）" : "自动（基于知识库选题 + 自动纲要）"}`);
  logger.info(`文章根目录：${config.project.base_output_folder}`);
  logger.info(`知识来源：${type.knowledge.source}${type.knowledge.source !== "local" ? `（WeKnora ${type.knowledge.weknora.kb_ids.length} 个知识库）` : ""}`);
  logger.info(`模型：写作=${options.model || type.model}，评稿=${options["review-model"] || type.review.model || type.model}`);

  try {
    ctx.models = createModelClient(config, logger);

    const resume = Boolean(article?.existing);
    const resumeStage = fullPipeline && resume ? detectStartStage(article.dir) : "topic";
    const resumeIndex = stageIndex(resumeStage);
    if (resume) logger.info(`断点续跑：从 ${resumeStage} 阶段开始`);

    // 只在可能真的要用知识库时才建索引；已有 01/02/03 产物时直接读文件。
    const earlyFiles = [ARTIFACT.topic, ARTIFACT.sources, ARTIFACT.outline];
    const earlyMissing = !article || earlyFiles.some((name) => !exists(path.join(article.dir, name)));
    const needLocal = type.knowledge.source === "local" || type.knowledge.source === "both";
    if (!inputProvided) {
      if (needLocal && earlyMissing) {
        ctx.notes = indexKnowledge(type, {
          logger,
          maxFileBytes: type.knowledge.max_file_bytes,
          cacheDir: path.join(PROJECT_ROOT, ".temp", "wechat-article"),
        });
        if (ctx.notes.length === 0) throw new Error(`知识库为空：${type.knowledge_dirs.join(", ")}`);
      } else {
        ctx.notes = [];
      }
    }

    let topic = null;
    let sources = [];
    let outline = null;

    if (!inputProvided && !(fullPipeline && resumeIndex > stageIndex("bundle"))) {
      // Stage 1: topic -------------------------------------------------
      topic = await resolveTopic(ctx, ctx.notes || [], resume);
      ctx.topic = topic;
      if (!article) {
        bindArticle(createArticle(config, { title: topic.title || topic.topic, slug: options.slug, type, entry: command }));
      }
      writeJson(path.join(article.dir, ARTIFACT.topic), topic);
      writeText(path.join(article.dir, ARTIFACT.topicMd), renderTopicMarkdown(topic));
      logger.step(`选题完成：《${topic.title || topic.topic}》`);
      ctx.state.stages.topic = { ok: true, title: topic.title || topic.topic, reused: Boolean(ctx.topicReused) };
      if (stopStage === "topic") return finish(ctx);

      // Stage 2: sources -----------------------------------------------
      sources = await resolveSources(ctx, topic, resume);
      ctx.sources = sources;
      const counts = sources.reduce((acc, s) => ({ ...acc, [s.origin || "local"]: (acc[s.origin || "local"] || 0) + 1 }), {});
      const breakdown = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" + ") || "none";
      logger.info(`收集到 ${sources.length} 篇素材（${breakdown}）：${sources.map((s) => s.title.slice(0, 24)).join(" / ") || "（无）"}`);
      writeJson(path.join(article.dir, ARTIFACT.sources), sources);
      ctx.state.stages.sources = { ok: true, count: sources.length, source: type.knowledge.source };
      if (stopStage === "sources") return finish(ctx);

      // Stage 3: outline -----------------------------------------------
      outline = manualEntry ? buildManualOutline(ctx, topic) : await resolveOutline(ctx, sources, resume);
      ctx.outline = outline;
      writeJson(path.join(article.dir, ARTIFACT.outline), outline);
      writeText(path.join(article.dir, ARTIFACT.outlineMd), renderOutlineMarkdown(outline));
      logger.step(`纲要完成：${(outline.outline || []).length} 个小节，${(outline.image_plan || []).length} 张配图`);
      ctx.state.stages.outline = { ok: true, sections: (outline.outline || []).length };
      if (stopStage === "outline") return finish(ctx);

      // Draft input: 标题 + 大纲 + 相关资料 打包成一份 JSON，初稿阶段只读它。
      ctx.draftInput = resolveDraftInput(ctx, { topic, outline, sources });
      logger.info(`初稿输入：${path.basename(ARTIFACT.draftInput)}（${summarizeDraftInput(ctx.draftInput).join("｜")}）`);
      ctx.state.stages.bundle = { ok: true, file: path.join(article.dir, ARTIFACT.draftInput) };
      if (bundleOnly) {
        logger.step(`准备完成：已生成 ${ARTIFACT.draftInput}，可用 draft --article ${article.slug} 继续写初稿`);
        return finish(ctx);
      }
    } else {
      // 续跑：前面的产物直接读回来，供后续阶段使用。
      ctx.topic = readJsonSafe(path.join(article.dir, ARTIFACT.topic)) || { title: article.article?.title || "" };
      ctx.sources = readJsonSafe(path.join(article.dir, ARTIFACT.sources)) || [];
      ctx.outline = readJsonSafe(path.join(article.dir, ARTIFACT.outline)) || { title: ctx.topic.title, outline: [], image_plan: [] };
      if (exists(path.join(article.dir, ARTIFACT.draftInput))) {
        ctx.draftInput = normalizeDraftInput(readJson(path.join(article.dir, ARTIFACT.draftInput)));
      }
    }

    // --input 直接把「标题 + 大纲 + 资料」交给初稿阶段，跳过选题/检索/纲要。
    if (inputProvided) {
      ctx.draftInput = resolveDraftInput(ctx, {});
      ctx.state.stages.bundle = { ok: true, file: path.join(article.dir, ARTIFACT.draftInput) };
    }

    // Stage 4: draft ---------------------------------------------------
    let articleText;
    if (fullPipeline && resumeIndex > stageIndex("draft")) {
      articleText = readText(path.join(article.dir, ARTIFACT.draft));
      ctx.state.stages.draft = { ok: true, reused: true, file: path.join(article.dir, ARTIFACT.draft) };
      logger.info(`续跑：复用 ${ARTIFACT.draft}`);
    } else {
      if (!ctx.draftInput) throw new Error(`缺少 ${ARTIFACT.draftInput}，先运行 bundle 或从前一步重新开始`);
      articleText = await generateDraft(ctx, ctx.draftInput);
      const draftFile = path.join(article.dir, ARTIFACT.draft);
      writeText(draftFile, articleText);
      ctx.article = articleText;
      logger.step(`初稿完成：${countWords(articleText)} 字 → ${ARTIFACT.draft}`);
      ctx.state.stages.draft = { ok: true, words: countWords(articleText), file: draftFile };
    }
    if (stopStage === "draft") return finish(ctx);

    // Stage 5: review loop --------------------------------------------
    if (fullPipeline && resumeIndex > stageIndex("review")) {
      articleText = readText(path.join(article.dir, ARTIFACT.reviewed));
      ctx.state.stages.review = { ok: true, reused: true, file: path.join(article.dir, ARTIFACT.reviewed) };
      logger.info(`续跑：复用 ${ARTIFACT.reviewed}`);
    } else {
      const reviewed = await reviewLoop(ctx, articleText);
      articleText = reviewed.article;
      ctx.article = articleText;
      ctx.review = reviewed.history;
      const reviewedFile = path.join(article.dir, ARTIFACT.reviewed);
      writeText(reviewedFile, articleText);
      logger.step(`审稿完成：${reviewed.history.length} 轮，最终 ${reviewed.final.total ?? "n/a"} 分 → ${ARTIFACT.reviewed}`);
      ctx.state.stages.review = {
        ok: true,
        rounds: reviewed.history.length,
        score: reviewed.final.total,
        passed: reviewed.passed,
        file: reviewedFile,
      };
    }
    if (stopStage === "review") return finish(ctx);

    // Stage 6: illustrations ------------------------------------------
    if (fullPipeline && resumeIndex > stageIndex("illustrate")) {
      articleText = readText(path.join(article.dir, ARTIFACT.illustrated));
      ctx.images = readJsonSafe(path.join(article.dir, ARTIFACT.images)) || [];
      ctx.state.stages.illustrate = { ok: true, reused: true, file: path.join(article.dir, ARTIFACT.illustrated) };
      logger.info(`续跑：复用 ${ARTIFACT.illustrated}`);
    } else {
      const illustrated = await illustrateArticle(ctx, articleText);
      articleText = illustrated.article;
      ctx.article = articleText;
      ctx.images = illustrated.images;
      const illustratedFile = path.join(article.dir, ARTIFACT.illustrated);
      writeText(illustratedFile, articleText);
      logger.step(`配图完成：${illustrated.images.filter((i) => i.success).length}/${illustrated.images.length} → ${ARTIFACT.illustrated}`);
      ctx.state.stages.illustrate = {
        ok: true,
        images: illustrated.images.map((i) => ({ index: i.index, success: i.success, pipeline: i.pipeline || null })),
        file: illustratedFile,
      };
    }
    if (stopStage === "illustrate") return finish(ctx);

    // Stage 7: publish + archive --------------------------------------
    let publishResult = null;
    if (fullPipeline && resumeIndex > stageIndex("publish")) {
      publishResult = readJsonSafe(path.join(article.dir, ARTIFACT.publish));
      logger.info("续跑：发布已完成，继续归档");
    } else {
      publishResult = await publishArticle(ctx, articleText, { stage: "final" });
      ctx.publish = publishResult;
      ctx.state.stages.publish = publishResult;
    }

    if (publishResult?.status === "published") {
      const archived = archiveArticle({
        config,
        type,
        dir: article.dir,
        slug: article.slug,
        publish: publishResult,
        logger,
      });
      ctx.state.stages.archive = { ok: true, zip: archived.archive?.zip };
      ctx.archivedZip = archived.archive?.zip;
      // 目录已被打包删除，后续不能再往里写 state.json。
      ctx.outputDir = "";
    } else {
      logger.info(`未归档：发布状态为 ${publishResult?.status || "unknown"}（只有真实投递成功才打包并清理 draft）`);
    }

    return finish(ctx);
  } catch (error) {
    ctx.logger.error(`管线失败：${error.message}`);
    if (verbose && error.stack) console.error(error.stack);
    ctx.state.error = error.message;
    ctx.state.finishedAt = new Date().toISOString();
    if (ctx.outputDir) writeJson(path.join(ctx.outputDir, ARTIFACT.state), ctx.state);
    process.exitCode = 1;
  }
}

function finish(ctx) {
  ctx.state.finishedAt = new Date().toISOString();
  if (ctx.outputDir) writeJson(path.join(ctx.outputDir, ARTIFACT.state), ctx.state);
  console.log("\n=== 管线完成 ===");
  console.log(`类型：${ctx.type.name}`);
  if (ctx.state.article?.slug) console.log(`文章：${ctx.state.article.slug}`);
  if (ctx.archivedZip) console.log(`归档：${ctx.archivedZip}`);
  else if (ctx.outputDir) console.log(`输出：${ctx.outputDir}`);
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

/**
 * Entry 2: build the outline from user input instead of the model.
 * Accepts --outline-file <md|json> or --outline <md|json text>.
 */
function buildManualOutline(ctx, topic) {
  const { options, type, logger } = ctx;
  const file = path.resolve(PROJECT_ROOT, String(options["outline-file"] || ""));
  let raw = "";
  let parsed = null;

  if (options["outline-file"]) {
    if (!fs.existsSync(file)) throw new Error(`--outline-file 不存在：${file}`);
    if (file.toLowerCase().endsWith(".json")) {
      parsed = readJson(file);
    } else {
      raw = fs.readFileSync(file, "utf8");
    }
    logger.info(`手动提纲：${file}`);
  } else if (options.outline !== undefined) {
    const inline = String(options.outline);
    if (inline.trim().startsWith("{")) {
      try {
        parsed = JSON.parse(inline);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) raw = inline;
    logger.info("手动提纲：--outline 内联文本");
  }

  if (!parsed && !raw.trim()) {
    throw new Error('manual 入口需要提纲：用 --outline-file <提纲.md> 或 --outline "…"（也可直接传 03-outline.json）');
  }

  const title = String(options.title || topic.title || topic.topic || "").trim();
  const outline = parsed || parseOutlineMarkdown(raw, { title, targetWords: type.length.target });
  if (!outline) throw new Error("无法从提纲中解析出小节，请用「## 小节」配「- 要点」的格式");

  outline.title = String(outline.title || title).trim();
  outline.thesis = String(outline.thesis || topic.thesis || "").trim();
  outline.outline = Array.isArray(outline.outline) ? outline.outline : [];
  outline.image_plan = Array.isArray(outline.image_plan) ? outline.image_plan : [];
  if (outline.outline.length === 0) throw new Error("提纲中没有小节，请用「## 小节」配「- 要点」的格式");
  const count = resolveImageCount(type, outline, { count: options.images ? asNumber(options.images) : undefined });
  outline.image_plan = planImages(outline, count, { cover: type.illustrations.cover !== false });
  logger.info(`手动纲要：${outline.outline.length} 个小节，${outline.image_plan.length} 张配图`);
  return outline;
}

async function resolveOutline(ctx, sources, resume) {
  const { options, logger, outputDir } = ctx;
  const file = options["outline-file"]
    ? path.resolve(PROJECT_ROOT, String(options["outline-file"]))
    : resume
      ? path.join(outputDir, ARTIFACT.outline)
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

/**
 * Resolve the draft input: `--input <file>` wins, otherwise it is built from
 * the topic / outline / sources stages. Either way the result is validated and
 * written to `04-draft-input.json` so the draft step reads one stable artifact.
 */
function resolveDraftInput(ctx, { topic, outline, sources } = {}) {
  const { options, type, logger, outputDir, draftTemplate } = ctx;
  const target = path.join(outputDir, DRAFT_INPUT_FILE);
  let input;
  let raw;

  if (options.input || options["draft-input"]) {
    const file = path.resolve(PROJECT_ROOT, String(options.input || options["draft-input"]));
    if (!fs.existsSync(file)) throw new Error(`--input 不存在：${file}`);
    raw = readJson(file);
    input = normalizeDraftInput(raw);
    if (input.type && input.type !== type.id) {
      throw new Error(`--input 里的 type 是 ${input.type}，与当前 --type ${type.id} 不一致`);
    }
    input.type = type.id;
    logger.info(`初稿输入：复用 ${file}`);
  } else {
    input = buildDraftInput({
      type,
      topic: topic || ctx.topic || {},
      outline: outline || ctx.outline || {},
      sources: sources || ctx.sources || [],
      requirements: options.requirements ? String(options.requirements) : "",
    });
    raw = input;
  }

  const report = validateDraftInput(raw, { schema: draftTemplate.schema, type });
  for (const warning of report.warnings) logger.warn(`初稿输入：${warning}`);
  if (!report.ok) {
    throw new Error(`初稿输入不完整（${DRAFT_INPUT_FILE}）：\n  - ${report.errors.join("\n  - ")}`);
  }
  writeJson(target, input);
  return input;
}

async function generateDraft(ctx, input) {
  const { type, models, logger, options, mock } = ctx;
  if (mock) {
    const body = [
      "---",
      `title: ${input.title}`,
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
    return normalizeArticle(body, { title: input.title, type: type.id });
  }

  const prompt = buildDraftPrompt({ type, input, template: ctx.draftTemplate, maxChars: 18000 });
  const model = options.model || type.model;
  let article;
  try {
    article = await models.complete(model, { ...prompt, label: "draft", maxTokens: Math.max(4096, Math.round(type.length.max * 2)) });
  } catch (error) {
    logger.warn(`初稿模型失败（${error.message}），尝试分节生成`);
    article = await generateDraftBySections(ctx, input);
  }
  article = normalizeArticle(stripCodeFence(article), { title: input.title, type: type.id });
  article = ensureSectionHeadings(article, input.outline.map((section) => section.heading));
  const count = resolveImageCount(type, { image_plan: input.images }, { count: options.images ? asNumber(options.images) : undefined });
  article = normalizeImageMarkers(article, count, input.images);
  article = await fitLength(ctx, article, input);
  return article;
}

/**
 * Bring the draft into the type's word range: expand when too short,
 * condense when too long. At most `maxAttempts` model calls; keeps the
 * candidate only when it actually moves toward the target.
 */
async function fitLength(ctx, article, input) {
  const { type, models, logger, options, mock, draftTemplate } = ctx;
  if (mock) return article;
  const range = { min: type.length.min, max: type.length.max };
  const model = options.model || type.model;
  const maxAttempts = clamp(asNumber(options.lengthAttempts, 2), 0, 4);
  const markers = Math.max(parseImageMarkers(article).length, 0);
  const headings = input.outline.map((section) => section.heading);
  let current = article;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const words = countWords(current);
    const action = lengthAction(words, range);
    if (!action) {
      logger.info(`篇幅合格：${words} 字（要求 ${range.min}-${range.max}）`);
      return current;
    }
    logger.info(`篇幅 ${words} 字，${action === "expand" ? "扩充" : "压缩"}到约 ${type.length.target} 字（第 ${attempt}/${maxAttempts} 次）`);
    const prompt = buildLengthPrompt({
      type,
      article: current,
      wordCount: words,
      direction: action,
      retry: draftTemplate.prompt.retry,
      attempt,
    });
    let candidate;
    try {
      const text = await models.complete(model, {
        ...prompt,
        label: `length-${action}-${attempt}`,
        maxTokens: Math.max(4096, Math.round(type.length.max * 2)),
      });
      candidate = normalizeArticle(stripCodeFence(text), { title: input.title, type: type.id });
      candidate = ensureSectionHeadings(candidate, headings);
      if (markers) candidate = normalizeImageMarkers(candidate, markers, input.images);
    } catch (error) {
      logger.warn(`篇幅调整失败（${error.message}），保留当前稿件`);
      return current;
    }
    const nextWords = countWords(candidate);
    const moved = action === "expand" ? nextWords > words : nextWords < words;
    if (!moved) {
      logger.warn(`篇幅调整未改善（${words} → ${nextWords} 字），保留原稿`);
      return current;
    }
    current = candidate;
    const settled = lengthAction(nextWords, range);
    if (!settled) {
      logger.info(`篇幅调整完成：${words} → ${nextWords} 字`);
      return current;
    }
  }

  const finalWords = countWords(current);
  if (lengthAction(finalWords, range)) {
    logger.warn(`篇幅仍不在区间：${finalWords} 字（要求 ${range.min}-${range.max}）`);
  }
  return current;
}

async function generateDraftBySections(ctx, input) {
  const { type, models, options, logger, draftTemplate } = ctx;
  const model = options.model || type.model;
  const parts = [];
  for (const [i, section] of input.outline.entries()) {
    logger.info(`分节生成 ${i + 1}/${input.outline.length}：${section.heading}`);
    const prompt = buildDraftPrompt({
      type,
      input: { ...input, outline: [section], images: [] },
      template: draftTemplate,
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
  return normalizeArticle(`# ${input.title}\n\n${parts.join("\n\n")}`, { title: input.title, type: type.id });
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
    const roundDir = ensureDir(path.join(ctx.outputDir, ARTIFACT.reviewDir, `round-${round}`));
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
    writeText(path.join(ctx.outputDir, ARTIFACT.reviewDir, `round-${round}-diff.md`), diffSummary(afterCorrect, current));
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
    return normalizeImageMarkers(candidate, parseImageMarkers(article).length || type.illustrations.min);
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
  writeJson(path.join(outputDir, ARTIFACT.images), images);
  const next = replaceImageMarkers(article, replacements, { onFailure: type.illustrations.on_failure || "comment" });
  return { article: next, images };
}

async function publishArticle(ctx, article, { stage = "final" } = {}) {
  const { type, logger, options, outputDir, stamp } = ctx;
  const publishConfig = type.publish || {};
  const autoPublish = publishConfig.auto_publish === true || asBool(options["auto-publish"]);
  const dryRun = asBool(options["dry-run"]);

  const emailEnabled = options.email !== undefined ? asBool(options.email) : publishConfig.email?.enabled === true;
  const wechatEnabled = options.wechat !== undefined ? asBool(options.wechat) : publishConfig.wechat?.enabled === true;

  const title = getTitle(article, ctx.topic?.title || "未命名文章");
  const finalFile = path.join(outputDir, ARTIFACT.final);
  writeText(finalFile, article);

  const result = {
    title,
    status: null,
    email: null,
    wechat: null,
    finalFile,
    channels: { email: emailEnabled, wechat: wechatEnabled },
  };
  const persist = () => {
    writeJson(path.join(outputDir, ARTIFACT.publish), result);
    return result;
  };

  if (!emailEnabled && !wechatEnabled) {
    logger.info("发布环节未启用（email/wechat 均为 false），仅保留本地终稿");
    result.status = "skipped";
    result.reason = "email/wechat disabled";
    return persist();
  }

  if (!autoPublish && !dryRun) {
    logger.warn("publish.auto_publish=false：已生成终稿但未自动发布。加 --auto-publish 或 --email/--wechat 显式触发。");
    result.status = "skipped";
    result.reason = "auto_publish disabled";
    return persist();
  }

  if (emailEnabled) {
    const to = asList(options.to).length ? asList(options.to) : publishConfig.email?.to || [];
    const html = emailShell(title, await markdownToHtml(bodyOnly(article)));
    const htmlFile = writeText(path.join(outputDir, ARTIFACT.finalHtml), html);
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

  result.status = derivePublishStatus({ dryRun, emailEnabled, wechatEnabled, email: result.email, wechat: result.wechat });
  logger.step(`发布状态：${result.status}`);
  return persist();
}

function renderSubject(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/* ------------------------------------------------------------------ */
/* standalone commands                                                 */
/* ------------------------------------------------------------------ */

async function cmdReviewOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.illustrated, ARTIFACT.reviewed, ARTIFACT.draft]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, "review.log"), verbose: asBool(options.verbose), label: "review" });
  const models = createModelClient(config, logger);
  const article = fs.readFileSync(target.path, "utf8");
  const ctx = {
    config,
    type,
    logger,
    models,
    mock: asBool(options.mock),
    options,
    outputDir: target.dir,
    topic: { title: getTitle(article) },
  };
  const result = await reviewLoop(ctx, article);
  const out = path.join(target.dir, ARTIFACT.reviewed);
  writeText(out, result.article);
  console.log(`审稿完成：${result.history.length} 轮，${result.final.total ?? "n/a"} 分 → ${out}`);
}

async function cmdIllustrateOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.reviewed, ARTIFACT.draft, ARTIFACT.illustrated]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, "illustrate.log"), verbose: asBool(options.verbose), label: "illustrate" });
  const article = fs.readFileSync(target.path, "utf8");
  const ctx = {
    config,
    type,
    logger,
    options,
    mock: asBool(options.mock),
    outputDir: target.dir,
    topic: { title: getTitle(article) },
    outline: readJsonSafe(path.join(target.dir, ARTIFACT.outline)) || { title: getTitle(article), image_plan: [] },
  };
  const result = await illustrateArticle(ctx, article);
  const out = path.join(target.dir, ARTIFACT.illustrated);
  writeText(out, result.article);
  console.log(`配图完成：${result.images.filter((i) => i.success).length}/${result.images.length} → ${out}`);
}

async function cmdPublishOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.final, ARTIFACT.illustrated, ARTIFACT.reviewed, ARTIFACT.draft]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, "publish.log"), verbose: asBool(options.verbose), label: "publish" });
  const article = fs.readFileSync(target.path, "utf8");
  const stamp = timestamp();
  const ctx = { config, type, logger, options, outputDir: target.dir, stamp, topic: { title: getTitle(article) } };
  // Explicit invocation of `publish` counts as consent.
  const result = await publishArticle({ ...ctx, type: { ...type, publish: { ...type.publish, auto_publish: true } } }, article);

  // 真实投递成功且稿件在 draft/<slug>/ 里 → 打包并清理。
  if (result.status === "published") {
    try {
      const archived = archiveArticle({ config, type, dir: target.dir, slug: path.basename(target.dir), publish: result, logger });
      result.archive = archived.archive;
    } catch (error) {
      logger.warn(`不归档：${error.message}`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (["failed", "partial"].includes(result.status)) process.exitCode = 1;
}

/**
 * 单步命令选择稿件：
 *   --article <slug>  选 draft/<slug>/ 并取该阶段默认产物
 *   --file <path>     直接给稿件文件（也可以是 --article <path>，兼容旧用法）
 *   省略              自动选中 draft/ 下唯一（或最近）的文章
 */
function resolveArticleTarget(config, options, preferred) {
  const raw = options.file || options.article;
  if (raw && raw !== true) {
    const text = String(raw);
    const asPath = path.resolve(PROJECT_ROOT, text);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
      return { path: asPath, dir: path.dirname(asPath), slug: null };
    }
    if (text === "latest" || (!text.includes("/") && !text.includes("\\"))) {
      const opened = openArticle(config, text);
      const file = pickArticleFile(opened.dir, preferred);
      if (!file) throw new Error(`文章 ${opened.slug} 里没有可用的稿件（期望其中之一：${preferred.join(" / ")}）`);
      return { path: file, dir: opened.dir, slug: opened.slug };
    }
    throw new Error(`稿件不存在：${asPath}`);
  }
  const opened = openArticle(config);
  const file = pickArticleFile(opened.dir, preferred);
  if (!file) throw new Error(`文章 ${opened.slug} 里没有可用的稿件（期望其中之一：${preferred.join(" / ")}）`);
  return { path: file, dir: opened.dir, slug: opened.slug };
}

function inferTypeFromDir(config, dir) {
  const state = readJsonSafe(path.join(dir, ARTIFACT.state));
  const id = state?.article?.type || state?.type;
  if (id && config.types.some((type) => type.id === id)) return id;
  return inferTypeFromPath(config, dir);
}

function inferTypeFromPath(config, file) {
  const normalized = file.replace(/\\/g, "/");
  return config.types.find((type) => normalized.includes(`/${type.id}/`))?.id;
}

function readJsonSafe(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
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

/** Render an outline as Markdown that `parseOutlineMarkdown` can read back verbatim. */
function renderOutlineMarkdown(outline) {
  const parts = [
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
  ];
  if (outline.counterpoint) parts.push("", "## 反方观点", outline.counterpoint);
  if (outline.takeaway) parts.push("", "## 结论", outline.takeaway);
  parts.push(
    "",
    "## 配图",
    ...(outline.image_plan || []).map((img) =>
      img.prompt ? `- ${img.position}：${img.description}\n  - prompt: ${img.prompt}` : `- ${img.position}：${img.description}`,
    ),
    "",
  );
  return parts.join("\n");
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

/**
 * Apply --knowledge-source, respecting the global WeKnora switch
 * (knowledge.use_weknora / PB_USE_WEKNORA).
 */
function applyKnowledgeSource(config, type, options) {
  if (options["knowledge-source"] === undefined) return type;
  const src = String(options["knowledge-source"]).toLowerCase();
  if (!["local", "weknora", "both"].includes(src)) throw new Error("--knowledge-source 只能是 local | weknora | both");
  if (src !== "local") {
    if (config.defaults?.knowledge?.use_weknora === false) {
      throw new Error("WeKnora 已关闭（use_weknora=false / PB_USE_WEKNORA=false）：当前只能用 --knowledge-source local，要启用请设 PB_USE_WEKNORA=true");
    }
    if (!type.knowledge.weknora.base_url) throw new Error("WeKnora 未配置 base_url，无法使用远端知识库");
  }
  type.knowledge = { ...type.knowledge, source: src };
  return type;
}

/** Resolve the article type from --type, else PB_ARTICLE_TYPE / ARTICLE_TYPE, else --input's type. */
function resolveTypeId(options, fallback = "") {
  let value = options.type || env("PB_ARTICLE_TYPE") || env("ARTICLE_TYPE") || fallback;
  if (!value && (options.input || options["draft-input"])) {
    try {
      value = readJson(path.resolve(PROJECT_ROOT, String(options.input || options["draft-input"]))).type;
    } catch {
      /* fall through to the error below */
    }
  }
  if (!value || value === true) {
    throw new Error("缺少文章类型：用 --type <id> 指定，或在 .env 里设置 PB_ARTICLE_TYPE=<id>");
  }
  return String(value);
}

/**
 * Fail fast on bad entry arguments, before spending time on retrieval/models.
 * Entry 2 (manual) needs a title and an outline; either may come from the file.
 * Returns the title to use (empty for other entries).
 */
function assertEntryInputs(options, command) {
  if (command !== "manual") return "";
  const fileArg = options["outline-file"];
  const inline = options.outline !== undefined ? String(options.outline) : "";
  if (!fileArg && !inline.trim()) {
    throw new Error('manual 入口需要提纲：用 --outline-file <提纲.md> 或 --outline "…" 提供（也可直接传 03-outline.json）');
  }
  let text = inline;
  if (fileArg) {
    const file = path.resolve(PROJECT_ROOT, String(fileArg));
    if (!fs.existsSync(file)) throw new Error(`--outline-file 不存在：${file}`);
    text = fs.readFileSync(file, "utf8");
  }
  const given = String(options.title || options.topic || "").trim();
  if (given) return given;
  if (fileArg && String(fileArg).toLowerCase().endsWith(".json")) {
    try {
      const json = JSON.parse(text);
      const title = String(json.title || "").trim();
      if (title) return title;
    } catch {
      throw new Error(`--outline-file 不是合法 JSON：${fileArg}`);
    }
  }
  if (text.trim().startsWith("{")) {
    try {
      const title = String(JSON.parse(text).title || "").trim();
      if (title) return title;
    } catch {
      /* not JSON — fall through to the Markdown checks */
    }
  }
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  throw new Error('manual 入口需要标题：用 --title "文章标题"，或在提纲首行写「# 标题」');
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
