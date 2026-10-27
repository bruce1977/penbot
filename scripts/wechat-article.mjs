#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs, asNumber, asBool, asList } from "./lib/args.mjs";
import { findProjectRoot, loadDotEnv, env, needConfig, needNumber } from "./lib/env.mjs";
import { loadConfig, findType, listTypes, getModelProfile, validateConfig, validateWarnings, featurePaths } from "./lib/config.mjs";
import { ensureDir, writeText, writeJson, readJson, readText, exists, uniqueDir, relativeTo, timestamp, slugify } from "./lib/fsx.mjs";
import { createLogger } from "./lib/log.mjs";
import { createModelClient } from "./lib/models.mjs";
import { ARTIFACT, buildEnvelope, createArticle, detectStartStage, fileFromResult, listWrittenArticles, openArticle, pickArticleFile, readArticleMeta, stageIndex } from "./lib/article-store.mjs";
import { archiveArticle } from "./lib/archive.mjs";
import { indexKnowledge, pickRecent, searchKnowledge, searchWeKnora, collectSources, buildTerms, validateProposals, formatSources, landSources, extractExcerpts, daysAgo, isFreshlyCollected, termHeatmap, formatHeatmap } from "./lib/knowledge.mjs";
import {
  buildTopicPrompt,
  buildOutlinePrompt,
  buildDraftPrompt,
  buildScorePrompt,
  buildRevisePrompt,
  buildDeAiPrompt,
} from "./lib/prompts.mjs";
import {
  normalizeArticle,
  getTitle,
  countWords,
  lengthAction,
  parseImageMarkers,
  replaceImageMarkers,
  normalizeImageMarkers,
  formatImageMarker,
  ensureSectionHeadings,
  parseOutlineMarkdown,
  splitFrontmatter,
  buildFrontmatter,
  stripCodeFence,
  relocateLocalImages,
  verbatimOverlap,
  missingNumbers,
} from "./lib/markdown.mjs";
import { createCorrector, summarizeSensitive } from "./lib/corrector.mjs";
import { buildDraftInput, normalizeDraftInput, validateDraftInput, draftTemplateFromSteps, summarizeDraftInput } from "./lib/draft-input.mjs";
import { composePrompt, generateImages, resolveImageCount, planImages, validateImageRecords } from "./comm/wechat-illustrate.mjs";
import { validateProduced } from "./lib/template.mjs";
import { sendEmail, publishToWechat, markdownToHtml, emailShell, bodyOnly, derivePublishStatus } from "./comm/wechat-publish.mjs";
import { classifyArticle, classifyOrFallback, formatOutline, selectBestTopic, checkRevisionNeeded, needEndpointParam, needGateParam } from "./lib/classify.mjs";
import { createRecorder } from "./lib/io-record.mjs";
import {
  loadSteps,
  validateSteps,
  resolveStep,
  resolveSteps,
  resolveCall,
  stepNames,
  stepCallContract,
  promptById,
} from "./lib/steps.mjs";

const PROJECT_ROOT = findProjectRoot(process.cwd());
// 本入口的功能路径布局（config/wechat-article/ + 全局 config/models.yaml）
const PATHS = featurePaths("wechat-article");
const VERSION = "1.0.0";
/** 阶段名单源：既是 --stage / 分步命令的取值，也是节点 stage 的合法词汇。 */
const PIPELINE_STAGES = ["topic", "draft", "review", "compose", "publish"];
/** 入口支持"关掉即跳过"的节点；其他节点写 enabled 都是假开关，validate 报错。 */
const SKIPPABLE_STEPS = ["de_ai", "image_generation", "publish", "archive"];
/** 写初稿前必须准备好的东西：标题 + 大纲 + 相关资料（校验规则见 config/wechat-article/schemas/draft.yaml）。 */
const DRAFT_INPUT_FILE = ARTIFACT.draftInput;

/**
 * 步骤内每次外部调用（大模型 + 非模型 API：核稿、知识库检索、配图、邮件…）的固化编号：
 * id = 该调用在**所属步骤内**的子步骤序号（按执行顺序 01 起），直接充当
 * `NN-step/api/子步骤号_轮次(尝试)-label(_F).<模型|provider>.json` 的文件名主号
 * （步骤号由目录 NN-step 提供，不进文件名；服务段无模型名时用 provider）；
 * 轮次 = 该子步骤第几次「逻辑调用」（流程循环推进，如 2_1-revise → 2_2-revise）；
 * 单次调用内的重复（校验重试/升级二判/HTTP 重试）以 (尝试) 标注，如 1_1(2)-correct，不占子步骤号；
 * label = 调用名，同一步骤内不得重复；_F = 降级兜底。
 * id 同时原样记在 JSON 的 slot 字段。分步/独立命令复用所属步骤的编号体系；
 * 管线增删或调整步骤内调用时必须同步本表（含 label 归属）。
 */
const API_SLOT = {
  topic: { knowledge: "01", select: "02", best: "03", classify: "04", web_search: "05" },
  draft: { outline: "01", draft: "02" },
  review: { correct: "01", sensitive: "02", revise: "03", score: "04", check: "05" },
  compose: { de_ai: "01", generate: "02" },
  publish: { email: "01", wechat: "02" },
};

/**
 * 步骤节点是调用的配置单源（steps/<NN-阶段>.yaml 的 models.<调用名>）：
 *   - model：--model（遗留全局覆盖）> rounds.<轮次>.id > levels.<档位>.id > models.<label>.id > type.model；
 *   - rounds：按轮次覆盖，只有传入 round 的调用点（修正/评稿）会命中；id/options 逐字段合并；
 *   - levels：按档位覆盖，只有传入 level 的调用点（de_ai）会命中；合并规则同 rounds；
 *   - attempts：结构化输出调用的总尝试上限（options.retry_limit，带 schema 的调用必填）；
 *   - timeout / temperature / maxTokens：合并后的 options 覆盖，缺省吃 models.yaml 端点默认。
 */
function stepCallConfig({ config, type }, stepName, label, options = {}, round = null, level = null) {
  const step = resolveStep(stepName, { steps: config?.steps, type });
  const call = step?.calls?.[label];
  const resolved = resolveCall(call, round, level);
  const contract = stepCallContract(step, label);
  const schema = contract?.output_format || {};
  const retryLimit = resolved.options.retry_limit;
  // retry_limit（总尝试上限，含首轮）单源 steps 节点：它不是 models.yaml 的端点字段，
  // 没有"吃端点默认"这条路；代码兜 2 等于允许配置说谎——节点写 3、实际只跑 2 次没人发现。
  // 只有会做修复重试的调用（挂了校验契约的结构化输出）与去 AI 化（质量闸门重调）吃它，
  // 纯文本单次调用不需要配，不强制它们写一个没人读的值。
  // 判定用 schema_id（节点/调用声明的注册表 id），不是 output_format 非空——
  // 纯文本节点的 output_format 是形状备注（脚本不校验），按非空判会逼它们配一个没人读的值。
  if (contract?.schema_id && retryLimit === undefined) {
    throw new Error(
      `步骤 ${stepName}.${label} 有校验契约 ${contract.schema_id}（结构化调用），必须写 models.${label}.options.retry_limit（总尝试上限，含首轮；1 = 不做修复重试）`,
    );
  }
  return {
    model: options.model || resolved.model_id || type.model,
    attempts: retryLimit === undefined ? undefined : Math.max(1, Number(retryLimit)),
    timeout: resolved.options.timeout,
    temperature: resolved.options.temperature,
    maxTokens: resolved.options.max_tokens,
    // 提示词块与校验 DSL 单源 = 节点（多调用节点写在 models.<调用名>）。
    prompt: contract?.prompt || {},
    prompt_id: contract?.prompt_id || "",
    schema: contract?.output_format || {},
  };
}

/**
 * systemone 判断调用的完整 cfg：models.yaml 端点默认 + 节点 options 覆盖
 * + defaults.yaml classifier.* 行为参数（enabled / question / default_type）。
 * 节点没配该调用时返回 null，调用方按“判断模型不可用”处理。
 * 端点必填参数（model / endpoint / timeout_ms / max_retries）缺了就抛错点名
 * config/models.yaml，代码不留同值副本；base_url 留空仍按「判断模型不可用」降级。
 */
function systemOneCallConfig({ config, type }, stepName, label) {
  const step = resolveStep(stepName, { steps: config?.steps, type });
  const call = step?.calls?.[label];
  if (!call) return null;
  const behavior = config.classifier || {};
  const modelId = call.model_id;
  const profile = config.models?.[modelId] || {};
  const options = call.options || {};
  const profileWhere = `config/models.yaml ${modelId}`;
  const cfg = {
    enabled: behavior.enabled !== false,
    question: behavior.question,
    topic_question: behavior.topic_question,
    check_question: behavior.check_question,
    default_type: behavior.default_type || "",
    provider: "systemone",
    model_id: modelId,
    model: needEndpointParam(profile, "model", profileWhere),
    // 判定文案（state / instructions / criteria）来自节点 models.<调用名>.prompt。
    prompt: stepCallContract(step, label)?.prompt || {},
    prompt_id: stepCallContract(step, label)?.prompt_id || "",
    base_url: profile.base_url || "",
    endpoint: needEndpointParam(profile, "endpoint", profileWhere),
    api_key: profile.api_key || "",
    timeout_ms: Number(needEndpointParam(profile, "timeout_ms", profileWhere)),
    max_retries: Number(needEndpointParam(profile, "max_retries", profileWhere)),
  };
  if (options.escalate_below !== undefined) cfg.escalate_below = Number(options.escalate_below);
  if (options.min_confidence !== undefined) cfg.min_confidence = Number(options.min_confidence);
  const deepProfile = options.deep ? config.models?.[options.deep] : null;
  if (deepProfile?.model && deepProfile.model !== cfg.model) {
    const deepWhere = `config/models.yaml ${options.deep}`;
    cfg.deep = {
      model: deepProfile.model,
      // base_url / api_key 缺省时沿用一次判断的端点与密钥（同一服务，属继承而非同值默认）
      base_url: deepProfile.base_url || cfg.base_url,
      endpoint: needEndpointParam(deepProfile, "endpoint", deepWhere),
      api_key: deepProfile.api_key || cfg.api_key,
      timeout_ms: Number(needEndpointParam(deepProfile, "timeout_ms", deepWhere)),
      max_retries: Number(needEndpointParam(deepProfile, "max_retries", deepWhere)),
    };
  }
  return cfg;
}

/** 节点调用一览（validate / steps / doctor 展示用）："label=id(R1:id,…)"，本地节点为 —。 */
function callsLabel(step) {
  const calls = Object.values(step?.calls || {});
  if (!calls.length) return "—";
  return calls
    .map((call) => {
      const rounds = Object.entries(call.rounds || {})
        .map(([round, override]) => `R${round}:${override.model_id || call.model_id}`)
        .join(",");
      return `${call.label}=${call.model_id}${rounds ? `(${rounds})` : ""}`;
    })
    .join(" ");
}

const HELP = `wechat-article ${VERSION} — 微信公众号文章自动化管线

用法:
  node scripts/wechat-article.mjs <command> [options]

文章目录（根目录由 BASE_OUTPUT_FOLDER 决定，默认 output/wechat-article）:
  draft/<slug>/           一篇文章一个目录，所有中间产物和终稿都在里面
  published/              发布成功后归档的 <YYYYMMDD>-<slug>.zip

命令:
  auto               入口 1：从知识库自动选题（目录并集，3 候选 + 评分 → 判断模型择一）→ 判断模型定类 → 自动纲要 → 往下写
  manual             入口 2：用你给的标题 + 提纲，直接往下写（跳过选题与纲要模型）
  run                完整管线（等价 auto，保留兼容）
  topics             列出候选文章；加 --count N --output <目录> 则生成 N 个候选主题（含提纲）的 Markdown
  steps              列出流程节点、处理方法、模型与产物；--type 查看类型覆盖后的配置
  classify           只用判断模型（systemone）根据标题 + 提纲选类型，打印得分
  kbs                列出 WeKnora 知识库（获取 kb_ids）
  topic              选题步：选题 → 判断类型 → 收集素材（--topic 可手动指定主题）
  draft              初稿步：生成纲要 → 组装初稿输入 → 写初稿（读 02-step/draft-input.json，或 --input 指定一份）
  review             对已有稿件执行核稿 → 修正 → 评稿 → 判定循环（字数校验内置在修正里）
  compose            组稿步（04）：去 AI 化 + 生成配图，两路并发后组装成稿
  publish            发布已有稿件（邮件 / 公众号草稿）
  validate           校验配置文件（加 --input <file> 可同时校验初稿输入）
  doctor             检查环境与依赖

阶段产物（存在即完成；续跑时看最后一个产物决定从哪继续，没有 state.json）:
  01-result.json（选题 + 类型 + sources）→ 02-result.json（纲要 + 初稿输入 + 初稿）
  → 03-result.json（审稿循环）→ 04-result.json（组稿：去 AI 化 + 配图）→ 05-result.json（发布）
  每步中间文件收进 NN-step/ 子目录：01-step/（topic.md、proposal.json、sources/、web-search/）、
  02-step/（outline.json/.md、draft-input.json、draft.md）、
  03-step/（round-N/、reviewed.md）、04-step/（polished.md、images.json、composed.md、images/）、
  05-step/（final.md、final.html）；每步外部调用（模型 + API）留痕在 NN-step/api/，文本日志在 logs/pipeline.log

两个入口（后续步骤完全一致，都可用 --stage 提前停止）:
  # 入口 1：自动选题 + 自动纲要
  node scripts/wechat-article.mjs auto --type ai-news --stage draft

  # 入口 2：手动标题 + 提纲（提纲用「## 小节」+「- 要点」；也可直接给 02-step/outline.json）
  node scripts/wechat-article.mjs manual --type ai-news --title "文章标题" --outline-file outline.md

中断续跑（从最后一个产物继续，不会重复已完成阶段）:
  node scripts/wechat-article.mjs auto --article <slug>
  node scripts/wechat-article.mjs draft --article <slug>

分步执行（都在同一篇文章目录里追加产物）:
  node scripts/wechat-article.mjs topic   --type ai-news
  node scripts/wechat-article.mjs draft   --article <slug>

通用参数:
  --config <path>        类型注册表，默认 ${PATHS.config}
  --defaults <path>      全局默认配置，默认 config/wechat-article/defaults.yaml
  --models <path>        模型总表，默认 config/models.yaml
  --steps <path>         步骤配置，默认 config/wechat-article/steps.yaml
  --type <id>            文章类型 id（历史遗留，现仅作判断模型失败时的回退；定类由 systemone 完成）
  --article <slug>       选择/续跑 draft 下的文章；latest = 最近一篇；分步命令省略时自动选中唯一一篇
  --file <path>          review/compose/publish 直接指定稿件文件（也可继续用 --article <path>）
  --slug <name>          新建文章时覆盖目录名（默认取标题的 slug）
  --title <text>         手动入口的文章标题
  --outline-file <path>  手动入口 / classify 的提纲文件（.md 或 .json）；分步时也可复用自动生成的 02-step/outline.json
  --outline <text>       手动入口的内联提纲（Markdown 或 JSON）
  --topic <text>         手动指定主题（省略则自动选题；手动时跳过选题模型调用）
  --from-proposal <n>    复用文章目录里 01-step/proposal.json 的第 n 个候选主题（需配合 --article）
  --requirements <text>  手动补充写作要求
  --topic-file <path>    复用已有选题 JSON（如 01-result.json）
  --sources-file <path>  复用已有素材 JSON（数组，跳过检索；照常落地 01-step/sources/ 并转成链接条目）
  --input <path>         初稿输入 JSON（标题 + 大纲 + 资料）；draft / run 可用，跳过选题和纲要
  --model <profile>      遗留：全局覆盖 llm 类调用的模型（单源在节点 models.<调用名>.id；后续清理）
  --review-model <p>     遗留：只覆盖评稿调用（scoring.models.score）
  --rounds <n>           核稿-修正-评稿-判定的最大轮次（1-5，默认取配置）
  --length-attempts <n>  修正稿字数校验不过时的重试次数（默认 3；重试耗尽仍不合格则中断流程）
  --knowledge-source <s> 覆盖知识来源：local | weknora | both
  --images <n>           配图数量（1-5）
  --de-ai-level <l>      compose 去 AI 化档位：light | standard | deep（省略则用节点 handler_options.level）
  --count <n>            topics：生成多少个候选主题（含提纲，1-10）
  --md                   topics：把候选主题以 Markdown 打印到终端
  --stage <name>         终止阶段：${PIPELINE_STAGES.join("|")}
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
  node scripts/wechat-article.mjs topics --type ai-insight
  node scripts/wechat-article.mjs run --type ai-insight --mock
  node scripts/wechat-article.mjs run --type ai-news --topic "某模型开源" --requirements "重点写对开发者的影响"
  node scripts/wechat-article.mjs draft --input output/wa-demo/02-step/draft-input.json
  node scripts/wechat-article.mjs review --article my-article-slug
  node scripts/wechat-article.mjs publish --article my-article-slug --to me@example.com
  node scripts/wechat-article.mjs classify --title "某模型开源" --outline-file outline.md

配置：config/wechat-article/defaults.yaml（全局默认）+ config/models.yaml（模型）+ config/wechat-article/article-types.yaml（类型注册表）+ config/wechat-article/types/<id>.yaml（类型明细）
流程节点：config/wechat-article/steps.yaml（阶段 → steps/NN-*.yaml：处理方法、模型调用、I/O、依赖）
提示词：config/wechat-article/prompts/*.yaml；数据结构：config/wechat-article/schemas/*.yaml
判断模型：端点与密钥用 SYSTEMONE_BASE_URL / SYSTEMONE_API_KEY（models.yaml systemone.*）；一次/二次模型与置信度参数（escalate_below、min_confidence）配在各调用节点——steps/10-topic.yaml 的 models.classify / models.best、steps/30-review.yaml 的 scoring.models.check；未配置端点时回退 classifier.default_type（定类）/ pass_score 规则（审稿去留）
初稿提示词：config/wechat-article/prompts/draft.yaml（draft_writing）；初稿校验规则：config/wechat-article/schemas/draft.yaml（draft_input）
`;

