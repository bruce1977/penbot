import path from "node:path";
import fs from "node:fs";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9'’._-]*/g;

/** Split YAML-ish frontmatter from the body. */
export function splitFrontmatter(markdown) {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text.trim() };
  return { data: parseSimpleYaml(match[1]), body: text.slice(match[0].length).trim() };
}

/** Parse the small YAML subset used by article frontmatter. */
export function parseSimpleYaml(yamlText) {
  const data = {};
  const lines = String(yamlText || "").split(/\r?\n/);
  let currentKey = null;
  let currentList = null;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const listItem = raw.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(unquote(listItem[1].trim()));
      currentList = data[currentKey];
      continue;
    }
    const pair = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    currentKey = pair[1];
    const value = pair[2].trim();
    if (value === "") {
      data[currentKey] = [];
      currentList = data[currentKey];
    } else {
      data[currentKey] = unquote(value);
      currentList = null;
    }
  }
  return data;
}

function unquote(value) {
  const text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return text;
}

function yamlValue(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ").trim();
  if (/^[A-Za-z0-9\u3400-\u9fff][^:#\n"']*$/.test(text) && !/^[-?]/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Serialize frontmatter, preserving known fields in a stable order. */
export function buildFrontmatter(data = {}) {
  const order = ["title", "author", "type", "date", "cover", "digest", "source_url", "keywords"];
  const keys = [...order.filter((k) => data[k] !== undefined && data[k] !== ""), ...Object.keys(data).filter((k) => !order.includes(k) && data[k] !== undefined && data[k] !== "")];
  const lines = ["---"];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlValue(item)}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Ensure the article has frontmatter and a title. */
export function normalizeArticle(markdown, { title, author, type, cover } = {}) {
  const { data, body } = splitFrontmatter(stripCodeFence(markdown));
  const next = { ...data };
  if (title) next.title = title;
  if (!next.title) next.title = firstHeading(body) || "未命名文章";
  if (author && !next.author) next.author = author;
  if (type) next.type = type;
  if (cover) next.cover = cover;
  delete next.image_list;
  return `${buildFrontmatter(next)}${body.trim()}\n`;
}

export function stripCodeFence(markdown) {
  let text = String(markdown || "").trim();
  const fence = text.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  if (fence) text = fence[1].trim();
  return text;
}

export function firstHeading(markdown) {
  const match = String(markdown || "").match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

export function getTitle(markdown, fallback = "未命名文章") {
  const { data } = splitFrontmatter(markdown);
  return data.title || firstHeading(markdown) || fallback;
}

export function countWords(text) {
  const { body } = splitFrontmatter(text);
  const clean = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`~|-]/g, " ");
  const cjk = (clean.match(CJK) || []).length;
  const latin = (clean.match(LATIN_WORD) || []).length;
  return cjk + latin;
}

const IMAGE_MARKER = /\[\[\s*img\s*[:：]\s*(\d+)\s*(?:\|\s*([\s\S]*?))?\]\]|\[图\s*(\d+)\s*[:：]\s*([^\]]*)\]/gi;

/**
 * Canonical image marker:
 *   [[img:1|图片说明|optional prompt]]
 * Legacy marker also supported:
 *   [图1：图片说明]
 */
export function parseImageMarkers(markdown) {
  const markers = [];
  const text = String(markdown || "");
  let match;
  IMAGE_MARKER.lastIndex = 0;
  while ((match = IMAGE_MARKER.exec(text))) {
    const index = Number(match[1] || match[3]);
    const payload = (match[2] || match[4] || "").trim();
    const [description, prompt] = splitMarkerPayload(payload);
    markers.push({
      index,
      description: description || `配图 ${index}`,
      prompt: prompt || "",
      marker: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return markers;
}

function splitMarkerPayload(payload) {
  const text = String(payload || "").trim();
  const pipe = text.indexOf("|");
  if (pipe === -1) return [text, ""];
  return [text.slice(0, pipe).trim(), text.slice(pipe + 1).trim()];
}

/** Replace every marker with an image or a failure placeholder. */
export function replaceImageMarkers(markdown, replacements, { onFailure = "comment" } = {}) {
  const text = String(markdown || "");
  return text.replace(IMAGE_MARKER, (whole, a, b, c, d) => {
    const index = Number(a || c);
    const payload = (b || d || "").trim();
    const [description] = splitMarkerPayload(payload);
    const replacement = replacements.get(index);
    if (replacement) {
      const alt = description || `配图 ${index}`;
      return `![${alt}](${replacement})`;
    }
    if (onFailure === "keep") return whole;
    if (onFailure === "drop") return "";
    return `<!-- 配图生成失败：${description || `配图 ${index}`} -->`;
  });
}

/** Insert missing markers near paragraph boundaries when the model ignored them. */
export function ensureImageMarkers(markdown, count) {
  const markers = parseImageMarkers(markdown);
  if (markers.length >= count) return markdown;
  const { data, body } = splitFrontmatter(markdown);
  const paragraphs = body.split(/\r?\n\s*\r?\n/);
  const insertions = [];
  const missing = count - markers.length;
  const step = Math.max(1, Math.floor(paragraphs.length / (missing + 1)));
  for (let i = 1; i <= missing; i += 1) {
    insertions.push({ at: Math.min(paragraphs.length, step * i), index: markers.length + i });
  }
  insertions.sort((x, y) => y.at - x.at);
  for (const item of insertions) {
    paragraphs.splice(item.at, 0, `[[img:${item.index}|配图 ${item.index}]]`);
  }
  return `${buildFrontmatter(data)}${paragraphs.join("\n\n")}\n`;
}

/** Normalize relative image paths for a markdown file in dir. */
export function imagePathForMarkdown(fileDir, imageFile) {
  return path.relative(fileDir, imageFile).split(path.sep).join("/");
}

/** Local markdown image sources in document order. */
export function collectLocalImages(markdown, fileDir) {
  const out = [];
  const regex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = regex.exec(markdown))) {
    const src = match[2];
    if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) continue;
    const resolved = path.resolve(fileDir, decodeURI(src));
    if (fs.existsSync(resolved)) out.push({ alt: match[1], src, file: resolved });
  }
  return out;
}

export { IMAGE_MARKER };
