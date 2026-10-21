// 素材收集阶段测试：本地知识库索引/检索、WeKnora 远端来源
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  indexKnowledge,
  pickRecent,
  searchKnowledge,
  searchWeKnora,
  collectSources,
  buildTerms,
  extractExcerpts,
  assessSourceSufficiency,
  formatSources,
  landSources,
  loadSource,
  sourceExcerpts,
} from "../scripts/lib/knowledge.mjs";
import { parseSearchMarkdown, buildSearchQueries, gatherWebSearch } from "../scripts/lib/web-search.mjs";
import { tempDir } from "./helpers.mjs";

/* ------------------------------------------------------------------ */
/* knowledge                                                           */
/* ------------------------------------------------------------------ */

test("buildTerms produces CJK bigrams and latin words without stopwords", () => {
  const terms = buildTerms("大模型 Agent 的推理成本");
  assert.ok(terms.includes("agent"));
  assert.ok(terms.includes("模型"));
  assert.ok(terms.includes("推理"));
  assert.ok(!terms.includes("的"));
});

test("indexKnowledge, pickRecent and searchKnowledge rank by relevance", () => {
  const dir = tempDir("wa-kb-");
  fs.writeFileSync(
    path.join(dir, "agent.md"),
    "---\ntitle: Agent 稳定性\ndate: 2026-09-01\ntags: [Agent, 稳定性]\n---\n\nAgent 的不稳定来自工具调用与上下文管理。\n",
  );
  fs.writeFileSync(path.join(dir, "cooking.md"), "---\ntitle: 红烧肉做法\ndate: 2020-01-01\n---\n\n今天来做一道红烧肉。\n");

  const type = { knowledge_dirs: [dir] };
  const notes = indexKnowledge(type, { logger: null });
  assert.equal(notes.length, 2);

  const recent = pickRecent(notes, { days: 365, limit: 10 });
  assert.equal(recent[0].title, "Agent 稳定性");

  const hits = searchKnowledge(notes, { topic: "Agent 稳定性", limit: 5 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].title, /Agent/);
  assert.ok(hits[0].score > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("searchKnowledge takes the source from frontmatter when present", () => {
  const dir = tempDir("wa-src-");
  fs.writeFileSync(
    path.join(dir, "with-source.md"),
    "---\ntitle: 带来源的文章\ndate: 2026-09-01\nsource: 机器之心_带来源的文章.md\n---\n\nAgent 稳定性来自工具调用与上下文管理，这里补足长度以通过过滤。\n",
  );
  fs.writeFileSync(
    path.join(dir, "no-source.md"),
    "---\ntitle: 没有来源的文章\ndate: 2026-09-02\n---\n\nAgent 稳定性来自工具调用与上下文管理，这里补足长度以通过过滤。\n",
  );
  const notes = indexKnowledge({ knowledge_dirs: [dir] }, { logger: null });
  const hits = searchKnowledge(notes, { topic: "Agent 稳定性", limit: 5 });
  const withSource = hits.find((h) => h.title === "带来源的文章");
  const noSource = hits.find((h) => h.title === "没有来源的文章");
  assert.equal(withSource.source, "机器之心_带来源的文章.md");
  assert.equal(withSource.file, path.join(dir, "with-source.md"));
  // 没有 source 字段才回退本地文件路径。
  assert.equal(noSource.source, path.join(dir, "no-source.md"));

  const landDir = tempDir("wa-land-src-");
  const [slim] = landSources(landDir, [withSource]);
  assert.deepEqual(Object.keys(slim).sort(), ["index", "link", "title"]);
  // 相对 link + baseDir 也能回读出处
  assert.equal(loadSource(slim, { baseDir: landDir }).source, "机器之心_带来源的文章.md");
  fs.rmSync(landDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extractExcerpts picks paragraphs matching the terms", () => {
  const body = [
    "无关的第一段，用来填充内容，这里需要写得足够长以便通过长度过滤。".repeat(2),
    "Agent 工具调用经常失败，这是当前最核心的问题所在，有必要在正文里重点展开讨论并给出可行的缓解方案。",
    "结尾段落，同样需要足够长度来满足过滤条件，否则会被丢弃掉。".repeat(2),
  ].join("\n\n");
  const excerpts = extractExcerpts(body, ["agent", "工具"], 400, 1);
  assert.equal(excerpts.length, 1);
  assert.match(excerpts[0], /Agent/);
});

/* ------------------------------------------------------------------ */
/* weknora knowledge source                                            */
/* ------------------------------------------------------------------ */

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function weknoraType(overrides = {}) {
  return {
    name: "T",
    topic: { keywords: ["Agent"] },
    knowledge: {
      source: "weknora",
      max_sources: 6,
      excerpt_chars: 500,
      weknora: { base_url: "http://wk/api/v1", api_key: "k", kb_ids: ["kb1"], match_count: 6 },
      ...overrides,
    },
  };
}

function kbDir(count = 6) {
  const dir = tempDir("wa-kb-");
  for (let i = 1; i <= count; i++) {
    fs.writeFileSync(
      path.join(dir, `agent-${i}.md`),
      `---\ntitle: Agent 稳定性 ${i}\ndate: 2026-09-0${i}\n---\n\nAgent 工具调用稳定性问题 ${i}，需要系统性分析。\n`,
    );
  }
  return dir;
}

test("searchWeKnora normalizes hits, strips image noise and parses frontmatter", async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(String(url), /\/knowledge-bases\/kb1\/hybrid-search$/);
    assert.deepEqual(JSON.parse(init.body), { query_text: "Agent", match_count: 6 });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            knowledge_id: "k1",
            knowledge_title: "标题一",
            content: "![](resource://abc) 正文 A",
            score: 0.02,
            knowledge_description: "一段摘要",
            knowledge_custom_metadata: "date: 2025-01-20T10:00:00+08:00\nkeywords: AI, Agent",
          },
          { knowledge_id: "k1", knowledge_title: "标题一", content: "正文 B", score: 0.05 },
        ],
      }),
      text: async () => "",
    };
  });
  try {
    const hits = await searchWeKnora(weknoraType(), "Agent", {});
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "weknora://kb1/k1");
    assert.equal(hits[0].date, "2025-01-20");
    assert.deepEqual(hits[0].tags, ["AI", "Agent"]);
    assert.equal(hits[0].summary, "一段摘要");
    assert.equal(hits[0].score, 0.05);
    assert.equal(hits[0].excerpts.length, 2);
    assert.ok(!hits[0].excerpts[0].includes("resource://"));
  } finally {
    restore();
  }
});

