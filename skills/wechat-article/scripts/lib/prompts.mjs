import { formatSources } from "./knowledge.mjs";
import { buildDraftVars } from "./draft-input.mjs";
import { renderTemplate } from "./template.mjs";

const JSON_RULES = [
  "只输出一个合法 JSON 对象，不要输出 Markdown 代码块、解释或前后缀。",
  "所有字符串使用中文，除专有名词外不要夹杂英文。",
  "不要编造素材中不存在的事实、数字、机构或引用。",
].join("\n");

/**
 * 选题提示词：模板来自 config/prompts/topic.yaml 的 select_topic（步骤引用
 * topic.select_topic），动态部分全部用占位符渲染；代码只准备变量，不再内联文案。
 * 输入是精简候选（标题 + 距今天数 + 新采集标记）和确定性词频热度表，
 * 不含逐篇 tags/summary/正文。时效以随条目给定的数字为准，模型不自行推断。
 * type 可以是选题阶段的占位对象（auto/deferred 入口，未定类）：类型相关字段全部可缺省。
 * 见 docs/topic-selection.md。
 */
export function buildTopicPrompt({ prompt, type, candidates, heatmap = "", written = [], mode = "auto", userTopic = "", userRequirements = "", count = 3 }) {
  if (!prompt?.system || !prompt?.user) {
    throw new Error("缺少选题提示词配置 topic.select_topic（system/user）");
  }
  const total = Math.max(1, Number(count) || 1);
  const render = (text) => renderTemplate(text, {
    type_name: type.name || "公众号",
    type_description: type.description || "",
    audience: type.style?.audience || "对相关话题感兴趣的读者",
    count: total,
    count_label: `${total} 个`,
    json_rules: JSON_RULES,
    mode_line: mode === "manual"
      ? `用户已指定主题：${userTopic}\n补充要求：${userRequirements || "无"}`
      : `请从下列近期知识库文章中自动挑选 ${total} 个最值得写的主题。`,
    candidates: candidates
      .map((note, i) => `${i + 1}. 《${note.title}》 · ${note.daysAgo} 天前${note.fresh ? "（新采集）" : ""}`)
      .join("\n") || "（无候选）",
    heatmap: heatmap || "（无热度数据）",
    written: written
      .map((w) => `- 《${w.title}》${w.date ? `（${w.date}）` : ""}`)
      .join("\n") || "（无历史记录）",
    dedupe_rule: written.length
      ? "严禁与上方「已写过的文章」重复：事件、标题、核心判断任一撞车的候选会被程序直接作废，白白浪费名额；宁可退选热度较低的新方向。"
      : "与已有文章形成差异，不要重复同一事件的消息面。",
    length_range: type.length ? `目标篇幅 ${type.length.min}-${type.length.max} 字。` : "",
  }).replace(/[ \t]+$/gm, "");
  return { system: render(prompt.system), prompt: render(prompt.user) };
}

