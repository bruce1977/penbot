// 选题阶段测试：选题 prompt / 热度表 / 查重校验 / systemone 定类与择题
import test from "node:test";
import assert from "node:assert/strict";

import { buildTopicPrompt } from "../scripts/lib/prompts.mjs";
import { loadSteps } from "../scripts/lib/steps.mjs";
import { validateProposals, termHeatmap, formatHeatmap } from "../scripts/lib/knowledge.mjs";
import {
  buildSystemOneBody,
  buildTopicChoiceBody,
  classifyArticle,
  classifyOrFallback,
  normalizeClassifyResult,
  selectBestTopic,
  systemOneUrl,
} from "../scripts/lib/classify.mjs";

/* ------------------------------------------------------------------ */
/* multi-topic selection prompt                                        */
/* ------------------------------------------------------------------ */

const TOPIC_PROMPT = loadSteps().prompts["topic.select_topic"];

test("buildTopicPrompt 的文案来自 topic.select_topic YAML", () => {
  assert.throws(
    () => buildTopicPrompt({ type: {}, candidates: [] }),
    /缺少选题提示词配置 topic\.select_topic/,
  );
  const out = buildTopicPrompt({
    prompt: { ...TOPIC_PROMPT, system: "自定义：只输出 {{count}} 个主题，规则：{{json_rules}}\n候选：{{candidates}}／热度：{{heatmap}}" },
    type: { name: "栏目", style: {} },
    candidates: [{ title: "文章一", daysAgo: 1, fresh: true }],
    count: 2,
  });
  assert.match(out.system, /^自定义：只输出 2 个主题，规则：只输出一个合法 JSON 对象/);
  assert.match(out.system, /候选：1\. 《文章一》 · 1 天前（新采集）／热度：（无热度数据）/);
});

test("buildTopicPrompt uses titles + heatmap only and always asks for topics[]", () => {
  const type = {
    id: "t",
    name: "测试栏目",
    description: "desc",
    length: { min: 800, max: 1300, target: 1000 },
    style: { audience: "读者" },
    topic: { keywords: ["AI"] },
  };
  const candidates = [
    { title: "文章一", daysAgo: 3, fresh: true },
    { title: "文章二", daysAgo: 12, fresh: false },
  ];
  const prompt = buildTopicPrompt({
    prompt: TOPIC_PROMPT,
    type,
    candidates,
    heatmap: "本地部署｜6 篇｜最近 2026-10-12（8 天前）｜近 7 天新采集 3 篇",
    count: 3,
  });
  assert.match(prompt.system, /时效以.*距今天数/);
  assert.match(prompt.prompt, /《文章一》 · 3 天前（新采集）/);
  assert.match(prompt.prompt, /《文章二》 · 12 天前/);
  assert.match(prompt.prompt, /本地部署｜6 篇/);
  assert.match(prompt.prompt, /"topics"/);
  assert.match(prompt.prompt, /"score"/);
  assert.match(prompt.prompt, /候选列表中出现过的原标题/);
});

test("buildTopicPrompt 传入已写清单时渲染查重段落与规则", () => {
  const type = { id: "t", name: "测试栏目", style: {} };
  const candidates = [{ title: "文章一", daysAgo: 3, fresh: true }];
  const written = [
    { title: "上周写过的文章", date: "2026-10-12" },
    { title: "更早的一篇文章" },
  ];
  const prompt = buildTopicPrompt({ prompt: TOPIC_PROMPT, type, candidates, written, count: 3 });
  assert.match(prompt.prompt, /已写过的文章（来自发布归档，避免重复选题）：\n- 《上周写过的文章》（2026-10-12）/);
  assert.match(prompt.prompt, /- 《更早的一篇文章》\n/);
  assert.match(prompt.prompt, /严禁与上方「已写过的文章」重复：.*作废/);
  // 未定类（auto/deferred）时不出现篇幅规则
  assert.doesNotMatch(prompt.prompt, /目标篇幅/);

  const empty = buildTopicPrompt({ prompt: TOPIC_PROMPT, type, candidates, count: 3 });
  assert.match(empty.prompt, /已写过的文章（来自发布归档，避免重复选题）：\n（无历史记录）/);
  assert.match(empty.prompt, /与已有文章形成差异/);
});