test("searchWeKnora logs and skips failing knowledge bases", async () => {
  const warnings = [];
  const restore = stubFetch(async () => ({ ok: false, status: 500, text: async () => "boom" }));
  try {
    const type = weknoraType({ weknora: { base_url: "http://wk/api/v1", api_key: "k", kb_ids: ["kb1"] } });
    const hits = await searchWeKnora(type, "Agent", { logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(hits, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 500/);
  } finally {
    restore();
  }
});

test("collectSources interleaves local and WeKnora when source=both", async () => {
  const dir = kbDir(6);
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [1, 2, 3].map((i) => ({
        knowledge_id: `w${i}`,
        knowledge_title: `远端 ${i}`,
        content: `远端内容 ${i}`,
        score: 0.03 - i * 0.01,
      })),
    }),
    text: async () => "",
  }));
  try {
    const type = weknoraType({ source: "both", max_sources: 6 });
    type.knowledge_dirs = [dir];
    const sources = await collectSources(type, {
      topic: { topic: "Agent 稳定性" },
      notes: indexKnowledge(type, { logger: null }),
    });
    assert.equal(sources.length, 6);
    assert.deepEqual(sources.map((s) => s.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(sources.filter((s) => s.origin === "weknora").length, 3);
    assert.equal(sources[0].origin, "local");
    assert.equal(sources[1].origin, "weknora");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectSources stays offline in mock mode even for a WeKnora source", async () => {
  const dir = kbDir(3);
  const restore = stubFetch(async () => {
    throw new Error("network must not be used in mock mode");
  });
  try {
    const type = weknoraType();
    type.knowledge_dirs = [dir];
    const sources = await collectSources(type, {
      topic: { topic: "Agent 稳定性" },
      notes: indexKnowledge(type, { logger: null }),
      mock: true,
    });
    assert.ok(sources.length >= 1);
    assert.equal(sources.every((s) => s.origin === "local"), true);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 充分性闸门（通道 1 → 2 的开关）                                       */
/* ------------------------------------------------------------------ */

const GATE_NOW = Date.parse("2026-10-21T00:00:00Z");

function gateSource(title, { days = 3, chars = 900 } = {}) {
  return {
    title,
    date: new Date(GATE_NOW - days * 86400000).toISOString().slice(0, 10),
    excerpts: ["x".repeat(chars)],
  };
}

test("assessSourceSufficiency passes when all four signals are healthy", () => {
  const sources = [gateSource("DeepSeek 发布 V4.1"), gateSource("本地部署方案对比"), gateSource("开源模型周报"), gateSource("推理成本测算")];
  const verdict = assessSourceSufficiency(sources, {
    topic: { source_hints: ["DeepSeek 发布 V4.1", "本地部署方案对比"] },
    maxSources: 8,
    now: GATE_NOW,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.reasons, []);
});

test("assessSourceSufficiency reports every failing signal", () => {
  const sources = [gateSource("旧文一篇", { days: 400, chars: 400 }), gateSource("另一篇旧文", { days: 400, chars: 400 })];
  const verdict = assessSourceSufficiency(sources, {
    topic: { source_hints: ["点名素材 A", "点名素材 B"] },
    maxSources: 8,
    now: GATE_NOW,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(";"), /命中 2 篇 < 4/);
  assert.match(verdict.reasons.join(";"), /摘录 800 字 < 3000/);
  assert.match(verdict.reasons.join(";"), /source_hints 覆盖 0\/2/);
  assert.match(verdict.reasons.join(";"), /90 天内无命中/);
});

test("assessSourceSufficiency treats missing hints and thresholds via gate config", () => {
  const sources = [gateSource("文章", { days: 5, chars: 200 })];
  const verdict = assessSourceSufficiency(sources, {
    topic: {},
    maxSources: 2,
    gate: { min_excerpt_chars: 100, fresh_days: 30 },
    now: GATE_NOW,
  });
  assert.equal(verdict.ok, true, verdict.reasons.join("; "));
  assert.equal(verdict.signals.hint_coverage, 1);
});

/* ------------------------------------------------------------------ */
/* 通道 2：Markdown 解析 / 关键字构造 / 落地编排                          */
/* ------------------------------------------------------------------ */

const SEARCH_MD = [
  "# 外部检索：DeepSeek V4.1 本地部署 2026",
  "",
  "## [大模型本地部署：显存与价格](https://example.com/deploy)",
  "",
  "开源模型自部署所需显存与速度估算。",
  "",
  "## 页面内部小节",
  "",
  "这一节不是结果块，应留在上一条的 excerpt 里。",
  "",
  "## [V4.1 权重开源公告](https://example.org/announce)",
  "",
  "MIT 许可证，HuggingFace 可下载。",
  "",
  "<!-- fetched_at: 2026-10-21 | provider: opencode/websearch -->",
].join("\n");

test("parseSearchMarkdown splits on link headers only and drops the footer", () => {
  const blocks = parseSearchMarkdown(SEARCH_MD, { excerptChars: 1200 });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, "大模型本地部署：显存与价格");
  assert.equal(blocks[0].url, "https://example.com/deploy");
  assert.match(blocks[0].excerpt, /页面内部小节/);
  assert.ok(!blocks.map((b) => b.excerpt).join("").includes("fetched_at"));
  assert.equal(parseSearchMarkdown("", { limit: 4 }).length, 0);
});

test("buildSearchQueries makes title + keyword queries with the year", () => {
  const queries = buildSearchQueries(
    { title: "DeepSeek V4.1 免费跑起来？", keywords: ["DeepSeek V4.1", "本地部署", "免费模型", "开源替代", "多余"] },
    { max: 2 },
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^DeepSeek V4\.1 免费跑起来 \d{4}$/);
  assert.match(queries[1], /^DeepSeek V4\.1 本地部署 免费模型 开源替代 \d{4}$/);
});

test("gatherWebSearch stays home when the gate says local is enough", async () => {
  let called = 0;
  const out = await gatherWebSearch({
    topic: { title: "T", source_hints: [] },
    localSources: [1, 2, 3, 4].map(() => gateSource("S")),
    articleDir: tempDir("wa-ext-"),
    cfg: { max_sources: 6 },
    now: GATE_NOW,
    searchImpl: async () => { called += 1; return []; },
  });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test("gatherWebSearch lands markdown + index.json and returns web entries", async () => {
  const dir = tempDir("wa-ext-");
  const results = await gatherWebSearch({
    topic: { title: "DeepSeek V4.1 免费跑起来", keywords: ["本地部署"], source_hints: [] },
    localSources: [gateSource("旧", { days: 400, chars: 100 })],
    articleDir: dir,
    cfg: { max_queries: 1, max_sources: 2, max_per_query: 2, excerpt_chars: 300 },
    model: "ollama-local/qwen3.5:9b",
    now: GATE_NOW,
    searchImpl: async (queries) => queries.map((q) => ({ query: q, markdown: SEARCH_MD })),
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].origin, "web");
  assert.equal(results[0].source, "https://example.com/deploy");
  assert.match(results[0].file, /^01-step\/web-search\/.*\.md$/);
  assert.ok(fs.existsSync(path.join(dir, results[0].file)));
  const index = JSON.parse(fs.readFileSync(path.join(dir, "01-step", "web-search", "index.json"), "utf8"));
  assert.equal(index[0].status, "ok");
  assert.equal(index[0].hits, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gatherWebSearch records failed queries in index.json without throwing", async () => {
  const dir = tempDir("wa-ext-");
  const logs = [];
  const results = await gatherWebSearch({
    topic: { title: "T", keywords: ["K"] },
    localSources: [],
    articleDir: dir,
    cfg: { max_queries: 2 },
    now: GATE_NOW,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    searchImpl: async (queries) => queries.map((q, i) => (i === 0 ? { query: q, markdown: "", error: "serve 起不来" } : { query: q, markdown: SEARCH_MD })),
  });
  assert.equal(results.length, 2);
  const index = JSON.parse(fs.readFileSync(path.join(dir, "01-step", "web-search", "index.json"), "utf8"));
  assert.equal(index[0].status, "failed");
  assert.equal(index[0].error, "serve 起不来");
  assert.ok(logs.some((l) => l.includes("本地素材不足")));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 素材落地：01-step/sources/*.md + result.json 只留链接                  */
/* ------------------------------------------------------------------ */

test("landSources writes one MD per material and returns {index,title,link} entries", () => {
  const dir = tempDir("wa-land-");
  const slim = landSources(dir, [
    { index: 1, title: "Agent 稳定性：实践与反思", date: "2026-10-01", score: 12.5, file: "D:\\kb\\agent.md", excerpts: ["第一段摘录。", "第二段摘录。"], origin: "local" },
    { index: 2, title: "V4.1 权重开源公告", date: "2026-10-20", score: 0, source: "https://example.org/announce", excerpts: ["MIT 许可证。"], origin: "web" },
  ]);
  assert.equal(slim.length, 2);
  assert.deepEqual(Object.keys(slim[0]).sort(), ["index", "link", "title"]);
  assert.equal(slim[0].link, "01-step/sources/1-Agent-稳定性-实践与反思.md");

  // 其余信息全部从落地 MD 回读（相对 link 需 baseDir）
  const meta1 = loadSource(slim[0], { baseDir: dir });
  assert.equal(meta1.source, "D:\\kb\\agent.md");
  assert.equal(meta1.origin, "local");
  assert.equal(meta1.date, "2026-10-01");
  assert.equal(meta1.score, 12.5);
  assert.deepEqual(meta1.excerpts, ["第一段摘录。", "第二段摘录。"]);
  assert.equal(loadSource(slim[1], { baseDir: dir }).source, "https://example.org/announce");

  const text = fs.readFileSync(path.join(dir, slim[0].link), "utf8");
  assert.match(text, /^---\ntitle: Agent 稳定性：实践与反思\norigin: local\nsource: D:\\kb\\agent\.md\ndate: 2026-10-01\nscore: 12\.5\n---\n/);
  assert.match(text, /第一段摘录。\n\n第二段摘录。/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatSources and the gate read landed bodies back from link-only entries", () => {
  const dir = tempDir("wa-land-");
  const long = "这段摘录足够长，用来验证闸门按落地正文计字数。".repeat(140);
  const slim = landSources(dir, [
    { index: 1, title: "本地一篇", date: "2026-10-10", source: "剪存来源.md", file: "D:\\kb\\a.md", excerpts: [long], origin: "local" },
  ]);
  assert.deepEqual(Object.keys(slim[0]).sort(), ["index", "link", "title"]);
  assert.equal(slim[0].link, "01-step/sources/1-本地一篇.md");
  const formatted = formatSources(slim, { maxChars: 5000, baseDir: dir });
  assert.match(formatted, /### 素材 1：本地一篇/);
  assert.match(formatted, /- 文件：剪存来源\.md/);
  assert.match(formatted, /- 日期：2026-10-10/);
  assert.ok(formatted.includes(long.trim()));

  // 条目无 date/excerpts，闸门的字数与时效信号都经相对 link + baseDir 回读
  const verdict = assessSourceSufficiency(slim, { topic: {}, maxSources: 1, now: GATE_NOW, baseDir: dir });
  assert.equal(verdict.ok, true, verdict.reasons.join("; "));

  assert.deepEqual(sourceExcerpts({ index: 9, title: "x", link: "01-step/sources/不存在.md" }, { baseDir: dir }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
