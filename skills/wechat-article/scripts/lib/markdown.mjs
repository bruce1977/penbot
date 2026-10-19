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
 * Decide whether a draft is too short, too long or fine for the given range.
 * Returns "expand" | "condense" | null.
 */
export function lengthAction(wordCount, { min, max } = {}) {
  if (Number.isFinite(min) && wordCount < min) return "expand";
  if (Number.isFinite(max) && wordCount > max) return "condense";
  return null;
}

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

/**
 * Reconcile markers the model produced with the planned count:
 * drop duplicate indices, cap at `count`, renumber sequentially
 * (1..N in document order), then pad when there are too few.
 */
export function normalizeImageMarkers(markdown, count) {
  const text = String(markdown || "");
  const markers = parseImageMarkers(text);
  if (markers.length === 0) return ensureImageMarkers(text, count);

  const limit = Number.isFinite(count) && count > 0 ? count : Infinity;
  const keep = new Map();
  const seen = new Set();
  let next = 1;
  for (const marker of markers) {
    if (seen.has(marker.index)) continue;
    if (next > limit) break;
    seen.add(marker.index);
    keep.set(marker.start, { index: next, description: marker.description, prompt: marker.prompt });
    next += 1;
  }
  if (keep.size === 0) return ensureImageMarkers(text, count);

  let out = "";
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start < cursor) continue;
    out += text.slice(cursor, marker.start);
    const kept = keep.get(marker.start);
    if (kept) {
      const payload = kept.prompt ? `${kept.description}|${kept.prompt}` : kept.description;
      out += `[[img:${kept.index}|${payload}]]`;
    }
    cursor = marker.end;
  }
  out += text.slice(cursor);

  return keep.size < limit ? ensureImageMarkers(out, count) : out;
}

/**
 * Parse a user-written outline (Markdown) into the outline object used by the
 * pipeline. Accepts both the format rendered by this pipeline and a minimal
 * "# title" + "## section" + "- point" form.
 * Returns null when no section can be found.
 */
export function parseOutlineMarkdown(text, { title = "", targetWords = 0 } = {}) {
  const result = {
    title: String(title || "").trim(),
    thesis: "",
    audience: "",
    hook: "",
    outline: [],
    counterpoint: "",
    takeaway: "",
    image_plan: [],
  };
  let mode = "sections";
  let current = null;
  let lastImage = null;

  const clean = (value) => String(value || "").replace(/^\*+|\*+$/g, "").trim();
  const stripBullet = (value) => String(value || "").replace(/^[-*]\s*/, "").trim();
  const appendText = (field, value) => {
    const next = clean(value);
    if (!next) return;
    result[field] = result[field] ? `${result[field]}\n${next}` : next;
  };
  const startSection = (heading, words = 0) => {
    current = { heading: clean(heading), points: [], source_indexes: [], target_words: Number(words) || 0 };
    result.outline.push(current);
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const h2 = line.match(/^#{2,}\s+(.+)$/);
    if (h2) {
      const name = h2[1].replace(/[（(]\s*约?\s*\d+\s*字\s*[)）]\s*$/, "").trim();
      if (/^(结构|大纲|正文结构)$/.test(name)) {
        mode = "structure";
        current = null;
      } else if (/^反方观点$/.test(name)) {
        mode = "counter";
      } else if (/^(结论|结尾|总结|收尾)$/.test(name)) {
        mode = "takeaway";
      } else if (/^配图$/.test(name)) {
        mode = "images";
        lastImage = null;
      } else if (/^(备选标题|相关素材|读者|受众)$/.test(name)) {
        mode = "meta";
      } else {
        startSection(name);
        mode = "sections";
      }
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      if (!result.title) result.title = h1[1].trim();
      continue;
    }

    if (line.startsWith(">")) {
      if (!result.thesis) result.thesis = stripBullet(line.replace(/^>\s?/, ""));
      continue;
    }

    const meta = line.match(/^[-*]\s*(读者|受众|开篇钩子|核心判断|主题)[：:]\s*(.*)$/);
    if (meta) {
      const [, key, value] = meta;
      if (key === "读者" || key === "受众") result.audience = value.trim();
      else if (key === "开篇钩子") result.hook = value.trim();
      else if (key === "主题" && !result.title) result.title = value.trim();
      else result.thesis = value.trim();
      continue;
    }

    if (mode === "images") {
      if (/^[-*]\s*prompt\s*[:：]/i.test(line)) {
        if (lastImage) lastImage.prompt = line.replace(/^[-*]\s*prompt\s*[:：]\s*/i, "").trim();
        continue;
      }
      const img = line.match(/^[-*]\s*(?:([^：:]+)[：:])?\s*(.+)$/);
      if (!img) continue;
      const position = (img[1] || "").trim();
      const rest = img[2].trim();
      const [description, prompt] = rest.split("|");
      lastImage = {
        position: position || `inline_${result.image_plan.length + 1}`,
        description: (description || "").trim(),
        prompt: (prompt || "").trim(),
      };
      result.image_plan.push(lastImage);
      continue;
    }

    if (mode === "counter") {
      appendText("counterpoint", stripBullet(line));
      continue;
    }
    if (mode === "takeaway") {
      appendText("takeaway", stripBullet(line));
      continue;
    }
    if (mode === "meta") continue;

    const cjkHeading = line.match(/^([一二三四五六七八九十]+)[、.．]\s*(.+)$/);
    if (cjkHeading && mode === "sections") {
      startSection(cjkHeading[2]);
      continue;
    }

    const numbered = line.match(/^\d+[.、)]\s*(.+)$/);
    if (numbered && !current) {
      const withWords = numbered[1].match(/^\*{0,2}(.+?)\*{0,2}\s*[（(]\s*约?\s*(\d+)\s*字\s*[)）]\s*$/);
      startSection(withWords ? withWords[1] : numbered[1], withWords ? withWords[2] : 0);
      continue;
    }
    if (numbered && mode === "structure") {
      const withWords = numbered[1].match(/^\*{0,2}(.+?)\*{0,2}\s*[（(]\s*约?\s*(\d+)\s*字\s*[)）]\s*$/);
      startSection(withWords ? withWords[1] : numbered[1], withWords ? withWords[2] : 0);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!current) startSection(bullet[1]);
      else current.points.push(clean(bullet[1]));
      continue;
    }

    if (current) current.points.push(clean(line));
    else startSection(line);
  }

  if (result.outline.length === 0) return null;

  const total = Number(targetWords) || 0;
  if (total > 0) {
    const base = Math.floor(total / result.outline.length);
    const last = result.outline.length - 1;
    result.outline.forEach((section, i) => {
      if (!section.target_words) section.target_words = i === last ? total - base * last : base;
    });
  }
  return result;
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
