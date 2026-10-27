// 外部资料检索：脚本自行拉起 `opencode serve`，用官方 v2 客户端
// @opencode/client 执行 websearch，直接取 tool part 的原始输出（v2 即 Markdown）
// ——结果不经过模型转述，模型只负责触发一次工具调用。
//
// 模型 id 是 opencode 自己配置的模型（provider/modelID），与 config/models.yaml 无关。
// 环境变量：
//   OPENCODE_DEFAULT_MODEL     默认检索模型（provider/model）
//   OPENCODE_SERVE_PORT        固定 serve 端口：能连上且口令对 → 复用，连不上 → 自起自关
//   OPENCODE_SERVER_PASSWORD   serve Basic 认证口令（复用探测和自起 serve 都用它）
// 可单独运行测试：
//   node scripts/lib/web-search.mjs "关键字组1" "关键字组2" [--model ollama-local/qwen3.5:9b] [--out result.md]
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import { needNumber } from "./env.mjs";
import { ensureDir, slugify } from "./fsx.mjs";
import { assessSourceSufficiency } from "./knowledge.mjs";

const SERVE_TIMEOUT_MS = 30000;
/**
 * websearch 单组检索超时：实配置单源 = defaults.yaml `knowledge.web-search.timeout_ms`，
 * 这里只是该项缺省时的兜底，不再另设互相矛盾的第二份默认值。
 * 取值依据：单组实测 40–170s（见 docs/wechat-article/materials-collection.md），180s 覆盖上限。
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 180000;
/** serve 存活看门狗余量：启动 + 建会话 + 收尾轮询；必须大于它，否则看门狗会先把在跑的检索掐死 */
const SERVE_LIFETIME_SLACK_MS = 60000;
export const DEFAULT_SEARCH_MODEL = "ollama-local/qwen3.5:9b";

/** 模型参数归一化：字符串 "provider/model" 或对象；缺省读环境变量 OPENCODE_DEFAULT_MODEL，再落默认 9b */
function parseModel(model) {
  const raw = model || process.env.OPENCODE_DEFAULT_MODEL || DEFAULT_SEARCH_MODEL;
  if (typeof raw === "object" && raw !== null) {
    return { providerID: raw.providerID, modelID: raw.modelID ?? raw.id };
  }
  const i = String(raw).lastIndexOf("/");
  if (i <= 0) throw new Error(`模型格式应为 provider/model，收到：${raw}`);
  return { providerID: String(raw).slice(0, i), modelID: String(raw).slice(i + 1) };
}

/**
 * opencode 可执行文件：优先本仓库 `node_modules/.bin`（package.json 声明的 @opencode/cli，
 * 版本被锁住），没有再退回 PATH 上的全局安装。
 */
export function resolveOpencodeBin(
  root = path.resolve(import.meta.dirname, "..", ".."),
) {
  const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  return fs.existsSync(bin) ? bin : "opencode";
}

/**
 * 启动一个临时 `opencode serve` 进程并解析监听地址与服务密码。
 * 返回 { baseUrl, password, close() }；超过 maxLifetimeMs 未关闭会被自动杀掉（防孤儿服务）。
 * maxLifetimeMs 由调用方按「检索预算 + 余量」传入，必须大于单组检索超时，否则看门狗会掐断在跑的请求。
 */
