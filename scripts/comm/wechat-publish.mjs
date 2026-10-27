import fs from "node:fs";
import path from "node:path";
import { needConfig, needNumber } from "../lib/env.mjs";
import { ensureDir } from "../lib/fsx.mjs";

/**
 * 发布结果状态：
 *   published = 所有启用的渠道都真实投递成功
 *   partial   = 有成功也有失败
 *   failed    = 启用的渠道全部失败
 *   skipped   = 未启用发布 / auto_publish=false
 *   dry_run   = 演练
 * 只有 published 会触发归档。
 */
export function derivePublishStatus({ dryRun, emailEnabled, wechatEnabled, email, wechat }) {
  const channels = [emailEnabled ? email : null, wechatEnabled ? wechat : null].filter(Boolean);
  if (dryRun) return "dry_run";
  if (channels.length === 0) return "skipped";
  // 渠道级演练（如 wechat.dry_run=true）没有真实投递，不触发归档。
  if (channels.some((channel) => channel.dryRun === true)) return "dry_run";
  const ok = channels.filter((channel) => channel.success === true).length;
  if (ok === channels.length) return "published";
  if (ok > 0) return "partial";
  return "failed";
}

/**
 * 本地图片 → CID 内联附件。images 项必须是 { src, file }：src 是 HTML 里实际出现的
 * 引用串（05 的 final.md 用相对 05-step/ 的路径），file 是绝对路径。
 * 只按绝对路径找的话（旧实现），相对引用的图永远替换不命中：附件发出去了，
 * 正文里仍是本地路径，邮件图片全断。
 */
export function inlineLocalImages(html, images = []) {
  const attachments = [];
  let out = String(html || "");
  for (const image of images) {
    if (!image?.file || !fs.existsSync(image.file)) continue;
    const cid = `article-image-${attachments.length + 1}`;
    attachments.push({
      filename: path.basename(image.file),
      content: fs.readFileSync(image.file).toString("base64"),
      content_id: cid,
      content_type: mimeFor(image.file),
    });
    const needle = String(image.src || image.file).replace(/\\/g, "/");
    out = out.split(needle).join(`cid:${cid}`);
  }
  return { html: out, attachments };
}