async function main() {
  const { command, options } = parseArgs();
  if (!command || options.help) {
    console.log(HELP);
    return;
  }

  loadDotEnv(PROJECT_ROOT);
  const configPath = path.resolve(PROJECT_ROOT, options.config || PATHS.config);
  const config = loadConfig(configPath, {
    root: PROJECT_ROOT,
    defaultsPath: String(options.defaults || PATHS.defaults),
    modelsPath: String(options.models || PATHS.models),
  });
  config.stepsPath = path.resolve(PROJECT_ROOT, options.steps || path.join(config.__dir, "steps.yaml"));
  if (fs.existsSync(config.stepsPath)) {
    try {
      config.steps = loadSteps(config.stepsPath, { root: PROJECT_ROOT, config });
    } catch (error) {
      config.steps = null;
      config.stepsError = error.message;
    }
  }

  switch (command) {
    case "validate":
      return cmdValidate(config, options);
    case "doctor":
      return cmdDoctor(config, options);
    case "steps":
      return cmdSteps(config, options);
    case "topics":
      return cmdTopics(config, options);
    case "classify":
      return cmdClassify(config, options);
    case "kbs":
      return cmdListKbs(config, options);
    case "auto":
    case "manual":
    case "topic":
    case "draft":
    case "run":
      return cmdPipeline(config, options, command);
    case "review":
      return cmdReviewOnly(config, options);
    case "compose":
      return cmdComposeOnly(config, options);
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
  const warnings = validateWarnings(config);
  const stepReport = validateSteps(config.steps, { types: config.types, stages: PIPELINE_STAGES, skippable: SKIPPABLE_STEPS });
  issues.push(...stepReport.errors);
  warnings.push(...stepReport.warnings);
  if (config.stepsError) issues.push(`步骤配置加载失败：${config.stepsError}`);
  const rows = config.types.map((type) => ({
    id: type.id,
    name: type.name,
    enabled: type.enabled,
    knowledge_dirs: type.knowledge_dirs.length,
    words: `${type.length.min}-${type.length.max}`,
    dimensions: type.scoring.dimensions.length,
    pass_score: type.scoring.pass_score,
    images: `${type.illustrations.min}-${type.illustrations.max}`,
    image_format: type.illustrations.position_format,
  }));
  console.log(`配置文件：${config.__path}`);
  if (config.__defaults_path) {
    console.log(`全局默认：${config.__defaults_path}`);
  } else {
    warnings.push(`未找到全局默认配置：${PATHS.defaults}（可用 --defaults 指定）`);
  }
  if (config.__models_path) {
    console.log(`模型总表：${config.__models_path}（${Object.keys(config.models || {}).length} 个模型）`);
  } else {
    warnings.push(`未找到模型总表：${PATHS.models}（可用 --models 指定）`);
  }
  console.table(rows);
  const classifier = config.classifier || {};
  const classifyCfg = systemOneCallConfig({ config }, "classify_type", "classify");
  console.log(
    classifyCfg
      ? `判断模型：${classifier.enabled ? "启用" : "禁用"}（classify=${classifyCfg.model || classifyCfg.model_id || "?"}${classifyCfg.deep ? ` → 二次 ${classifyCfg.deep.model}（< ${classifyCfg.escalate_below ?? "未配置 escalate_below"}）` : ""} @ ${classifyCfg.base_url || "base_url 未配置"}，默认类型 ${classifier.default_type || "未设置"}）`
      : "判断模型：steps classify_type 未配置 classify 调用（不会自动分类）",
  );
  if (config.steps) {
    const steps = resolveSteps(config.steps);
    console.log(`步骤配置：${config.steps.file}（${steps.length} 个步骤）`);
    console.table(
      steps.map((step) => ({
        step_name: step.step_name,
        stage: step.stage,
        handler: handlerLabel(step.handler),
        calls: callsLabel(step),
      })),
    );
    console.log(
      `提示词注册表：${Object.keys(config.steps.prompts || {}).length} 个 id；数据结构注册表：${Object.keys(config.steps.schemas || {}).length} 个 id`,
    );
  } else {
    console.warn(`\n未找到步骤配置：${config.stepsPath}（可用 --steps 指定）`);
  }
  if (issues.length) {
    console.error("\n发现问题：");
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("配置校验通过。");
  }
  for (const warning of warnings) console.warn(`  [warn] ${warning}`);

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
    if (!config.steps) {
      console.error(`\n未找到步骤配置：${config.stepsPath || PATHS.steps}（draft_input 的校验规则来自 bundle_draft_input 节点）`);
      process.exitCode = 1;
      return;
    }
    const { schema: draftInputSchema } = draftTemplateFromSteps({ steps: config.steps, type: inputType });
    const report = validateDraftInput(raw, { schema: draftInputSchema, type: inputType, advisory: true });
    console.log(`\n初稿输入：${file}`);
    for (const line of summarizeDraftInput(input)) console.log(`  ${line}`);
    for (const warning of report.warnings) console.warn(`  [warn] ${warning}`);
    for (const error of report.errors) console.error(`  [error] ${error}`);
    if (report.ok) console.log("初稿输入校验通过。");
    else process.exitCode = 1;
  }
}

function cmdSteps(config, options = {}) {
  if (!config.steps) {
    console.error(`未找到步骤配置：${config.stepsPath || PATHS.steps}`);
    process.exitCode = 1;
    return;
  }
  const type = options.type
    ? (() => {
        try {
          return findType(config, options.type);
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
          return null;
        }
      })()
    : null;
  if (options.type && !type) return;

  if (options.step) {
    const step = resolveStep(String(options.step), { steps: config.steps, type });
    if (!step) {
      console.error(`未知步骤：${options.step}`);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ type: type?.id || null, step: redactStep(step) }, null, 2));
      return;
    }
    console.log(`步骤：${step.step_name}（${step.label}）`);
    console.log(`来源：${relativeTo(PROJECT_ROOT, step.source) || step.source}`);
    console.log(`阶段：${step.stage}`);
    console.log(`处理：${handlerLabel(step.handler)}`);
    const calls = Object.values(step.calls || {});
    if (!calls.length) {
      console.log("模型调用：（无，本地节点）");
    }
    for (const call of calls) {
      // 提示词/数据结构写在节点级（单调用节点）或调用级（多调用节点）：
      // 按 stepCallContract 的解析结果打印，否则多调用节点看不见自己引用了哪些 id。
      const contract = stepCallContract(step, call.label);
      const ids = [
        contract?.prompt_id && `prompt=${contract.prompt_id}`,
        contract?.schema_id && `schema=${contract.schema_id}`,
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`模型调用：${call.label} → ${call.model_id}（${call.template}）${ids ? ` ${ids}` : ""}${Object.keys(call.options).length ? ` ${JSON.stringify(call.options)}` : ""}`);
      for (const [round, override] of Object.entries(call.rounds || {})) {
        const opts = Object.keys(override.options).length ? ` ${JSON.stringify(override.options)}` : "";
        console.log(`  轮次 ${round}：${override.model_id || call.model_id}${opts}`);
      }
    }
    console.log(`依赖：${step.depends_on.join(", ") || "（无）"}`);
    console.log(`产物：读 ${step.artifacts.reads.join(", ") || "（无）"} → 写 ${step.artifacts.writes.join(", ") || "（无）"}`);
    if (step.prompt_id) console.log(`提示词 id：${step.prompt_id}`);
    if (step.schema_id) console.log(`数据结构 id：${step.schema_id}`);
    if (step.result_schema) console.log(`result 本体校验契约：${step.result_schema}（落盘前跑，校验本步的 NN-result.json）`);
    if (step.handler_options && Object.keys(step.handler_options).length) {
      console.log(`\n处理参数：`);
      console.log(JSON.stringify(redactSecrets(step.handler_options), null, 2));
    }
    // 引用了注册表 id 的输出格式才是脚本真跑的校验契约；内联的 input/output_format
    // 只是形状备注（纯文本节点没有可校验的 JSON 形状）。打印时区分开，别让人以为都校验。
    const formatBlock = (title, format) => {
      if (!format || !Object.keys(format).length) return;
      console.log(`\n${title}：`);
      console.log(JSON.stringify(format, null, 2));
    };
    formatBlock("输入格式（形状备注，脚本不校验）", step.input_format);
    formatBlock(`输出格式（${step.schema_id ? `校验契约 ${step.schema_id}` : "形状备注，脚本不校验"}）`, step.output_format);
    formatBlock(`result 本体（校验契约 ${step.result_schema}）`, step.result_output_format);
    for (const call of calls) {
      if (!call.input_format && !call.output_format) continue;
      formatBlock(`调用 ${call.label} 输入格式（形状备注，脚本不校验）`, call.input_format);
      formatBlock(`调用 ${call.label} 输出格式（${call.schema_id ? `校验契约 ${call.schema_id}` : "形状备注，脚本不校验"}）`, call.output_format);
    }
    if (Object.keys(step.prompt || {}).length) {
      console.log(`\n提示词：`);
      for (const [key, text] of Object.entries(step.prompt)) {
        console.log(`--- ${key} ---`);
        console.log(text);
      }
    }
    return;
  }

  const steps = resolveSteps(config.steps, { type });
  if (options.json) {
    console.log(JSON.stringify({ type: type?.id || null, file: config.steps.file, steps: steps.map(redactStep) }, null, 2));
    return;
  }
  console.log(`步骤配置：${config.steps.file}${type ? `（类型 ${type.id} 覆盖后）` : ""}`);
  console.table(
    steps.map((step) => ({
      step_name: step.step_name,
      label: step.label,
      stage: step.stage,
      handler: handlerLabel(step.handler),
      calls: callsLabel(step),
      writes: step.artifacts.writes.join(", "),
    })),
  );
  console.log(`共 ${steps.length} 个步骤：${stepNames(config.steps).join(" → ")}`);
}

function handlerLabel(handler) {
  if (!handler) return "-";
  if (handler.kind === "builtin") return `builtin:${handler.entry}`;
  if (handler.kind === "script") return relativeTo(PROJECT_ROOT, handler.path) || handler.path;
  if (handler.kind === "http") return handler.url;
  return handler.raw || handler.kind;
}

/** steps --json / --step 不输出真实密钥。 */
function redactStep(step) {
  return {
    ...step,
    handler_options: redactSecrets(step.handler_options),
  };
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/api_?key|auth_?key|secret|token|password/i.test(key)) out[key] = maskSecret(child);
    else out[key] = redactSecrets(child);
  }
  return out;
}

function maskSecret(value) {
  if (value === undefined || value === null || value === "") return "";
  return "***";
}