export async function startServe({
  port,
  bin,
  timeoutMs = SERVE_TIMEOUT_MS,
  maxLifetimeMs = DEFAULT_SEARCH_TIMEOUT_MS + SERVE_LIFETIME_SLACK_MS,
  logger,
} = {}) {
  port = port || 20000 + Math.floor(Math.random() * 20000);
  const serveBin = bin || resolveOpencodeBin();
  const serveArgs = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];
  // Windows 走 shell:true：Node 会把命令与参数拼成一个串交给 cmd，路径含空格会被切断，只给 bin 加引号。
  const proc =
    process.platform === "win32"
      ? spawn([serveBin.includes(" ") ? `"${serveBin}"` : serveBin, ...serveArgs].join(" "), {
          shell: true,
          windowsHide: true,
        })
      : spawn(serveBin, serveArgs, { windowsHide: true });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // 启动失败（超时/提前退出）时也必须杀掉进程树，否则 serve 会变成孤儿
  const killProc = () => {
    try {
      // shell:true 下 kill() 只杀 shell 包装，Windows 需要按进程树杀
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  };

  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      killProc();
      reject(new Error(`opencode serve 启动超时（${timeoutMs}ms）：${(stderr || stdout).slice(0, 300)}`));
    }, timeoutMs);
    const onExit = (code) => {
      cleanup();
      killProc();
      reject(new Error(`opencode serve 退出（code ${code}）：${(stderr || stdout).slice(0, 300)}`));
    };
    const poll = setInterval(() => {
      const url = stdout.match(/server listening on (https?:\/\/\S+)/)?.[1];
      // serve 检测到环境里已有 OPENCODE_SERVER_PASSWORD 时不再打印口令行，直接用环境值
      const password = stdout.match(/server password (\S+)/)?.[1] || process.env.OPENCODE_SERVER_PASSWORD;
      if (url && password) {
        cleanup();
        resolve({ url, password });
      }
    }, 200);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      proc.off("exit", onExit);
    };
    proc.on("exit", onExit);
  });

  let closed = false;
  const kill = () => {
    if (closed) return;
    closed = true;
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    killProc();
  };
  const lifetimeTimer =
    maxLifetimeMs > 0
      ? setTimeout(() => {
          logger?.warn?.(`opencode serve 到达存活期（${maxLifetimeMs}ms），主动回收`);
          kill();
        }, maxLifetimeMs)
      : null;
  lifetimeTimer?.unref?.(); // 定时器本身不阻止 node 正常退出

  return { baseUrl: started.url, password: started.password, close: kill };
}

function makeClient(baseUrl, password) {
  return OpenCode.make({
    baseUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
}

/** 固定端口探测超时 */
const PROBE_TIMEOUT_MS = 2000;

/**
 * 取得一个可用的 opencode serve：
 *   1. 配置了 OPENCODE_SERVE_PORT 且带 OPENCODE_SERVER_PASSWORD 探测通过 → 复用（close 为空操作）；
 *   2. 端口被占但口令不符 → warn 后降级临时随机端口；
 *   3. 端口空闲 → 以固定端口+固定口令起 serve，close() 关掉；
 *   4. 未配置端口 → 随机端口临时 serve（close 受最大存活时间看门狗保护）。
 * 返回 { baseUrl, password, reused, close() }。
 */
export async function ensureServer({ port, password, logger, maxLifetimeMs } = {}) {
  port = port ?? toInt(process.env.OPENCODE_SERVE_PORT);
  password = password ?? (process.env.OPENCODE_SERVER_PASSWORD || "");
  let status = 0;
  if (port) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/session`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      status = res.status;
    } catch {
      /* 连不上 = 端口空闲 */
    }
    if (status === 200 && password) {
      logger?.info?.(`复用已运行的 opencode serve (port ${port})`);
      return { baseUrl, password, reused: true, close() {} };
    }
    if (status === 401 || status === 403) {
      logger?.warn?.(`端口 ${port} 已有 opencode serve 但口令不符，降级临时端口（请核对 .env 的 OPENCODE_SERVER_PASSWORD）`);
    }
  }
  const own = await startServe({
    port: port && status !== 401 && status !== 403 ? port : undefined,
    logger,
    ...(maxLifetimeMs ? { maxLifetimeMs } : {}),
  });
  return { baseUrl: own.baseUrl, password: own.password, reused: false, close: own.close };
}

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/** 从消息列表里取最近一次已完成的 websearch 工具输出。
 *  v2 输出本身就是 Markdown（`## [title](url)` + 摘录）；旧版是 JSON 结果列表，兼容转换。 */
function extractSearchMarkdown(messages) {
  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of [...msg.content].reverse()) {
      if (block.type !== "tool" || !/websearch/i.test(block.name || "")) continue;
      if (block.state?.status !== "completed") continue;
      const text = (block.state.content || [])
        .map((c) => (typeof c === "string" ? c : c?.text || ""))
        .join("\n\n")
        .trim();
      if (!text) continue;
      if (text.startsWith("{")) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return text; // 不是合法 JSON 就当纯文本用
        }
        if (Array.isArray(parsed?.results)) return resultsToMarkdown(parsed.results);
      }
      return text;
    }
  }
  return null;
}

