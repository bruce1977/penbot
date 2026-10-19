import fs from "node:fs";
import path from "node:path";
import { walkFiles, readText, readJson, writeJson, ensureDir } from "./fsx.mjs";
import { splitFrontmatter } from "./markdown.mjs";

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "及", "或", "对", "从", "到", "把", "被", "让", "给", "为", "以", "于",
  "一个", "一种", "一些", "这个", "那个", "我们", "你们", "他们", "自己", "什么", "如何", "怎么", "为什么",
  "可以", "需要", "应该", "已经", "正在", "还是", "但是", "而且", "因为", "所以", "如果", "虽然",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
]);

/**
 * Build a lightweight in-memory index over one or more markdown knowledge dirs.
 * A mtime/size keyed cache keeps repeated runs fast; stale entries are rebuilt.
 */
export function indexKnowledge(type, { logger, maxFileBytes = 400000, cacheDir = null } = {}) {
  const cacheFile = cacheDir ? path.join(cacheDir, "knowledge-index.json") : null;
  const cache = cacheFile ? readJson(cacheFile, { version: 1, notes: {} }) : { version: 1, notes: {} };
  const cacheNotes = cache.notes || {};
  const nextCache = {};
  const notes = [];
  const seen = new Set();
  let reused = 0;
  let parsed = 0;

  for (const dir of type.knowledge_dirs || []) {
    const files = walkFiles(dir, (file) => /\.(md|markdown|txt)$/i.test(file));
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;
      const key = `${stat.mtimeMs}:${stat.size}`;
      const cached = cacheNotes[file];
      if (cached && cached.key === key) {
        nextCache[file] = cached;
        notes.push(cached.note);
        reused += 1;
        continue;
      }
      let text;
      try {
        text = readText(file);
      } catch {
        continue;
      }
      const { data, body } = splitFrontmatter(text);
      const title = data.title || firstLine(body) || path.basename(file, path.extname(file));
      const date = normalizeDate(data.date) || stat.mtime.toISOString().slice(0, 10);
      const tags = toArray(data.tags).map(String);
      const summary = String(data.summary || data.description || "").trim();
      const haystack = `${title}\n${tags.join(" ")}\n${summary}\n${body}`.toLowerCase();
      const note = {
        file,
        title: cleanTitle(title),
        date,
        mtime: stat.mtimeMs,
        tags,
        summary,
        body,
        length: body.length,
        haystack,
      };
      nextCache[file] = { key, note };
      notes.push(note);
      parsed += 1;
    }
  }

  if (cacheFile && (parsed > 0 || reused === 0)) {
    try {
      ensureDir(path.dirname(cacheFile));
      writeJson(cacheFile, { version: 1, updatedAt: new Date().toISOString(), notes: nextCache });
    } catch (error) {
      logger?.debug(`知识库缓存写入失败：${error.message}`);
    }
  }

  logger?.info(`知识库索引完成：${notes.length} 篇（复用 ${reused}，解析 ${parsed}）`);
  return notes;
}

