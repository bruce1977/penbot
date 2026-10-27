// 选题阶段测试：选题 prompt / 热度表 / 查重校验 / systemone 定类、择题与审稿去留
import test from "node:test";
import assert from "node:assert/strict";

import { buildTopicPrompt } from "../../scripts/lib/prompts.mjs";
import { loadSteps } from "../../scripts/lib/steps.mjs";
import { validateProposals, termHeatmap, formatHeatmap } from "../../scripts/lib/knowledge.mjs";
import {
  buildSystemOneBody,
  buildTopicChoiceBody,
  buildReviewCheckBody,
  checkRevisionNeeded,
  classifyArticle,
  classifyOrFallback,
  normalizeClassifyResult,
  selectBestTopic,
  systemOneUrl,
} from "../../scripts/lib/classify.mjs";

/* ------------------------------------------------------------------ */
/* multi-topic selection prompt                                        */
/* ------------------------------------------------------------------ */

const STEPS_REL = "config/wechat-article/steps.yaml";
const PROMPTS = loadSteps(STEPS_REL).prompts;
const TOPIC_PROMPT = PROMPTS["topic.select_topic"];
const TOPIC_SCHEMA = loadSteps(STEPS_REL).schemas["topic.select_topic"].output;

test("buildTopicPrompt 的文案来自 topic.select_topic YAML", () => {
  // 报错里的 id 由调用方从节点配置带来（prompt_id），代码不写死提示词 id。
  assert.throws(
    () => buildTopicPrompt({ promptId: "topic.select_topic", type: {}, candidates: [] }),
    /缺少提示词配置 topic\.select_topic/,
  );
  assert.throws(
    () => buildTopicPrompt({ type: {}, candidates: [] }),
    /缺少提示词配置（节点未声明 prompt id）/,
  );
  const out = buildTopicPrompt({
    prompt: { ...TOPIC_PROMPT, system: "自定义：只输出 {{count}} 个主题\n候选：{{candidates}}／热度：{{heatmap}}" },
    type: { name: "栏目", style: {} },
    candidates: [{ title: "文章一", daysAgo: 1, fresh: true }],
    count: 2,
  });
  assert.match(out.system, /^自定义：只输出 2 个主题\n候选：1\. 《文章一》 · 1 天前（新采集）／热度：（无热度数据）/);
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
    schema: TOPIC_SCHEMA,
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
  // 给模型看的输出骨架内联在 prompts/topic.yaml；schemas/topic.yaml 的
  // select_topic.output 只管脚本校验，两处由人工保持同形（不互为来源）。
  assert.match(prompt.prompt, /"topic": "一句话主题（不超过 64 字）"/);
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
/* 条件文案：整句只在注册表里，代码只按条件挑 key                        */
/* ------------------------------------------------------------------ */

test("buildTopicPrompt 的四个条件分支都从 topic.select_topic 取整句，缺 key 抛错", () => {
  const base = {
    prompt: TOPIC_PROMPT,
    promptId: "topic.select_topic",
    type: { name: "栏目", style: { audience: "从业者" }, length: { min: 800, max: 1300 } },
    candidates: [{ title: "文章一", daysAgo: 1 }],
  };
  assert.match(buildTopicPrompt({ ...base, mode: "auto" }).prompt, /请从下列近期知识库文章中自动挑选 3 个/);
  assert.match(buildTopicPrompt({ ...base, mode: "manual", userTopic: "我的题目" }).prompt, /用户已指定主题：我的题目/);
  assert.match(buildTopicPrompt({ ...base, written: [{ title: "旧文" }] }).prompt, /严禁与上方「已写过的文章」重复/);
  assert.match(buildTopicPrompt({ ...base, written: [] }).prompt, /与已有文章形成差异/);
  assert.match(buildTopicPrompt(base).system, /目标读者：从业者/);
  assert.match(buildTopicPrompt(base).prompt, /目标篇幅 800-1300 字/);
  // 未定类 / 没写字数区间：整行省略，不换成代码里的默认文案
  const placeholder = buildTopicPrompt({ ...base, type: { name: "公众号", style: {}, length: null } });
  assert.doesNotMatch(placeholder.system, /目标读者/);
  assert.doesNotMatch(placeholder.prompt, /目标篇幅/);

  for (const key of ["mode_line_auto", "dedupe_rule_no_history", "audience_line", "length_range"]) {
    const broken = { ...TOPIC_PROMPT, [key]: "" };
    assert.throws(
      () => buildTopicPrompt({ ...base, prompt: broken }),
      new RegExp(`缺少提示词文案 topic\\.select_topic\\.${key}`),
    );
  }
});

/* ------------------------------------------------------------------ */
/* systemone 请求体文案：来自 prompts/topic.yaml                        */
/* ------------------------------------------------------------------ */

test("classify / select_best 的 instructions 与 state 取自 YAML 注册表", () => {
  const steps = loadSteps(STEPS_REL);
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

test("validateProposals 对匹配收缩的 source_hints 记警告（落盘与模型输出差异可见）", () => {
  const candidates = [{ title: "文章一" }, { title: "文章二" }];
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const topic = { topic: "主题甲", title: "主题甲", source_hints: ["文章一", "不存在的文章"] };
  const [first] = validateProposals([topic], candidates, [], logger);
  assert.deepEqual(first.source_hints, ["文章一"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /source_hints 匹配收缩 2→1/);
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
    prompt: PROMPTS["topic.classify_type"],
    promptId: "topic.classify_type",
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
  assert.equal(systemOneUrl("https://routellm.abacus.ai/v1", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai", "/v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
  assert.equal(systemOneUrl("https://routellm.abacus.ai/", "v1/systemone"), "https://routellm.abacus.ai/v1/systemone");
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
      prompt: PROMPTS["topic.classify_type"],
      prompt_id: "topic.classify_type",
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
      prompt: PROMPTS["topic.classify_type"],
      prompt_id: "topic.classify_type",
    },
    types: [{ id: "ai-news", name: "AI 资讯快评", enabled: true }],
  };
  const result = await classifyArticle({ config, title: "某模型开源", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.type, "ai-news");
});

const twoPassConfig = (deep = true, promptId = "topic.classify_type") => ({
  classifier: {
    enabled: true,
    prompt: PROMPTS[promptId],
    prompt_id: promptId,
    base_url: "http://systemone.local",
    endpoint: "/v1/systemone",
    api_key: "k",
    model: "tev1",
    question: "article_type",
    topic_question: "topic_pick",
    check_question: "review_check",
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

test("判断模型的端点/问题名/闸门参数单源配置：缺字段抛错点名配置路径，不降级成判断模型不可用", async () => {
  const never = async () => {
    throw new Error("不应发起网络调用");
  };
  const withClassifier = (patch) => {
    const config = twoPassConfig();
    return { ...config, classifier: { ...config.classifier, ...patch } };
  };

  await assert.rejects(
    classifyArticle({ config: withClassifier({ question: "" }), title: "某模型开源", outline: "## 事实", fetchImpl: never }),
    /缺少判断模型行为参数：defaults\.yaml classifier\.question/,
  );
  await assert.rejects(
    classifyArticle({ config: withClassifier({ timeout_ms: undefined }), title: "某模型开源", outline: "## 事实", fetchImpl: never }),
    /判断模型缺少 timeout_ms：config\/models\.yaml/,
  );
  await assert.rejects(
    classifyArticle({ config: withClassifier({ escalate_below: undefined }), title: "某模型开源", outline: "## 事实", fetchImpl: async () => new Response(JSON.stringify(answer("ai-news", 0.9)), { status: 200 }) }),
    /判断模型缺少 escalate_below：steps 节点 models\.<调用名>\.options/,
  );

  // cfg 没写模型名时不再伪造 "jev-latest"：请求体不带 model，留痕由 provider 段承担。
  let seen;
  const spy = async (url, init) => {
    seen = JSON.parse(init.body);
    return new Response(JSON.stringify(answer("ai-news", 0.9)), { status: 200 });
  };
  await classifyArticle({ config: withClassifier({ model: "", deep: null }), title: "某模型开源", outline: "## 事实", fetchImpl: spy });
  assert.ok(!("model" in seen), "请求体不写代码里的模型名副本");
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
  const body = buildTopicChoiceBody({
    topics: topicCandidates,
    model: "tev1",
    prompt: PROMPTS["topic.select_best"],
    promptId: "topic.select_best",
  });
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
  const result = await selectBestTopic({ config: twoPassConfig(true, "topic.select_best"), topics: topicCandidates, fetchImpl });
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
  const escalated = await selectBestTopic({ config: twoPassConfig(true, "topic.select_best"), topics: topicCandidates, fetchImpl: deepFetch });
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
  const bad = await selectBestTopic({ config: twoPassConfig(true, "topic.select_best"), topics: topicCandidates, fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /未知/);

  let touched = false;
  const guardFetch = async () => {
    touched = true;
    throw new Error("不应调用");
  };
  const single = await selectBestTopic({ config: twoPassConfig(true, "topic.select_best"), topics: [topicCandidates[0]], fetchImpl: guardFetch });
  assert.equal(single.ok, true);
  assert.equal(single.index, 0);
  assert.equal(touched, false);

  const mock = await selectBestTopic({ config: twoPassConfig(true, "topic.select_best"), topics: topicCandidates, mock: true, fetchImpl: guardFetch });
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

test("buildReviewCheckBody 渲染评稿结果，选项是 done/continue", () => {
  const body = buildReviewCheckBody({
    score: { composite_score: 60, verdict: "revise", issues: [{ severity: "high", dimension: "length", problem: "篇幅不足", fix: "扩写" }], must_fix: ["补 300 字"] },
    wordCount: 700,
    length: { min: 800, max: 1300 },
    passScore: 80,
    round: 2,
    prompt: {
      state: "第 {{round}} 轮：总分 {{total}}（通过线 {{pass_score}}），结论 {{verdict}}，当前 {{word_count}} 字（{{length.min}}-{{length.max}}）。\n{{issues}}\n{{must_fix}}",
      instructions: "判断是否需要继续修改",
      criteria_done: "达标",
      criteria_continue: "仍需改",
    },
  });
  assert.match(body.state, /第 2 轮：总分 60（通过线 80），结论 revise，当前 700 字（800-1300）/);
  assert.match(body.state, /篇幅不足/);
  assert.match(body.state, /补 300 字/);
  assert.equal(body.questions.review_check.instructions, "判断是否需要继续修改");
  assert.deepEqual(body.questions.review_check.criteria, { done: "达标", continue: "仍需改" });
});

test("checkRevisionNeeded 低置信度升级二次判断；禁用时回退由调用方处理", async () => {
  const answerCheck = (choice, confidence) => ({
    answers: { review_check: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } },
    model: "tev1-1.0",
  });
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.model === "tev1") return new Response(JSON.stringify(answerCheck("continue", 0.4)), { status: 200 });
    assert.equal(body.model, "nimble");
    return new Response(JSON.stringify(answerCheck("done", 0.9)), { status: 200 });
  };
  const result = await checkRevisionNeeded({
    config: twoPassConfig(true, "review.check"),
    score: { composite_score: 60, verdict: "revise", issues: [], must_fix: [] },
    wordCount: 700,
    length: { min: 800, max: 1300 },
    passScore: 80,
    round: 1,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "done", "一次 continue 置信度 0.4，升级后采用二次的 done");
  assert.equal(result.escalated, true);
  assert.equal(calls, 2);

  const disabled = await checkRevisionNeeded({ config: twoPassConfig(false), cfg: { enabled: false }, score: {}, round: 1 });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, "classifier.disabled");

  const mocked = await checkRevisionNeeded({ config: twoPassConfig(), score: { total: 60 }, round: 1, mock: true });
  assert.equal(mocked.decision, "done");
});
