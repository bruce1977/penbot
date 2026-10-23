import fs from "node:fs";
import path from "node:path";
import { ensureDir, sleep } from "../lib/fsx.mjs";

const DEFAULT_SCENES = {
  "wechat-cover": { width: 900, height: 383 },
  "wechat-cover-thumb": { width: 500, height: 500 },
  "article-inline": { width: 1080, height: 810 },
  "news-cover": { width: 1200, height: 630 },
  "news-inline": { width: 1200, height: 800 },
};

/**
 * Generate one image through ModelScope and Pollinations in parallel.
 * ModelScope wins when both succeed; Pollinations is the free fallback.
 */
export async function generateImages({ plans, outputDir, config = {}, logger, topic = "" }) {
  const scenes = { ...DEFAULT_SCENES, ...(config.scenes || {}) };
  const concurrency = Math.max(1, Number(config.concurrency || 2));
  ensureDir(outputDir);
  const results = [];
  const queue = [...plans];

  async function worker() {
    while (queue.length) {
      const plan = queue.shift();
      const result = await generateOne({ plan, outputDir, config, scenes, logger, topic });
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, () => worker()));
  results.sort((a, b) => a.index - b.index);
  return results;
}

async function generateOne({ plan, outputDir, config, scenes, logger, topic }) {
  const index = plan.index;
  const scene = plan.scene || (index === 0 ? "wechat-cover" : "article-inline");
  const size = scenes[scene] || DEFAULT_SCENES["article-inline"];
  const prompt = composePrompt(plan, config, topic);
  const position = plan.position || (index === 0 ? "cover" : `inline_${index}`);
  logger?.info(`配图 ${index} 开始生成（${scene} ${size.width}x${size.height}）`);

  const tasks = [];
  if (config.modelscope?.enabled !== false) {
    tasks.push(
      runPipeline("modelscope", () => generateModelScope({ prompt, size, outputDir, index, config: config.modelscope || {} }), logger),
    );
  }
  if (config.pollinations?.enabled !== false) {
    tasks.push(
      runPipeline("pollinations", () => generatePollinations({ prompt, size, outputDir, index, config: config.pollinations || {} }), logger),
    );
  }

  const settled = await Promise.all(tasks);
  const successes = settled.filter((item) => item.ok);
  const preferred = successes.find((item) => item.pipeline === "modelscope") || successes[0];
  if (!preferred) {
    const errors = settled.map((item) => `${item.pipeline}: ${item.error}`).join(" | ");
    logger?.warn(`配图 ${index} 生成失败：${errors}`);
    return { index, position, scene, prompt, success: false, error: errors };
  }

  // Keep only the chosen file, delete the losing candidate.
  for (const item of successes) {
    if (item !== preferred) {
      try {
        fs.unlinkSync(item.file);
      } catch {
        /* ignore */
      }
    }
  }

  logger?.info(`配图 ${index} 完成：${preferred.pipeline} → ${path.basename(preferred.file)}`);
  return {
    index,
    position,
    scene,
    description: plan.description,
    prompt,
    success: true,
    pipeline: preferred.pipeline,
    file: preferred.file,
    attempts: settled.map((item) => ({ pipeline: item.pipeline, ok: item.ok, error: item.error || null })),
  };
}

async function runPipeline(name, fn, logger) {
  try {
    return { pipeline: name, ok: true, file: await fn() };
  } catch (error) {
    logger?.warn(`配图管线 ${name} 失败：${error.message}`);
    return { pipeline: name, ok: false, error: error.message };
  }
}

export function composePrompt(plan, config, topic) {
  const style = config.style || "简洁的科技插画，干净的构图，克制的配色";
  const negative = "no text, no words, no letters, no watermark, no logo";
  const base = plan.prompt?.trim();
  const description = plan.description?.trim();
  const subject = base || description || topic || "abstract technology concept";
  return [
    subject,
    style,
    negative,
    "16:9 horizontal composition, generous negative space, editorial illustration for a Chinese tech article",
  ].join(", ");
}

async function generateModelScope({ prompt, size, outputDir, index, config }) {
  const apiKey = config.api_key || process.env.PB_MODEL_IMAGE_API_KEY || process.env.PB_MODEL_API_KEY;
  if (!apiKey) throw new Error("missing ModelScope API key");
  const base = (config.base_url || "https://api-inference.modelscope.cn").replace(/\/+$/, "");
  const model = config.model || "Tongyi-MAI/Z-Image-Turbo";
  const timeout = Number(config.timeout_ms || 90000);
  const pollInterval = Number(config.poll_interval_ms || 5000);
  const maxPolls = Number(config.max_polls || 18);

  const body = {
    model,
    prompt,
    size: `${size.width}x${size.height || 810}`,
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

async function generatePollinations({ prompt, size, outputDir, index, config }) {
  const base = (config.base_url || "https://image.pollinations.ai").replace(/\/+$/, "");
  const params = new URLSearchParams({
    width: String(size.width),
    height: String(size.height || 810),
    model: config.model || "turbo",
    nologo: "true",
    seed: String(Date.now() % 1000000),
  });
  const url = `${base}/prompt/${encodeURIComponent(prompt)}?${params}`;
  const file = path.join(outputDir, `${String(index).padStart(2, "0")}_pollinations.png`);
  await download(url, file, Number(config.timeout_ms || 90000));
  return file;
}

async function download(url, dest, timeout) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 2048) throw new Error(`downloaded file too small (${buffer.length} bytes)`);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buffer);
  return dest;
}

/** Decide how many images to generate for a type. */
export function resolveImageCount(type, outline, options = {}) {
  const min = type.illustrations.min || 1;
  const max = type.illustrations.max || 5;
  const planned = Array.isArray(outline?.image_plan) ? outline.image_plan.length : 0;
  const requested = options.count ?? type.illustrations.count ?? planned ?? min;
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
