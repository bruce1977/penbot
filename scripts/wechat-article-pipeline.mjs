#!/usr/bin/env node
/**
 * wechat-article-pipeline.mjs — inbox 监听 + draft 巡检的无人值守编排器。
 *
 * 职责（两条独立节奏，单并发）：
 *   1. inbox 监听：`BASE_INBOX_FOLDER/wechat-article/*.md` 里的新素材，先用判断模型分成
 *      「标题素材 / 草稿素材」，分别路由到 `manual --topic` / `post --file` 入口；
 *      一旦文章目录建出来（进入流转）就删掉 inbox 原稿，避免重复处理。
 *   2. draft 巡检：对 `BASE_OUTPUT_FOLDER/draft/<slug>/` 下每篇未完成的文章，按产物
 *      （`NN-result.json`，`detectStartStage`）接力推进每个阶段；每阶段子进程带自己的超时，
 *      超时 kill 后下一轮按上一步产物续跑。
 *
 * 为什么是子进程而不是 import 主入口：入口脚本一 import 就 parseArgs 跑起来，且 lint
 * 规则（`tests/wechat-article/lint.test.mjs`）只允许 comm 模块被主入口引用——编排器另起
 * 文件只能 spawn `wechat-article.mjs`。子进程天然给出「超时 kill」的边界。
 *
 * 失败策略（两层，与管线一致）：
 *   - 单次子进程超时 / 非 0 退出 → 记一次失败，下一轮按产物续跑（不自我修复提示词）；
 *   - 同一篇连续失败 / 无进展达 `pipeline.max_fails` 次 → 标记跳过并记日志，等人处理。
 *
 * 所有阈值/开关单源 `config/wechat-article/defaults.yaml` 的 `pipeline` 段（`${PB_*}` 旋钮），
 * inbox 根目录只认环境变量 `BASE_INBOX_FOLDER`（留空 = 关闭 inbox，仅做 draft 巡检）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findProjectRoot, loadDotEnv, needNumber, toBool } from "./lib/env.mjs";
import { loadConfig } from "./lib/config.mjs";
import { classifyChoice } from "./lib/classify.mjs";
import { ARTIFACT, detectStartStage, ensureLayout, listArticles, readStageResult } from "./lib/article-store.mjs";
import { ensureDir, exists, sleep } from "./lib/fsx.mjs";

const PROJECT_ROOT = findProjectRoot();
const ENTRY = path.join(PROJECT_ROOT, "scripts", "wechat-article.mjs");
const ARTICLE_TYPES_CONFIG = "config/wechat-article/article-types.yaml";

/* ------------------------------------------------------------------ */
/* 日志（编排器是入口层，console 不受限；进程输出直接给人看）             */
/* ------------------------------------------------------------------ */

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const watcherLogger = {
  info: (message) => log(message),
  warn: (message) => log(`WARN ${message}`),
  error: (message) => log(`ERROR ${message}`),
};

/* ------------------------------------------------------------------ */
/* 配置读取（消费点抛错点名配置路径，代码不留同值默认）                  */
/* ------------------------------------------------------------------ */

/** inbox 根目录：只认 BASE_INBOX_FOLDER，留空 = 关闭 inbox 监听。 */
export function resolveInboxDir(env = process.env) {
  const base = String(env.BASE_INBOX_FOLDER || "").trim();
  if (!base) return "";
  return path.join(path.resolve(base), "wechat-article");
}

/** 某阶段子进程超时（ms）：缺失即抛错点名配置路径，代码不替配置兜底。 */
export function stageTimeout(pipelineCfg, stage) {
  const value = pipelineCfg?.stage_timeouts?.[stage];
  return needNumber(value, `defaults.yaml pipeline.stage_timeouts.${stage}`);
}