async function cmdDoctor(config, options) {
  const logger = createLogger({ verbose: true, label: "doctor" });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, status: ok ? "OK" : "FAIL", detail });

  add("Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  add("配置文件", fs.existsSync(config.__path), config.__path);
  add("全局默认", Boolean(config.__defaults_path), config.__defaults_path || `未找到 ${PATHS.defaults}`);
  add("模型总表", Boolean(config.__models_path), config.__models_path || `未找到 ${PATHS.models}`);
  if (config.steps) {
    const report = validateSteps(config.steps, { types: config.types, stages: PIPELINE_STAGES, skippable: SKIPPABLE_STEPS });
    add(
      "步骤配置",
      report.errors.length === 0,
      report.errors.length ? report.errors.join("；") : `${config.steps.steps.length} 个步骤 @ ${config.steps.file}`,
    );
  } else {
    add("步骤配置", false, config.stepsError || `未找到 ${config.stepsPath || PATHS.steps}`);
  }

  for (const type of listTypes(config)) {
    const missing = type.knowledge_dirs.filter((dir) => !fs.existsSync(dir));
    add(`知识库 ${type.id}`, missing.length === 0, missing.length ? `缺失：${missing.join(", ")}` : `${type.knowledge_dirs.length} 个目录`);
  }

  // 判断模型（systemone）：配置在 steps 节点 models.classify / models.best
  const classifier = config.classifier || {};
  const doctorClassifyCfg = systemOneCallConfig({ config }, "classify_type", "classify");
  if (!classifier.enabled) {
    add("判断模型 systemone", true, "已禁用（classifier.enabled=false）");
  } else if (!doctorClassifyCfg) {
    add("判断模型 systemone", false, "steps classify_type 未配置 classify 调用（models.classify.id）");
  } else if (!doctorClassifyCfg.base_url) {
    add(
      "判断模型 systemone",
      true,
      `未配置（缺 SYSTEMONE_BASE_URL），将回退 ${doctorClassifyCfg.default_type || "（无默认类型）"}`,
    );
  } else {
    add("判断模型 systemone", true, `${doctorClassifyCfg.model_id}（${doctorClassifyCfg.model}）@ ${doctorClassifyCfg.base_url}`);
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
        // auth_header 单源 defaults.yaml defaults.knowledge.weknora（这里不留 "X-API-Key" 副本，
        // 与检索侧 knowledge.mjs 同一口径）；缺项就报配置缺项，不用猜的头去探。
        const authHeader = needConfig(wk.auth_header, "defaults.yaml defaults.knowledge.weknora.auth_header");
        const res = await fetch(`${wk.base_url.replace(/\/+$/, "")}/knowledge-bases`, {
          headers: { [authHeader]: wk.api_key, "X-Request-ID": String(Date.now()) },
          // 探测预算（不是服务参数）：doctor 只列知识库，不等 defaults 的 timeout_ms
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

  // 节点里出现的每个模型 id 都要能连通：默认调用 + 轮次覆盖 + 档位覆盖，
  // llm 与 systemone（含升级用的 deep 判断模型）一视同仁。
  const nodeModelIds = (config.steps?.steps || [])
    .flatMap((step) => Object.values(step.calls || {}))
    .flatMap((call) => [
      call.model_id,
      ...Object.values(call.rounds || {}).map((round) => round.model_id),
      ...Object.values(call.levels || {}).map((level) => level.model_id),
    ]);
  const modelIds = [...new Set([...nodeModelIds, ...config.types.map((t) => t.model)].filter(Boolean))];
  for (const id of modelIds) {
    if (options.mock) {
      add(`模型 ${id}`, true, "mock 模式跳过");
      continue;
    }
    const profile = getModelProfile(config, id);
    if (profile.provider === "ollama") {
      // 端点地址单源 config/models.yaml：doctor 不兜一个 localhost 端口，否则检查的是代码里的地址
      if (!profile.base_url) {
        add(`模型 ${id}`, false, "缺少 base_url：config/models.yaml");
        continue;
      }
      try {
        const res = await fetch(`${profile.base_url.replace(/\/+$/, "")}/api/tags`, {
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
    // 端点与鉴权头只从 defaults.yaml 读：缺项就如实报"配置缺项"，不用代码猜的 /api/correct 去探
    // （原来这里两份 `|| "/api/correct"`、一份 `|| "X-Auth-Key"`，后者还与 defaults.yaml 冲突）。
    let endpoint;
    try {
      endpoint = needConfig(correct.correct_endpoint, "defaults.yaml defaults.review.correct_cn.correct_endpoint");
      const headers = { "Content-Type": "application/json" };
      if (correct.api_key) {
        const authHeader = needConfig(correct.auth_header, "defaults.yaml defaults.review.correct_cn.auth_header");
        if (String(authHeader).toLowerCase() === "authorization") headers.Authorization = `Bearer ${correct.api_key}`;
        else headers[authHeader] = correct.api_key;
      }
      const url = `${correct.base_url.replace(/\/+$/, "")}${endpoint}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "这是一句用于连通性测试的中文。" }),
        // 探测预算（不是服务参数）：doctor 只想知道端点通不通，不等 defaults 的 timeout_ms
        signal: AbortSignal.timeout(20000),
      });
      add("核稿服务 correct-cn", res.ok, `${url} → HTTP ${res.status}`);
    } catch (error) {
      add("核稿服务 correct-cn", false, error.message);
    }
  } else {
    add("核稿服务 correct-cn", true, "未启用");
  }

  const ill = config.defaults?.illustrations || {};
  // 通道顺序与 key 都只从 defaults.yaml 读：primary 不兜 "modelscope"（副本会让 doctor 报出
  // 一个配置里没写的顺序），PB_MODEL_API_KEY 这个旧别名也已删除（.env 里根本没有它，
  // 留着只会让 doctor 显示绿色而真实运行取不到 key）。
  const channelRole = (name) => (
    ill.primary === name ? "主选"
      : [].concat(ill.fallback || []).includes(name) ? "备用" : "未参与");
  const ms = ill.modelscope;
  const msKey = ms?.api_key;
  if (ms?.enabled !== false) add(`配图 ModelScope（${channelRole("modelscope")}）`, Boolean(msKey), msKey ? "已配置 key" : "缺少 PB_MODEL_IMAGE_API_KEY");
  const poll = ill.pollinations;
  add(`配图 Pollinations（${channelRole("pollinations")}）`, poll?.enabled !== false && Boolean(poll?.base_url), poll?.base_url || "缺少 base_url：defaults.yaml illustrations.pollinations.base_url");

  const pub = config.defaults?.publish || {};
  // 凭据只看配置：defaults.yaml 已用 ${PB_RESEND_API_KEY} 把 .env 展开进来，
  // 这里再 env() 一次等于给同一项开第二个读取口（配置删掉这行 doctor 照样报绿）。
  const emailKey = pub.email?.api_key;
  if (pub.email?.enabled) {
    add("邮件 Resend", Boolean(emailKey), [
      emailKey ? "已配置 key" : "缺少 PB_RESEND_API_KEY",
      (pub.email.to || []).length ? `收件人 ${String((pub.email.to || []).length)} 个` : "未配置收件人",
    ].join("；"));
  } else {
    add("邮件 Resend", true, "未启用（publish.email.enabled 或 --email 打开）");
  }

  if (pub.wechat?.enabled) {
    const hasId = Boolean(env("WECHAT_MP_APP_ID") || env("WECHAT_APP_ID"));
    add("公众号 Wenyan", hasId, hasId ? "已配置 WECHAT_MP_APP_ID" : "缺少 WECHAT_MP_APP_ID");
  } else {
    add("公众号 Wenyan", true, "未启用（publish.wechat.enabled 或 --wechat 打开）");
  }

  // 归档：知识库入库目录可写 + zip 落点存在（archive.enabled 整体开关看 steps 节点）
  const knowledgeDir = pub.archive?.knowledge_dir;
  if (!knowledgeDir) {
    add("归档 知识库入库", true, "knowledge_dir 留空：只打包，不入库");
  } else {
    const target = path.resolve(PROJECT_ROOT, knowledgeDir);
    if (!exists(target)) {
      add("归档 知识库入库", true, `${target} 不存在，归档时创建`);
    } else {
      try {
        fs.accessSync(target, fs.constants.W_OK);
        add("归档 知识库入库", true, target);
      } catch (error) {
        add("归档 知识库入库", false, `${target} 不可写：${error.message}`);
      }
    }
  }

  console.table(checks);
  const failed = checks.filter((c) => c.status === "FAIL");
  if (failed.length) {
    logger.warn(`${failed.length} 项检查未通过；管线会在这些环节降级或跳过。`);
    process.exitCode = 0; // doctor is diagnostic only
  }
}

/* ------------------------------------------------------------------ */
/* classify                                                            */
/* ------------------------------------------------------------------ */

async function cmdClassify(config, options) {
  const title = String(options.title || options.topic || "").trim();
  if (!title) throw new Error('classify 需要 --title "文章标题"（也可用 --topic）');
  const outline = readOutlineText(options);
  const logger = createLogger({ verbose: asBool(options.verbose), label: "classify" });
  const cfg = systemOneCallConfig({ config }, "classify_type", "classify");
  if (!cfg) throw new Error("steps classify_type 未配置 classify 调用（models.classify.id）");
  const result = await classifyArticle({ config, cfg, title, outline, logger, mock: asBool(options.mock) });
  const fallback = cfg.default_type || "";

  const chain = cfg.deep
    ? `${cfg.model} → 二次 ${cfg.deep.model}（置信度 < ${cfg.escalate_below ?? "未配置 escalate_below"} 时）`
    : cfg.model || cfg.model_id;
  console.log(`判断模型：${chain} @ ${cfg.base_url || "（未配置）"}`);
  if (outline) console.log(`提纲：${outline.split(/\r?\n/).filter(Boolean).length} 行`);
  const scores = Object.entries(result.scores || {});
  if (scores.length) console.table(scores.map(([id, score]) => ({ type: id, score })));

  if (result.ok) {
    console.log(`选择：${result.type}（置信度 ${result.confidence}${result.first ? "，二次判断" : ""}）`);
    if (result.escalated && result.first) {
      console.log(`一次判断：${result.first.type}（置信度 ${result.first.confidence}，模型 ${result.first.model}）`);
    }
    if (result.reason) console.log(`理由：${result.reason}`);
    const min = needGateParam(cfg, "min_confidence", "steps 节点 classify_type.models.classify.options");
    if (result.confidence < min) {
      console.log(`置信度低于 ${min}，实际运行会回退到 ${fallback || "（无默认类型，直接报错）"}`);
    }
  } else {
    console.log(`分类失败：${result.reason}`);
    if (fallback) console.log(`实际运行会回退到：${fallback}`);
    process.exitCode = 1;
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
  if (wk.api_key) {
    headers[needConfig(wk.auth_header, "defaults.yaml defaults.knowledge.weknora.auth_header")] = wk.api_key;
  }
  const res = await fetch(`${base}/knowledge-bases`, {
    headers,
    // 命令级探测预算（不是服务参数），列知识库不需要 defaults 的 timeout_ms
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WeKnora HTTP ${res.status}`);
  const data = await res.json();
  const rows = (data.data || []).map((kb) => ({ id: kb.id, name: kb.name, docs: kb.knowledge_count, type: kb.type }));
  console.table(rows);
  console.log(`\n共 ${rows.length} 个知识库（${base}）。如需启用远端检索，把 id 填到 article-types.yaml 的 defaults.knowledge.weknora.kb_ids。`);
}

async function cmdTopics(config, options) {
  const type = findType(config, resolveTypeId(options));
  applyKnowledgeSource(config, type, options);
  const logger = createLogger({ verbose: asBool(options.verbose), label: "topics" });
  const needLocal = type.knowledge.source === "local" || type.knowledge.source === "both";
  const notes = needLocal
    ? indexKnowledge(type, {
        logger,
        maxFileBytes: needNumber(type.knowledge.max_file_bytes, "defaults.yaml defaults.knowledge.max_file_bytes"),
        cacheDir: path.join(PROJECT_ROOT, ".temp", "wechat-article"),
      })
    : [];
  const candidates = await buildCandidates({ type, logger }, notes);
  const w = topicWindows(type);
  const recent = pickRecent(candidates, { days: w.candidateDays, limit: w.maxCandidates });

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
    const freshRows = rows.length ? recent.filter((note) => isFreshlyCollected(note, { days: w.freshDays })).length : 0;
    console.log(`\n共 ${candidates.length} 篇（来源 ${type.knowledge.source}），近 ${w.candidateDays} 天文件日期 ${recent.length} 篇，其中近 ${w.freshDays} 天新采集 ${freshRows} 篇。`);
    console.log(`提示：加 --count 3 --output output 可以生成 3 个候选主题（含提纲）的 Markdown；或运行 topic --type ${type.id} 自动选题。`);
    return;
  }

  const total = count > 0 ? count : 3;
  const models = createModelClient(config, logger);
  const pool = recent.length ? recent : candidates;
  const proposals = await generateProposals({
    config,
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
    score: asNumber(raw?.score) || 0,
    keywords: Array.isArray(raw?.keywords) ? raw.keywords.map(String) : [],
    source_hints: Array.isArray(raw?.source_hints) ? raw.source_hints.map(String) : [],
    title_candidates: Array.isArray(raw?.title_candidates) ? raw.title_candidates.map(String) : [],
  };
  if (!topic.topic) topic.topic = topic.title;
  if (!topic.title) topic.title = topic.topic;
  return topic;
}

/**
 * 双窗口配置：大样本按文件日期，小样本按采集日期（mtime）。见 docs/topic-selection.md。
 * 四个值单源 types/<id>.yaml 的 topic 段——代码里原来那份 15/7/40/3 与四个类型写的值一模一样，
 * 属于"第二份真相"；旧字段 lookback_days / candidates 的回退也删了（没有任何类型再用它们）。
 */
function topicWindows(type) {
  const cfg = type.topic || {};
  const where = (key) => `types/${type.id}.yaml 的 topic.${key}`;
  return {
    candidateDays: needNumber(cfg.candidate_days, where("candidate_days")),
    freshDays: needNumber(cfg.fresh_days, where("fresh_days")),
    maxCandidates: needNumber(cfg.max_candidates, where("max_candidates")),
    proposals: clamp(needNumber(cfg.proposals, where("proposals")), 1, 5),
  };
}

/** 候选池 → 模型输入：只有标题 + 距今天数 + 新采集标记，外加确定性词频热度表。 */
function buildTopicInput(type, notes) {
  const { candidateDays, freshDays, maxCandidates } = topicWindows(type);
  const now = Date.now();
  const recent = pickRecent(notes, { days: candidateDays, limit: maxCandidates });
  const pool = recent.length ? recent : notes.slice(0, maxCandidates);
  const candidates = pool.map((note) => ({
    note,
    title: note.title,
    daysAgo: daysAgo(note, now),
    fresh: isFreshlyCollected(note, { days: freshDays, now }),
  }));
  const heatmap = termHeatmap(pool, { top: 15, freshDays, now });
  return { pool, candidates, heatmap, heatmapText: formatHeatmap(heatmap) };
}

/** Step 1 of the pipeline: pick N topics, then give each one an outline (no article retrieval). */
async function generateProposals({ config, type, pool, count, models, logger, mock, options }) {
  const requirements = options.requirements ? String(options.requirements) : "";
  const written = config ? listWrittenArticles(config) : [];

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
  const input = buildTopicInput(type, pool);
  const call = stepCallConfig({ config, type }, "select_topic", "select", options);
  const prompt = buildTopicPrompt({
    prompt: call.prompt,
    promptId: call.prompt_id,
    type,
    candidates: input.candidates,
    heatmap: input.heatmapText,
    written,
    mode: "auto",
    userRequirements: requirements,
    count,
  });
  try {
    const result = await models.jsonValidated(call.model, {
      ...prompt,
      schema: call.schema,
      attempts: call.attempts,
      timeout: call.timeout,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      label: "topic",
      slot: API_SLOT.topic.select,
    });
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

  let topics = rawTopics.map(normalizeTopic).filter((t) => t.topic);
  topics = validateProposals(topics, input.candidates, written, logger).slice(0, count);
  for (const c of input.candidates) {
    if (topics.length >= count) break;
    if (topics.some((t) => t.topic === c.title)) continue;
    topics.push(
      normalizeTopic({
        topic: c.title,
        title: c.title,
        thesis: c.note.summary || "",
        angle: "基于知识库最新文章",
        source_hints: [c.title],
      }),
    );
  }

  const out = [];
  for (let i = 0; i < topics.length; i += 1) {
    const topic = topics[i];
    logger.info(`生成提纲 ${i + 1}/${topics.length}：《${topic.title}》`);
    out.push({ ...topic, outline: await generateProposalOutline({ type, topic, pool, models, logger, options, requirements, steps: config.steps }) });
  }
  return out;
}

async function generateProposalOutline({ type, topic, pool, models, logger, options, requirements, steps }) {
  const sources = topicSourcesFromPool(topic, pool);
  logger.info(`  参考素材：${sources.map((s) => s.title).join(" / ") || "（无）"}`);
  const call = stepCallConfig({ config: { steps }, type }, "outline", "outline", options);
  const prompt = buildOutlinePrompt({
    prompt: call.prompt,
    promptId: call.prompt_id,
    type,
    topic,
    sources,
    userRequirements: requirements,
    maxChars: 10000,
  });

  let outline;
  try {
    outline = await models.jsonValidated(call.model, {
      ...prompt,
      schema: call.schema,
      attempts: call.attempts,
      timeout: call.timeout,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      label: "outline",
      slot: API_SLOT.draft.outline,
    });
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
  lines.push(`node scripts/wechat-article.mjs manual --type ${type.id} --title "标题" --outline-file outline.md --stage draft`);
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

  // 先定位文章目录，这样 --type 也可以从 01-result.json 里推断。
  const selector = options.article && options.article !== true ? String(options.article) : "";
  const existing = selector ? openArticle(config, selector) : null;
  let typeInfo = await resolveTypeForEntry(config, options, {
    title: entryTitle,
    command,
    existing,
  });
  let type;
  if (typeInfo.deferred) {
    // auto 入口：选题阶段用所有启用类型知识库的并集，定类在选题之后由判断模型完成。
    type = autoTopicType(config);
    if (!type.knowledge_dirs.length) {
      throw new Error("启用类型都没有配置 knowledge_base_path，无法自动选题");
    }
  } else {
    type = findType(config, typeInfo.typeId);
    if (!type.enabled) throw new Error(`文章类型 ${type.id} 已禁用`);
  }

  if (!typeInfo.deferred) applyKnowledgeSource(config, type, options);

  const verbose = asBool(options.verbose);
  const mock = asBool(options.mock);
  const fullPipeline = ["run", "auto", "manual"].includes(command);
  const manualEntry = command === "manual";
  const stopStage = fullPipeline ? String(options.stage || "publish") : command;
  const inputArg = options.input || options["draft-input"];
  const inputProvided = Boolean(inputArg);
  if (inputProvided && !["draft", "run"].includes(command)) {
    throw new Error("--input 只用于 draft / run：给它一份初稿输入 JSON（标题 + 大纲 + 资料，即 02-step/draft-input.json）");
  }
  // Entry 2: the user supplies the title (and outline); the topic model is skipped.
  if (manualEntry && !options.topic && entryTitle) options.topic = entryTitle;

  const stamp = timestamp();
  const inputFile = inputProvided ? path.resolve(PROJECT_ROOT, String(inputArg)) : "";
  if (inputProvided && !fs.existsSync(inputFile)) throw new Error(`--input 不存在：${inputFile}`);

  // 文章目录：--article <slug> 指定/续跑；manual 与 --input 直接新建；
  // 其余分步命令要求 draft/ 下已有文章（只有一篇时自动选中）。
  const stepCommands = PIPELINE_STAGES;
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

  // LLM/API 请求落地：文章目录建立前先进内存缓冲，bindArticle 时 flush 到 logs/。
  const recorder = createRecorder();

  const ctx = {
    config,
    recorder,
    type,
    logger,
    verbose,
    outputDir: article?.dir || "",
    draftTemplate: draftTemplateFromSteps({ steps: config.steps, type }),
    mock,
    stamp,
    options,
    // 纯内存的执行摘要（仅用于收尾打印），不落盘：进度一律以产出文件为准
    state: {
      version: VERSION,
      article: article ? { ...article.article, title: article.article.title || entryTitle } : null,
      type: type.id,
      typeName: type.name,
      typeSource: typeInfo.source,
      classification: typeInfo.classification || undefined,
      startedAt: new Date().toISOString(),
      outputDir: article?.dir || "",
      mock,
      stages: {},
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
    ctx.models = createModelClient(config, logger, recorder);
    recorder.setStepDir(path.join(created.dir, "01-step"));
    logger.info(`文章目录：${created.dir}`);
  }

  logger.step(
    typeInfo.deferred
      ? `管线启动：类型待定（选题后由判断模型定类；知识库并集 ${type.knowledge_dirs.length} 个目录）`
      : `管线启动：${type.name}（${type.id}）`,
  );
  logger.info(`入口：${manualEntry ? "手动（标题 + 提纲）" : "自动（基于知识库选题 + 自动纲要）"}`);
  logger.info(`类型来源：${TYPE_SOURCE_LABEL[typeInfo.source] || typeInfo.source}`);
  if (typeInfo.classification?.reason) logger.info(`分类理由：${typeInfo.classification.reason}`);
  logger.info(`文章根目录：${config.project.base_output_folder}`);
  logger.info(`知识来源：${type.knowledge.source}${type.knowledge.source !== "local" ? `（WeKnora ${type.knowledge.weknora.kb_ids.length} 个知识库）` : ""}`);
  const nodeModel = (name, label, overrides = {}) => stepCallConfig({ config, type }, name, label, { ...options, ...overrides }).model;
  const classifyModel = systemOneCallConfig({ config, type }, "classify_type", "classify")?.model_id || "未配置";
  const bestModel = systemOneCallConfig({ config, type }, "select_topic", "best")?.model_id || "未配置";
  const checkModel = systemOneCallConfig({ config, type }, "scoring", "check")?.model_id || "未配置";
  logger.info(
    `模型：选题=${nodeModel("select_topic", "select")}，择题=${bestModel}，定类=${classifyModel}，纲要=${nodeModel("outline", "outline")}，写作=${nodeModel("draft_writing", "draft")}，评稿=${nodeModel("scoring", "score", { model: options["review-model"] })}，判定=${checkModel}`,
  );

  try {
    ctx.models = createModelClient(config, logger, recorder);
    if (article) recorder.setStepDir(path.join(article.dir, "01-step"));

    const resume = Boolean(article?.existing);
    const resumeStage = fullPipeline && resume ? detectStartStage(article.dir) : "topic";
    const resumeIndex = stageIndex(resumeStage);
    if (resume) logger.info(`断点续跑：从 ${resumeStage} 阶段开始`);

    // 只在可能真的要用知识库时才建索引；已有 01/02 产物时直接读文件。
    const earlyFiles = [ARTIFACT.topic, ARTIFACT.outline];
    const earlyMissing = !article || earlyFiles.some((name) => !exists(path.join(article.dir, name)));
    const needLocal = type.knowledge.source === "local" || type.knowledge.source === "both";
    if (!inputProvided) {
      if (needLocal && earlyMissing) {
        ctx.notes = indexKnowledge(type, {
          logger,
          maxFileBytes: needNumber(type.knowledge.max_file_bytes, "defaults.yaml defaults.knowledge.max_file_bytes"),
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

    if (!inputProvided && !(fullPipeline && resumeIndex > stageIndex("draft"))) {
      // Stage 1: topic -------------------------------------------------
      const selection = await resolveTopic(ctx, ctx.notes || [], resume);
      topic = selection.topic;
      ctx.topic = topic;

      // deferred 入口：拿到选题标题后，由判断模型定类，类型从此决定下游所有步骤。
      if (typeInfo.deferred) {
        const outcome = await classifyOrFallback({
          config,
          cfg: systemOneCallConfig({ config, type }, "classify_type", "classify"),
          title: topic.title || topic.topic,
          outline: topic.thesis || "",
          logger,
          mock,
          recorder,
          // 升级二判属同一子步骤的「尝试」（(2) 标注），与一次判断共用 slot
          slot: API_SLOT.topic.classify,
        });
        let typeId = "";
        let source = outcome.source;
        if (outcome.source === "classifier" && outcome.typeId) {
          typeId = outcome.typeId;
        } else if (typeInfo.hint) {
          typeId = typeInfo.hint.typeId;
          source = typeInfo.hint.source;
          logger.info(`判断模型未定类，回退${TYPE_SOURCE_LABEL[source] || source}：${typeId}`);
        } else if (outcome.typeId) {
          typeId = outcome.typeId;
        }
        if (!typeId) {
          throw new Error(
            `无法确定文章类型：判断模型未返回结果（${outcome.result?.reason || "未配置或不可用"}），且 classifier.default_type 和 --type 均未配置`,
          );
        }
        type = findType(config, typeId);
        if (!type.enabled) throw new Error(`文章类型 ${type.id} 已禁用`);
        applyKnowledgeSource(config, type, options);
        typeInfo = { typeId, source };
        ctx.type = type;
        ctx.state.type = type.id;
        ctx.state.typeName = type.name;
        ctx.state.typeSource = source;
        ctx.state.classification = outcome.result || undefined;
        // 素材检索收窄到定类后的知识库目录（并集里其他类型的内容不作素材）。
        const underDirs = (file) =>
          type.knowledge_dirs.some((dir) => file === dir || file.startsWith(`${dir}/`) || file.startsWith(`${dir}${path.sep}`));
        const narrowed = (ctx.notes || []).filter((note) => underDirs(note.file));
        if (narrowed.length) ctx.notes = narrowed;
        if (selection.proposals) {
          selection.proposals.type = type.id;
          selection.proposals.classification = {
            type: typeId,
            source,
            confidence: outcome.result?.confidence,
            reason: outcome.result?.reason,
          };
        }
        logger.info(`判断模型定类：${type.name}（${type.id}，来源 ${TYPE_SOURCE_LABEL[source] || source}）`);
      }

      if (!article) {
        bindArticle(createArticle(config, { title: topic.title || topic.topic, slug: options.slug, type, entry: command }));
      }
      // 素材收集属于选题步：先把素材收齐，再一次性写 01-result.json。
      const gathered = await resolveSources(ctx, topic, resume);
      const counts = gathered.reduce((acc, s) => ({ ...acc, [s.origin || "local"]: (acc[s.origin || "local"] || 0) + 1 }), {});
      const breakdown = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" + ") || "none";
      logger.info(`收集到 ${gathered.length} 篇素材（${breakdown}）：${gathered.map((s) => s.title.slice(0, 24)).join(" / ") || "（无）"}`);
      // 正文落 01-step/sources/*.md，01-result.json#sources 只留 {index,title,link}。
      sources = landSources(article.dir, gathered);
      ctx.sources = sources;

      // 01 步对外只有 01-result.json（信封 + 选题字段 + 素材链接）；候选、人读版收进 01-step/。
      // 信封在这里诞生：title/type 从这里起，之后每一步只顺延、不再重新发明。
      ensureDir(path.join(article.dir, "01-step"));
      const topicResult = validateResult(
        {
          ...buildEnvelope(article.dir, "topic", {
            title: topic.title || topic.topic,
            type: type.id,
            files: {
              topicMd: ARTIFACT.topicMd,
              proposal: selection.proposals ? ARTIFACT.topicProposal : null,
            },
          }),
          // 只带下游要读的选题字段；score / title_candidates 是择题过程，留在 01-step/proposal.json
          topic: topic.topic || "",
          thesis: topic.thesis || "",
          angle: topic.angle || "",
          rationale: topic.rationale || "",
          keywords: topic.keywords || [],
          source_hints: topic.source_hints || [],
          sources,
        },
        { step: "select_topic", config, type, file: ARTIFACT.topic, logger },
      );
      writeJson(path.join(article.dir, ARTIFACT.topic), topicResult);
      writeText(path.join(article.dir, ARTIFACT.topicMd), renderTopicMarkdown(topic));
      if (selection.proposals) {
        writeJson(path.join(article.dir, ARTIFACT.topicProposal), selection.proposals);
      }
      logger.step(`选题完成：《${topic.title || topic.topic}》`);
      ctx.state.stages.topic = {
        ok: true,
        title: topic.title || topic.topic,
        reused: Boolean(ctx.topicReused),
        sources: sources.length,
      };
      if (stopStage === "topic") return finish(ctx);

      // Stage 2（合并的 draft 阶段）：纲要 → 组装初稿输入 →（下面写初稿）----
      recorder.setStepDir(path.join(article.dir, "02-step"));
      outline = manualEntry ? buildManualOutline(ctx, topic) : await resolveOutline(ctx, sources, resume);
      ctx.outline = outline;
      writeJson(path.join(article.dir, ARTIFACT.outline), outline);
      writeText(path.join(article.dir, ARTIFACT.outlineMd), renderOutlineMarkdown(outline, topic.title || topic.topic));
      logger.step(`纲要完成：${(outline.outline || []).length} 个小节，${(outline.image_plan || []).length} 张配图`);

      // Draft input: 标题 + 大纲 + 相关资料 打包成一份 JSON，初稿节点只读它。
      ctx.draftInput = resolveDraftInput(ctx, { topic, outline, sources });
      logger.info(`初稿输入：${ARTIFACT.draftInput}（${summarizeDraftInput(ctx.draftInput).join("｜")}）`);
    } else {
      // 续跑：前面的产物直接读回来，供后续阶段使用。
      ctx.topic = readJsonSafe(path.join(article.dir, ARTIFACT.topic)) || { title: article.article?.title || "" };
      ctx.sources = ctx.topic.sources || [];
      ctx.outline = readJsonSafe(path.join(article.dir, ARTIFACT.outline)) || { title: ctx.topic.title, outline: [], image_plan: [] };
      if (exists(path.join(article.dir, ARTIFACT.draftInput))) {
        ctx.draftInput = normalizeDraftInput(readJson(path.join(article.dir, ARTIFACT.draftInput)));
      }
    }

    // --input 直接把「标题 + 大纲 + 资料」交给初稿节点，跳过选题/纲要/组装。
    if (inputProvided) {
      ctx.draftInput = resolveDraftInput(ctx, {});
      ctx.outline = ctx.outline || {
        title: ctx.draftInput.title,
        outline: ctx.draftInput.outline || [],
        image_plan: ctx.draftInput.images || [],
      };
    }

    // Stage 2 续：写初稿（仍属合并后的 draft 阶段，日志继续落 02-step/）
    let articleText;
    // 从更晚的阶段续跑时，初稿路径只认 02-result.json#files.draft；本阶段内复用完产物才回退固定名。
    const draftRel = (fullPipeline && resumeIndex > stageIndex("draft") && fileFromResult(article.dir, "draft", "draft")) || ARTIFACT.draftMd;
    const draftFile = path.join(article.dir, draftRel);
    const draftReused = fullPipeline && (resumeIndex > stageIndex("draft") || (resume && exists(draftFile)));
    if (draftReused) {
      articleText = readText(draftFile);
      ctx.article = articleText;
      ctx.state.stages.draft = { ok: true, reused: true, file: draftFile };
      logger.info(`续跑：复用 ${draftRel}`);
    } else {
      if (!ctx.draftInput) throw new Error(`缺少 ${ARTIFACT.draftInput}，先跑 topic/draft 或用 --input 给一份初稿输入`);
      articleText = await generateDraft(ctx, ctx.draftInput);
      writeText(draftFile, articleText);
      ctx.article = articleText;
      logger.step(`初稿完成：${countWords(articleText)} 字 → ${ARTIFACT.draftMd}`);
      ctx.state.stages.draft = { ok: true, words: countWords(articleText), sections: (ctx.outline?.outline || []).length, file: draftFile };
    }
    const draftStage = ctx.outline || { outline: [], image_plan: [] };
    writeJson(path.join(article.dir, ARTIFACT.draft), validateResult({
      ...buildEnvelope(article.dir, "draft", {
        title: ctx.topic?.title || draftStage.title || "",
        type: type.id,
        files: {
          outline: ARTIFACT.outline,
          outlineMd: ARTIFACT.outlineMd,
          draftInput: ARTIFACT.draftInput,
          draft: ARTIFACT.draftMd,
        },
      }),
      sections: (draftStage.outline || []).length,
      images_planned: (draftStage.image_plan || []).length,
      words: countWords(articleText),
    }, { step: "draft_writing", config, type, file: ARTIFACT.draft, logger }));
    if (stopStage === "draft") return finish(ctx);

    // Stage 3: review loop ---------------------------------------------
    recorder.setStepDir(path.join(article.dir, "03-step"));
    if (fullPipeline && resumeIndex > stageIndex("review")) {
      // 跨步读取只认 03-result.json#files；地图里没有（旧产物/散落稿件）才回退到固定文件名。
      const reviewedRel = fileFromResult(article.dir, "review", "reviewed") || ARTIFACT.reviewed;
      articleText = readText(path.join(article.dir, reviewedRel));
      ctx.state.stages.review = { ok: true, reused: true, file: path.join(article.dir, reviewedRel) };
      logger.info(`续跑：复用 ${reviewedRel}`);
    } else {
      const reviewed = await reviewLoop(ctx, articleText);
      articleText = reviewed.article;
      ctx.article = articleText;
      ctx.review = reviewed.history;
      const reviewedFile = finishReviewStage(ctx, reviewed);
      logger.step(`审稿完成：${reviewed.history.length} 轮，综合评分 ${reviewed.final.composite_score ?? "n/a"}（通过线 ${reviewed.pass_score}）→ ${ARTIFACT.reviewed}`);
      ctx.state.stages.review = {
        ok: true,
        rounds: reviewed.history.length,
        score: reviewed.final.composite_score,
        passed: reviewed.passed,
        file: reviewedFile,
      };
    }
    if (stopStage === "review") return finish(ctx);

    // Stage 4: 组稿（去 AI 化 + 配图，两路并发）--------------------
    recorder.setStepDir(path.join(article.dir, "04-step"));
    if (fullPipeline && resumeIndex > stageIndex("compose")) {
      const composedRel = fileFromResult(article.dir, "compose", "composed") || ARTIFACT.composed;
      const imagesRel = fileFromResult(article.dir, "compose", "images") || ARTIFACT.images;
      articleText = readText(path.join(article.dir, composedRel));
      ctx.images = readJsonSafe(path.join(article.dir, imagesRel)) || [];
      ctx.state.stages.compose = { ok: true, reused: true, file: path.join(article.dir, composedRel) };
      logger.info(`续跑：复用 ${composedRel}`);
    } else {
      const composed = await composeArticle(ctx, articleText);
      articleText = composed.article;
      ctx.article = articleText;
      ctx.images = composed.images;
      const composedFile = finishComposeStage(ctx, composed);
      ctx.state.stages.compose = {
        ok: true,
        polish: { ok: composed.polish.ok, fallback: Boolean(composed.polish.fallback), model: composed.polish.model || null },
        images: composed.images.map((i) => ({ index: i.index, success: i.success, pipeline: i.pipeline || null })),
        file: composedFile,
      };
    }
    if (stopStage === "compose") return finish(ctx);

    // Stage 5: publish + archive --------------------------------------
    recorder.setStepDir(path.join(article.dir, "05-step"));
    let publishResult = null;
    if (fullPipeline && resumeIndex > stageIndex("publish")) {
      publishResult = readJsonSafe(path.join(article.dir, ARTIFACT.publish));
      logger.info("续跑：发布已完成，继续归档");
    } else {
      publishResult = await publishArticle(ctx, articleText);
      ctx.publish = publishResult;
      ctx.state.stages.publish = publishResult;
    }

    // 归档整体开关单源在 steps 节点 archive.enabled；
    // 知识库入库与否由 defaults.publish.archive.knowledge_dir 是否为空决定。
    if (!stepEnabled("archive", config, type)) {
      logger.info("归档环节已关闭（steps 节点 archive.enabled=false）：产物留在 draft/，不打包不删除");
    } else if (publishResult?.status === "published") {
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
      // 目录已被打包删除，收尾只打印，不再写任何文件。
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
    process.exitCode = 1;
  }
}

function finish(ctx) {
  ctx.state.finishedAt = new Date().toISOString();
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
      ? path.join(outputDir, ARTIFACT.topic)
      : null;
  if (file && fs.existsSync(file)) {
    logger.info(`复用已有选题：${file}`);
    ctx.topicReused = true;
    return { topic: normalizeTopic(readJson(file)), proposals: null };
  }
  if (options["from-proposal"]) {
    const idx = clamp(asNumber(options["from-proposal"]) || 1, 1, 10);
    const value = String(options["from-proposal"]);
    const proposalFile = path.isAbsolute(value)
      ? value
      : outputDir
        ? path.join(outputDir, ARTIFACT.topicProposal)
        : null;
    if (!proposalFile) {
      throw new Error("--from-proposal 需要配合 --article <slug>（选题候选存在文章目录里）");
    }
    if (!fs.existsSync(proposalFile)) {
      throw new Error(`找不到选题候选：${proposalFile}（先跑一次自动选题，或改用 --topic）`);
    }
    const payload = readJson(proposalFile);
    const chosen = (payload.topics || [])[idx - 1];
    if (!chosen) {
      throw new Error(`候选第 ${idx} 个不存在（文件里共 ${(payload.topics || []).length} 个）`);
    }
    logger.info(`从候选选题 #${idx}：《${chosen.title || chosen.topic}》`);
    return { topic: normalizeTopic(chosen), proposals: null };
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
    const hits = await searchWeKnora(type, query, {
      logger,
      // 候选池上限单源 types/<id>.yaml 的 topic.max_candidates（本地路径用的同一个值）；
      // 原来读的是早废弃的 topic.candidates 别名，还配了 `|| 15` 的兜底，两个都没有配置来源。
      limit: topicWindows(type).maxCandidates,
      recorder: ctx.recorder,
      slot: API_SLOT.topic.knowledge,
    });
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
  if (options["sources-file"]) {
    const file = path.resolve(PROJECT_ROOT, String(options["sources-file"]));
    if (!fs.existsSync(file)) throw new Error(`--sources-file 不存在：${file}`);
    logger.info(`复用已有素材：${file}`);
    return readJson(file);
  }
  // 素材收在 01-result.json 的 sources 字段里：续跑时收过就不重复检索。
  const resultFile = path.join(outputDir, ARTIFACT.topic);
  if (resume && fs.existsSync(resultFile)) {
    const prev = readJson(resultFile).sources;
    if (Array.isArray(prev) && prev.length) {
      logger.info(`复用已有素材：${ARTIFACT.topic}#sources（${prev.length} 条）`);
      return prev;
    }
  }
  return mergeWebSearchSources(ctx, topic, await collectSources(type, { topic, notes: ctx.notes, logger, mock: ctx.mock }));
}

/**
 * 通道 2：充分性闸门判定本地不足时，用 opencode websearch 补外部素材。
 * 任何失败只 warn（serve 起不来 / 全组检索失败都不阻塞），mock 永不联网。
 * 外部 Markdown 落地在 01-step/web-search/，与 01-result.json#sources 同属选题步。
 */
async function mergeWebSearchSources(ctx, topic, local) {
  const { type, logger, mock, outputDir } = ctx;
  const cfg = type.knowledge?.["web-search"] || {};
  if (!cfg.enabled || mock || !outputDir) return local;
  try {
    const { gatherWebSearch } = await import("./lib/web-search.mjs");
    const webSearch = await gatherWebSearch({
      topic,
      localSources: local,
      articleDir: outputDir,
      cfg,
      model: cfg.model,
      maxSources: type.knowledge.max_sources,
      logger,
      recorder: ctx.recorder,
      slot: API_SLOT.topic.web_search,
    });
    if (!webSearch.length) return local;
    return [...local, ...webSearch].map((item, i) => ({ ...item, index: i + 1 }));
  } catch (error) {
    logger.warn(`外部检索不可用：${error.message}`);
    return local;
  }
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
    throw new Error('manual 入口需要提纲：用 --outline-file <提纲.md> 或 --outline "…"（也可直接传 02-step/outline.json）');
  }

  const title = String(options.title || topic.title || topic.topic || "").trim();
  const outline = parsed || parseOutlineMarkdown(raw, { title, targetWords: type.length.target });
  if (!outline) throw new Error("无法从提纲中解析出小节，请用「## 小节」配「- 要点」的格式");

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

  const input = buildTopicInput(type, candidates);
  const { candidateDays, freshDays, proposals: proposalCount } = topicWindows(type);
  const freshCount = input.candidates.filter((c) => c.fresh).length;
  const written = listWrittenArticles(ctx.config);

  // Manual topic: skip the topic model entirely (one step instead of two).
  if (manual) {
    logger.info(`手动主题：${manual}（跳过选题模型）`);
    const keywords = (type.topic.keywords || []).slice(0, 6);
    const topic = {
      topic: manual,
      title: manual,
      thesis: "",
      angle: "手动指定",
      rationale: requirements || "用户手动指定主题。",
      keywords: keywords.length ? keywords : buildTerms(manual).slice(0, 6),
      source_hints: input.candidates.slice(0, 3).map((c) => c.title),
      title_candidates: [],
    };
    return { topic, proposals: null };
  }

  logger.info(
    `自动选题：近 ${candidateDays} 天文件日期 ${input.candidates.length} 篇候选，其中近 ${freshDays} 天新采集 ${freshCount} 篇`,
  );

  if (mock) {
    const mockTopics = Array.from({ length: proposalCount }, (_, i) =>
      normalizeTopic({
        topic: `（Mock）${type.name}测试主题 ${i + 1}`,
        title: `（Mock）${type.name}测试标题 ${i + 1}`,
        thesis: "这是 mock 选题，用于验证脚本流程。",
        angle: "流程验证",
        rationale: "mock 模式不调用模型。",
        score: 90 - i * 5,
        keywords: type.topic.keywords?.slice(0, 4) || ["测试"],
        source_hints: input.candidates.slice(0, 2).map((c) => c.title),
        title_candidates: [`（Mock）${type.name}测试标题 ${i + 1}`],
      }),
    );
    const mockVerdict = await selectBestTopic({ config: ctx.config, topics: mockTopics, logger, mock: true });
    const mockChosen = mockTopics[mockVerdict.ok ? mockVerdict.index : 0];
    return {
      topic: mockChosen,
      proposals: buildProposalPayload(type, input, mockTopics, { mock: true, picked: mockVerdict, chosen: mockChosen }),
    };
  }

  const call = stepCallConfig(ctx, "select_topic", "select", options);
  const prompt = buildTopicPrompt({
    prompt: call.prompt,
    promptId: call.prompt_id,
    type,
    candidates: input.candidates,
    heatmap: input.heatmapText,
    written,
    mode: "auto",
    userRequirements: requirements,
    count: proposalCount,
  });
  let topics = [];
  try {
    const result = await models.jsonValidated(call.model, {
      ...prompt,
      schema: call.schema,
      attempts: call.attempts,
      timeout: call.timeout,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      label: "topic",
      slot: API_SLOT.topic.select,
    });
    const raw = Array.isArray(result.topics) ? result.topics : [result];
    topics = validateProposals(raw.map(normalizeTopic).filter((t) => t.topic), input.candidates, written, logger);
  } catch (error) {
    logger.warn(`选题模型失败（${error.message}），回退到规则选题`);
  }

  if (!topics.length) {
    const best = input.candidates[0];
    topics = [
      normalizeTopic({
        topic: best?.title || type.name,
        title: best?.title || type.name,
        thesis: best?.note.summary || "",
        angle: "基于知识库最新文章",
        rationale: "模型不可用或输出无效，采用最新候选文章作为主题。",
        keywords: type.topic.keywords?.slice(0, 4) || [],
        source_hints: best ? [best.title] : [],
        title_candidates: [best?.title || type.name],
      }),
    ];
  }

  // 本地负责凑齐选项：撞车剔除后不足 proposalCount 个时按时间顺序回填，再校验一次防止回填重复
  if (topics.length < proposalCount) {
    for (const c of input.candidates) {
      if (topics.length >= proposalCount) break;
      if (topics.some((t) => t.topic === c.title)) continue;
      topics.push(
        normalizeTopic({
          topic: c.title,
          title: c.title,
          thesis: c.note?.summary || "",
          angle: "基于知识库最新文章",
          rationale: "选题模型候选不足，按时间顺序回填。",
          keywords: type.topic?.keywords?.slice(0, 4) || [],
          source_hints: [c.title],
          title_candidates: [c.title],
        }),
      );
    }
    topics = validateProposals(topics, input.candidates, written);
  }

  // 写作模型出候选 + 评分，systemone 判定择一；判定不可用时按评分第一篇。
  let picked = null;
  if (topics.length > 1) {
    const verdict = await selectBestTopic({
      config: ctx.config,
      cfg: systemOneCallConfig(ctx, "select_topic", "best"),
      topics,
      logger,
      recorder: ctx.recorder,
      slot: API_SLOT.topic.best,
    });
    if (verdict.ok) {
      picked = verdict;
      const t = topics[verdict.index];
      logger.info(
        `判断模型择题：第 ${verdict.index + 1} 个候选《${t.title || t.topic}》（置信度 ${verdict.confidence}${verdict.escalated ? "，二次判断" : ""}）`,
      );
    } else {
      logger.warn(`判断模型择题不可用（${verdict.reason}），按写作模型评分取第一篇`);
    }
  }
  const chosen = topics[picked ? picked.index : 0];
  return { topic: chosen, proposals: buildProposalPayload(type, input, topics, { picked, chosen }) };
}

function buildProposalPayload(type, input, topics, { mock = false, picked = null, chosen = null } = {}) {
  const w = topicWindows(type);
  return {
    version: 1,
    mock,
    generated_at: new Date().toISOString(),
    type: type.id,
    windows: { candidate_days: w.candidateDays, fresh_days: w.freshDays },
    candidates: input.candidates.map((c) => ({
      title: c.title,
      date: c.note.date,
      days_ago: c.daysAgo,
      fresh: c.fresh,
    })),
    heatmap: input.heatmap,
    topics,
    // systemone 择题判定（从 topics 里选第 index 个）；判定不可用或单候选时为 null
    picked: picked
      ? {
          index: picked.index,
          title: chosen?.title || chosen?.topic || "",
          confidence: picked.confidence,
          model: picked.model,
          escalated: Boolean(picked.escalated),
          first_choice: picked.first ? Number(picked.first.type) || null : null,
        }
      : null,
  };
}

async function generateOutline(ctx, sources) {
  const { type, models, logger, topic, options, mock, outputDir } = ctx;
  if (mock) {
    return {
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

  const call = stepCallConfig(ctx, "outline", "outline", options);
  const prompt = buildOutlinePrompt({
    prompt: call.prompt,
    promptId: call.prompt_id,
    type,
    topic,
    sources,
    userRequirements: options.requirements ? String(options.requirements) : "",
    maxChars: 16000,
    baseDir: outputDir || "",
  });
  let outline;
  try {
    outline = await models.jsonValidated(call.model, {
      ...prompt,
      schema: call.schema,
      attempts: call.attempts,
      timeout: call.timeout,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      label: "outline",
      slot: API_SLOT.draft.outline,
    });
  } catch (error) {
    logger.warn(`纲要模型失败（${error.message}），使用规则纲要`);
    outline = fallbackOutline(type, topic, sources);
  }
  // 标题不进纲要：单源 = 01 选题步（ctx.topic.title），下游各自从 topic/draftInput 取
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
 * written to `02-step/draft-input.json` so the draft step reads one stable artifact.
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
      baseDir: outputDir || "",
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
      formatImageMarker(type.illustrations.position_format, 1),
      "",
      "## 第一节",
      "",
      "Mock 内容用于测试选题、纲要、评稿、配图与发布流程，不代表真实写作质量。",
      "",
      "## 第二节",
      "",
      "如果你看到这篇文章，说明脚本的模型调用被替换成了 mock。",
      "",
      formatImageMarker(type.illustrations.position_format, 2),
      "",
      "## 结尾",
      "",
      "流程验证结束。",
      "",
    ].join("\n");
    return normalizeArticle(body, { title: input.title, type: type.id });
  }

  const prompt = buildDraftPrompt({ type, input, template: ctx.draftTemplate, maxChars: 18000 });
  const call = stepCallConfig(ctx, "draft_writing", "draft", options);
  let article;
  try {
    article = await models.complete(call.model, {
      ...prompt,
      timeout: call.timeout,
      temperature: call.temperature,
      label: "draft",
      slot: API_SLOT.draft.draft,
      maxTokens: call.maxTokens || Math.max(4096, Math.round(type.length.max * 2)),
    });
  } catch (error) {
    logger.warn(`初稿模型失败（${error.message}），尝试分节生成`);
    article = await generateDraftBySections(ctx, input);
  }
  article = normalizeArticle(stripCodeFence(article), { title: input.title, type: type.id });
  article = ensureSectionHeadings(article, input.outline.map((section) => section.heading));
  const count = resolveImageCount(type, { image_plan: input.images }, { count: options.images ? asNumber(options.images) : undefined });
  article = normalizeImageMarkers(article, count, input.images, { format: type.illustrations.position_format });
  // 篇幅不在这里调：修正环节（reviewLoop → reviseWithLengthCheck）内置字数校验。
  return article;
}

async function generateDraftBySections(ctx, input) {
  const { type, models, options, logger, draftTemplate } = ctx;
  const call = stepCallConfig(ctx, "draft_writing", "draft", options);
  const parts = [];
  for (const [i, section] of input.outline.entries()) {
    logger.info(`分节生成 ${i + 1}/${input.outline.length}：${section.heading}`);
    const prompt = buildDraftPrompt({
      type,
      input: { ...input, outline: [section], images: [] },
      template: draftTemplate,
      maxChars: 10000,
      // 「只写这一节」的约束句单源 prompts/draft.yaml 的 section_only
      section: section.heading,
    });
    const text = await models.complete(call.model, {
      ...prompt,
      timeout: call.timeout,
      label: `draft-section-${i + 1}`,
      slot: API_SLOT.draft.draft,
      maxTokens: 2048,
    });
    parts.push(stripCodeFence(text).replace(/^---[\s\S]*?---\s*/, "").trim());
  }
  return normalizeArticle(`# ${input.title}\n\n${parts.join("\n\n")}`, { title: input.title, type: type.id });
}

/** 修正环节需要的小节/配图基准信息：优先初稿输入，退回纲要，再退回稿件本身。 */
function lengthInput(ctx, article) {
  const outline = ctx.draftInput?.outline || ctx.outline?.outline || [];
  return {
    title: ctx.draftInput?.title || getTitle(article),
    outline,
    images: ctx.draftInput?.images || ctx.outline?.image_plan || [],
  };
}

/**
 * 重跑审稿阶段前清掉上一进程的轮次目录与留痕：子步骤/尝试计数器每次进程都从 1 开始，
 * 旧 (尝试) 文件不会被覆盖，留着会让本次运行看起来调用了更多次；同时删掉
 * reviewed.md / 03-result.json，保证「存在即完成」只对最后一次运行成立。
 */
function resetReviewArtifacts(outputDir) {
  const stepDir = path.join(outputDir, ARTIFACT.reviewDir);
  if (fs.existsSync(stepDir)) {
    for (const entry of fs.readdirSync(stepDir)) {
      if (entry === "api" || /^round-\d+/.test(entry)) {
        fs.rmSync(path.join(stepDir, entry), { recursive: true, force: true });
      }
    }
  }
  fs.rmSync(path.join(outputDir, ARTIFACT.reviewed), { force: true });
  fs.rmSync(path.join(outputDir, ARTIFACT.review), { force: true });
}

/**
 * 审稿轮次与通过线单源配置，代码不兜 3 / 80（那两份副本与 defaults.yaml 同值，
 * 抬 PB_REVIEW_ROUNDS / PB_PASS_SCORE 就白抬了）：
 *   max_rounds → --rounds > defaults.yaml defaults.review.max_rounds（类型可覆盖），clamp 1-5；
 *   pass_score → types/<id>.yaml 顶层 pass_score > defaults.yaml defaults.review.pass_score。
 * 加载期 normalizeType 只把写出来的值归成数字，缺了由这里抛错点名配置路径。
 */
function maxRoundsOf(type, roundsOption) {
  if (roundsOption !== undefined && roundsOption !== null && roundsOption !== "") {
    return clamp(needNumber(roundsOption, "--rounds"), 1, 5);
  }
  return clamp(needNumber(type.review?.max_rounds, "defaults.yaml defaults.review.max_rounds（可用 .env PB_REVIEW_ROUNDS 抬起）"), 1, 5);
}

function passScoreOf(type) {
  return needNumber(
    type.review?.pass_score,
    `类型 ${type.id} 的 pass_score：写在 types/${type.id}.yaml 顶层或 defaults.yaml defaults.review.pass_score（可用 .env PB_PASS_SCORE 抬起）`,
  );
}

async function reviewLoop(ctx, article) {
  const { type, logger, options } = ctx;
  resetReviewArtifacts(ctx.outputDir);
  const maxRounds = maxRoundsOf(type, options.rounds);
  const passScore = passScoreOf(type);
  const history = [];
  let current = article;
  let final = null;
  let stopReason = "max_rounds";

  for (let round = 1; round <= maxRounds; round += 1) {
    logger.step(`第 ${round}/${maxRounds} 轮：核稿 → 修正 → 评稿 → 判定`);
    const roundDir = ensureDir(path.join(ctx.outputDir, ARTIFACT.reviewDir, `round-${round}`));

    // 1) 并行调用规则端点：/api/correct 与 /api/sensitive/check，只采集候选，不做字面替换。
    let correctResult;
    if (ctx.mock) {
      correctResult = { enabled: false, ok: true, skipped: true, candidates: [], sensitive: [], errors: { correct: null, sensitive: null } };
    } else {
      const corrector = createCorrector(type.review.correct_cn, logger, {
        recorder: ctx.recorder,
        slots: { correct: API_SLOT.review.correct, sensitive: API_SLOT.review.sensitive },
      });
      correctResult = await corrector.check(current);
    }
    const afterCorrect = current;
    const sensitiveSummary = summarizeSensitive(correctResult.sensitive);
    // candidates = 过滤后的错别字候选（交给改稿模型逐条核实）；sensitive = 敏感词摘要，只留痕不进提示词。
    writeJson(path.join(roundDir, "correct.json"), {
      ok: correctResult.ok,
      skipped: Boolean(correctResult.skipped),
      errors: correctResult.errors || { correct: null, sensitive: null },
      candidates: correctResult.candidates || [],
      sensitive: sensitiveSummary,
      timings: correctResult.timings || {},
    });
    writeText(path.join(roundDir, "after-correct.md"), afterCorrect);

    // 2) revise：首轮依据核稿候选，第二轮起叠加上一轮评分；
    //    返回稿本地计字，不合格带原因重试，重试耗尽抛错中断管线。
    current = await reviseWithLengthCheck(ctx, afterCorrect, {
      corrections: correctResult.candidates || [],
      score: final,
      round,
    });
    writeText(path.join(roundDir, "after-revise.md"), current);
    if (!ctx.mock) {
      writeText(path.join(ctx.outputDir, ARTIFACT.reviewDir, `round-${round}-diff.md`), diffSummary(afterCorrect, current));
    }

    // 3) score
    const score = await scoreArticle(ctx, current, round);
    writeJson(path.join(roundDir, "score.json"), score);
    logger.info(`评稿得分：${score.composite_score ?? "n/a"}（通过线 ${passScore}）${score.verdict ? `，结论 ${score.verdict}` : ""}`);

    // 4) 去留判定（scoring 节点 models.check；不可用时回退 pass_score 规则）
    const check = await revisionCheck(ctx, current, score, round, passScore);
    writeJson(path.join(roundDir, "check.json"), check);

    const entry = {
      round,
      word_count: countWords(current),
      correct: { ok: correctResult.ok, candidates: (correctResult.candidates || []).length, sensitive: sensitiveSummary.count },
      score,
      check,
    };
    history.push(entry);
    final = score;

    if (check.decision === "done") {
      stopReason = "done";
      logger.step(`第 ${round} 轮判定无需再改（${check.source}），结束审稿循环`);
      break;
    }
    if (round === maxRounds) {
      logger.warn(`已达到最大轮次 ${maxRounds}，判定仍为继续修改，保留当前稿件`);
      break;
    }
  }

  // 通过与否只由确定性阈值裁决：本轮最后一份稿件的综合评分（脚本按权重回算，非模型自报）。
  // check 判定只决定"还要不要再改一轮"，不作为出稿质量结论，两者可以不一致。
  const passed = (history.at(-1)?.score?.composite_score ?? 0) >= passScore;

  return {
    article: current,
    history,
    final: final || { composite_score: null, issues: [] },
    passed,
    pass_score: passScore,
    stop_reason: stopReason,
  };
}

/** 审稿落盘的唯一实现：管线与独立 review 命令共用，写 reviewed.md + 03-result.json。 */
function finishReviewStage(ctx, reviewed) {
  const file = path.join(ctx.outputDir, ARTIFACT.reviewed);
  writeText(file, reviewed.article);
  writeJson(path.join(ctx.outputDir, ARTIFACT.review), validateResult({
    ...buildEnvelope(ctx.outputDir, "review", {
      title: ctx.topic?.title || "",
      type: ctx.type?.id || "",
      files: { reviewed: ARTIFACT.reviewed },
    }),
    // 每轮只留闸门要看的那几个数；核稿候选、敏感词命中这些过程明细在 03-step/ 里。
    rounds: reviewed.history.map(({ round, word_count, score, check }) => ({
      round,
      word_count,
      composite_score: score?.composite_score ?? null,
      scorer: score?.scorer ?? null,
      scorer_model: score?.scorer_model ?? null,
      decision: check?.decision ?? null,
    })),
    final: {
      composite_score: reviewed.final?.composite_score ?? null,
      reported_score: reviewed.final?.reported_score ?? null,
      scorer: reviewed.final?.scorer ?? null,
      scorer_model: reviewed.final?.scorer_model ?? null,
      decision: reviewed.history.at(-1)?.check?.decision ?? null,
      stop_reason: reviewed.stop_reason ?? null,
    },
    passed: reviewed.passed,
    pass_score: reviewed.pass_score,
  }, { step: "scoring", config: ctx.config, type: ctx.type, file: ARTIFACT.review, logger: ctx.logger }));
  return file;
}

async function scoreArticle(ctx, article, round) {
  const { type, models, options, mock, logger } = ctx;
  if (mock) {
    return {
      dimensions: type.scoring.dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, score: 85, comment: "mock" })),
      composite_score: 85,
      reported_score: null,
      verdict: "pass",
      reported_verdict: "pass",
      strengths: ["mock"],
      issues: [],
      must_fix: [],
      suggested_title: "",
      word_count: countWords(article),
      scorer: "mock",
      scorer_model: "mock",
    };
  }

  const wordCount = countWords(article);
  const call = stepCallConfig(ctx, "scoring", "score", { model: options["review-model"] }, round);
  const prompt = buildScorePrompt({
    prompt: call.prompt,
    promptId: call.prompt_id,
    type,
    article,
    wordCount,
    round,
  });
  let result;
  try {
    result = await models.jsonValidated(call.model, {
      ...prompt,
      schema: call.schema,
      attempts: call.attempts,
      timeout: call.timeout,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      label: "score",
      slot: API_SLOT.review.score,
    });
  } catch (error) {
    logger.warn(`评稿模型失败（${error.message}），使用规则评分`);
    return ruleBasedScore(type, article, wordCount);
  }
  return scoreArticleResult(
    normalizeScore(type, result, wordCount, { model: models.getProfile(call.model).model || call.model }),
    logger,
  );
}

/** 自报总分与维度加权回算背离时警告：闸门只认回算值（composite_score）。 */
function scoreArticleResult(score, logger) {
  if (score.reported_score !== null && Math.abs(score.reported_score - score.composite_score) > 5) {
    logger.warn(
      `评稿自报总分 ${score.reported_score} 与维度加权回算 ${score.composite_score} 相差 ${Math.round(Math.abs(score.reported_score - score.composite_score) * 10) / 10} 分，综合评分取回算值`,
    );
  }
  if (score.reported_verdict && score.reported_verdict !== score.verdict) {
    logger.warn(`评稿自报结论 ${score.reported_verdict} 与综合评分阈值判出的 ${score.verdict} 不一致，以综合评分为准`);
  }
  return score;
}

export function normalizeScore(type, result, wordCount, { model = "" } = {}) {
  // 通过线单源配置（passScoreOf 缺了会抛错点名路径），这里不再兜 80。
  const passScore = passScoreOf(type);
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
  // 综合评分 = 脚本按维度分加权回算，唯一进闸门的分数；模型自报的 total 只作诊断留痕。
  const composite = Math.round(dims.reduce((sum, d) => sum + d.score * d.weight, 0) * 10) / 10;
  const reported = Number(result.total);
  const issues = (result.issues || []).map((issue) => ({
    severity: ["high", "medium", "low"].includes(issue.severity) ? issue.severity : "medium",
    dimension: issue.dimension || "",
    location: issue.location || "",
    problem: issue.problem || String(issue),
    fix: issue.fix || "",
  }));
  return {
    dimensions: dims,
    composite_score: composite,
    reported_score: Number.isFinite(reported) ? clamp(reported, 0, 100) : null,
    verdict: composite >= passScore ? "pass" : "revise",
    reported_verdict: ["pass", "revise"].includes(result.verdict) ? result.verdict : null,
    strengths: Array.isArray(result.strengths) ? result.strengths.map(String) : [],
    issues,
    must_fix: Array.isArray(result.must_fix) ? result.must_fix.map(String) : [],
    suggested_title: String(result.suggested_title || ""),
    word_count: wordCount,
    scorer: "model",
    scorer_model: model,
  };
}

export function ruleBasedScore(type, article, wordCount) {
  const { body } = splitFrontmatter(article);
  const imageFormat = type.illustrations.position_format;
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim() && parseImageMarkers(p, { format: imageFormat }).length === 0);
  const longParagraphs = paragraphs.filter((p) => p.replace(/[^\n]/g, "").length > 5 || p.length > 220).length;
  const markers = parseImageMarkers(article, { format: imageFormat }).length;
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
  const composite = Math.round(dims.reduce((sum, d) => sum + d.score * d.weight, 0) * 10) / 10;
  return {
    dimensions: dims,
    composite_score: composite,
    reported_score: null,
    verdict: composite >= passScoreOf(type) ? "pass" : "revise",
    reported_verdict: null,
    strengths: [],
    issues: [
      ...(inRange ? [] : [{ severity: "high", dimension: "length", location: "全文", problem: `字数 ${wordCount} 不在 ${type.length.min}-${type.length.max} 区间`, fix: "扩充或压缩到目标字数" }]),
      ...(longParagraphs ? [{ severity: "medium", dimension: "structure", location: "全文", problem: `${longParagraphs} 个段落过长`, fix: "拆分超过 5 行的段落" }] : []),
    ],
    must_fix: inRange ? [] : ["调整篇幅到要求区间"],
    suggested_title: "",
    word_count: wordCount,
    scorer: "rule",
    scorer_model: null,
  };
}

/**
 * 修正（内置字数校验）：首轮修改依据 = 核稿候选，第二轮起叠加上一轮评分。
 * 返回稿由本地函数计字，不在 [min,max] 区间就以上一稿为基准带原因重新调用；
 * 重试上限 --length-attempts（默认 3），耗尽仍不合格则抛错中断管线。
 */
async function reviseWithLengthCheck(ctx, article, { corrections = [], score = null, round }) {
  const { type, models, options, logger, mock } = ctx;
  if (mock) return article;
  const call = stepCallConfig(ctx, "revision", "revise", options, round);
  const range = { min: type.length.min, max: type.length.max };
  const maxRetries = clamp(asNumber(options.lengthAttempts, 3), 0, 5);
  const input = lengthInput(ctx, article);
  const imageFormat = type.illustrations.position_format;
  const markers = parseImageMarkers(article, { format: imageFormat }).length || type.illustrations.min;
  let failReason = null;
  let lastError = null;
  // 重试以上一次返回稿为基准：字数不合格说的是「上一稿」，继续拿原稿会让提示词里的
  // 当前字数与正文自相矛盾（模型倾向于退回原稿长度，永远收敛不了）。
  let base = article;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const prompt = buildRevisePrompt({
      prompt: call.prompt,
      promptId: call.prompt_id,
      type,
      article: base,
      review: score,
      corrections,
      round,
      wordCount: countWords(base),
      attempt,
      failReason,
    });
    let candidate;
    try {
      const text = await models.complete(call.model, {
        ...prompt,
        timeout: call.timeout,
        temperature: call.temperature,
        label: "revise",
        slot: API_SLOT.review.revise,
        attempt,
        maxTokens: call.maxTokens || Math.max(4096, Math.round(range.max * 2)),
      });
      candidate = normalizeArticle(stripCodeFence(text), { title: getTitle(article), type: type.id });
      candidate = ensureSectionHeadings(candidate, input.outline.map((section) => section.heading));
      candidate = normalizeImageMarkers(candidate, markers, input.images, { format: imageFormat });
    } catch (error) {
      lastError = error;
      failReason = { words: null, action: null, error: error.message };
      logger.warn(`修正调用失败（第 ${attempt}/${maxRetries + 1} 次）：${error.message}`);
      continue;
    }
    lastError = null;
    const words = countWords(candidate);
    const action = lengthAction(words, range);
    if (!action) {
      logger.info(`修正完成：${words} 字，字数合格（要求 ${range.min}-${range.max}）${attempt > 1 ? `，第 ${attempt} 次尝试` : ""}`);
      return candidate;
    }
    failReason = { words, action };
    base = candidate;
    logger.warn(`修正稿字数不合格：${words} 字（要求 ${range.min}-${range.max}），需${action === "expand" ? "扩写" : "压缩"}（重试 ${Math.min(attempt, maxRetries)}/${maxRetries}）`);
  }

  if (lastError) {
    throw new Error(`修正环节中断：${maxRetries + 1} 次调用均未产出稿件，最后一次错误：${lastError.message}`);
  }
  throw new Error(`修正环节中断：重试 ${maxRetries} 次后字数仍不合格（最后 ${failReason.words} 字，要求 ${range.min}-${range.max} 字）`);
}

/** 循环去留判定：scoring 节点 models.check（systemone）；不可用或低置信度时回退 pass_score 规则。 */
async function revisionCheck(ctx, current, score, round, passScore) {
  const { type, logger } = ctx;
  if (ctx.mock) return { decision: "done", source: "mock", ok: true, confidence: 1 };
  const blocked = (score.issues || []).some((issue) => issue.severity === "high");
  const ruleDecision = () => (((score.composite_score ?? 0) >= passScore && !blocked) ? "done" : "continue");
  const cfg = systemOneCallConfig(ctx, "scoring", "check");
  if (!cfg) {
    logger.warn("scoring 节点未配置 check 调用，按 pass_score 规则决定去留");
    return { decision: ruleDecision(), source: "rule", ok: false, reason: "未配置 models.check" };
  }
  const minConfidence = needGateParam(cfg, "min_confidence", "steps 节点 scoring.models.check.options");
  const result = await checkRevisionNeeded({
    config: ctx.config,
    cfg,
    score,
    wordCount: countWords(current),
    length: { min: type.length.min, max: type.length.max },
    passScore,
    round,
    logger,
    recorder: ctx.recorder,
    slot: API_SLOT.review.check,
  });
  if (result.ok && result.decision) {
    if (Number(result.confidence ?? 1) < minConfidence) {
      logger.warn(`判断模型置信度 ${result.confidence} 低于 ${minConfidence}，按 pass_score 规则决定去留`);
      return { decision: ruleDecision(), source: "rule", ok: false, reason: `低置信度 ${result.confidence}`, model: result.model, confidence: result.confidence };
    }
    logger.info(`判断模型去留：${result.decision === "done" ? "无需再改" : "继续修改"}（置信度 ${result.confidence}${result.escalated ? "，二次判断" : ""}）`);
    return { decision: result.decision, source: "classifier", ok: true, confidence: result.confidence, model: result.model, escalated: Boolean(result.escalated) };
  }
  logger.warn(`判断模型不可用（${result.reason || "unknown"}），按 pass_score 规则决定去留`);
  return { decision: ruleDecision(), source: "rule", ok: false, reason: result.reason || "unknown" };
}

/**
 * steps 节点的 enabled 是否放行该环节（type 层 steps.<step>.enabled 可覆盖；
 * 节点不存在或配置未加载时默认放行）。04 两条分支、05 发布与归档都用这一个判定。
 */
export function stepEnabled(name, config, type) {
  return resolveStep(name, { steps: config?.steps, type })?.enabled !== false;
}

/**
 * 本步 result 本体的校验契约：steps 节点 `result_schema` 指向 schemas 注册表里的紧凑 DSL。
 * 节点没配（或引用的条目没有 output）就是「没校验」——validateProduced 如实返回 checked:false，
 * 产物里不假装校验过。不合格只警告不阻塞，与 04/05 既有口径一致。
 */
function validateResult(payload, { step, config, type, file, logger }) {
  payload.validation = validateProduced(payload, resolveStep(step, { steps: config?.steps, type })?.result_output_format);
  for (const error of payload.validation.errors) logger?.warn?.(`${file} 结构不符：${error}`);
  return payload;
}

/**
 * 04 两条分支的开关：节点 `enabled`（type 层 `steps.<step>.enabled` 可覆盖）是唯一入口，
 * de_ai 与 image_generation 同规则。关掉的那条只降级——不调用、不产出中间文件、不造假。
 */
export function composeBranches(ctx) {
  return { deAi: stepEnabled("de_ai", ctx.config, ctx.type), images: stepEnabled("image_generation", ctx.config, ctx.type) };
}

/**
 * 04 组稿阶段主执行：去 AI 化（模型改写）与配图（外部生成）并发。
 * 两路互不依赖——去 AI 化只读审稿稿，配图只读纲要的 image_plan；
 * 都结束后再把图片替换进润色稿。去 AI 化失败退回审稿稿，不阻塞发布。
 */
async function composeArticle(ctx, article) {
  const { type, logger, options, outputDir, outline } = ctx;
  const count = resolveImageCount(type, outline, { count: options.images ? asNumber(options.images) : undefined });
  const plans = planImages(outline, count, { cover: type.illustrations.cover !== false });
  const imageStep = resolveStep("image_generation", { steps: ctx.config?.steps, type });
  const { deAi: deAiEnabled, images: imagesEnabled } = composeBranches(ctx);

  const [polish, imageResult] = await Promise.all([
    deAiEnabled
      ? polishArticle(ctx, article).catch((error) => {
        logger.warn(`去 AI 化失败（${error.message}），退回审稿稿继续配图`);
        return { article, ok: false, fallback: true, model: null, error: error.message, words: countWords(article), level: null };
      })
      : Promise.resolve({
        article,
        ok: true,
        skipped: true,
        mock: false,
        model: null,
        words: countWords(article),
        attempts: 0,
        gate: null,
        level: null,
      }),
    imagesEnabled
      ? generateArticleImages(ctx, plans, imageStep)
      : Promise.resolve({ images: [], validation: null }),
  ]);
  const images = imageResult.images;

  // 关档（skipped）和失败回退（fallback）都没有润色稿：宁可不写 polished.md，
  // 也不把审稿稿复制一份冒充 04 的中间产物。composed.md 才是终稿。
  const hasPolished = !polish.skipped && !polish.fallback;
  if (hasPolished) writeText(path.join(outputDir, ARTIFACT.polished), polish.article);
  // file 与 sources 的 link 同规矩：相对文章根目录、/ 分隔（归档搬家后仍可读）。
  writeJson(path.join(outputDir, ARTIFACT.images), images.map((image) => (image.file ? { ...image, file: relativeTo(outputDir, image.file) } : image)));
  const replacements = new Map();
  for (const image of images) {
    if (image.success) replacements.set(image.index, relativeTo(outputDir, image.file));
  }
  const composed = replaceImageMarkers(polish.article, replacements, {
    onFailure: needConfig(type.illustrations.on_failure, "defaults.yaml defaults.illustrations.on_failure"),
    failureNote: imagesEnabled ? "配图生成失败" : "配图已关闭",
    format: type.illustrations.position_format,
    plans,
  });
  const success = images.filter((image) => image.success).length;
  const polishState = polish.skipped
    ? "已关闭（用审稿稿）"
    : polish.ok
      ? `完成${polish.level ? `（${polish.level}档）` : ""}`
      : "未生效（用审稿稿）";
  logger.step(`去 AI 化${polishState}：${polish.words} 字；配图 ${imagesEnabled ? `${success}/${images.length}` : "已关闭"}`);
  return { article: composed, images, planned: plans.length, imagesSkipped: !imagesEnabled, imagesValidation: imageResult.validation, polish };
}

/** 04 阶段落盘：composed.md + 04-result.json（两路并发的汇总）。 */
export function finishComposeStage(ctx, result) {
  const file = path.join(ctx.outputDir, ARTIFACT.composed);
  writeText(file, result.article);
  const images = result.images || [];
  writeJson(path.join(ctx.outputDir, ARTIFACT.compose), validateResult({
    ...buildEnvelope(ctx.outputDir, "compose", {
      title: ctx.topic?.title || "",
      type: ctx.type?.id || "",
      files: {
        polished: result.polish.skipped || result.polish.fallback ? null : ARTIFACT.polished,
        images: ARTIFACT.images,
        composed: ARTIFACT.composed,
      },
    }),
    polish: {
      ok: result.polish.ok,
      skipped: Boolean(result.polish.skipped),
      level: result.polish.level || null,
      fallback: Boolean(result.polish.fallback),
      mock: Boolean(result.polish.mock),
      model: result.polish.model || null,
      words: result.polish.words,
      attempts_used: result.polish.attempts ?? null,
      gate: result.polish.gate || null,
      error: result.polish.error || null,
    },
    // 每张图的明细（通道、提示词、耗时）只落 04-step/images.json，这里记三个数与汇总。
    images_planned: result.planned ?? images.length,
    images_success: images.filter((image) => image.success).length,
    images_skipped: Boolean(result.imagesSkipped),
    images_validation: result.imagesValidation || null,
  }, { step: "image_generation", config: ctx.config, type: ctx.type, file: ARTIFACT.compose, logger: ctx.logger }));
  return file;
}

/**
 * de_ai 的本地质量判据（零 token）：逐字重叠率、字数区间、原稿数字是否都还在。
 * 实测过：只看禁用词计数会漏掉主失效模式——模型整篇誊抄原稿时，禁用词数量和原稿一样。
 */
export function polishSignals(source, polished, range, maxOverlap) {
  const echo = Number(verbatimOverlap(source, polished).toFixed(2));
  const words = countWords(polished);
  const lostNumbers = missingNumbers(source, polished);
  const violations = [];
  if (echo > maxOverlap) violations.push(`改写不足：与原稿逐字重叠 ${Math.round(echo * 100)}%（上限 ${Math.round(maxOverlap * 100)}%）`);
  const action = lengthAction(words, range);
  if (action) violations.push(`字数${action === "expand" ? "偏少" : "偏多"}：${words} 字（要求 ${range.min}-${range.max}）`);
  if (lostNumbers.length) violations.push(`原稿数字丢失：${lostNumbers.join("、")}`);
  return { echo, words, lost_numbers: lostNumbers, violations, ok: violations.length === 0 };
}

/**
 * de_ai 档位（light / standard / deep）：`handler_options.level` 选档，
 * `--de-ai-level` 与 type 层 `steps.de_ai.handler_options.level` 可覆盖；
 * 每档自带提示词 id、重叠上限和采样参数（models.de_ai.levels.<档>.options）。
 * 提示词 id 单源在 levels.<档>.prompt（type 层 steps.de_ai.prompt 指定 id 时优先）。
 * 档位没在 levels 里定义 = 配置说谎，直接抛错，不静默退回默认档。
 */
export function deAiLevelConfig(ctx) {
  const step = resolveStep("de_ai", { steps: ctx.config?.steps, type: ctx.type });
  const handler = step?.handler_options || {};
  const levels = handler.levels || {};
  const level = String(ctx.options?.["de-ai-level"] || handler.level || "").trim();
  if (!level) throw new Error("de_ai 缺少 handler_options.level（可选值：light / standard / deep）");
  const def = levels[level];
  if (!def) {
    throw new Error(`de_ai 档位 ${level} 未在 handler_options.levels 里定义（已定义：${Object.keys(levels).join(" / ") || "无"}）`);
  }
  const prompt = step.prompt_id || def.prompt;
  if (!prompt) throw new Error(`de_ai 档位 ${level} 缺少 prompt（提示词 id 单源在 levels.<档>.prompt）`);
  const maxOverlap = Number(def.max_verbatim_overlap);
  if (!(maxOverlap >= 0 && maxOverlap <= 1)) {
    throw new Error(`de_ai 档位 ${level} 的 max_verbatim_overlap 必须在 0-1 之间：${def.max_verbatim_overlap}`);
  }
  return { level, prompt, maxOverlap };
}

/**
 * 离合格还差多少（只在不合格稿之间择优时用）：三项判据各按「超出量 / 阈值」折算相加。
 * 光比违规条数不够——三条都擦边和一条离谱的，条数一样。
 */
function polishSeverity(signals, { min, max }, maxOverlap) {
  const echoOver = Math.max(0, signals.echo - maxOverlap);
  const lengthOff = signals.words < min ? (min - signals.words) / min : signals.words > max ? (signals.words - max) / max : 0;
  return echoOver + lengthOff + (signals.lost_numbers.length ? 0.5 : 0);
}

export function isBetterAttempt(a, b, range, maxOverlap) {
  if (a.signals.violations.length !== b.signals.violations.length) {
    return a.signals.violations.length < b.signals.violations.length;
  }
  return polishSeverity(a.signals, range, maxOverlap) < polishSeverity(b.signals, range, maxOverlap);
}

/**
 * 去 AI 化：de_ai 节点 models.de_ai（llm 模板，纯文本输出），按档位取提示词与参数。
 * frontmatter、小节标题和配图标记由脚本按审稿稿回填，模型只许改表达。
 * 判据不合格就换一次采样重调，上限 = 该档位 retry_limit（含首轮）；耗尽后取最接近合格的一版
 * （先比违规条数，再比离各阈值的距离），只标记不阻塞——去 AI 化整条分支失败时组稿仍退回审稿稿。
 */
async function polishArticle(ctx, article) {
  const { type, logger, models, options, mock } = ctx;
  const words = countWords(article);
  if (mock) {
    logger.info("mock：跳过去 AI 化模型调用，润色稿沿用审稿稿");
    return { article, ok: true, mock: true, model: null, words, attempts: 0, gate: null, level: null };
  }
  const { level, prompt: promptId, maxOverlap } = deAiLevelConfig(ctx);
  const call = stepCallConfig(ctx, "de_ai", "de_ai", options, null, level);
  const prompt = buildDeAiPrompt({
    prompt: promptById(ctx.config.steps, promptId),
    id: promptId,
    type,
    article,
    title: ctx.topic?.title || getTitle(article),
  });
  const range = { min: type.length.min, max: type.length.max };
  // 档位（含默认调用）的 retry_limit 都必须真写：闸门重调的次数是配置说的，不是代码兜的。
  const attempts = needNumber(call.attempts, `steps 节点 de_ai 的 models.de_ai${level ? `.levels.${level}` : ""}.options.retry_limit`);
  const input = lengthInput(ctx, article);
  const imageFormat = type.illustrations.position_format;
  const markers = parseImageMarkers(article, { format: imageFormat }).length || type.illustrations.min;
  const model = getModelProfile(ctx.config, call.model).model || call.model;
  const tried = [];
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let text;
    try {
      text = await models.complete(call.model, {
        ...prompt,
        timeout: call.timeout,
        temperature: call.temperature,
        label: "de_ai",
        slot: API_SLOT.compose.de_ai,
        attempt,
        maxTokens: call.maxTokens || Math.max(4096, Math.round(range.max * 2)),
      });
    } catch (error) {
      lastError = error;
      logger.warn(`去 AI 化调用失败（第 ${attempt}/${attempts} 次）：${error.message}`);
      continue;
    }
    let polished = normalizeArticle(stripCodeFence(text), { title: getTitle(article), type: type.id });
    polished = ensureSectionHeadings(polished, input.outline.map((section) => section.heading));
    polished = normalizeImageMarkers(polished, markers, input.images, { format: imageFormat });
    const signals = polishSignals(article, polished, range, maxOverlap);
    tried.push({ polished, signals, attempt });
    if (signals.ok) {
      logger.info(`去 AI 化完成（${level}档）：${words} → ${signals.words} 字，重叠 ${Math.round(signals.echo * 100)}%（上限 ${Math.round(maxOverlap * 100)}%）${attempt > 1 ? `，第 ${attempt} 次尝试` : ""}`);
      return {
        article: polished,
        ok: true,
        mock: false,
        model,
        words: signals.words,
        attempts: attempt,
        level,
        gate: gateOf(signals, { attemptsUsed: attempt, attemptsAllowed: attempts, picked: attempt, maxOverlap }),
      };
    }
    logger.warn(`去 AI 化不合格（第 ${attempt}/${attempts} 次）：${signals.violations.join("；")}`);
  }

  if (!tried.length) {
    throw new Error(`${attempts} 次调用均未产出稿件${lastError ? `，最后一次错误：${lastError.message}` : ""}`);
  }
  const best = tried.reduce((a, b) => (isBetterAttempt(b, a, range, maxOverlap) ? b : a));
  logger.warn(`去 AI 化重试耗尽：取最接近合格的一版（第 ${best.attempt} 次，${best.signals.violations.join("；")}）`);
  return {
    article: best.polished,
    ok: true,
    mock: false,
    model,
    words: best.signals.words,
    attempts,
    level,
    gate: gateOf(best.signals, { attemptsUsed: attempts, attemptsAllowed: attempts, picked: best.attempt, maxOverlap }),
  };
}

function gateOf(signals, { attemptsUsed, attemptsAllowed, picked, maxOverlap }) {
  return {
    passed: signals.ok,
    attempts_used: attemptsUsed,
    attempts_allowed: attemptsAllowed,
    picked_attempt: picked,
    echo: signals.echo,
    max_echo: maxOverlap,
    lost_numbers: signals.lost_numbers,
    violations: signals.violations,
  };
}

/**
 * 配图：mock 只落占位 PNG，真实通道内部并发（defaults.yaml illustrations.concurrency）。
 * 提示词模板与产物结构都取自 image_generation 节点（prompts + schemas 单源），
 * 产出的 images.json 按 schemas 的 output 校验一次，不合格只警告——配图失败只降级。
 */
async function generateArticleImages(ctx, plans, imageStep) {
  const { type, logger, mock, outputDir, topic } = ctx;
  const imagesDir = ensureDir(path.join(outputDir, ARTIFACT.imagesDir));
  // 模板单源在节点 prompt；两条分支都用它，mock 的 images.json 才不会与真实形状分叉。
  const template = String(imageStep?.prompt?.user || "").trim();
  if (!template) {
    throw new Error("缺少配图提示词模板：steps 节点 image_generation 的 prompt（prompts/revision.yaml → image_generation.user）");
  }
  let images;

  if (mock) {
    // Create tiny placeholder PNGs so downstream publishing can be validated.
    const scene = (type.illustrations.scenes || {});
    images = plans.map((plan) => {
      const file = path.join(imagesDir, `${String(plan.index).padStart(2, "0")}_mock.png`);
      if (!exists(file)) fs.writeFileSync(file, MOCK_PNG);
      const size = scene[plan.scene] || scene["article-inline"];
      if (!Number(size?.width) || !Number(size?.height)) {
        throw new Error(`缺少配图尺寸：defaults.yaml illustrations.scenes.${plan.scene}（或 article-inline）的 width/height`);
      }
      const prompt = composePrompt(plan, type.illustrations, topic?.title || topic?.topic || "", template, size);
      return { ...plan, prompt, success: true, pipeline: "mock", file };
    });
  } else {
    logger.step(`开始生成 ${plans.length} 张配图`);
    images = await generateImages({
      plans,
      outputDir: imagesDir,
      config: type.illustrations,
      promptTemplate: template,
      logger,
      topic: topic?.title || topic?.topic || "",
      recorder: ctx.recorder,
      slot: API_SLOT.compose.generate,
    });
  }

  const validation = validateImageRecords(images, imageStep?.output_format);
  for (const error of validation.errors) logger.warn(`配图产物结构不符（${ARTIFACT.images}）：${error}`);
  return { images, validation };
}

export async function publishArticle(ctx, article) {
  const { type, logger, options, outputDir, stamp } = ctx;
  const publishConfig = type.publish || {};
  const publishStep = resolveStep("publish", { steps: ctx.config?.steps, type });
  const autoPublish = publishConfig.auto_publish === true || asBool(options["auto-publish"]);
  const dryRun = asBool(options["dry-run"]);

  const emailEnabled = options.email !== undefined ? asBool(options.email) : publishConfig.email?.enabled === true;
  const wechatEnabled = options.wechat !== undefined ? asBool(options.wechat) : publishConfig.wechat?.enabled === true;

  const title = getTitle(article, ctx.topic?.title || "未命名文章");
  const finalFile = path.join(outputDir, ARTIFACT.final);

  // publish 节点的 enabled 是整个环节的开关：连终稿都不落，04 的 composed.md 保持最终稿。
  // 与 auto_publish=false 不同——那是「落终稿但不投递」。
  if (!stepEnabled("publish", ctx.config, type)) {
    logger.info("发布环节已关闭（steps 节点 publish.enabled=false）：不生成 05 产物，不投递");
    return {
      ...buildEnvelope(outputDir, "publish", { title, type: type.id }),
      status: "skipped",
      reason: "steps.publish.enabled=false",
      email: null,
      wechat: null,
      channels: { email: false, wechat: false },
    };
  }

  // 终稿落进 05-step/ 后基准目录深了一层：图片引用同步换成相对本目录的路径，
  // 否则外部发布器（wenyan CLI 按稿件文件所在目录解析相对路径）找不到配图。
  const { markdown: finalArticle, images: finalImages } = relocateLocalImages(article, outputDir, path.dirname(finalFile));
  writeText(finalFile, finalArticle);

  const result = {
    ...buildEnvelope(outputDir, "publish", {
      title,
      type: type.id,
      files: { final: relativeTo(outputDir, finalFile) },
    }),
    status: null,
    email: null,
    wechat: null,
    channels: { email: emailEnabled, wechat: wechatEnabled },
  };
  const persist = () => {
    // 产物结构按 publish 节点 result_schema（publish.publish）的契约校验一次：不合格只警告，不阻塞发布。
    result.validation = validateProduced(result, publishStep?.result_output_format);
    for (const error of result.validation.errors) logger.warn(`发布产物结构不符（${ARTIFACT.publish}）：${error}`);
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
    const html = emailShell(title, await markdownToHtml(bodyOnly(finalArticle)));
    const htmlFile = writeText(path.join(outputDir, ARTIFACT.finalHtml), html);
    result.files.html = relativeTo(outputDir, htmlFile);
    result.email = dryRun
      ? { success: true, dryRun: true, to }
      : await sendEmail({
          to,
          subject: renderSubject(needConfig(publishConfig.email?.subject, "defaults.yaml defaults.publish.email.subject"), { title, date: stamp.date, type: type.name }),
          html,
          images: finalImages.map((image) => ({ src: image.src, file: image.file })),
          config: publishConfig.email || {},
          logger,
          recorder: ctx.recorder,
          slot: API_SLOT.publish.email,
        });
  }

  if (wechatEnabled) {
    result.wechat = await publishToWechat({
      markdownFile: finalFile,
      config: { ...publishConfig.wechat, dry_run: dryRun || publishConfig.wechat?.dry_run },
      logger,
      recorder: ctx.recorder,
      slot: API_SLOT.publish.wechat,
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

/**
 * 独立命令要读 02 的纲要/初稿输入：路径只认 02-result.json#files（跨步读取走地图，不猜文件名）；
 * 地图里没有才回退固定文件名——那是对只有散落稿件的目录跑单步命令的场景。
 */
function readDraftArtifacts(dir) {
  const outlineRel = fileFromResult(dir, "draft", "outline") || ARTIFACT.outline;
  const draftInputRel = fileFromResult(dir, "draft", "draftInput") || ARTIFACT.draftInput;
  return {
    outline: readJsonSafe(path.join(dir, outlineRel)) || undefined,
    draftInput: readJsonSafe(path.join(dir, draftInputRel)) || undefined,
  };
}

async function cmdReviewOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.composed, ARTIFACT.reviewed, ARTIFACT.draftMd]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, ARTIFACT.log), verbose: asBool(options.verbose), label: "review" });
  const recorder = createRecorder();
  recorder.setStepDir(path.join(target.dir, "03-step"));
  const models = createModelClient(config, logger, recorder);
  const article = fs.readFileSync(target.path, "utf8");
  const ctx = {
    config,
    type,
    logger,
    models,
    recorder,
    mock: asBool(options.mock),
    options,
    outputDir: target.dir,
    topic: { title: getTitle(article) },
    draftTemplate: draftTemplateFromSteps({ steps: config.steps, type }),
    ...readDraftArtifacts(target.dir),
  };
  const result = await reviewLoop(ctx, article);
  const out = finishReviewStage(ctx, result);
  console.log(`审稿完成：${result.history.length} 轮，综合评分 ${result.final.composite_score ?? "n/a"}（通过线 ${result.pass_score}）→ ${out}`);
}

async function cmdComposeOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.reviewed, ARTIFACT.draftMd, ARTIFACT.composed]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, ARTIFACT.log), verbose: asBool(options.verbose), label: "compose" });
  const article = fs.readFileSync(target.path, "utf8");
  const recorder = createRecorder();
  recorder.setStepDir(path.join(target.dir, "04-step"));
  const models = createModelClient(config, logger, recorder);
  const draftArtifacts = readDraftArtifacts(target.dir);
  const ctx = {
    config,
    type,
    logger,
    models,
    recorder,
    options,
    mock: asBool(options.mock),
    outputDir: target.dir,
    topic: { title: getTitle(article) },
    draftInput: draftArtifacts.draftInput,
    outline: draftArtifacts.outline || { title: getTitle(article), image_plan: [] },
  };
  const result = await composeArticle(ctx, article);
  const out = finishComposeStage(ctx, result);
  const success = result.images.filter((i) => i.success).length;
  console.log(`组稿完成：去 AI 化${result.polish.ok ? ` ${result.polish.words} 字` : "未生效（用审稿稿）"}，配图 ${success}/${result.images.length} → ${out}`);
}

async function cmdPublishOnly(config, options) {
  const target = resolveArticleTarget(config, options, [ARTIFACT.final, ARTIFACT.composed, ARTIFACT.reviewed, ARTIFACT.draftMd]);
  const type = findType(config, options.type || inferTypeFromDir(config, target.dir) || resolveTypeId(options));
  const logger = createLogger({ file: path.join(target.dir, ARTIFACT.log), verbose: asBool(options.verbose), label: "publish" });
  const article = fs.readFileSync(target.path, "utf8");
  const stamp = timestamp();
  const recorder = createRecorder();
  recorder.setStepDir(path.join(target.dir, "05-step"));
  const ctx = { config, type, logger, recorder, options, outputDir: target.dir, stamp, topic: { title: getTitle(article) } };
  // Explicit invocation of `publish` counts as consent.
  const result = await publishArticle({ ...ctx, type: { ...type, publish: { ...type.publish, auto_publish: true } } }, article);

  // 真实投递成功且稿件在 draft/<slug>/ 里 → 打包并清理；archive 节点关掉则整段跳过。
  if (!stepEnabled("archive", config, type)) {
    logger.info("归档环节已关闭（steps 节点 archive.enabled=false）：产物留在 draft/，不打包不删除");
  } else if (result.status === "published") {
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
      const dir = findArticleRoot(path.dirname(asPath));
      return { path: asPath, dir, slug: dir ? path.basename(dir) : null };
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

/**
 * --file 给的产物在 NN-step/ 子目录里，文章根目录要往上找（认 01-result.json）；
 * 找不到就退回文件所在目录。
 */
function findArticleRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth++) {
    if (fs.existsSync(path.join(dir, ARTIFACT.topic))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return path.resolve(startDir);
}

function inferTypeFromDir(config, dir) {
  const id = readArticleMeta(dir).type;
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

/** Render an outline as Markdown that `parseOutlineMarkdown` can read back verbatim. 标题来自选题步，不在纲要里。 */
function renderOutlineMarkdown(outline, title) {
  const parts = [
    `# ${title || ""}`,
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
 * auto 入口（deferred）选题阶段的占位类型：不预设栏目，
 * 知识库取所有 enabled 类型 knowledge_dirs 的并集；检索条数、选题窗口与模型
 * 一律继承第一个 enabled 类型（与 knowledge_dirs 的并集同规格），代码里没有第二套默认值。
 * 四个类型的 topic 窗口本来就一致，占位类型只是要在定类之前把选题跑完。
 * 选题完成后由判断模型定类，本对象不再参与下游步骤。
 */
function autoTopicType(config) {
  const enabled = (config.types || []).filter((t) => t.enabled);
  const dirs = [...new Set(enabled.flatMap((t) => t.knowledge_dirs || []))];
  const knowledge = enabled[0]?.knowledge || {};
  return {
    id: "auto",
    name: "公众号",
    description: "",
    enabled: true,
    knowledge_dirs: dirs,
    knowledge: {
      ...knowledge,
      source: "local",
      weknora: { ...(knowledge.weknora || {}), enabled: false, kb_ids: [] },
    },
    style: {},
    topic: enabled[0]?.topic || {},
    length: null,
    model: enabled[0]?.model,
  };
}

const TYPE_SOURCE_LABEL = {
  cli: "--type 指定",
  env: "环境变量 PB_ARTICLE_TYPE",
  input: "初稿输入的 type",
  article: "续跑文章已有 01-result.json",
  classifier: "判断模型（systemone）自动分类",
  default: "classifier.default_type",
  deferred: "选题后由判断模型定类",
};

/**
 * 入口阶段的类型解析（异步版）：
 *   续跑文章 > --input.type > 判断模型 > --type/env 回退提示 > default_type
 * auto 入口（没有标题/提纲）返回 deferred：类型在选题之后由判断模型确定，
 * --type 只是分类失败时的回退提示，不再预先定类。
 */
async function resolveTypeForEntry(config, options, { title = "", command, existing } = {}) {
  if (existing?.article?.type) return { typeId: existing.article.type, source: "article" };

  const inputArg = options.input || options["draft-input"];
  if (inputArg && inputArg !== true) {
    try {
      const raw = readJson(path.resolve(PROJECT_ROOT, String(inputArg)));
      if (raw.type) return { typeId: String(raw.type), source: "input" };
    } catch {
      /* 读不出来就继续往下走 */
    }
  }

  const hint =
    options.type && options.type !== true
      ? { typeId: String(options.type), source: "cli" }
      : env("PB_ARTICLE_TYPE") || env("ARTICLE_TYPE")
        ? { typeId: env("PB_ARTICLE_TYPE") || env("ARTICLE_TYPE"), source: "env" }
        : null;

  const outline = readOutlineText(options);
  const headline = String(title || options.topic || "").trim();
  if (headline || outline) {
    const classifierLogger = createLogger({ verbose: asBool(options.verbose), label: "classify" });
    const outcome = await classifyOrFallback({
      config,
      cfg: systemOneCallConfig({ config }, "classify_type", "classify"),
      title: headline || outline.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "").trim() || "",
      outline,
      logger: classifierLogger,
      mock: asBool(options.mock),
    });
    if (outcome.source === "classifier" && outcome.typeId) {
      classifierLogger.info(
        `判断模型选择：${outcome.typeId}（置信度 ${outcome.result?.confidence ?? "?"}）${outcome.result?.reason ? `：${outcome.result.reason}` : ""}`,
      );
      return { typeId: outcome.typeId, source: outcome.source, classification: outcome.result };
    }
    // 判断模型没能定类：--type/env 提示优先于 default_type。
    if (hint) return { ...hint, classification: outcome.result };
    if (outcome.typeId) return { typeId: outcome.typeId, source: outcome.source, classification: outcome.result };
    throw new Error(
      "无法确定文章类型：判断模型未给出结果，且 classifier.default_type 和 --type 均未配置（配置 SYSTEMONE_* 或 --type 后重试）",
    );
  }

  // auto 入口：没有标题也没有提纲——先选题，选题后再让判断模型定类。
  return { deferred: true, source: "deferred", hint };
}

/** 读取 manual 入口的提纲文本（Markdown 原样返回，JSON 转成可读文本）。 */
function readOutlineText(options) {
  const fileArg = options["outline-file"];
  if (fileArg && fileArg !== true) {
    const file = path.resolve(PROJECT_ROOT, String(fileArg));
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      return String(fileArg).toLowerCase().endsWith(".json") ? outlineJsonToText(text) : text;
    }
  }
  if (options.outline !== undefined && options.outline !== true) {
    const text = String(options.outline);
    return text.trim().startsWith("{") ? outlineJsonToText(text) : text;
  }
  return "";
}

function outlineJsonToText(text) {
  try {
    return formatOutline(JSON.parse(text));
  } catch {
    return text;
  }
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
    throw new Error('manual 入口需要提纲：用 --outline-file <提纲.md> 或 --outline "…" 提供（也可直接传 02-step/outline.json）');
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

// 只在作为命令执行时跑 CLI；被测试 import 时只导出函数。
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(`\n错误：${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  });
}