/** 旧版 JSON 结果列表 → Markdown */
function resultsToMarkdown(results, { maxExcerptChars = 2000 } = {}) {
  return results
    .flatMap((r) => [
      `## ${r.title || r.url}`,
      "",
      `- URL: ${r.url}`,
      `- 发布时间: ${r.publish_date || "未知"}`,
      "",
      ...(r.excerpts || []).map((e) => {
        const text = String(e).trim();
        return text.length > maxExcerptChars ? `${text.slice(0, maxExcerptChars)}…` : text;
      }),
      "",
    ])
    .join("\n");
}

/**
 * 对单个关键字组执行一次 websearch，返回 Markdown 文本（检索结果列表）。
 *
 * @param {object} options
 * @param {string} options.query                关键字组（原样作为搜索词）
 * @param {string|{providerID, modelID}} [options.model] opencode 侧模型 "provider/model"；
 *        缺省 = 环境变量 OPENCODE_DEFAULT_MODEL ?? DEFAULT_SEARCH_MODEL（ollama-local/qwen3.5:9b）
 * @param {{baseUrl: string, password: string}} [options.server]   复用已启动的 serve；缺省时临时起一个
 * @param {number} [options.timeoutMs=DEFAULT_SEARCH_TIMEOUT_MS]   本组检索的总超时
 * @param {object} [options.logger]
 * @param {string} [options.slot] 调用留痕（NN-step/api/）的子步骤号（同一步骤内多组检索共用同一子步骤，轮次按组递增）
 * @returns {Promise<string>} Markdown 检索结果
 */
export async function websearch({
  query,
  model,
  server,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
  logger,
  recorder,
  slot,
}) {
  const { providerID, modelID } = parseModel(model);
  const resolvedModel = `${providerID}/${modelID}`;
  const started = Date.now();
  const record = (extra) => {
    if (!recorder) return;
    recorder.record({
      label: "websearch",
      slot,
      provider: "opencode-websearch",
      model: resolvedModel,
      duration_ms: Date.now() - started,
      request: { query, text: `调用一次 websearch 工具，query 参数原样使用：${query}。然后只回复 DONE。` },
      ...extra,
    });
  };
  let own = null;
  if (!server) own = await ensureServer({ logger, maxLifetimeMs: timeoutMs + SERVE_LIFETIME_SLACK_MS });
  const baseUrl = server?.baseUrl || own?.baseUrl;
  const password = server?.password || own?.password;
  const client = makeClient(baseUrl, password);

  try {
    const session = await client.session.create({
      title: `web-search-${Date.now()}`,
      model: { id: modelID, providerID },
    });
    const sessionID = session.id ?? session.sessionID;
    await client.session.prompt(
      { sessionID, text: `调用一次 websearch 工具，query 参数原样使用：${query}。然后只回复 DONE。` },
      { signal: AbortSignal.timeout(60000) },
    );

    // 不用 session.wait：它的长轮询会被 fetch 的 300s headersTimeout 掐断。
    // 改为短轮询消息列表，拿到已完成的 websearch tool part 就返回。
    const deadline = Date.now() + timeoutMs;
    let markdown = null;
    while (!markdown && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 8000));
      const response = await client.message.list({ sessionID }, { signal: AbortSignal.timeout(30000) });
      const messages = response.data ?? [];
      markdown = extractSearchMarkdown(messages);
      const errored = messages.find((m) => m.type === "assistant" && m.error);
      if (!markdown && errored) throw new Error(`opencode 会话出错：${errored.error?.name || "unknown"} ${JSON.stringify(errored.error?.data || {}).slice(0, 200)}`);
    }
    if (!markdown) throw new Error(`opencode websearch 超时（${timeoutMs}ms，session ${sessionID}）`);

    logger?.info?.(`websearch "${query}" done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${markdown.length} chars`);
    record({ response: markdown });
    client.session.remove({ sessionID }).catch(() => {});
    return markdown;
  } catch (error) {
    record({ response: "", error: error.message });
    throw error;
  } finally {
    own?.close();
  }
}

