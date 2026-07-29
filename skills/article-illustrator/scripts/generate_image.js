const fs = require("fs");
const path = require("path");

const SCENE_MAP = {
  "wechat-cover":       { width: 900,  height: 383  },
  "wechat-cover-thumb": { width: 500,  height: 500  },
  "article-inline":     { width: 1080, height: 0    },
  "news-cover":         { width: 1200, height: 630  },
  "news-inline":        { width: 1200, height: 800  },
  "novel-cover":        { width: 1200, height: 1800 },
  "novel-inline":       { width: 1080, height: 1440 },
};

const API_BASE = "https://api-inference.modelscope.cn";
const API_KEY = process.env.PB_MODEL_API_KEY;
const NEGATIVE_PROMPT = "photorealistic, 3d render, oil painting, western fantasy, anime style, manga, chibi, too many details, cluttered composition, bright neon colors, over-saturated, soft focus, blurry, deformed hands, extra limbs, signature, watermark, text, words, logo";
const POLL_MAX_RETRIES = 30;
const POLL_INTERVAL_MS = 5000;
const PER_IMAGE_TIMEOUT_MS = parseInt(process.env.PB_IMAGE_TIMEOUT_MS || "60000", 10);

function parseArgs() {
  const [,, prompt, scene, position, outputDir] = process.argv;
  if (!prompt || !scene || !position || !outputDir) {
    console.error("Usage: node generate_image.js <prompt> <scene> <position> <outputDir>");
    process.exit(1);
  }
  const size = SCENE_MAP[scene];
  if (!size) {
    console.error(`Unknown scene: ${scene}`);
    process.exit(1);
  }
  return { prompt, scene, position, outputDir: path.resolve(outputDir), size };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return dest;
}

async function apiRequest(endpoint, body, method = "POST", extraHeaders = {}) {
  const url = new URL(endpoint, API_BASE);
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-ModelScope-Async-Mode": "true",
      "Accept": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function pollTask(taskId) {
  for (let i = 0; i < POLL_MAX_RETRIES; i++) {
    const { status, data } = await apiRequest(`/v1/tasks/${taskId}`, null, "GET", {
      "X-ModelScope-Task-Type": "image_generation",
    });
    if (data) {
      if (data.task_status === "SUCCEED") {
        if (Array.isArray(data.output_images) && data.output_images[0]) {
          return data.output_images[0];
        }
        throw new Error(`Task ${taskId} SUCCEED but no output_images`);
      }
      if (data.task_status === "FAILED") {
        const msg = (data.errors?.message) || JSON.stringify(data);
        throw new Error(`Task ${taskId} failed: ${msg}`);
      }
    }
    if (status !== 200) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Task ${taskId} timed out after ${POLL_MAX_RETRIES * POLL_INTERVAL_MS}ms`);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

async function generateWithModelScope(prompt, size, outputDir, position) {
  if (!API_KEY) throw new Error("PB_MODEL_API_KEY not set");
  const sizeLabel = `${size.width}x${size.height || 1080}`;
  const body = {
    model: "Tongyi-MAI/Z-Image-Turbo",
    prompt,
    size: sizeLabel,
    parameters: { negative_prompt: NEGATIVE_PROMPT, steps: 20 },
  };
  const { status, data } = await withTimeout(apiRequest("/v1/images/generations", body), PER_IMAGE_TIMEOUT_MS);
  if (status !== 200) throw new Error(`Submit failed: ${JSON.stringify(data)}`);
  const taskId = data.task_id;
  if (!taskId) throw new Error(`No task_id in submit response: ${JSON.stringify(data)}`);
  const imageUrl = await withTimeout(pollTask(taskId), PER_IMAGE_TIMEOUT_MS);
  const dest = path.join(outputDir, `${position}_modelscope.png`);
  return download(imageUrl, dest);
}

async function generateWithPollinations(prompt, size, outputDir, position) {
  const params = new URLSearchParams({
    width: String(size.width),
    height: String(size.height || 1080),
    model: "turbo",
    nologo: "true",
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  const dest = path.join(outputDir, `${position}_pollinations.png`);
  return download(url, dest);
}

function cleanupTempFiles(paths, keepPath) {
  paths.forEach(f => {
    if (f !== keepPath && fs.existsSync(f)) fs.unlinkSync(f);
  });
}

function buildResult(position, scene, prompt, outputDir, msResult, poResult) {
  const result = {
    position, scene, prompt, output_dir: outputDir,
    attempts: [], success: false,
  };

  if (msResult.status === "fulfilled") {
    const stats = fs.statSync(msResult.value);
    result.attempts.push({ pipeline: "modelscope", local_path: msResult.value, success: true, size_bytes: stats.size });
  } else {
    result.attempts.push({ pipeline: "modelscope", success: false, error: msResult.reason?.message || "unknown" });
  }

  if (poResult.status === "fulfilled") {
    const stats = fs.statSync(poResult.value);
    result.attempts.push({ pipeline: "pollinations", local_path: poResult.value, success: true, size_bytes: stats.size });
  } else {
    result.attempts.push({ pipeline: "pollinations", success: false, error: poResult.reason?.message || "unknown" });
  }

  const modelscopePath = msResult.status === "fulfilled" ? msResult.value : null;
  const pollinationsPath = poResult.status === "fulfilled" ? poResult.value : null;
  const selectedPath = modelscopePath || pollinationsPath;
  if (selectedPath) {
    const finalPath = path.join(outputDir, `${position}.png`);
    fs.renameSync(selectedPath, finalPath);
    result.local_path = finalPath;
    result.selected_pipeline = modelscopePath ? "modelscope" : "pollinations";
    result.success = true;
  } else {
    result.error = "both pipelines failed";
  }

  return result;
}

async function main() {
  // 步骤 1: 解析命令行参数
  const { prompt, scene, position, outputDir, size } = parseArgs();

  // 步骤 2: 双管线并行生成
  const [msResult, poResult] = await Promise.allSettled([
    generateWithModelScope(prompt, size, outputDir, position),
    generateWithPollinations(prompt, size, outputDir, position),
  ]);

  // 步骤 3: 优选并输出
  const result = buildResult(position, scene, prompt, outputDir, msResult, poResult);

  const paths = [msResult, poResult].map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
  cleanupTempFiles(paths, result.local_path);

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
