import fs from "node:fs";
import path from "node:path";
import { needConfig, needNumber } from "./env.mjs";
import { walkFiles, readText, readJson, writeJson, writeText, ensureDir, slugify } from "./fsx.mjs";
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
  const cache = cacheFile ? readJson(cacheFile, { version: 0, notes: {} }) : { version: 0, notes: {} };
  // v2：note 增加 source（frontmatter 出处）；旧缓存整体作废重建一次。
  if (cache.version !== 2) cache.notes = {};
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
        source: String(data.source || "").trim(),
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
      writeJson(cacheFile, { version: 2, updatedAt: new Date().toISOString(), notes: nextCache });
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

/** Days between the note's content date (file date) and now. */
export function daysAgo(note, now = Date.now()) {
  const stamp = Date.parse(note.date);
  return Math.max(0, Math.floor((now - (Number.isFinite(stamp) ? stamp : note.mtime)) / 86400000));
}

/** Collect date (mtime) freshness: documents ingested within the fresh window. */
export function isFreshlyCollected(note, { days = 7, now = Date.now() } = {}) {
  return note.mtime >= now - days * 86400000;
}

const TERM_NOISE = new Set([
  "http", "https", "www", "com", "cn", "org", "net", "img", "src", "alt", "png", "jpg", "jpeg",
  "gif", "webp", "mp", "qq", "qpic", "mmbiz", "appmsg", "data", "id", "wx", "idc", "cdn",
]);

/** Strip link/URL/HTML noise so the heatmap ranks content words, not scraper artifacts. */
function cleanTermText(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\w-]+\.(com|cn|net|org|html?|png|jpe?g|gif|webp)\b/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Deterministic term heatmap over a candidate pool: term x docs x latest date x
 * freshly-collected count. Replaces per-note LLM tags as the grouping signal —
 * tags are noisy, cross-document term frequency is not.
 */
export function termHeatmap(notes, { top = 15, freshDays = 7, bodyChars = 2000, now = Date.now() } = {}) {
  const stats = new Map();
  for (const note of notes) {
    const text = cleanTermText(`${note.title}\n${note.tags.join(" ")}\n${note.summary}\n${String(note.body || "").slice(0, bodyChars)}`);
    const stamp = Number.isFinite(Date.parse(note.date)) ? Date.parse(note.date) : note.mtime;
    const fresh = isFreshlyCollected(note, { days: freshDays, now });
    for (const term of new Set(buildTerms(text))) {
      if (TERM_NOISE.has(term)) continue;
      let item = stats.get(term);
      if (!item) {
        item = { term, docs: 0, latest: 0, fresh: 0 };
        stats.set(term, item);
      }
      item.docs += 1;
      item.latest = Math.max(item.latest, stamp);
      if (fresh) item.fresh += 1;
    }
  }
  const rows = [...stats.values()]
    .filter((item) => item.docs >= 2)
    .sort((a, b) => b.docs - a.docs || b.latest - a.latest)
    .slice(0, top)
    .map((item) => ({
      term: item.term,
      docs: item.docs,
      latest_date: new Date(item.latest).toISOString().slice(0, 10),
      days_ago: Math.max(0, Math.floor((now - item.latest) / 86400000)),
      fresh: item.fresh,
    }));
  const all = rows.map((r) => r.term);
  return rows.filter((r) => !all.some((other) => other !== r.term && other.includes(r.term)));
}

