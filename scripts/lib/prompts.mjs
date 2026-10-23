import { formatSources } from "./knowledge.mjs";
import { buildDraftVars } from "./draft-input.mjs";
import { renderTemplate } from "./template.mjs";

const JSON_RULES = [
  "只输出一个合法 JSON 对象，不要输出 Markdown 代码块、解释或前后缀。",
  "所有字符串使用中文，除专有名词外不要夹杂英文。",
  "不要编造素材中不存在的事实、数字、机构或引用。",
].join("\n");

/** 渲染注册表提示词块：变量补齐后清掉 YAML 块标量留下的行尾空格。 */
function renderPromptBlock(prompt, vars, id) {
  if (!prompt?.system || !prompt?.user) {
    throw new Error(`缺少提示词配置 ${id}（system/user）`);
  }
  const render = (text) => renderTemplate(text, vars).replace(/[ \t]+$/gm, "");
  return { system: render(prompt.system), prompt: render(prompt.user) };
}

/**
 * 选题提示词：模板来自 prompts/topic.yaml 的 select_topic（步骤引用
 * topic.select_topic），输出 JSON 骨架说明直接内联在提示词配置里；
 * schemas/topic.yaml 的 select_topic.output 只作 models.jsonValidated 的
 * 校验规则，不向提示词供词。代码不内联文案。
 * 输入是精简候选（标题 + 距今天数 + 新采集标记）和确定性词频热度表，
 * 不含逐篇 tags/summary/正文。时效以随条目给定的数字为准，模型不自行推断。
 * type 可以是选题阶段的占位对象（auto/deferred 入口，未定类）：类型相关字段全部可缺省。
 * 见 docs/topic-selection.md。
 */
export function buildTopicPrompt({ prompt, type, candidates, heatmap = "", written = [], mode = "auto", userTopic = "", userRequirements = "", count = 3 }) {
  const total = Math.max(1, Number(count) || 1);
  return renderPromptBlock(
    prompt,
    {
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
    },
    "topic.select_topic",
  );
}

/**
 * 纲要提示词：模板来自 prompts/outline.yaml 的 outline（步骤引用
 * outline.outline），输出 JSON 骨架说明内联在提示词配置里；
 * schemas/outline.yaml 的 outline.output 只作校验规则。
 */
export function buildOutlinePrompt({ prompt, type, topic, sources, userRequirements = "", maxChars = 14000, baseDir = "" }) {
  const dimensionText = (type.scoring?.dimensions || [])
    .map((d) => `- ${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.description || ""}`)
    .join("\n");
  const imageCount = type.illustrations?.count || type.illustrations?.max || 3;

  return renderPromptBlock(
    prompt,
    {
      type_name: type.name || "公众号",
      persona: type.style?.persona || "",
      tone: type.style?.tone || "清晰、克制",
      audience: type.style?.audience || "普通读者",
      topic: topic.topic,
      thesis: topic.thesis || "",
      angle: topic.angle || "",
      requirements_block: userRequirements ? `用户补充要求：${userRequirements}` : "",
      materials: formatSources(sources, { maxChars, baseDir }) || "（无可用素材，请基于常识谨慎写作，并明确标注不确定处）",
      length: { min: type.length.min, max: type.length.max, target: type.length.target },
      structure: (type.style?.structure || []).join(" → "),
      dos: (type.style?.dos || []).join("；") || "论点清晰、论据充分",
      donts: (type.style?.donts || []).join("；") || "空话、编造",
      extra: type.prompts?.outline_extra ? `5. ${type.prompts.outline_extra}` : "",
      scoring_dimensions: dimensionText,
      image: {
        min: type.illustrations?.min ?? 1,
        max: type.illustrations?.max ?? imageCount,
        count: imageCount,
        style: type.illustrations?.style || "简洁科技插画",
      },
    },
    "outline.outline",
  );
}

export function buildDraftPrompt({ type, input, template, maxChars = 14000 }) {
  const vars = buildDraftVars({ type, input, maxChars });
  return {
    system: renderTemplate(template.prompt.system, vars),
    prompt: renderTemplate(template.prompt.user, vars),
  };
}

/**
 * 评稿提示词：模板来自 prompts/review.yaml 的 scoring（步骤引用
 * review.scoring），输出 JSON 骨架说明内联在提示词配置里；
 * schemas/review.yaml 的 scoring.output 只作校验规则。
 */