export function buildOutlinePrompt({ type, topic, sources, userRequirements = "", maxChars = 14000, baseDir = "" }) {
  const dimensionText = type.scoring.dimensions
    .map((d) => `- ${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.description || ""}`)
    .join("\n");
  const imageCount = type.illustrations.count || type.illustrations.max || 3;

  return {
    system: [
      `你是「${type.name}」栏目的资深作者。${type.style.persona || ""}`,
      `文风：${type.style.tone || "清晰、克制"}。目标读者：${type.style.audience || "普通读者"}。`,
      "你只负责写纲要，不写正文。纲要必须能被另一位作者直接据此成文。",
      JSON_RULES,
    ].join("\n"),
    prompt: [
      `主题：${topic.topic}`,
      `核心判断：${topic.thesis || ""}`,
      `切入角度：${topic.angle || ""}`,
      userRequirements ? `用户补充要求：${userRequirements}` : "",
      "",
      "可用素材（来自本地知识库，引用时使用编号）：",
      formatSources(sources, { maxChars, baseDir }) || "（无可用素材，请基于常识谨慎写作，并明确标注不确定处）",
      "",
      "写作要求：",
      `1. 篇幅 ${type.length.min}-${type.length.max} 字，目标 ${type.length.target} 字。`,
      type.style.structure?.length ? `2. 结构参考：${type.style.structure.join(" → ")}` : "",
      `3. 必须满足的要点：${(type.style.dos || []).join("；") || "论点清晰、论据充分"}`,
      `4. 必须避免：${(type.style.donts || []).join("；") || "空话、编造"}`,
      type.prompts?.outline_extra ? `5. ${type.prompts.outline_extra}` : "",
      "",
      "评分维度（成文后会按此打分，纲要需为每个维度预留内容）：",
      dimensionText,
      "",
      "配图规划：",
      `- 全文配图 ${type.illustrations.min}-${type.illustrations.max} 张，建议 ${imageCount} 张。`,
      `- 配图风格：${type.illustrations.style || "简洁科技插画"}。`,
      "- 每张图给出插入位置、画面说明（30-80 字）和英文 Prompt（描述画面主体、构图、配色，不要文字）。",
      "",
      "输出 JSON 结构：",
      "{",
      '  "title": "最终标题",',
      '  "alternatives": ["备选标题 1", "备选标题 2"],',
      '  "thesis": "全文核心判断",',
      '  "audience": "目标读者",',
      '  "hook": "开篇使用的场景/数据/冲突",',
      '  "outline": [',
      '    { "heading": "小节标题", "points": ["要点"], "source_indexes": [1, 2], "target_words": 300 }',
      "  ],",
      '  "counterpoint": "需要回应的反方观点",',
      '  "takeaway": "读者可带走的结论或行动",',
      '  "image_plan": [',
      '    { "position": "cover|inline_1|inline_2", "description": "中文画面说明", "prompt": "English image prompt" }',
      "  ]",
      "}",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildDraftPrompt({ type, input, template, maxChars = 14000 }) {
  const vars = buildDraftVars({ type, input, maxChars });
  return {
    system: renderTemplate(template.prompt.system, vars),
    prompt: renderTemplate(template.prompt.user, vars),
  };
}

export function buildScorePrompt({ type, article, wordCount, round }) {
  const dimensions = type.scoring.dimensions
    .map(
      (d) =>
        `- ${d.id}｜${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.description || ""}${
          d.criteria?.length ? `\n  评判要点：${d.criteria.join("；")}` : ""
        }`,
    )
    .join("\n");

  return {
    system: [
      `你是微信公众号「${type.name}」栏目的终审编辑，以严格、具体、可执行为标准评稿。`,
      "你不负责鼓励作者，只负责指出真实问题。",
      "评分必须区分档次：有明显硬伤的稿件不得高于 75 分；达到发表水准才给 80 分以上。",
      JSON_RULES,
    ].join("\n"),
    prompt: [
      `请对下面这篇稿件进行第 ${round} 轮评稿。`,
      "",
      `## 栏目要求`,
      `- 篇幅要求：${type.length.min}-${type.length.max} 字，当前 ${wordCount} 字。`,
      `- 目标读者：${type.style.audience || ""}`,
      `- 文风：${type.style.tone || ""}`,
      `- 结构：${(type.style.structure || []).join(" → ")}`,
      `- 必须做到：${(type.style.dos || []).join("；")}`,
      `- 必须避免：${(type.style.donts || []).join("；")}`,
      `- 通过分数线：${type.review.pass_score ?? type.scoring.pass_score}`,
      "",
      `## 评分维度（每个维度 0-100 分）`,
      dimensions,
      "",
      "## 稿件",
      article,
      "",
      "## 输出 JSON 结构",
      "{",
      '  "dimensions": [',
      '    { "id": "维度 id", "name": "维度名", "score": 0, "comment": "具体扣分理由，引用原文片段" }',
      "  ],",
      '  "total": 0,',
      '  "verdict": "pass|revise",',
      '  "strengths": ["最多 3 条"],',
      '  "issues": [',
      '    { "severity": "high|medium|low", "dimension": "维度 id", "location": "所在小节或原文片段", "problem": "问题描述", "fix": "可直接执行的修改建议" }',
      "  ],",
      '  "must_fix": ["本轮必须修改的前 3 个问题"],',
      '  "suggested_title": "如果标题不够好，给出更好的标题，否则留空"',
      "}",
      "",
      "注意：total 必须等于各维度按权重加权后的结果，不要四舍五入到整数以外。",
    ].join("\n"),
  };
}

export function buildRevisePrompt({ type, article, review, round }) {
  const issues = (review.issues || [])
    .map(
      (issue, i) =>
        `${i + 1}. [${issue.severity || "medium"}][${issue.dimension || ""}] ${issue.problem}\n   位置：${issue.location || "全文"}\n   建议：${issue.fix || ""}`,
    )
    .join("\n");

  return {
    system: [
      `你是「${type.name}」栏目的改稿编辑。`,
      "你的任务是按审稿意见修改稿件，而不是重写。保留原文有效的结构、事实和语气。",
      "只输出修改后的完整 Markdown 文章，不要输出修改说明、对比或任何解释。",
    ].join("\n"),
    prompt: [
      `## 审稿意见（第 ${round} 轮）`,
      `总分：${review.total}，结论：${review.verdict}`,
      issues || "（无具体问题，请做语言层面的精修）",
      "",
      `## 必须修复`,
      (review.must_fix || []).map((item, i) => `${i + 1}. ${item}`).join("\n") || "（无）",
      "",
      `## 修改原则`,
      `1. 逐条落实审稿意见，不要遗漏 high 级问题。`,
      `2. 不要改变文章的核心判断和已核实的事实。`,
      `3. 修改后篇幅保持在 ${type.length.min}-${type.length.max} 字。`,
      `4. 保留 frontmatter 和所有配图标记 [[img:n|说明|prompt]]，除非某张图明显与内容不符。`,
      `5. 不要新增未经素材支持的数据或案例。`,
      type.prompts?.revise_extra ? `6. ${type.prompts.revise_extra}` : "",
      "",
      `## 原稿`,
      article,
      "",
      "现在输出修改后的完整文章：",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildCorrectFallbackPrompt({ article, issues }) {
  const list = (issues || [])
    .map((issue, i) => {
      const type = issue.type || issue.category || "error";
      const from = issue.original || issue.word || "";
      const to = issue.corrected || issue.suggestion || "";
      return `${i + 1}. [${type}] ${from}${to ? ` → ${to}` : ""}（${issue.suggestion || ""}）`;
    })
    .join("\n");
  return {
    system: "你是中文校对员。只修复错别字、敏感词和语法错误，不润色文风，不改变结构和事实。只输出修正后的完整 Markdown。",
    prompt: [`## 待修复问题`, list || "（无）", "", "## 原文", article, "", "请输出修正后的完整文章："].join("\n"),
  };
}

const EXPAND_RULES = [
  "1. 优先在现有小节内补充：具体机制、可验证的细节、对读者的实际影响、必要的背景解释。",
  "2. 每个小节至少 2 个自然段，每段 2-5 句；不要一句一段，也不要新增小节标题。",
  "3. 只能用原稿已有的事实、数据和逻辑做展开，严禁编造新的数据、案例或引用。",
  "4. 不要写「本文将」「如上所述」这类元叙述，也不要重复同一句话。",
].join("\n");

const CONDENSE_RULES = [
  "1. 删除重复表述、空洞形容词和元叙述，不得删除事实与关键判断。",
  "2. 合并过短的段落，保持每段 2-5 句。",
  "3. 必须保留所有配图标记和原有小节标题。",
].join("\n");

export function buildLengthPrompt({ type, article, wordCount, direction, retry, attempt = 1 }) {
  const expand = direction === "expand";
  const target = type.length.target || Math.round((type.length.min + type.length.max) / 2);
  const errors = `当前 ${wordCount} 字，要求 ${type.length.min}-${type.length.max} 字（目标约 ${target} 字）。`;
  return {
    system: `你是「${type.name}」栏目的改稿编辑。只输出完整的 Markdown 文章，不要输出任何说明、对比或解释。`,
    prompt: renderTemplate(retry, {
      retry_tag: attempt,
      errors,
      length_fix: expand ? EXPAND_RULES : CONDENSE_RULES,
      article,
      word_count: wordCount,
      target,
      length: { min: type.length.min, target, max: type.length.max },
    }),
  };
}