/** Render the heatmap as prompt lines; model consumes numbers, never guesses. */
export function formatHeatmap(rows) {
  if (!rows.length) return "（无明显热词）";
  return rows
    .map((r) => `${r.term}｜${r.docs} 篇｜最近 ${r.latest_date}（${r.days_ago} 天前）｜近 7 天新采集 ${r.fresh} 篇`)
    .join("\n");
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
    // 出处优先取资料 frontmatter 的 source（原始剪存来源），没有才回退本地路径。
    source: note.source || note.file,
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
 * 每个 kb 的真实请求经 recorder 落 <step>/api/（只记请求体与响应原文，鉴权 header 不写）。
 */
export async function searchWeKnora(type, query, { logger, limit, recorder, slot } = {}) {
  const cfg = type.knowledge?.weknora || {};
  const base = String(cfg.base_url || "").replace(/\/+$/, "");
  const kbIds = (cfg.kb_ids || []).filter(Boolean);
  if (!base || kbIds.length === 0) return [];

  const headers = { "Content-Type": "application/json", "X-Request-ID": String(Date.now()) };
  // auth_header / timeout_ms 单源 defaults.yaml defaults.knowledge.weknora（原来这两处
  // 各有一份和配置同值的副本，改配置不生效）。只有真会发请求才要求配全：
  // 没配 base_url / kb_ids 上面已经直接跳过本通道。
  if (cfg.api_key) headers[needConfig(cfg.auth_header, "defaults.yaml defaults.knowledge.weknora.auth_header")] = cfg.api_key;
  const timeoutMs = needNumber(cfg.timeout_ms, "defaults.yaml defaults.knowledge.weknora.timeout_ms");

  // match_count 单源 defaults.yaml knowledge.weknora.match_count（没写就用本步的总条数上限）；
  // 这里不再留 defaults 的同值兜底，否则改配置不生效。
  const matchCount = Math.max(3, Math.min(Number(cfg.match_count) || limit, 20));
  const groups = new Map();

  for (const kbId of kbIds) {
    const body = { query_text: query, match_count: matchCount };
    if (cfg.vector_threshold) body.vector_threshold = Number(cfg.vector_threshold);
    if (cfg.keyword_threshold) body.keyword_threshold = Number(cfg.keyword_threshold);
    const label = cfg.kb_names?.[kbId] || kbId;
    const startedAt = Date.now();
    const record = (extra) => {
      if (!recorder) return;
      recorder.record({
        label: "knowledge_search",
        slot,
        provider: "weknora",
        request: { ...body, kb_id: kbId },
        duration_ms: Date.now() - startedAt,
        ...extra,
      });
    };
    try {
      const res = await fetch(`${base}/knowledge-bases/${encodeURIComponent(kbId)}/hybrid-search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text().catch(() => "");
      record({ response: raw, error: res.ok ? undefined : `HTTP ${res.status}` });
      if (!res.ok) {
        logger?.warn(`WeKnora 检索失败（${label}）：HTTP ${res.status} ${raw.slice(0, 120)}`);
        continue;
      }
      const data = JSON.parse(raw);
      for (const item of data.data || []) addWeKnoraHit(groups, item, kbId, cfg, excerptCharsOf(type));
      logger?.info(`WeKnora 检索（${label}）：命中 ${(data.data || []).length} 个片段`);
    } catch (error) {
      record({ error: error.message });
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
  // 单源 defaults.yaml defaults.knowledge.excerpt_chars；缺了抛错点名配置路径，
  // 不兜一个和配置同值的数（normalizeType 只把写出来的值归成数字，不再铺默认值）。
  return needNumber(type.knowledge?.excerpt_chars, "defaults.yaml defaults.knowledge.excerpt_chars");
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
  // 条数上限单源 defaults.yaml knowledge.max_sources（.env PB_KNOWLEDGE_MAX_SOURCES 抬起）；
  // 不留同值兜底，改了配置就得真的生效——缺了宁可抛错点名配置路径，也不要 NaN 条数
  // 让 slice(0, NaN) 静默交出空素材。
  const limit = needNumber(type.knowledge?.max_sources, "defaults.yaml defaults.knowledge.max_sources（可用 .env PB_KNOWLEDGE_MAX_SOURCES 抬起）");
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
          excerptChars: excerptCharsOf(type),
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

const TITLE_NOISE = /[\s\u3000/\\\-_－—()（）\[\]【】{}「」『』"'‘’“”!！?？.。:：;；、,，]+/g;

function normTitle(text) {
  return String(text || "").toLowerCase().replace(TITLE_NOISE, "");
}

/**
 * 素材充分性闸门（纯代码，不调模型）：任一确定性信号不达标即判不足。
 * 四个信号：命中条数、摘录总字数、source_hints 覆盖率、时效（90 天内有命中）。
 * 返回 { ok, reasons[], signals }，reasons 直接进日志说明为什么走外部检索。
 */
export function assessSourceSufficiency(sources, { topic, maxSources = 8, gate = {}, now = Date.now(), baseDir = "" } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const reasons = [];
  const signals = {};

  const minHits = gate.min_hits ?? Math.ceil(maxSources * (Number(gate.min_hits_ratio) || 0.5));
  signals.hits = list.length;
  if (signals.hits < minHits) reasons.push(`命中 ${signals.hits} 篇 < ${minHits}`);

  const chars = list.reduce(
    (n, s) => n + sourceExcerpts(s, { baseDir }).reduce((m, e) => m + String(e).length, 0),
    0,
  );
  signals.excerpt_chars = chars;
  // gate 允许只写个别阈值（本函数的 API 约定，缺的判据退回这里的默认），
  // 所以这四个阈值保留兜底；defaults.yaml 的 web-search.gate 才是实配置单源。
  const minChars = Number(gate.min_excerpt_chars) || 3000;
  if (chars < minChars) reasons.push(`摘录 ${chars} 字 < ${minChars}`);

  const hints = (topic?.source_hints || []).map(normTitle).filter(Boolean);
  signals.hint_coverage = 1;
  if (hints.length) {
    const titles = list.map((s) => normTitle(s.title));
    const covered = hints.filter((h) => titles.some((t) => t && (t.includes(h) || h.includes(t)))).length;
    signals.hint_coverage = covered / hints.length;
    const minCoverage = Number(gate.min_hint_coverage) || 0.5;
    if (signals.hint_coverage < minCoverage) {
      reasons.push(`source_hints 覆盖 ${covered}/${hints.length} < ${minCoverage}`);
    }
  }

  const freshDays = Number(gate.fresh_days) || 90;
  signals.fresh_hits = list.filter((s) => {
    // 链接条目没有 date 字段，从落地 MD 的 frontmatter 回读。
    const stamp = Date.parse(s.date || loadSource(s, { baseDir }).date);
    return Number.isFinite(stamp) && now - stamp <= freshDays * 86400000;
  }).length;
  if (signals.fresh_hits === 0) reasons.push(`${freshDays} 天内无命中`);

  return { ok: reasons.length === 0, reasons, signals };
}

/**
 * 素材落地：每条素材写 01-step/sources/<index>-<slug>.md（frontmatter 记录
 * 来源可追溯，正文只放摘录段——版权考虑，不整篇复制）。`01-result.json#sources`
 * 只留 {index, title, link}（link 为相对文章目录的路径，/ 分隔），其余信息都在
 * MD 里，回读统一走 loadSource（相对 link 需传 baseDir=文章目录）。
 * 重复运行同 index+标题覆盖同一文件。
 */
export function landSources(articleDir, sources) {
  const dir = ensureDir(path.join(articleDir, "01-step", "sources"));
  // parseSimpleYaml 只剥外层引号，不做转义还原：值原样写，首字符是引号才整体加引号。
  const scalar = (value) => {
    const text = String(value ?? "");
    return /^['"]/.test(text.trim()) ? JSON.stringify(text) : text;
  };
  return (Array.isArray(sources) ? sources : []).map((source, i) => {
    // 续跑复用的链接条目（{index,title,link}）原样保留：正文已在落地 MD 里，
    // 重写会把空正文覆盖回文件。
    if (typeof source?.link === "string" && source.link && !source.excerpts) {
      return { index: source.index || i + 1, title: source.title || "", link: source.link };
    }
    const index = source.index || i + 1;
    const excerpts = sourceExcerpts(source);
    const file = path.join(dir, `${index}-${slugify(source.title, "source")}.md`);
    writeText(file, [
      "---",
      `title: ${scalar(source.title || "")}`,
      `origin: ${source.origin || "local"}`,
      `source: ${scalar(source.source || source.file || "")}`,
      `date: ${scalar(source.date || "")}`,
      `score: ${source.score ?? 0}`,
      "---",
      "",
      // 空行分隔：loadSource 按空行切段回读，段落必须一一对应。
      ...excerpts.flatMap((excerpt) => [String(excerpt).trim(), ""]),
    ].join("\n"));
    return {
      index,
      title: source.title || "",
      // 相对文章目录、统一 / 分隔：文章目录本身固定，result.json 只留变化部分。
      link: path.relative(articleDir, file).split(path.sep).join("/"),
    };
  });
}

/**
 * 素材字段统一读取：内嵌字段优先（运行中的完整条目 / 旧格式 / --sources-file），
 * 缺失的（origin/source/date/score/excerpts）从 link 指向的落地 MD 回读。
 * link 是相对文章目录的相对路径时（现格式），用 baseDir 解析。
 */
export function loadSource(source, { baseDir = "" } = {}) {
  const meta = {
    title: source?.title || "",
    origin: source?.origin || "",
    // 落地前的条目没有 source 字段，file（知识库路径/URL）即出处；链接条目交给落地 MD 回读。
    source: source?.source || (source?.link ? "" : source?.file) || "",
    date: source?.date || "",
    score: source?.score ?? 0,
    excerpts: Array.isArray(source?.excerpts) && source.excerpts.length ? source.excerpts : [],
  };
  if (meta.excerpts.length) return meta;
  let file = source?.link || source?.file;
  if (typeof file === "string" && file && baseDir && !path.isAbsolute(file) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file)) {
    file = path.resolve(baseDir, file);
  }
  if (typeof file !== "string" || !file || !fs.existsSync(file)) return meta;
  try {
    const { data, body } = splitFrontmatter(readText(file));
    return {
      title: meta.title || String(data.title || "").trim(),
      origin: meta.origin || String(data.origin || "").trim(),
      source: meta.source || String(data.source || "").trim(),
      date: meta.date || String(data.date || "").trim(),
      score: meta.score || Number(data.score) || 0,
      excerpts: String(body)
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    };
  } catch {
    return meta;
  }
}

/** 素材正文：loadSource 的 excerpts 投影。 */
export function sourceExcerpts(source, options = {}) {
  return loadSource(source, options).excerpts;
}

/** Build compact source blocks for prompts (bounded by characters). */
export function formatSources(sources, { maxChars = 24000, baseDir = "" } = {}) {
  const parts = [];
  let used = 0;
  for (const source of sources) {
    const meta = loadSource(source, { baseDir });
    const block = [
      `### 素材 ${source.index}：${meta.title}`,
      `- 文件：${meta.source || source.link || source.file}`,
      `- 日期：${meta.date}`,
      source.tags?.length ? `- 标签：${source.tags.join("、")}` : "",
      source.summary ? `- 摘要：${source.summary}` : "",
      "",
      ...meta.excerpts.map((excerpt) => `> ${String(excerpt).replace(/\n/g, "\n> ")}`),
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

/**
 * 选题提案校验（防幻觉 + 防重复）：
 *   - source_hints 必须能对上给定候选标题，对不上的降到末位兜底；
 *   - 与已写文章标题词面重合 ≥0.6 的打 duplicate_of 标记并剔除（除非全部撞车）。
 * 查重在这里（写作模型侧）做完，判断模型择题时看到的选项天然不含重复。
 */
export function validateProposals(topics, candidates, written = [], logger = null) {
  const titleOf = (hint) => String(hint || "").replace(/[《》]/g, "").trim();
  const match = (hint) =>
    candidates.find((c) => {
      const t = titleOf(c.title);
      const h = titleOf(hint);
      return h && (t.includes(h) || h.includes(t.slice(0, 18)));
    });
  const writtenSets = written
    .filter((w) => w.title)
    .map((w) => ({ title: w.title, terms: new Set(buildTerms(w.title)) }))
    .filter((w) => w.terms.size);
  const valid = [];
  const demoted = [];
  const duplicates = [];
  for (const topic of topics) {
    const before = topic.source_hints.map(titleOf).filter(Boolean);
    topic.source_hints = [...new Set(topic.source_hints.map((hint) => match(hint)?.title).filter(Boolean))];
    if (!topic.source_hints.length) {
      logger?.warn(`选题《${topic.topic || topic.title}》的 ${before.length} 条 source_hints 全部匹配不上候选标题，降级为备选`);
      demoted.push(topic);
      continue;
    }
    if (topic.source_hints.length < before.length) {
      logger?.warn(`选题《${topic.topic || topic.title}》source_hints 匹配收缩 ${before.length}→${topic.source_hints.length}（模型给了候选列表外的素材名）`);
    }
    const terms = new Set(buildTerms(`${topic.title} ${topic.topic}`));
    for (const w of writtenSets) {
      let hit = 0;
      for (const t of w.terms) if (terms.has(t)) hit += 1;
      if (hit / w.terms.size >= 0.6) topic.duplicate_of = w.title;
    }
    if (topic.duplicate_of) duplicates.push(topic);
    else valid.push(topic);
  }
  if (valid.length) return [...valid, ...demoted];
  return [...duplicates, ...demoted];
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