export function buildScorePrompt({ prompt, type, article, wordCount, round }) {
  const dimensions = (type.scoring?.dimensions || [])
    .map(
      (d) =>
        `- ${d.id}｜${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.description || ""}${
          d.criteria?.length ? `\n  评判要点：${d.criteria.join("；")}` : ""
        }`,
    )
    .join("\n");

  return renderPromptBlock(
    prompt,
    {
      type_name: type.name,
      round,
      length: { min: type.length.min, max: type.length.max },
      word_count: wordCount,
      audience: type.style?.audience || "",
      tone: type.style?.tone || "",
      structure: (type.style?.structure || []).join(" → "),
      dos: (type.style?.dos || []).join("；"),
      donts: (type.style?.donts || []).join("；"),
      pass_score: type.review?.pass_score ?? type.scoring?.pass_score,
      scoring_dimensions: dimensions,
      article,
    },
    "review.scoring",
  );
}

/**
 * 改稿提示词：模板来自 prompts/revision.yaml 的 revision（步骤引用
 * revision.revision）。输出是 Markdown，无 JSON schema。
 * 首轮修改依据 = 核稿改动点；第二轮起叠加上一轮评分（review）。
 * 字数校验不过时由调用方带 attempt + failReason 重新调用，渲染
 * retry 块（含 length_fix_expand / length_fix_condense 规则）。
 */
export function buildRevisePrompt({ prompt, type, article, review = null, corrections = [], round, wordCount, attempt = 1, failReason = null }) {
  const range = { min: type.length.min, max: type.length.max };
  const target = type.length.target || Math.round((range.min + range.max) / 2);
  const correctionLines = (corrections || [])
    .map((issue, i) => {
      const kind = issue.type || issue.category || "error";
      const from = issue.original || issue.word || "";
      const to = issue.corrected || issue.suggestion || "";
      return `${i + 1}. [${kind}] ${from}${to ? ` → ${to}` : ""}`;
    })
    .join("\n") || "（核稿未发现需要修复的问题）";
  const issueLines = (review?.issues || [])
    .map(
      (issue, i) =>
        `${i + 1}. [${issue.severity || "medium"}][${issue.dimension || ""}] ${issue.problem}\n   位置：${issue.location || "全文"}\n   建议：${issue.fix || ""}`,
    )
    .join("\n");
  const review_basis = review
    ? `总分：${review.total}，结论：${review.verdict}\n${issueLines || "（无具体问题，请做语言层面的精修）"}\n\n核稿改动点：\n${correctionLines}`
    : `首轮修改：本轮没有评分意见，请按下列核稿改动点精修稿件。\n${correctionLines}`;

  let retry_block = "";
  if (failReason) {
    const expand = failReason.action === "expand";
    const errors = failReason.error
      ? `上一次尝试是调用失败，不是字数问题（错误：${failReason.error}）。按修改依据重新输出完整文章即可。`
      : `当前 ${failReason.words} 字，要求 ${range.min}-${range.max} 字（目标约 ${target} 字），${expand ? "需要增补" : "需要删减"}约 ${Math.max(failReason.error ? 0 : expand ? range.min - failReason.words : failReason.words - range.max, Math.abs(failReason.words - target))} 字。`;
    const length_fix = failReason.error
      ? "保持原有结构、配图标记和 frontmatter，整篇重新输出。"
      : (expand ? prompt?.length_fix_expand : prompt?.length_fix_condense) || "";
    const rendered = renderTemplate(prompt?.retry || "", { retry_tag: attempt, errors, length_fix }).trim();
    retry_block = rendered ? `${rendered}\n` : "";
  }

  return renderPromptBlock(
    prompt,
    {
      type_name: type.name,
      round,
      review_basis,
      must_fix: (review?.must_fix || []).map((item, i) => `${i + 1}. ${item}`).join("\n") || "（无）",
      retry_block,
      word_count: wordCount,
      length: { min: range.min, target, max: range.max },
      extra: type.prompts?.revise_extra ? `6. ${type.prompts.revise_extra}` : "",
      article,
    },
    "revision.revision",
  );
}

/** 校对回退提示词：模板来自 prompts/review.yaml 的 review（review.review）。 */
export function buildCorrectFallbackPrompt({ prompt, article, issues }) {
  const list = (issues || [])
    .map((issue, i) => {
      const kind = issue.type || issue.category || "error";
      const from = issue.original || issue.word || "";
      const to = issue.corrected || issue.suggestion || "";
      return `${i + 1}. [${kind}] ${from}${to ? ` → ${to}` : ""}（${issue.suggestion || ""}）`;
    })
    .join("\n");
  return renderPromptBlock(prompt, { issues: list || "（无）", article }, "review.review");
}