/** 给检索结果加文件头（落 01-step/web-search/<slug>.md 时调用） */
export function wrapSearchMarkdown(query, markdown) {
  return [
    `# 外部检索：${query}`,
    "",
    markdown,
    "",
    `<!-- fetched_at: ${new Date().toISOString()} | provider: opencode/websearch -->`,
  ].join("\n");
}

/**
 * 关键字组列表 → 每组一次 websearch → Markdown。
 * 各组**并行**（同一个 serve 上各开一个会话），所以 `timeout_ms` 就是外部检索的总时长上限，
 * 不会随关键字组数线性放大。单组失败只 warn，返回结果顺序与 queries 一致。
 */
export async function searchWebSearch(queries, { model, timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS, logger, recorder, slot } = {}) {
  const server = await ensureServer({ logger, maxLifetimeMs: timeoutMs + SERVE_LIFETIME_SLACK_MS });
  try {
    return await Promise.all(
      queries.map(async (query) => {
        try {
          const markdown = await websearch({ query, model, server, timeoutMs, logger, recorder, slot });
          return { query, markdown: wrapSearchMarkdown(query, markdown) };
        } catch (error) {
          logger?.warn?.(`websearch "${query}" failed: ${error.message}`);
          return { query, markdown: "", error: error.message };
        }
      }),
    );
  } finally {
    server.close();
  }
}

/**
 * 解析 websearch 的 Markdown 输出：以 `## [标题](URL)` 为界切块。
 * 结果正文里也可能出现非链接的 `## 小节`，所以只认「## [」开头的块。
 * 返回 [{ title, url, excerpt }]。
 *
 * 参数默认值只服务"直接调用本模块"的使用者（管线里一律由 gatherWebSearch 传
 * defaults.yaml 的 needNumber 结果，不吃这里的数字）——别把它当配置的第二份真相。
 */
