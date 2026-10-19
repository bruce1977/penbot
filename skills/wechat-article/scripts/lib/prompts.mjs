import { formatSources } from "./knowledge.mjs";

const JSON_RULES = [
  "只输出一个合法 JSON 对象，不要输出 Markdown 代码块、解释或前后缀。",
  "所有字符串使用中文，除专有名词外不要夹杂英文。",
  "不要编造素材中不存在的事实、数字、机构或引用。",
].join("\n");

export function buildTopicPrompt({ type, candidates, mode = "auto", userTopic = "", userRequirements = "" }) {
  const list = candidates
    .map(
      (note, i) =>
        `${i + 1}. 《${note.title}》\n   日期：${note.date}${note.tags.length ? `｜标签：${note.tags.slice(0, 6).join("、")}` : ""}\n   ${truncate(note.summary || note.excerpt || "", 160)}`,
    )
    .join("\n");

  return {
    system: [
      `你是「${type.name}」栏目的选题编辑。${type.description || ""}`,
      `目标读者：${type.style.audience || "对相关话题感兴趣的读者"}。`,
      "你的任务是从近期知识库文章中提炼一个值得写的主题，而不是简单复述某一篇。",
      JSON_RULES,
    ].join("\n"),
    prompt: [
      mode === "manual"
        ? `用户已指定主题：${userTopic}\n补充要求：${userRequirements || "无"}`
        : "请从下列近期知识库文章中自动选择一个最适合本栏目的主题。",
      "",
      "近期文章候选：",
      list || "（无候选）",
      "",
      "选题要求：",
      `1. 主题要具体，能用一个明确判断或问题概括，不要写成「AI 行业观察」这类空泛题目。`,
      `2. 优先选择有事实密度、有冲突或反常识、且近期讨论度高的方向。`,
      `3. 与已有文章形成差异，不要重复同一事件的消息面。`,
      `4. 目标篇幅 ${type.length.min}-${type.length.max} 字。`,
      "",
      "输出 JSON 结构：",
      "{",
      '  "topic": "一句话主题（不超过 30 字）",',
      '  "thesis": "核心判断，一句话，必须可证伪",',
      '  "angle": "切入角度，说明与常见报道的差异",',
      '  "rationale": "为什么现在写这个主题（80 字内）",',
      '  "keywords": ["检索关键词", "3-6 个"],',
      '  "source_hints": ["最相关的候选文章标题"],',
      '  "title_candidates": ["标题 1", "标题 2", "标题 3"]',
      "}",
    ].join("\n"),
  };
}

export function buildOutlinePrompt({ type, topic, sources, userRequirements = "", maxChars = 14000 }) {
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
      formatSources(sources, { maxChars }) || "（无可用素材，请基于常识谨慎写作，并明确标注不确定处）",
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

export function buildDraftPrompt({ type, topic, outline, sources, maxChars = 14000 }) {
  const outlineText = (outline.outline || [])
    .map((section, i) => {
      const sourcesText = section.source_indexes?.length ? `（素材 ${section.source_indexes.join("、")}）` : "";
      return `${i + 1}. ${section.heading}${section.target_words ? `｜约 ${section.target_words} 字` : ""}\n   ${(section.points || []).join("\n   ")} ${sourcesText}`;
    })
    .join("\n");

  const images = (outline.image_plan || [])
    .map((img, i) => `${i + 1}. ${img.position || `inline_${i + 1}`}：${img.description}`)
    .join("\n");

  return {
    system: [
      `你是「${type.name}」栏目的作者。${type.style.persona || ""}`,
      `文风：${type.style.tone || "清晰、克制"}。`,
      `标题风格：${type.style.title_style || "准确、有信息量"}。`,
      "直接输出 Markdown 正文，不要输出任何解释、前言或结尾寒暄。",
      "不要在正文里写「本文将」「下面我们来看」这类元叙述。",
    ].join("\n"),
    prompt: [
      `# 任务`,
      `根据纲要写一篇完整的微信公众号文章。`,
      "",
      `## 主题`,
      `${outline.title || topic.topic}`,
      "",
      `核心判断：${outline.thesis || topic.thesis || ""}`,
      `开篇钩子：${outline.hook || ""}`,
      `读者：${outline.audience || type.style.audience || ""}`,
      "",
      `## 纲要`,
      outlineText,
      "",
      `## 必须回应的反方观点`,
      outline.counterpoint || "（无）",
      "",
      `## 结尾要落到的结论`,
      outline.takeaway || "",
      "",
      `## 可用素材`,
      formatSources(sources, { maxChars }) || "（无）",
      "",
      `## 硬性要求`,
      `- 篇幅 ${type.length.min}-${type.length.max} 字，不要低于 ${type.length.min} 字。`,
      `- 每段不超过 5 行，适配手机阅读。`,
      `- 使用 Markdown：一级标题只出现一次作为文章标题，小节用 ##。`,
      `- 首行必须是 frontmatter：`,
      `---`,
      `title: ${outline.title || topic.topic}`,
      `---`,
      `- 正文中按以下格式插入配图标记，全文 ${type.illustrations.min}-${type.illustrations.max} 个，必须使用这种格式：`,
      `[[img:1|中文画面说明|English image prompt]]`,
      `- 配图位置建议：`,
      images || "封面 1 张 + 正文 1-2 张",
      `- 不要使用 HTML 标签，不要插入真实图片链接，不要写图片来源。`,
      `- 引用素材中的事实时自然叙述，不要出现「根据素材 3」这类字样。`,
      type.prompts?.draft_extra ? `- ${type.prompts.draft_extra}` : "",
      "",
      "现在开始输出文章：",
    ]
      .filter(Boolean)
      .join("\n"),
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

export function truncate(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