/** 组装 systemone 判断配置（从 models.yaml 压平的 profile）；模型 id 未定义返回 null 走降级。 */
export function buildSystemOneCfg(config, modelId) {
  const profile = config?.models?.[modelId];
  if (!profile) return null;
  return {
    provider: "systemone",
    model_id: modelId,
    model: profile.model || "",
    base_url: profile.base_url || "",
    endpoint: profile.endpoint || "",
    api_key: profile.api_key || "",
    timeout_ms: Number(profile.timeout_ms ?? 0),
    max_retries: Number(profile.max_retries ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* 文章状态                                                            */
/* ------------------------------------------------------------------ */

function draftRoot(config) {
  return ensureLayout(config).draft;
}

function articleDir(config, slug) {
  return path.join(draftRoot(config), slug);
}

/** 已发布 = 流程终点（05-result.json status=published）；归档失败也不再自动重试。 */
export function isPublished(dir) {
  return readStageResult(dir, "publish")?.status === "published";
}

function draftSlugs(config) {
  const root = draftRoot(config);
  if (!exists(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/* ------------------------------------------------------------------ */
/* inbox 素材：读取、标题、分类                                          */
/* ------------------------------------------------------------------ */

function nextInboxFile(inboxDir) {
  if (!exists(inboxDir)) return "";
  const names = fs
    .readdirSync(inboxDir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort();
  return names.length ? path.join(inboxDir, names[0]) : "";
}

/** 从素材里取标题：frontmatter title > 一级标题 > 首个非空行 > 文件名。 */
export function extractTitle(text, file) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === "---") break;
      const match = line.match(/^title:\s*(.+)$/i);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const heading = lines.find((line) => /^#\s+\S/.test(line.trim()));
  if (heading) return heading.replace(/^#\s+/, "").trim();
  const firstText = lines.find((line) => line.trim() && !line.trim().startsWith("#"));
  if (firstText) return firstText.trim().slice(0, 60);
  return path.basename(file, path.extname(file));
}

/**
 * 本地规则兜底：成篇正文（够长 + 有多个非列表/标题的正文段）判为草稿素材，否则标题素材。
 * 判断模型不可用 / 未配置时用它，保证 inbox 仍能被路由（与 classifyOrFallback 同一哲学）。
 */
export function classifyByRule(text) {
  const trimmed = String(text).trim();
  const lines = trimmed.split(/\r?\n/);
  const cjkChars = trimmed.replace(/\s/g, "").length;
  const bodyParagraphs = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^[#>\-*+\d]/.test(t)) return false;
    return t.length > 30;
  }).length;
  return cjkChars >= 200 && bodyParagraphs >= 2 ? "draft" : "topic";
}

/** 判断模型把素材分成 topic / draft；不可用回退本地规则，不阻塞。 */
export async function classifyMaterial(config, pipelineCfg, text, title) {
  const classifyCfg = pipelineCfg?.classify || {};
  const enabled = toBool(classifyCfg.enabled, true);
  const question = String(classifyCfg.question || "").trim();
  if (enabled && question) {
    const cfg = buildSystemOneCfg(config, String(classifyCfg.model_id || "systemone.classifier"));
    if (cfg?.base_url) {
      const outcome = await classifyChoice({
        cfg,
        question,
        prompt: classifyCfg,
        vars: { text: String(text).slice(0, 8000), title },
        options: [
          { id: "topic", description: classifyCfg.criteria?.topic || "" },
          { id: "draft", description: classifyCfg.criteria?.draft || "" },
        ],
        logger: watcherLogger,
        slot: "pipeline",
        label: "classify_material",
      });
      if (outcome.ok && (outcome.type === "topic" || outcome.type === "draft")) {
        log(`素材分类：${outcome.type}（置信度 ${outcome.confidence ?? "?"}，模型 ${outcome.model || "?"}）`);
        return outcome.type;
      }
      log(`判断模型不可用（${outcome.reason || "unknown"}），素材分类回退本地规则`);
    } else {
      log("未配置判断模型端点（config/models.yaml systemone.*），素材分类用本地规则");
    }
  }
  const rule = classifyByRule(text);
  log(`素材分类（本地规则）：${rule}`);
  return rule;
}

/* ------------------------------------------------------------------ */
/* 子进程执行（超时 kill，Windows 下连进程树一起杀）                     */
/* ------------------------------------------------------------------ */

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

/** 跑一次 `wechat-article.mjs <args>`，带超时；返回 { code, signal, timedOut, error }。 */
export function runStage(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`子进程超时（${Math.round(timeoutMs / 1000)}s）：${args.join(" ")} → kill`);
      killTree(child.pid);
    }, timeoutMs);
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => settle({ code: -1, signal: "", timedOut, error: error.message }));
    child.on("exit", (code, signal) => settle({ code, signal, timedOut }));
  });
}