/* ------------------------------------------------------------------ */
/* systemone 请求体文案：来自 prompts/topic.yaml                        */
/* ------------------------------------------------------------------ */

test("classify / select_best 的 instructions 与 state 取自 YAML 注册表", () => {
  const steps = loadSteps();
  const body = buildSystemOneBody({
    types: [{ id: "ai-news", name: "AI 资讯快评" }],
    title: "测试标题",
    outline: "小节一",
    prompt: steps.prompts["topic.classify_type"],
  });
  assert.match(body.state, /^标题：测试标题\n\n提纲：\n小节一$/);
  assert.match(body.questions.article_type.instructions, /不要因为某个类型的描述更长而偏向它/);

  const choice = buildTopicChoiceBody({
    topics: [{ title: "主题一", score: 90 }],
    prompt: steps.prompts["topic.select_best"],
  });
  assert.match(choice.state, /^候选主题（公众号选题，一次模型调用产出，按评分从高到低）：\n\n1\. 《主题一》（写作模型评分 90）$/);
  assert.match(choice.questions.topic_pick.instructions, /写作模型评分只作参考/);

  // 显式覆盖生效（可配置验证）；instructions 是纯文本，state 支持占位符
  const custom = buildSystemOneBody({
    types: [{ id: "t", name: "T" }],
    title: "x",
    prompt: { instructions: "只要编号", state: "S:{{title}}" },
  });
  assert.equal(custom.questions.article_type.instructions, "只要编号");
  assert.equal(custom.state, "S:x");
});

test("validateProposals 剔除撞车候选，systemone 只会看到非重复选项", () => {
  const candidates = [{ title: "深度学习模型量化实战" }, { title: "文章二" }];
  const written = [{ title: "深度学习模型量化实战" }];
  const mk = (title) => ({ topic: title, title, source_hints: ["文章二"] });
  const dup = mk("深度学习模型量化实战");
  const out = validateProposals([mk("新方向一"), dup, mk("新方向二")], candidates, written);
  assert.deepEqual(out.map((t) => t.title), ["新方向一", "新方向二"]);
  assert.equal(dup.duplicate_of, "深度学习模型量化实战");
});

test("validateProposals 全部撞车时兜底保留，无引用候选降末位", () => {
  const candidates = [{ title: "深度学习模型量化实战" }, { title: "文章二" }];
  const written = [{ title: "深度学习模型量化实战" }];
  const all = validateProposals([{ topic: "深度学习模型量化实战", title: "深度学习模型量化实战", source_hints: ["文章二"] }], candidates, written);
  assert.equal(all.length, 1, "全部撞车时保留重复候选兜底");
  const mk = (title, hints) => ({ topic: title, title, source_hints: hints });
  const out = validateProposals([mk("无引用", ["不存在的文章"]), mk("正常", ["文章二"])], candidates, written);
  assert.deepEqual(out.map((t) => t.title), ["正常", "无引用"]);
});

