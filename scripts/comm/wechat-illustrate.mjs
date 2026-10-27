import path from "node:path";
import { needNumber } from "../lib/env.mjs";
import { ensureDir, sleep, writeBinary } from "../lib/fsx.mjs";
import { renderTemplate, validateProduced } from "../lib/template.mjs";

// 尺寸场景与通道参数单源 defaults.yaml illustrations：代码里不留副本，缺字段直接抛错点名
// 配置路径（旧版这里的 timeout/max_polls 副本早就和配置的 120000/24 打架，等于两份真相）。
const CHANNEL_PARAM_SOURCE = "defaults.yaml illustrations";

/** 读一个必填的配图配置项；缺了就抛，不静默用代码里的默认值。 */
function need(config, channel, key) {
  const value = config?.[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`缺少配图通道参数：${CHANNEL_PARAM_SOURCE}.${channel}.${key}`);
  }
  return value;
}

/**
 * Generate one image through the configured channels, in order:
 * `primary` first, then each `fallback` only if the previous channel failed.
 * ModelScope is the primary channel (better quality, tolerates parallel images);
 * Pollinations is the key-free fallback and is hard-throttled — see
 * withPollinationsQuota().
 * `promptTemplate` 是节点 image_generation 的提示词模板（prompts/revision.yaml），
 * 缺了直接抛——不在代码里留一份副本兜着，那样改配置不生效。
 */
export async function generateImages({ plans, outputDir, config = {}, promptTemplate, logger, topic = "", recorder, slot }) {
  const template = String(promptTemplate || "").trim();
  if (!template) {
    throw new Error("缺少配图提示词模板：steps 节点 image_generation 的 prompt（prompts/revision.yaml → image_generation.user）");
  }
  const scenes = config.scenes || {};
  // 并发数单源 defaults.yaml illustrations.concurrency（.env PB_IMAGE_CONCURRENCY 抬起）；
  // 这里的 1 只是非法/缺失值的下限兜底——0 个 worker 会让队列永远跑不完。
  const concurrency = Math.max(1, Number(config.concurrency) || 1);
  const channels = resolveChannels(config);
  ensureDir(outputDir);
  const results = [];
  const queue = [...plans];

  async function worker() {
    while (queue.length) {
      const plan = queue.shift();
      const result = await generateOne({ plan, outputDir, config, scenes, template, channels, logger, topic, recorder, slot });
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, () => worker()));
  results.sort((a, b) => a.index - b.index);
  return results;
}

const CHANNELS = {
  modelscope: { run: generateModelScope },
  pollinations: { run: generatePollinations },
};

/**
 * 通道顺序：illustrations.primary + illustrations.fallback 是单源；
 * 两者都没写时按 CHANNELS 声明顺序（modelscope → pollinations）。
 * enabled: false 的通道直接剔除；写了未知通道名视为配置错误，直接抛。
 */
export function resolveChannels(config) {
  const declared = [config.primary, ...(Array.isArray(config.fallback) ? config.fallback : config.fallback ? [config.fallback] : [])]
    .filter(Boolean);
  for (const name of declared) {
    if (!CHANNELS[name]) throw new Error(`illustrations.primary/fallback 里有未知配图通道：${name}`);
  }
  const names = [];
  for (const name of (declared.length ? declared : Object.keys(CHANNELS))) {
    if (!names.includes(name)) names.push(name);
  }
  return names
    .filter((name) => config[name]?.enabled !== false)
    .map((name, index) => ({
      name,
      // 排在首位之后 = 主通道失败才轮到的兜底降级，留痕按 AGENTS.md 的命名规则尾部标 _F。
      // 首选被 enabled:false 摘掉后，新的首位不再是降级。
      fallback: index > 0,
      run: CHANNELS[name].run,
      // 顶层 negative_prompt 是各通道共享的默认值，通道段写了同名键才覆盖。
      options: { negative_prompt: config.negative_prompt, ...(config[name] || {}) },
    }));
}

/**
 * 每张图落在哪个场景/位置：第 1 张固定封面。
 * planImages 已经把 scene/position 写死，这里只兜住直接传裸 image_plan 的调用方。
 */