/* ------------------------------------------------------------------ */
/* 推进：每阶段接力 + 每阶段超时                                        */
/* ------------------------------------------------------------------ */

/**
 * 把一篇文章推进到发布/归档：按 detectStartStage 决定下一阶段，spawn `auto --article
 * <slug> --stage <阶段>` 跑它（带该阶段超时），跑完重新判定，循环直到完成/失败/无进展。
 * 返回 { done, failed, noProgress, stage, timedOut }。
 */
export async function advanceDraft(config, pipelineCfg, slug) {
  const dir = articleDir(config, slug);
  let noProgressStreak = 0;
  for (;;) {
    if (!exists(dir)) return { done: true, stage: "", reason: "目录已归档" };
    if (isPublished(dir)) return { done: true, stage: "publish", reason: "已发布" };
    const stage = detectStartStage(dir);
    const timeout = stageTimeout(pipelineCfg, stage);
    log(`${slug}: 推进 ${stage}（超时 ${Math.round(timeout / 1000)}s）`);
    const result = await runStage(["auto", "--article", slug, "--stage", stage], timeout);
    if (!exists(dir)) return { done: true, stage, reason: "已归档" };
    const after = isPublished(dir) ? "publish" : detectStartStage(dir);
    if (result.timedOut || result.code !== 0) {
      log(`${slug}: ${stage} ${result.timedOut ? "超时被 kill" : `失败（exit ${result.code}${result.error ? `：${result.error}` : ""}）`}，留待下轮续跑`);
      return { done: false, failed: true, noProgress: false, stage, timedOut: result.timedOut };
    }
    if (after === stage) {
      noProgressStreak += 1;
      if (noProgressStreak >= 2) {
        log(`${slug}: ${stage} 完成但产物未前进，连续 ${noProgressStreak} 次无进展`);
        return { done: false, failed: false, noProgress: true, stage, timedOut: false };
      }
    } else {
      noProgressStreak = 0;
    }
  }
}

/**
 * 处理一份 inbox 素材：分类 → 用入口命令建目录（进入流转）→ 删原稿 → 接力推进剩余阶段。
 * 返回 { slug, done, failed, noProgress, stage, timedOut }；slug 为空表示没进入流转（保留原稿）。
 */
export async function processInbox(config, pipelineCfg, file) {
  const text = fs.readFileSync(file, "utf8");
  const title = extractTitle(text, file);
  const kind = await classifyMaterial(config, pipelineCfg, text, title);
  const snapshot = new Set(draftSlugs(config));
  const firstStage = kind === "topic" ? "topic" : "review";
  const args =
    kind === "topic"
      ? ["manual", "--topic", title, "--outline-file", file, "--stage", "topic"]
      : ["post", "--file", file, "--stage", "review"];
  const timeout = stageTimeout(pipelineCfg, firstStage);
  log(`${path.basename(file)}: 派发 ${kind === "topic" ? "标题素材" : "草稿素材"} → ${args.join(" ")}`);
  const result = await runStage(args, timeout);
  const newSlug = draftSlugs(config).find((slug) => !snapshot.has(slug));
  if (!newSlug) {
    log(`${path.basename(file)}: 未进入流转（${result.timedOut ? "超时" : `exit ${result.code}`}），保留原稿待重试`);
    return { slug: "", done: false, failed: true, noProgress: false, stage: firstStage, timedOut: result.timedOut };
  }
  fs.unlinkSync(file);
  log(`${path.basename(file)} → ${newSlug}（${kind === "topic" ? "标题素材" : "草稿素材"}），已删除 inbox 原稿`);
  if (result.timedOut || result.code !== 0) {
    // 首阶段失败但已进入流转：交给下一轮 draft 巡检按产物续跑。
    return { slug: newSlug, done: false, failed: true, noProgress: false, stage: firstStage, timedOut: result.timedOut };
  }
  return { slug: newSlug, ...(await advanceDraft(config, pipelineCfg, newSlug)) };
}