test("termHeatmap aggregates across documents and marks freshly collected", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const day = 86400000;
  const mk = (title, daysAgo, mtimeDaysAgo, extra = "") => ({
    title,
    tags: [],
    summary: "",
    body: extra,
    date: new Date(now - daysAgo * day).toISOString().slice(0, 10),
    mtime: now - mtimeDaysAgo * day,
  });
  const notes = [
    mk("本地部署 Ollama 记", 2, 1, "本地部署 本地部署 ollama"),
    mk("本地部署 llama.cpp", 5, 10, "本地部署 ollama"),
    mk("云厂商 GPU 涨价", 3, 2, "GPU 涨价"),
  ];
  const rows = termHeatmap(notes, { top: 10, freshDays: 7, now });
  const local = rows.find((r) => r.term === "本地部署");
  assert.ok(local, "本地部署 应出现在热度表");
  assert.equal(local.docs, 2);
  assert.equal(local.fresh, 1); // 只有第一篇的 mtime 在 7 天窗口内
  assert.equal(local.days_ago, 2); // days_ago 以最新文件日期为准
  assert.ok(!rows.find((r) => r.term === "GPU"), "只出现在 1 篇的孤词应被丢弃");
  assert.match(formatHeatmap(rows), /本地部署｜2 篇｜.*近 7 天新采集 1 篇/);
});

/* ------------------------------------------------------------------ */
/* systemone 定类                                                      */
/* ------------------------------------------------------------------ */

test("buildSystemOneBody turns the types into a choice question", () => {
  const body = buildSystemOneBody({
    model: "jev-latest",
    types: [
      {
        id: "ai-news",
        name: "AI 资讯快评",
        description: "单条新闻快速解读",
        style: { persona: "科技媒体主编", audience: "从业者" },
        topic: { keywords: ["发布", "开源"] },
      },
      { id: "ai-insight", name: "AI 深度观点", description: "围绕一个判断展开" },
    ],
    title: "某模型开源",
    outline: "## 发生了什么\n- 细节",
  });
  assert.equal(body.model, "jev-latest");
  assert.match(body.state, /标题：某模型开源/);
  assert.match(body.state, /## 发生了什么/);
  const question = body.questions.article_type;
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.criteria).sort(), ["ai-insight", "ai-news"]);
  assert.match(question.criteria["ai-news"], /单条新闻快速解读/);
  assert.match(question.instructions, /不要依据选项/);
});

test("systemOneUrl does not duplicate /v1", () => {
  assert.equal(systemOneUrl("https://routellm.abacus.ai/v1"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai/", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
});

test("normalizeClassifyResult reads answers.<question>.choice and clamps confidence", () => {
  const types = [{ id: "ai-news" }, { id: "ai-insight" }];
  const good = normalizeClassifyResult(
    {
      answers: {
        article_type: {
          type: "choice",
          choice: "ai-news",
          probabilities: { "ai-news": 0.94, "ai-insight": 0.06 },
          confidence: 2,
        },
      },
    },
    types,
  );
  assert.equal(good.ok, true);
  assert.equal(good.type, "ai-news");
  assert.equal(good.confidence, 1);
  assert.equal(good.probabilities["ai-news"], 0.94);

  const byProbability = normalizeClassifyResult(
    { answers: { article_type: { probabilities: { "ai-insight": 0.7, "ai-news": 0.3 } } } },
    types,
  );
  assert.equal(byProbability.type, "ai-insight");

  assert.equal(normalizeClassifyResult({ answers: {} }, types).ok, false);
  assert.equal(normalizeClassifyResult({ answers: { article_type: { choice: "ghost" } } }, types).ok, false);
});

test("classifyArticle calls /v1/systemone and parses answers", async () => {
  const config = {
    classifier: {
      enabled: true,
      base_url: "http://systemone.local/v1",
      endpoint: "/v1/systemone",
      api_key: "k",
      model: "jev-latest",
      question: "article_type",
      timeout_ms: 1000,
      max_retries: 0,
      min_confidence: 0.5,
    },
    types: [
      { id: "ai-news", name: "AI 资讯快评", enabled: true },
      { id: "ai-insight", name: "AI 深度观点", enabled: true },
    ],
  };
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        id: "systemone-1",
        object: "systemone.classification",
        model: "jev-1.13.0",
        answers: {
          article_type: {
            type: "choice",
            choice: "ai-news",
            probabilities: { "ai-news": 0.91, "ai-insight": 0.09 },
            confidence: 0.88,
          },
        },
        usage: { input_tokens: 120, output_tokens: 2 },
      }),
      { status: 200 },
    );
  };
  const result = await classifyArticle({ config, title: "某模型开源", outline: "## 事实", fetchImpl });
  assert.equal(seen.url, "http://systemone.local/v1/systemone");
  assert.equal(seen.headers.Authorization, "Bearer k");
  assert.equal(seen.body.model, "jev-latest");
  assert.equal(seen.body.questions.article_type.type, "choice");
  assert.match(seen.body.state, /某模型开源/);
  assert.equal(result.ok, true);
  assert.equal(result.type, "ai-news");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.probabilities["ai-news"], 0.91);
});

