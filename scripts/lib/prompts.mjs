import { formatSources } from "./knowledge.mjs";
import { buildDraftVars } from "./draft-input.mjs";
import { getTitle } from "./markdown.mjs";
import { renderTemplate, pickPromptText as pickText } from "./template.mjs";
import { needConfig, needNumber } from "./env.mjs";

function missingBlock(id) {
  return `缺少提示词配置${id ? ` ${id}` : "（节点未声明 prompt id）"}（system/user）`;
}

/**
 * 渲染注册表提示词块：变量补齐后清掉 YAML 块标量留下的行尾空格。
 * id 由调用方从节点配置带来（stepCallContract 的 prompt_id），只用于报错定位；
 * 代码不自己拼 id，配置改了报错信息不会跟着说谎。
 */
function renderPromptBlock(prompt, vars, id) {
  if (!prompt?.system || !prompt?.user) throw new Error(missingBlock(id));
  const render = (text) => renderTemplate(text, vars).replace(/[ \t]+$/gm, "");
  return { system: render(prompt.system), prompt: render(prompt.user) };
}

/** 先校验整块提示词存在，再挑其中的条件文案：否则缺配置时报的是「缺句子」而不是「缺块」。 */
function requirePromptBlock(prompt, id) {
  if (!prompt?.system || !prompt?.user) throw new Error(missingBlock(id));
}

/**
 * 选题提示词：模板由 select_topic 节点 models.select.prompt 给出，
 * 输出 JSON 骨架说明直接内联在提示词配置里；
 * schemas/topic.yaml 的 select_topic.output 只作 models.jsonValidated 的
 * 校验规则，不向提示词供词。代码不内联文案。
 * 输入是精简候选（标题 + 距今天数 + 新采集标记）和确定性词频热度表，
 * 不含逐篇 tags/summary/正文。时效以随条目给定的数字为准，模型不自行推断。
 * type 可以是选题阶段的占位对象（auto/deferred 入口，未定类）：类型相关字段全部可缺省。
 * 见 docs/topic-selection.md。
 */
export function buildTopicPrompt({ prompt, promptId = "", type, candidates, heatmap = "", written = [], mode = "auto", userTopic = "", userRequirements = "", count = 3 }) {
  requirePromptBlock(prompt, promptId);
  const total = Math.max(1, Number(count) || 1);
  const vars = {
    type_name: type.name || "",
    type_description: type.description || "",
    audience: type.style?.audience || "",
    count: total,
    count_label: `${total} 个`,
    user_topic: userTopic,
    user_requirements: userRequirements || "无",
    candidates: candidates
      .map((note, i) => `${i + 1}. 《${note.title}》 · ${note.daysAgo} 天前${note.fresh ? "（新采集）" : ""}`)
      .join("\n") || "（无候选）",
    heatmap: heatmap || "（无热度数据）",
    written: written
      .map((w) => `- 《${w.title}》${w.date ? `（${w.date}）` : ""}`)
      .join("\n") || "（无历史记录）",
    length: type.length || {},
  };
  // 以下四处都是"整句文案 + 条件"，句子全在 topic.select_topic 块里，代码只挑 key：
  // 类型没定（auto 占位类型没有 style）或没写字数区间时整行留空，不编默认文案。
  vars.audience_line = vars.audience ? pickText(prompt, "audience_line", vars, promptId) : "";
  vars.mode_line = pickText(prompt, mode === "manual" ? "mode_line_manual" : "mode_line_auto", vars, promptId);
  vars.dedupe_rule = pickText(prompt, written.length ? "dedupe_rule_with_history" : "dedupe_rule_no_history", vars, promptId);
  vars.length_range = type.length ? pickText(prompt, "length_range", vars, promptId) : "";
  return renderPromptBlock(prompt, vars, promptId);
}

/**
 * 纲要提示词：模板由 outline 节点 models.outline.prompt 给出，
 * 输出 JSON 骨架说明内联在提示词配置里；
 * schemas/outline.yaml 的 outline.output 只作校验规则。
 */
export function buildOutlinePrompt({ prompt, promptId = "", type, topic, sources, userRequirements = "", maxChars = 14000, baseDir = "" }) {
  requirePromptBlock(prompt, promptId);
  const dimensionText = (type.scoring?.dimensions || [])
    .map((d) => `- ${d.name}（权重 ${(d.weight * 100).toFixed(0)}%）：${d.description || ""}`)
    .join("\n");
  const ill = type.illustrations || {};
  // 张数区间单源类型配置（config.mjs 已把 defaults+image_count 归成数字），
  // 缺了抛错点名配置路径——代码里不垫 "建议 3 张" 这种没人写的默认值。
  const imageMin = needNumber(ill.min, `类型 ${type.id} 的 illustrations.min`);
  const imageMax = needNumber(ill.max, `类型 ${type.id} 的 illustrations.max`);
  const vars = {
    type_name: type.name || "",
    persona: type.style?.persona || "",
    tone: type.style?.tone || "",
    audience: type.style?.audience || "",
    topic: topic.topic,
    thesis: topic.thesis || "",
    angle: topic.angle || "",
    length: { min: type.length.min, max: type.length.max, target: type.length.target },
    structure: (type.style?.structure || []).join(" → "),
    dos: (type.style?.dos || []).join("；"),
    donts: (type.style?.donts || []).join("；"),
    extra: type.prompts?.outline_extra ? `5. ${type.prompts.outline_extra}` : "",
    scoring_dimensions: dimensionText,
    image: {
      min: imageMin,
      max: imageMax,
      count: ill.count,
      style: ill.style || "",
    },
  };
  const materials = formatSources(sources, { maxChars, baseDir });
  vars.materials = materials || pickText(prompt, "no_materials", vars, promptId);
  // 用户补充要求这句整句也在注册表里（outline.requirements_block），代码只判有无。
  vars.user_requirements = userRequirements;
  vars.requirements_block = userRequirements
    ? pickText(prompt, "requirements_block", vars, promptId)
    : "";
  // 建议张数只在类型写了 image_count.default 时给；没写就让它自己按小节决定。
  vars.image_plan = pickText(
    prompt,
    ill.count === undefined ? "image_plan_range" : "image_plan_default",
    vars,
    promptId,
  );
  return renderPromptBlock(prompt, vars, promptId);
}