export function parseSearchMarkdown(markdown, { limit = 8, excerptChars = 800 } = {}) {
  const chunks = String(markdown || "").split(/\n(?=## \[[^\]]+\]\(https?:\/\/)/);
  const out = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^## \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
    if (!m) continue;
    const body = chunk
      .slice(m[0].length)
      .split("\n")
      .filter((line) => !line.trim().startsWith("<!--"))
      .join("\n")
      .trim();
    out.push({ title: m[1].trim(), url: m[2], excerpt: body.slice(0, Number(excerptChars) || 800) });
    if (out.length >= limit) break;
  }
  return out;
}

/** 由选题构造外部检索关键字组：标题 + 关键词各一组，带年份提时效。 */
export function buildSearchQueries(topic, { max = 2 } = {}) {
  const year = new Date().getFullYear();
  const queries = [];
  const title = String(topic?.title || topic?.topic || "").replace(/[？?！!。.，,、]+$/, "").trim();
  if (title) queries.push(`${title} ${year}`);
  const kws = (topic?.keywords || []).filter(Boolean).slice(0, 4).join(" ");
  if (kws && kws !== title) queries.push(`${kws} ${year}`);
  return queries.slice(0, Number(max) || 2);
}

/**
 * 通道 2 编排：充分性闸门 → 关键字组 → searchWebSearch → 落地
 * `01-step/web-search/<slug>.md` + `index.json` → 转成与通道 1 同构的素材条目。
 * 闸门判定充足时返回 []（不联网）。返回的条目由调用方并入 sources。
 *
 * cfg = type.knowledge.web-search（gate 子块放阈值）；searchImpl 可注入便于测试。
 */
export async function gatherWebSearch({
  topic,
  localSources = [],
  articleDir,
  cfg = {},
  model,
  maxSources,
  logger,
  now = Date.now(),
  recorder,
  slot,
  searchImpl = searchWebSearch,
} = {}) {
  // 本通道的每个阈值都单源 defaults.yaml defaults.knowledge.web-search：
  // 原来这里和下面各有一份与配置同值的副本（8 / 2 / 3 / 6 / 800 / 180000），
  // 改 defaults.yaml 不生效就是这个形状。缺了直接抛错点名配置路径。
  const where = (key) => `defaults.yaml defaults.knowledge.web-search.${key}`;
  const sourceLimit = needNumber(maxSources, "defaults.yaml defaults.knowledge.max_sources");
  const verdict = assessSourceSufficiency(localSources, {
    topic,
    maxSources: sourceLimit,
    gate: cfg.gate || {},
    now,
  });
  if (verdict.ok) {
    logger?.info?.(`本地素材充足（${localSources.length} 篇），跳过外部检索`);
    return [];
  }
  logger?.warn?.(`本地素材不足：${verdict.reasons.join("；")}，走外部检索`);

  const queries = buildSearchQueries(topic, { max: needNumber(cfg.max_queries, where("max_queries")) });
  if (!queries.length) return [];
  const results = await searchImpl(queries, {
    model,
    // 单组检索限时（各组并行，所以它也是外部检索的总时长上限）单源 defaults.yaml：
    // DEFAULT_SEARCH_TIMEOUT_MS 只留给 serve 存活期与直接调用本模块的使用者，不再吃进配置路径。
    timeoutMs: needNumber(cfg.timeout_ms, where("timeout_ms")),
    logger,
    recorder,
    slot,
  });

  const dir = ensureDir(path.join(articleDir, "01-step", "web-search"));
  const index = [];
  const entries = [];
  for (const r of results) {
    if (!r.markdown) {
      index.push({ query: r.query, file: "", status: "failed", error: r.error || "empty" });
      continue;
    }
    const rel = `01-step/web-search/${slugify(r.query, "web-search")}.md`;
    fs.writeFileSync(path.join(articleDir, rel), r.markdown, "utf8");
    const blocks = parseSearchMarkdown(r.markdown, {
      limit: needNumber(cfg.max_per_query, where("max_per_query")),
      excerptChars: needNumber(cfg.excerpt_chars, where("excerpt_chars")),
    });
    for (const b of blocks) {
      entries.push({
        file: rel,
        title: b.title,
        url: b.url,
        source: b.url,
        date: new Date(now).toISOString().slice(0, 10),
        tags: [],
        summary: b.excerpt.slice(0, 160),
        matched: [],
        score: 0,
        excerpts: [b.excerpt],
        origin: "web",
      });
    }
    index.push({ query: r.query, file: rel, status: blocks.length ? "ok" : "empty", hits: blocks.length });
  }
  fs.writeFileSync(path.join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const capped = entries.slice(0, needNumber(cfg.max_sources, where("max_sources")));
  logger?.info?.(
    `外部检索：${queries.length} 组关键字，落地 ${index.filter((x) => x.file).length} 个文件，解析 ${entries.length} 条，并入 ${capped.length} 条`,
  );
  return capped;
}

/* ------------------------------------------------------------------ */
/* 独立运行入口：node scripts/lib/web-search.mjs "关键字组" [...]   */
/* ------------------------------------------------------------------ */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 独立运行入口不经过流水线，自行加载根目录 .env（已有环境变量优先）
  const { loadDotEnv } = await import("./env.mjs");
  loadDotEnv();
  const argv = process.argv.slice(2);
  let model;
  let outFile;
  const queries = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--out") outFile = argv[++i];
    else queries.push(argv[i]);
  }
  if (!queries.length) {
    console.error('用法: node web-search.mjs "关键字组1" ["关键字组2" ...] [--model provider/model] [--out result.md]');
    console.error(`默认模型: 环境变量 OPENCODE_DEFAULT_MODEL ?? ${DEFAULT_SEARCH_MODEL}`);
    process.exit(1);
  }
  const logger = { info: (m) => console.error("[info]", m), warn: (m) => console.error("[warn]", m) };
  const out = await searchWebSearch(queries, { model, logger });
  const md = out
    .map((r) => (r.error ? `# 外部检索：${r.query}\n\n（失败：${r.error}）` : r.markdown))
    .join("\n\n---\n\n");
  if (outFile) fs.writeFileSync(outFile, md, "utf8");
  else console.log(md);
  process.exitCode = out.some((r) => r.error) ? 2 : 0;
}