test("classifyArticle retries 429 before giving up", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "0.01" },
      });
    }
    return new Response(
      JSON.stringify({
        answers: { article_type: { type: "choice", choice: "ai-news", probabilities: { "ai-news": 0.9 }, confidence: 0.9 } },
      }),
      { status: 200 },
    );
  };
  const config = {
    classifier: {
      enabled: true,
      base_url: "http://systemone.local",
      endpoint: "/v1/systemone",
      api_key: "k",
      model: "jev-latest",
      question: "article_type",
      timeout_ms: 1000,
      max_retries: 1,
      min_confidence: 0.5,
    },
    types: [{ id: "ai-news", name: "AI 资讯快评", enabled: true }],
  };
  const result = await classifyArticle({ config, title: "某模型开源", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.type, "ai-news");
});

const twoPassConfig = (deep = true) => ({
  classifier: {
    enabled: true,
    base_url: "http://systemone.local",
    endpoint: "/v1/systemone",
    api_key: "k",
    model: "tev1",
    question: "article_type",
    timeout_ms: 1000,
    max_retries: 0,
    min_confidence: 0.5,
    escalate_below: 0.65,
    deep_model_id: deep ? "systemone.classifier-deep" : "",
    deep: deep ? { model: "nimble", base_url: "http://systemone.local", endpoint: "/v1/systemone", api_key: "k", timeout_ms: 1000, max_retries: 0 } : null,
  },
  types: [
    { id: "ai-news", name: "AI 资讯快评", enabled: true },
    { id: "ai-insight", name: "AI 深度观点", enabled: true },
  ],
});

const answer = (choice, confidence) => ({
  answers: { article_type: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } },
});

test("classifyArticle escalates to the deep model when confidence is below the threshold", async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    bodies.push(JSON.parse(init.body).model);
    const payload =
      calls === 1 ? { ...answer("ai-insight", 0.4), model: "tev1-1.0" } : { ...answer("ai-news", 0.9), model: "nimble-2.0" };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const result = await classifyArticle({ config: twoPassConfig(), title: "某模型开源", outline: "## 事实", fetchImpl });
  assert.deepEqual(bodies, ["tev1", "nimble"]);
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.equal(result.type, "ai-news");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.model, "nimble-2.0");
  assert.equal(result.first.type, "ai-insight");
  assert.equal(result.first.confidence, 0.4);
});

test("classifyArticle skips the deep model when confidence is high enough or deep is unset", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ...answer("ai-news", 0.9), model: "tev1-1.0" }), { status: 200 });
  };
  const high = await classifyArticle({ config: twoPassConfig(), title: "某模型开源", fetchImpl });
  assert.equal(calls, 1);
  assert.equal(high.escalated, false);
  assert.equal(high.confidence, 0.9);

  calls = 0;
  const noDeep = await classifyArticle({ config: twoPassConfig(false), title: "某模型开源", fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify(answer("ai-news", 0.3)), { status: 200 });
  } });
  assert.equal(calls, 1, "deep 未配置时不升级");
  assert.equal(noDeep.escalated, false);
});

test("classifyArticle keeps the first answer when the deep pass fails", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ ...answer("ai-insight", 0.4), model: "tev1-1.0" }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
  };
  const result = await classifyArticle({ config: twoPassConfig(), title: "某模型开源", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.equal(result.type, "ai-insight", "保留一次判断结果");
  assert.equal(result.confidence, 0.4);
  assert.equal(result.first, undefined);
});