export function resolvePlanSlot(plan) {
  const first = Number(plan.index) === 1;
  return {
    scene: plan.scene || (first ? "wechat-cover" : "article-inline"),
    position: plan.position || (first ? "cover" : `inline_${plan.index}`),
  };
}

async function generateOne({ plan, outputDir, config, scenes, template, channels, logger, topic, recorder, slot }) {
  const index = plan.index;
  const { scene, position } = resolvePlanSlot(plan);
  const configured = scenes[scene];
  if (!configured) logger?.warn(`配图 ${index} 的场景 ${scene} 不在 illustrations.scenes 里，按 article-inline 尺寸出图`);
  const size = configured || scenes["article-inline"];
  // 尺寸单源 illustrations.scenes：两处都取不到 = 配置缺失，按 AGENTS.md 第 2 层中断并点名路径，
  // 不用代码里的副本猜一个尺寸（那等于让改配置不生效）。
  if (!Number(size?.width) || !Number(size?.height)) {
    throw new Error(`缺少配图尺寸：${CHANNEL_PARAM_SOURCE}.scenes.${scene}（或 article-inline）的 width/height`);
  }
  const prompt = composePrompt(plan, config, topic, template, size);
  logger?.info(`配图 ${index} 开始生成（${scene} ${size.width}x${size.height}，通道 ${channels.map((channel) => channel.name).join(" → ") || "无"}）`);

  const base = { index, scene, prompt, size: `${size.width}x${size.height}` };
  const attempts = [];
  for (const channel of channels) {
    const startedAt = Date.now();
    const settled = await runPipeline(channel.name, () => channel.run({ prompt, size, outputDir, index, config: channel.options }), {
      recorder,
      slot,
      fallback: channel.fallback,
      request: { ...base, model: channel.options.model },
    });
    attempts.push({ pipeline: channel.name, ok: settled.ok, error: settled.error || null });
    if (settled.ok) {
      logger?.info(`配图 ${index} 完成：${channel.name} → ${path.basename(settled.file)}，${((Date.now() - startedAt) / 1000).toFixed(1)}s${channel.fallback ? "（主通道失败后降级）" : ""}`);
      return {
        index,
        position,
        scene,
        description: plan.description,
        prompt,
        success: true,
        pipeline: channel.name,
        file: settled.file,
        attempts,
      };
    }
    logger?.warn(`配图 ${index} 通道 ${channel.name} 失败：${settled.error}`);
  }

  const errors = attempts.map((item) => `${item.pipeline}: ${item.error}`).join(" | ") || "没有可用配图通道";
  logger?.warn(`配图 ${index} 生成失败：${errors}`);
  return { index, position, scene, description: plan.description, prompt, success: false, error: errors, attempts };
}

/** 单个配图通道（一次真实外部生成调用）：成功/失败都经 recorder 落 <step>/api/ 留痕。 */
async function runPipeline(name, fn, { recorder, slot, fallback = false, request } = {}) {
  const startedAt = Date.now();
  const record = (extra) => {
    if (!recorder) return;
    recorder.record({
      label: "illustrate",
      slot,
      fallback,
      provider: name,
      request,
      duration_ms: Date.now() - startedAt,
      ...extra,
    });
  };
  try {
    const file = await fn();
    record({ response: path.basename(file) });
    return { pipeline: name, ok: true, file };
  } catch (error) {
    record({ error: error.message });
    return { pipeline: name, ok: false, error: error.message };
  }
}

/**
 * 渲染发给图片模型的 prompt。模板与文字全在 prompts/revision.yaml → image_generation，
 * 这里只提供变量：主体来自 02 纲要，风格/负面词来自 defaults.illustrations，
 * 构图说明来自该场景的尺寸配置（scenes.<scene>.composition）。
 */