export function buildDraftPrompt({ type, input, template, maxChars = 14000, section = "" }) {
  const prompt = template?.prompt || {};
  const promptId = template?.prompt_id || "";
  const vars = buildDraftVars({ type, input, maxChars, prompt, promptId });
  const out = {
    system: renderTemplate(prompt.system, vars),
    prompt: renderTemplate(prompt.user, vars),
  };
  // 分节生成（初稿模型失败降级）时的约束句也在注册表里：draft_writing.section_only。
  if (section) out.prompt += `\n\n${pickText(prompt, "section_only", { ...vars, section_heading: section }, promptId)}`;
  return out;
}

/**
 * 评稿提示词：模板由 scoring 节点 models.score.prompt 给出，
 * 输出 JSON 骨架说明内联在提示词配置里；
 * schemas/review.yaml 的 scoring.output 只作校验规则。
 */
export function buildScorePrompt({ prompt, promptId = "", type, article, wordCount, round }) {
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
    promptId,
  );
}

/**
 * 去 AI 化提示词：模板 id 由 de_ai 档位给出（handler_options.levels.<档>.prompt，
 * 三档都在 prompts/revision.yaml 里）。输出是纯 Markdown，无 JSON schema；
 * 改写质量由调用方的零 token 闸门判定（重叠率 / 字数区间 / 数字保全）。
 */
export function buildDeAiPrompt({ prompt, type, article, title = "", id = "" }) {
  // 目标风格与读者单源类型配置（validate 已要求 enabled 类型写全 style.tone / style.audience）；
  // 「目标风格…／目标读者…」这句在 prompts/revision.yaml 的三个 de_ai 块里，
  // 代码不再自创「自然、克制」或拼「面向X」这种没人写的文案。
  const tone = needConfig(type.style?.tone, `类型 ${type.id} 的 style.tone（去 AI 化的目标风格）`);
  const audience = needConfig(type.style?.audience, `类型 ${type.id} 的 style.audience（去 AI 化的目标读者）`);
  return renderPromptBlock(
    prompt,
    {
      title: title || getTitle(article, ""),
      tone,
      audience,
      length: { min: type.length.min, max: type.length.max },
      article,
    },
    id,
  );
}

/**
 * 改稿提示词：模板由 revision 节点 models.revise.prompt 给出（prompts/revision.yaml）。
 * 输出是 Markdown，无 JSON schema。
 * 首轮修改依据 = 核稿接口的错别字候选（可能误报，由模型逐条核实）；第二轮起叠加上一轮评分（review）。
 * 字数校验不过时由调用方带 attempt + failReason 重新调用，渲染
 * retry 块（含 length_fix_expand / length_fix_condense 规则）。
 * 「有上一轮评分 / 首轮」「调用失败 / 字数不足 / 字数超出」这几句都是注册表里的具名 key，
 * 代码只按条件挑 key 并填数字，缺 key 抛错。
 */
export function buildRevisePrompt({ prompt, promptId = "", type, article, review = null, corrections = [], round, wordCount, attempt = 1, failReason = null }) {
  requirePromptBlock(prompt, promptId);
  const range = { min: type.length.min, max: type.length.max };
  const target = type.length.target || Math.round((range.min + range.max) / 2);
  const correctionLines = (corrections || [])
    .map((candidate, i) => {
      const kind = candidate.type || "typo";
      const from = candidate.original || "";
      const to = candidate.corrected || "";
      const line = candidate.line ? `（第 ${candidate.line} 行）` : "";
      return `${i + 1}. [${kind}] ${from ? `${from} → ${to}` : to}${line}`;
    })
    .join("\n") || "（规则接口未给出需要修复的候选）";
  const issueLines = (review?.issues || [])
    .map(
      (issue, i) =>
        `${i + 1}. [${issue.severity || "medium"}][${issue.dimension || ""}] ${issue.problem}\n   位置：${issue.location || "全文"}\n   建议：${issue.fix || ""}`,
    )
    .join("\n");

  const basisVars = {
    composite_score: review?.composite_score,
    verdict: review?.verdict,
    issue_lines: issueLines || pickText(prompt, "no_issue_line", {}, promptId),
    correction_lines: correctionLines,
  };
  const review_basis = pickText(
    prompt,
    review ? "review_basis_reviewed" : "review_basis_first_round",
    basisVars,
    promptId,
  );

  let retry_block = "";
  if (failReason) {
    const expand = failReason.action === "expand";
    const vars = {
      error: failReason.error,
      words: failReason.words,
      length: { min: range.min, max: range.max, target },
      delta: Math.max(
        failReason.error ? 0 : expand ? range.min - failReason.words : failReason.words - range.max,
        Math.abs(failReason.words - target),
      ),
    };
    const errors = pickText(
      prompt,
      failReason.error ? "retry_reason_call_failed" : expand ? "retry_reason_expand" : "retry_reason_condense",
      vars,
      promptId,
    );
    const length_fix = pickText(
      prompt,
      failReason.error ? "retry_fix_call_failed" : expand ? "length_fix_expand" : "length_fix_condense",
      vars,
      promptId,
    );
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
    promptId,
  );
}
