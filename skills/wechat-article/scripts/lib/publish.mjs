import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fsx.mjs";

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

/** Publish via Resend. Inline local images as CID attachments when possible. */
export async function sendEmail({ to, subject, html, text, images = [], config = {}, logger }) {
  const apiKey = config.api_key || process.env.PB_RESEND_API_KEY;
  const from = config.from || process.env.PB_RESEND_FROM;
  if (!apiKey) throw new Error("缺少 PB_RESEND_API_KEY");
  if (!from) throw new Error("缺少 PB_RESEND_FROM");

  const recipients = (Array.isArray(to) ? to : String(to || "").split(/[,;，；\s]+/)).filter(Boolean);
  if (!recipients.length) throw new Error("缺少收件人邮箱");

  const attachments = [];
  let finalHtml = html;
  for (const [i, image] of images.entries()) {
    if (!fs.existsSync(image)) continue;
    const cid = `article-image-${i + 1}`;
    const content = fs.readFileSync(image).toString("base64");
    attachments.push({
      filename: path.basename(image),
      content,
      content_id: cid,
      content_type: mimeFor(image),
    });
    const relative = image.replace(/\\/g, "/");
    finalHtml = finalHtml.split(relative).join(`cid:${cid}`);
  }

  const body = {
    from: from.includes("<") ? from : `公众号助手 <${from}>`,
    to: recipients,
    subject,
    html: finalHtml,
    ...(text ? { text } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  const retries = Number(config.retries ?? 2);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
      logger?.info(`邮件已发送：${data.id || "ok"} → ${recipients.join(", ")}`);
      return { success: true, id: data.id, to: recipients };
    } catch (error) {
      lastError = error;
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
 * Publish a markdown file to the WeChat draft box via @wenyan-md/cli.
 * The CLI handles uploading local images and cover.
 */
export async function publishToWechat({ markdownFile, config = {}, logger, envFile }) {
  const { spawn } = await import("node:child_process");
  const dryRun = config.dry_run === true;
  const command = config.command || "npx --yes @wenyan-md/cli";
  const [bin, ...baseArgs] = splitCommand(command);
  const args = [...baseArgs, "publish", "-f", markdownFile];
  if (config.theme) args.push("--theme", config.theme);
  if (config.highlight) args.push("--highlight", config.highlight);
  if (config.app_id) args.push("--app-id", config.app_id);
  if (config.server) args.push("--server", config.server);
  if (config.api_key) args.push("--api-key", config.api_key);
  const file = envFile || config.env_file || ".env";
  if (file && fs.existsSync(path.resolve(file))) args.push("--env-file", path.resolve(file));

  if (dryRun) {
    logger?.info(`[dry-run] ${bin} ${args.join(" ")}`);
    return { success: true, dryRun: true, command: `${bin} ${args.join(" ")}` };
  }

  const result = await new Promise((resolve) => {
    const child = spawn(bin, args, {
      shell: process.platform === "win32",
      windowsHide: true,
      env: { ...process.env },
    });
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

  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    logger?.warn(`公众号发布失败（exit ${result.code}）：${output.slice(-600)}`);
    return { success: false, code: result.code, output };
  }
  logger?.info(`公众号草稿发布完成：${output.slice(-300)}`);
  return { success: true, output };
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