/* ------------------------------------------------------------------ */
/* 巡检记账（失败 / 无进展计数，达上限跳过）                             */
/* ------------------------------------------------------------------ */

function recordOutcome(state, slug, outcome) {
  if (!slug) return;
  if (outcome.done) {
    state.failCounts.delete(slug);
    state.noProgress.delete(slug);
    return;
  }
  if (outcome.failed) {
    const fails = (state.failCounts.get(slug) || 0) + 1;
    state.failCounts.set(slug, fails);
    state.noProgress.delete(slug);
    if (fails >= state.maxFails) {
      state.skipped.add(slug);
      log(`${slug}: 连续失败 ${fails} 次，跳过（处理后重启 watcher 可重置）`);
    }
    return;
  }
  if (outcome.noProgress) {
    const streak = (state.noProgress.get(slug) || 0) + 1;
    state.noProgress.set(slug, streak);
    if (streak >= state.maxFails) {
      state.skipped.add(slug);
      log(`${slug}: 连续无进展 ${streak} 次，跳过`);
    }
  }
}

/** 巡检一轮 draft：对每篇未完成、未跳过的文章接力推进。 */
export async function inspectDraft(config, pipelineCfg, state) {
  for (const article of listArticles(config)) {
    if (state.skipped.has(article.slug)) continue;
    if (isPublished(article.dir)) continue;
    const outcome = await advanceDraft(config, pipelineCfg, article.slug);
    recordOutcome(state, article.slug, outcome);
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

function ensureDirs(config, inboxDir) {
  ensureLayout(config);
  if (inboxDir) ensureDir(inboxDir);
}

async function main() {
  loadDotEnv(PROJECT_ROOT);
  const config = loadConfig(ARTICLE_TYPES_CONFIG, { root: PROJECT_ROOT });
  const pipelineCfg = config.pipeline || {};
  const inboxDir = resolveInboxDir();
  ensureDirs(config, inboxDir);
  const pollMs = needNumber(pipelineCfg.poll_ms, "defaults.yaml pipeline.poll_ms");
  const inspectMs = needNumber(pipelineCfg.inspect_ms, "defaults.yaml pipeline.inspect_ms");
  const maxFails = needNumber(pipelineCfg.max_fails, "defaults.yaml pipeline.max_fails");
  const state = { failCounts: new Map(), noProgress: new Map(), skipped: new Set(), lastInspect: 0, maxFails };
  log(
    `watcher 启动：inbox=${inboxDir || "（未配置 BASE_INBOX_FOLDER，仅做 draft 巡检）"}，` +
      `draft=${draftRoot(config)}，巡检间隔 ${Math.round(inspectMs / 1000)}s，max_fails=${maxFails}`,
  );
  for (;;) {
    try {
      const file = inboxDir ? nextInboxFile(inboxDir) : "";
      if (file) {
        const outcome = await processInbox(config, pipelineCfg, file);
        recordOutcome(state, outcome.slug, outcome);
      } else if (Date.now() - state.lastInspect >= inspectMs) {
        state.lastInspect = Date.now();
        await inspectDraft(config, pipelineCfg, state);
      }
    } catch (error) {
      log(`巡检异常：${error.message}`);
    }
    await sleep(pollMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.on("SIGINT", () => {
    log("收到 SIGINT，退出 watcher（正在跑的子进程由 OS 回收，产物续跑不受影响）");
    process.exit(0);
  });
  main().catch((error) => {
    console.error(`watcher 启动失败：${error.message}`);
    process.exit(1);
  });
}

// 供单测引用：ARTIFACT 常量（避免未使用告警，同时点明续跑只认产物文件）。
export { ARTIFACT };