/* ------------------------------------------------------------------ */
/* systemone 择题判定                                                   */
/* ------------------------------------------------------------------ */

const topicCandidates = [
  { topic: "主题一", title: "候选标题一", score: 90, thesis: "判断一", rationale: "理由一", source_hints: ["素材 A"] },
  { topic: "主题二", title: "候选标题二", score: 80, thesis: "判断二", rationale: "理由二", source_hints: ["素材 B"] },
  { topic: "主题三", title: "候选标题三", score: 70, thesis: "判断三", rationale: "理由三", source_hints: ["素材 C"] },
];

test("buildTopicChoiceBody 把候选主题编号为 1..N 的 choice 问题", () => {
  const body = buildTopicChoiceBody({ topics: topicCandidates, model: "tev1" });
  assert.equal(body.model, "tev1");
  assert.match(body.state, /1\. 《候选标题一》（写作模型评分 90）/);
  assert.match(body.state, /核心判断：判断三/);
  assert.match(body.state, /素材：素材 A/);
  const q = body.questions.topic_pick;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys(q.criteria), ["1", "2", "3"]);
  assert.match(q.instructions, /评分只作参考/);
});

test("selectBestTopic 按 choice 编号返回 index，低置信度时升级二次", async () => {
  const pick = (choice, confidence) => ({
    answers: { topic_pick: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } },
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ...pick("2", 0.8), model: "tev1-1.0" }), { status: 200 });
  };
  const result = await selectBestTopic({ config: twoPassConfig(), topics: topicCandidates, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.index, 1);
  assert.equal(result.escalated, false);

  calls = 0;
  const deepFetch = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (calls === 1) {
      assert.equal(body.model, "tev1");
      return new Response(JSON.stringify({ ...pick("1", 0.4), model: "tev1-1.0" }), { status: 200 });
    }
    assert.equal(body.model, "nimble");
    assert.equal(body.questions.topic_pick.type, "choice");
    return new Response(JSON.stringify({ ...pick("3", 0.9), model: "nimble-2.0" }), { status: 200 });
  };
  const escalated = await selectBestTopic({ config: twoPassConfig(), topics: topicCandidates, fetchImpl: deepFetch });
  assert.equal(escalated.ok, true);
  assert.equal(escalated.index, 2);
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.first.confidence, 0.4);
});

test("selectBestTopic 非法编号回退、单候选与 mock 不走网络", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        answers: { topic_pick: { type: "choice", choice: "5", probabilities: { "5": 0.9 }, confidence: 0.9 } },
        model: "tev1-1.0",
      }),
      { status: 200 },
    );
  const bad = await selectBestTopic({ config: twoPassConfig(), topics: topicCandidates, fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /未知/);

  let touched = false;
  const guardFetch = async () => {
    touched = true;
    throw new Error("不应调用");
  };
  const single = await selectBestTopic({ config: twoPassConfig(), topics: [topicCandidates[0]], fetchImpl: guardFetch });
  assert.equal(single.ok, true);
  assert.equal(single.index, 0);
  assert.equal(touched, false);

  const mock = await selectBestTopic({ config: twoPassConfig(), topics: topicCandidates, mock: true, fetchImpl: guardFetch });
  assert.equal(mock.ok, true);
  assert.equal(mock.index, 0, "mock 取评分最高的一篇");
});

test("classifyOrFallback degrades to classifier.default_type", async () => {
  const config = {
    classifier: { enabled: true, base_url: "", api_key: "", default_type: "ai-news", min_confidence: 0.5 },
    types: [{ id: "ai-news", name: "AI 资讯快评", enabled: true }],
  };
  const outcome = await classifyOrFallback({ config, title: "某模型开源" });
  assert.equal(outcome.typeId, "ai-news");
  assert.equal(outcome.source, "default");
});