export function composePrompt(plan, config, topic, template, scene = {}) {
  const raw = plan.prompt?.trim() || plan.description?.trim() || topic?.trim() || "";
  // 三层都空 = 上游产物缺必要字段，按第 2 层中断并点名，不用代码里的英文占位主体蒙混出图。
  if (!raw) throw new Error(`配图 ${plan.index ?? "?"} 没有主体描述：纲要 image_plan 的 prompt/description 与选题标题都为空`);
  // 模板自带 "{{subject}}. Style:"，02 纲要的 prompt 结尾常带句号，不去掉会渲染出 "no text.. Style:"
  const subject = raw.replace(/[.。]\s*$/, "");
  return renderTemplate(template, {
    subject,
    style: config.style,
    negative: config.negative_prompt,
    composition: scene.composition,
    scene: plan.scene,
    width: scene.width,
    height: scene.height,
  }).replace(/[ \t]+$/gm, "").trim();
}

export async function generateModelScope({ prompt, size, outputDir, index, config }) {
  const apiKey = config.api_key || process.env.PB_MODEL_IMAGE_API_KEY || process.env.PB_MODEL_API_KEY;
  if (!apiKey) throw new Error(`缺少 ModelScope 配图密钥：${CHANNEL_PARAM_SOURCE}.modelscope.api_key（.env PB_MODEL_IMAGE_API_KEY）`);
  const base = need(config, "modelscope", "base_url").replace(/\/+$/, "");
  const model = need(config, "modelscope", "model");
  const timeout = Number(need(config, "modelscope", "timeout_ms"));
  const pollInterval = Number(need(config, "modelscope", "poll_interval_ms"));
  const maxPolls = Number(need(config, "modelscope", "max_polls"));

  const body = {
    model,
    prompt,
    size: `${size.width}x${size.height}`,
    parameters: { negative_prompt: config.negative_prompt || undefined, steps: 20 },
  };
  const submit = await fetch(`${base}/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-ModelScope-Async-Mode": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`submit HTTP ${submit.status}: ${JSON.stringify(submitted).slice(0, 300)}`);
  const taskId = submitted.task_id;
  if (!taskId) throw new Error(`no task_id: ${JSON.stringify(submitted).slice(0, 300)}`);

  let imageUrl = null;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollInterval);
    const res = await fetch(`${base}/v1/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-ModelScope-Task-Type": "image_generation",
      },
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    // 轮询报错（鉴权失效、task 不存在等）必须当场抛出：继续睡会把 max_polls 全部白等完，
    // 最后只报一句 task timed out，既掩盖真因又推迟通道降级。
    if (!res.ok) {
      throw new Error(`poll HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (data.task_status === "SUCCEED") {
      imageUrl = data.output_images?.[0];
      if (!imageUrl) throw new Error("task succeeded without output_images");
      break;
    }
    if (data.task_status === "FAILED") {
      throw new Error(data.errors?.message || JSON.stringify(data).slice(0, 300));
    }
  }
  if (!imageUrl) throw new Error(`task ${taskId} timed out`);
  const file = path.join(outputDir, `${String(index).padStart(2, "0")}_modelscope.png`);
  await download(imageUrl, file, timeout);
  return file;
}

/**
 * Pollinations 免费档（无需 key）实测限制：每 IP 45 秒 1 张，且同时只允许 1 张在飞
 * （5 个并发请求只有最先起跑的拿到 200，其余 402 FREE_LIMIT；ref/referrer/model 都不另开配额）。
 * 所以进程内排队串行 + 记配额释放时间，限速报错按 "Retry after Ns" 退避后重试。
 */
let pollinationsQueue = Promise.resolve();
let pollinationsFreeAt = 0;

async function withPollinationsQuota(config, run) {
  const minInterval = Number(need(config, "pollinations", "min_interval_ms"));
  const retries = Math.max(0, Number(need(config, "pollinations", "max_retries")));
  const previous = pollinationsQueue;
  let release;
  pollinationsQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  let lastError = null;
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const wait = pollinationsFreeAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const file = await run();
        pollinationsFreeAt = Date.now() + minInterval;
        return file;
      } catch (error) {
        lastError = error;
        const backoff = rateLimitBackoff(error.message);
        if (!backoff || attempt === retries) break;
        pollinationsFreeAt = Date.now() + backoff;
      }
    }
    throw lastError || new Error("pollinations 调用未产出图片");
  } finally {
    release();
  }
}

/** 限速（402/429/503）返回应退避的毫秒数，非限速错误返回 0（重试也没用）。 */
export function rateLimitBackoff(message) {
  if (!/FREE_LIMIT|SERVICE_UNAVAILABLE|HTTP (402|429|503)/i.test(message)) return 0;
  const seconds = Number(String(message).match(/retry after (\d+)\s*s/i)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120000) : 45000;
}

async function generatePollinations({ prompt, size, outputDir, index, config }) {
  const base = need(config, "pollinations", "base_url").replace(/\/+$/, "");
  const params = new URLSearchParams({
    width: String(size.width),
    height: String(size.height),
    model: need(config, "pollinations", "model"),
    nologo: "true",
    seed: String(Date.now() % 1000000),
  });
  const url = `${base}/prompt/${encodeURIComponent(prompt)}?${params}`;
  const file = path.join(outputDir, `${String(index).padStart(2, "0")}_pollinations.png`);
  return withPollinationsQuota(config, () => download(url, file, Number(need(config, "pollinations", "timeout_ms"))));
}

async function download(url, dest, timeout) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`download HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 2048) throw new Error(`downloaded file too small (${buffer.length} bytes)`);
  const target = withImageExtension(dest, res.headers.get("content-type"), buffer);
  writeBinary(target, buffer);
  return target;
}

/** 免费档实际返回的是 JPEG：扩展名必须跟着内容走，否则发布侧按扩展名报给微信的 mime 类型是错的。 */
export function withImageExtension(dest, contentType, buffer) {
  const jpeg = /jpe?g/i.test(contentType || "") || (buffer[0] === 0xff && buffer[1] === 0xd8);
  return jpeg ? dest.replace(/\.png$/i, ".jpg") : dest;
}

/**
 * 按 image_generation 节点的数据结构（schemas/revision.yaml → image_generation.output，
 * 紧凑 DSL）校验本次配图产物。只报告不改结果：配图分支失败本来就只降级。
 * 没配 schema 时返回 checked:false，让产物如实说明「没校验过」。
 */
export function validateImageRecords(images, outputSchema) {
  return validateProduced({ images }, outputSchema);
}

/** Decide how many images to generate for a type. */
export function resolveImageCount(type, outline, options = {}) {
  const illustrations = type.illustrations;
  // 区间单源 defaults.yaml defaults.illustrations.min/max（或类型的 image_count）。
  // 原来的 `|| 1` / `|| 5` 与配置同值，改 defaults 不生效；缺值现在直接抛错点名配置路径。
  const min = needNumber(illustrations.min, `类型 ${type.id} 的 illustrations.min`);
  const max = needNumber(illustrations.max, `类型 ${type.id} 的 illustrations.max`);
  const planned = Array.isArray(outline?.image_plan) ? outline.image_plan.length : 0;
  // 优先级：--images > 纲要实际规划 > 类型 image_count.default > min。
  // default 只在纲要没排出配图时兜底，不覆盖模型按小节规划的数量。
  const requested = options.count ?? (planned || illustrations.count || min);
  return Math.max(min, Math.min(max, requested || min));
}

/** Build plans from outline.image_plan, padding with generic positions. */
export function planImages(outline, count, { cover = true } = {}) {
  const planned = (outline?.image_plan || []).slice(0, count);
  const plans = planned.map((item, i) => ({
    index: i + 1,
    position: item.position || (i === 0 && cover ? "cover" : `inline_${i}`),
    scene: i === 0 && cover ? "wechat-cover" : "article-inline",
    description: item.description || `配图 ${i + 1}`,
    prompt: item.prompt || "",
  }));
  while (plans.length < count) {
    const i = plans.length;
    plans.push({
      index: i + 1,
      position: i === 0 && cover ? "cover" : `inline_${i}`,
      scene: i === 0 && cover ? "wechat-cover" : "article-inline",
      description: `配图 ${i + 1}`,
      prompt: "",
    });
  }
  return plans;
}