export function pickRecent(notes, { days = 365, limit = 40 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  return notes
    .filter((note) => {
      const stamp = Date.parse(note.date);
      return Number.isFinite(stamp) ? stamp >= cutoff : note.mtime >= cutoff;
    })
    .sort((a, b) => (Date.parse(b.date) || b.mtime) - (Date.parse(a.date) || a.mtime))
    .slice(0, limit);
}

/**
 * Score notes against a topic and return the most useful sources with excerpts.
 * Scoring is deterministic and cheap; the model is only used to write the outline.
 */
export function searchKnowledge(notes, { topic, keywords = [], limit = 8, excerptChars = 1800, maxPerFile = 2, exclude = [] } = {}) {
  const terms = buildTerms([topic, ...keywords].join(" "));
  const excludeTerms = buildTerms(exclude.join(" "));
  const scored = notes.map((note) => {
    const title = note.title.toLowerCase();
    const tagText = note.tags.join(" ").toLowerCase();
    const summary = note.summary.toLowerCase();
    let score = 0;
    const matched = [];
    for (const term of terms) {
      const weight = term.length >= 3 ? 3 : 1.5;
      let hit = 0;
      if (title.includes(term)) {
        score += 8 * weight;
        hit += 1;
      }
      if (tagText.includes(term)) {
        score += 5 * weight;
        hit += 1;
      }
      if (summary.includes(term)) {
        score += 3 * weight;
        hit += 1;
      }
      const occurrences = countOccurrences(note.haystack, term);
      if (occurrences > 0) {
        score += Math.min(occurrences, 8) * weight;
        hit += 1;
      }
      if (hit > 0) matched.push(term);
    }
    for (const term of excludeTerms) {
      if (note.haystack.includes(term)) score -= 20;
    }
    // Prefer substantive notes, but do not let length dominate.
    score += Math.min(note.length / 2000, 4);
    return { note, score, matched };
  });

  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return selected.map(({ note, score, matched }, i) => ({
    index: i + 1,
    file: note.file,
    title: note.title,
    date: note.date,
    tags: note.tags,
    summary: note.summary,
    matched,
    score: Math.round(score * 10) / 10,
    excerpts: extractExcerpts(note.body, matched, excerptChars, maxPerFile),
  }));
}

/* ------------------------------------------------------------------ */
/* WeKnora (remote knowledge base)                                     */
/* ------------------------------------------------------------------ */

/**
 * Hybrid search against one or more WeKnora knowledge bases.
 * Endpoint: POST {base_url}/knowledge-bases/{kb_id}/hybrid-search
 * Returns sources in the same shape as searchKnowledge().
 */
export async function searchWeKnora(type, query, { logger, limit } = {}) {
  const cfg = type.knowledge?.weknora || {};
  const base = String(cfg.base_url || "").replace(/\/+$/, "");
  const kbIds = (cfg.kb_ids || []).filter(Boolean);
  if (!base || kbIds.length === 0) return [];

  const headers = { "Content-Type": "application/json", "X-Request-ID": String(Date.now()) };
  if (cfg.api_key) headers[cfg.auth_header || "X-API-Key"] = cfg.api_key;

  const matchCount = Math.max(3, Math.min(Number(cfg.match_count) || limit || 8, 20));
  const groups = new Map();

  for (const kbId of kbIds) {
    const body = { query_text: query, match_count: matchCount };
    if (cfg.vector_threshold) body.vector_threshold = Number(cfg.vector_threshold);
    if (cfg.keyword_threshold) body.keyword_threshold = Number(cfg.keyword_threshold);
    const label = cfg.kb_names?.[kbId] || kbId;
    try {
      const res = await fetch(`${base}/knowledge-bases/${encodeURIComponent(kbId)}/hybrid-search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(cfg.timeout_ms) || 30000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        logger?.warn(`WeKnora 检索失败（${label}）：HTTP ${res.status} ${detail.slice(0, 120)}`);
        continue;
      }
      const data = await res.json();
      for (const item of data.data || []) addWeKnoraHit(groups, item, kbId, cfg, excerptCharsOf(type));
      logger?.info(`WeKnora 检索（${label}）：命中 ${(data.data || []).length} 个片段`);
    } catch (error) {
      logger?.warn(`WeKnora 检索异常（${label}）：${error.message}`);
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .map((group, i) => ({
      index: i + 1,
      file: group.file,
      title: group.title,
      date: group.date,
      tags: group.tags,
      summary: group.summary,
      matched: [],
      score: Math.round(group.score * 10000) / 10000,
      origin: "weknora",
      excerpts: group.excerpts.slice(0, 3),
    }));
}

function excerptCharsOf(type) {
  return Number(type.knowledge?.excerpt_chars) || 1800;
}

function addWeKnoraHit(groups, item, kbId, cfg, excerptChars) {
  const key = `${kbId}/${item.knowledge_id || item.id || item.knowledge_title}`;
  const content = cleanWeKnoraContent(item.content);
  if (!content) return;
  let group = groups.get(key);
  if (!group) {
    const meta = item.metadata || {};
    // WeKnora stores the original frontmatter as a YAML-ish string.
    const custom = parseCustomMetadata(item.knowledge_custom_metadata);
    const keywords = String(custom.keywords || "")
      .split(/[,，;；]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    group = {
      file: `weknora://${key}`,
      title: item.knowledge_title || item.title || "WeKnora 文档",
      date: normalizeDate(custom.date || meta.updated_at || meta.created_at) || "",
      tags: keywords.length ? keywords.slice(0, 8) : toArray(meta.tags).map(String),
      summary: truncateText(item.knowledge_description || meta.summary || meta.description, 320),
      score: 0,
      excerpts: [],
      seen: new Set(),
    };
    groups.set(key, group);
  }
  group.score = Math.max(group.score, Number(item.score) || 0);
  const trimmed = content.length > excerptChars ? `${content.slice(0, excerptChars)}…` : content;
  if (!group.seen.has(trimmed)) {
    group.seen.add(trimmed);
    group.excerpts.push(trimmed);
  }
}

/** Parse the flat "key: value" frontmatter string WeKnora keeps as custom metadata. */
function parseCustomMetadata(raw) {
  const out = {};
  if (!raw) return out;
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function truncateText(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Strip markdown image/link noise from WeKnora chunk content. */
function cleanWeKnoraContent(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s*\-]+$/gm, "")
    .trim();
}

/**
 * Collect sources for a topic according to knowledge.source
 * ("local" | "weknora" | "both"). Async because WeKnora is remote.
 */
export async function collectSources(type, { topic, notes = [], logger, mock = false } = {}) {
  const query = [topic?.topic, topic?.title, ...(topic?.keywords || []), ...(type.topic?.keywords || [])]
    .filter(Boolean)
    .join(" ");
  const limit = Number(type.knowledge.max_sources) || 8;
  // In mock mode, never hit the network.
  const source = mock ? "local" : type.knowledge.source;
  const exclude = type.topic?.exclude_keywords || [];

  const localLimit = source === "both" ? Math.ceil(limit / 2) : limit;
  const remoteLimit = source === "both" ? Math.max(1, limit - localLimit) : limit;

  const local =
    source === "local" || source === "both"
      ? searchKnowledge(notes, {
          topic: query,
          keywords: [],
          limit: localLimit,
          excerptChars: type.knowledge.excerpt_chars,
          exclude,
        }).map((item) => ({ ...item, origin: "local" }))
      : [];

  const remote =
    source === "weknora" || source === "both"
      ? await searchWeKnora(type, query, { logger, limit: remoteLimit })
      : [];

  // Merge: "both" interleaves local and WeKnora so each keeps its share.
  const merged = source === "both" ? interleave(local, remote, limit) : [...local, ...remote];
  const seen = new Set();
  return merged
    .filter((item) => {
      if (seen.has(item.file)) return false;
      seen.add(item.file);
      return true;
    })
    .slice(0, limit)
    .map((item, i) => ({ ...item, index: i + 1 }));
}

/** Alternate items from two lists (local / remote), capped at `limit`. */
function interleave(a, b, limit) {
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (i < a.length) out.push(a[i++]);
    if (j < b.length && out.length < limit) out.push(b[j++]);
  }
  return out;
}

/** Build compact source blocks for prompts (bounded by characters). */
export function formatSources(sources, { maxChars = 24000 } = {}) {
  const parts = [];
  let used = 0;
  for (const source of sources) {
    const block = [
      `### 素材 ${source.index}：${source.title}`,
      `- 文件：${source.file}`,
      `- 日期：${source.date}`,
      source.tags.length ? `- 标签：${source.tags.join("、")}` : "",
      source.summary ? `- 摘要：${source.summary}` : "",
      "",
      ...source.excerpts.map((excerpt) => `> ${excerpt.replace(/\n/g, "\n> ")}`),
      "",
    ]
      .filter(Boolean)
      .join("\n");
    if (used + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}

export function extractExcerpts(body, terms, budget = 1800, maxChunks = 2) {
  const paragraphs = String(body || "")
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !p.startsWith("![") && !/^#{1,6}\s/.test(p) && !/^```/.test(p));

  if (paragraphs.length === 0) return [];
  const ranked = paragraphs
    .map((paragraph, i) => {
      const lower = paragraph.toLowerCase();
      let score = 0;
      for (const term of terms) score += countOccurrences(lower, term);
      // Slight preference for early paragraphs when scores tie.
      score += Math.max(0, 3 - i * 0.1);
      return { paragraph, i, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .sort((a, b) => a.i - b.i);

  const perChunk = Math.max(200, Math.floor(budget / Math.max(1, ranked.length)));
  return ranked.map(({ paragraph }) => (paragraph.length > perChunk ? `${paragraph.slice(0, perChunk)}…` : paragraph));
}

/** Very small bilingual tokenizer: CJK bigrams plus latin words. */
export function buildTerms(text) {
  const normalized = String(text || "").toLowerCase();
  const terms = new Set();
  for (const word of normalized.match(/[a-z][a-z0-9.+#-]{1,}/g) || []) {
    if (!STOPWORDS.has(word) && word.length >= 2) terms.add(word);
  }
  const cjkRuns = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 4 && !STOPWORDS.has(run)) terms.add(run);
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) terms.add(bigram);
    }
  }
  return [...terms].slice(0, 60);
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) !== -1) {
    count += 1;
    index += term.length;
    if (count >= 20) break;
  }
  return count;
}

function firstLine(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("![")) || "";
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/^["'#\s]+|["'\s]+$/g, "")
    .trim()
    .slice(0, 120);
}

function normalizeDate(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!match) return "";
  const [, y, m, d] = match;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value)
    .replace(/^\[|\]$/g, "")
    .split(/[,，、;；]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