/** Publish via Resend. Inline local images as CID attachments when possible. */
export async function sendEmail({ to, subject, html, text, images = [], config = {}, logger, recorder, slot }) {
  // 凭据、发件人、重试次数都只从 defaults.yaml defaults.publish.email 读：
  // .env 的值由 expandEnv 在加载期展开进配置，这里再摸 process.env 等于给同一项开第二个口。
  const apiKey = needConfig(config.api_key, "defaults.yaml defaults.publish.email.api_key（值来自 .env PB_RESEND_API_KEY）");
  const from = needConfig(config.from, "defaults.yaml defaults.publish.email.from（值来自 .env PB_RESEND_FROM）");

  const recipients = (Array.isArray(to) ? to : String(to || "").split(/[,;，；\s]+/)).filter(Boolean);
  if (!recipients.length) throw new Error("缺少收件人邮箱");

  const { html: finalHtml, attachments } = inlineLocalImages(html, images);

  const body = {
    from: from.includes("<") ? from : `公众号助手 <${from}>`,
    to: recipients,
    subject,
    html: finalHtml,
    ...(text ? { text } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  // 单次投递的 HTTP 重试次数与限时（(尝试) 标注，不推轮次）单源 defaults.yaml；
  // 原来这里 `?? 2` 与写死的 30000 是配置里根本没有的第二份真相。
  const retries = needNumber(config.retries, "defaults.yaml defaults.publish.email.retries");
  const timeoutMs = needNumber(config.timeout_ms, "defaults.yaml defaults.publish.email.timeout_ms");
  const emailsUrl = `${String(needConfig(config.base_url, "defaults.yaml defaults.publish.email.base_url")).replace(/\/+$/, "")}/emails`;
  // 留痕用的请求体：不带正文 HTML 与 base64 附件内容（只留文件名/类型/大小），也不带密钥
  const logRequest = {
    ...body,
    html: undefined,
    html_chars: String(body.html || "").length,
    ...(attachments.length
      ? { attachments: attachments.map((a) => ({ filename: a.filename, content_id: a.content_id, content_type: a.content_type, bytes: a.content.length })) }
      : {}),
  };
  const record = (attempt, extra) => {
    if (!recorder) return;
    recorder.record({ label: "email", slot, provider: "resend", request: logRequest, attempt: attempt + 1, ...extra });
  };
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      const res = await fetch(emailsUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      record(attempt, { duration_ms: Date.now() - startedAt, response: JSON.stringify(data), error: res.ok ? undefined : `HTTP ${res.status}` });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
      logger?.info(`邮件已发送：${data.id || "ok"} → ${recipients.join(", ")}`);
      return { success: true, id: data.id, to: recipients };
    } catch (error) {
      lastError = error;
      if (!/HTTP \d/.test(error.message)) record(attempt, { duration_ms: Date.now() - startedAt, error: error.message });
      logger?.warn(`邮件发送失败（第 ${attempt + 1} 次）：${error.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return { success: false, error: lastError?.message || "unknown" };
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

/**
 * wenyan CLI 只认 WECHAT_APP_ID / WECHAT_APP_SECRET（见 @wenyan-md/core wrapper
 * getAppIdAndSecret），管线对外承诺的变量名是 WECHAT_MP_*；这里补齐别名，
 * 否则 CLI 会报「未提供 AppID」——凭据在 .env 里明明配好了。
 */
export function wechatChildEnv(env = process.env) {
  const out = { ...env };
  for (const [target, alias] of [
    ["WECHAT_APP_ID", "WECHAT_MP_APP_ID"],
    ["WECHAT_APP_SECRET", "WECHAT_MP_APP_SECRET"],
  ]) {
    if (!out[target] && out[alias]) out[target] = out[alias];
  }
  return out;
}

/** Windows 上必须经 cmd.exe 才能跑 npx（.cmd），所以参数自己加引号；含空格路径不会被拆开。 */
export function wechatCommandString([bin, ...args]) {
  return [bin, ...args.map(quoteArg)].join(" ");
}

function quoteArg(value) {
  const text = String(value);
  return /^[\w.@:/\\+-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Publish a markdown file to the WeChat draft box via @wenyan-md/cli.
 * The CLI handles uploading local images and cover.
 */
export async function publishToWechat({ markdownFile, config = {}, logger, recorder, slot, envFile }) {
  const { spawn } = await import("node:child_process");
  const dryRun = config.dry_run === true;
  // 命令串与环境文件路径单源 defaults.yaml defaults.publish.wechat：
  // 代码里那份 "npx --yes @wenyan-md/cli" / ".env" 与配置同值，改了配置不会生效。
  const command = needConfig(config.command, "defaults.yaml defaults.publish.wechat.command");
  const [bin, ...baseArgs] = splitCommand(command);
  const args = [...baseArgs, "publish", "-f", markdownFile];
  if (config.theme) args.push("--theme", config.theme);
  if (config.highlight) args.push("--highlight", config.highlight);
  if (config.app_id) args.push("--app-id", config.app_id);
  if (config.server) args.push("--server", config.server);
  if (config.api_key) args.push("--api-key", config.api_key);
  const file = needConfig(envFile || config.env_file, "defaults.yaml defaults.publish.wechat.env_file（--env-file 可覆盖）");
  if (file && fs.existsSync(path.resolve(file))) args.push("--env-file", path.resolve(file));
  // 密钥走命令行参数，任何回显（日志与留痕）都必须先打码。
  const safeArgs = maskSecrets(args);

  if (dryRun) {
    const shown = `${bin} ${safeArgs.join(" ")}`;
    logger?.info(`[dry-run] ${shown}`);
    return { success: true, dryRun: true, command: shown };
  }

  const win32 = process.platform === "win32";
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = win32
      ? spawn(wechatCommandString([bin, ...args]), { shell: true, windowsHide: true, env: wechatChildEnv() })
      : spawn(bin, args, { windowsHide: true, env: wechatChildEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

  const output = redact(`${result.stdout}\n${result.stderr}`.trim(), config.api_key);
  if (recorder) {
    recorder.record({
      label: "publish",
      slot,
      provider: "wenyan-md",
      request: { command: [bin, ...safeArgs].join(" "), markdown_file: markdownFile },
      duration_ms: Date.now() - startedAt,
      response: output.slice(-2000),
      error: result.code === 0 ? undefined : `exit ${result.code}`,
    });
  }
  if (result.code !== 0) {
    logger?.warn(`公众号发布失败（exit ${result.code}）：${output.slice(-600)}`);
    return { success: false, code: result.code, output };
  }
  logger?.info(`公众号草稿发布完成：${output.slice(-300)}`);
  return { success: true, output };
}

/** CLI 参数里 `--api-key <值>` 这类密钥取值统一换成 ***（日志与留痕共用打码后的参数）。 */
function maskSecrets(args) {
  const secretFlags = new Set(["--api-key", "--api_key", "--token"]);
  return args.map((arg, index) => (secretFlags.has(args[index - 1]) ? "***" : arg));
}

/** CLI 可能把整条命令回显进 stdout/stderr，输出里的密钥原文也一律替换掉。 */
function redact(text, ...secrets) {
  let out = String(text || "");
  for (const secret of secrets) if (secret && String(secret).length >= 6) out = out.split(String(secret)).join("***");
  return out;
}

function splitCommand(command) {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || [command];
}

/** Markdown to HTML using markdown-it when available, with a small fallback. */
export async function markdownToHtml(markdown) {
  try {
    const { default: MarkdownIt } = await import("markdown-it");
    const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
    return md.render(markdown);
  } catch {
    return fallbackMarkdown(markdown);
  }
}

function fallbackMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let inList = false;
  for (const line of lines) {
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (image) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<p><img src="${image[2]}" alt="${image[1]}" style="max-width:100%"></p>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    if (line.trim()) html.push(`<p>${line}</p>`);
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

/** Wrap HTML in a simple responsive email shell. */
export function emailShell(title, html) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; padding:0; background:#f6f7f9; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:#222; }
  .wrap { max-width:720px; margin:0 auto; padding:28px 20px 48px; background:#fff; }
  h1 { font-size:26px; line-height:1.35; margin:8px 0 18px; }
  h2 { font-size:20px; margin:28px 0 12px; }
  h3 { font-size:17px; margin:22px 0 10px; }
  p { font-size:16px; line-height:1.85; margin:0 0 16px; }
  img { max-width:100%; height:auto; border-radius:6px; margin:12px 0; }
  blockquote { margin:16px 0; padding:10px 16px; border-left:3px solid #4c6ef5; background:#f5f7ff; color:#444; }
  code { background:#f1f3f5; padding:2px 5px; border-radius:3px; font-size:14px; }
  pre { background:#f8f9fa; padding:14px; overflow:auto; border-radius:6px; }
  table { border-collapse:collapse; width:100%; margin:16px 0; }
  th, td { border:1px solid #e5e7eb; padding:8px 10px; font-size:14px; }
  .footer { margin-top:32px; padding-top:16px; border-top:1px solid #eee; color:#888; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
${html}
<div class="footer">由 penbot wechat-article 自动生成</div>
</div>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

/** Strip frontmatter for email body. */
export function bodyOnly(markdown) {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}
