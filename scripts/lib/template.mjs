/**
 * Tiny prompt-template engine.
 *
 * A template object looks like this (prompt + compact schema):
 *
 *   {
 *     "prompt": {
 *       "system": "... 你是 {{type_name}} 的作者 ...",
 *       "user":   "... {{title}} ... {{outline}} ...",
 *       "retry":  "... 第 {{retry_tag}} 次 ... {{errors}} ..."
 *     },
 *     "schema": {
 *       "title": ["string", 1, 64],
 *       "tags": ["array", 2, 5],
 *       "tags[]": ["string", 1],
 *       "note?": "string"
 *     }
 *   }
 *
 * Schema DSL (one line per field, no JSON Schema boilerplate):
 *   "string"                必填字符串
 *   ["string", min]         字符串，最短 min
 *   ["string", min, max]    字符串，长度区间
 *   ["number", min, max]    数字区间
 *   ["array", min]          数组，最少 min 项
 *   ["array", min, max]     数组，项数区间
 *   "boolean"               布尔
 *   "key?"                  可选字段（末尾问号）
 *   "list[]"                校验 list 的每个元素（标量数组）
 *   "list[].field"          校验 list 每个元素的 field（对象数组）
 *   [kind, n..., "..."]     kind 之后的数字项依次是 min/max；字符串尾项是给人看的
 *                           备注，校验时忽略。提示词里给模型看的输出结构说明
 *                           内联在 prompts/*.yaml，不由本 DSL 渲染。
 *
 * 违规分两级（脚本读得到、字段名对得上是硬约束；越界只是质量提示）：
 *   errors   必填缺失/为空、类型不符、结构不符、数组项数不足 min —— ok=false，需要重试
 *   warnings 非空字符串长度、数字取值越界、数组项数超 max        —— 不阻断，进日志
 */

/** Load a template file and fail early with a readable message. */
export function loadTemplate(file, readJson) {
  const template = readJson(file);
  if (!template?.prompt?.system || !template?.prompt?.user) {
    throw new Error(`${file} 缺少 prompt.system / prompt.user`);
  }
  if (!template.schema || typeof template.schema !== "object") {
    throw new Error(`${file} 缺少 schema`);
  }
  return template;
}

/** Replace {{path.to.value}}; unknown paths become an empty string. */
export function renderTemplate(text, vars = {}, { keepUnknown = false } = {}) {
  return String(text ?? "").replace(/\{\{\s*([\w.\[\]-]+)\s*\}\}/g, (_, key) => {
    const value = key
      .split(".")
      .reduce((acc, part) => (acc === undefined || acc === null ? acc : acc[part]), vars);
    if (value === undefined || value === null) return keepUnknown ? `{{${key}}}` : "";
    if (Array.isArray(value)) return value.join("、");
    return String(value);
  });
}

/** Validate data against the compact schema DSL. Returns { ok, errors, warnings }. */
export function validateTemplateSchema(data, schema) {
  const errors = [];
  const warnings = [];
  const walk = (value, rules, prefix) => {
    for (const [rawKey, rule] of Object.entries(rules || {})) {
      const optional = rawKey.endsWith("?");
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      if (key.includes("[]")) continue; // item rules are applied by the array branch below
      const label = prefix ? `${prefix}.${key}` : key;

      if (value?.[key] === undefined || value?.[key] === null) {
        if (!optional) errors.push(`${label} 缺失`);
      } else {
        check(value[key], rule, label, errors, warnings);
      }

      // Nested item rules: "outline[].heading"
      const itemPrefix = `${key}[].`;
      const itemRules = Object.fromEntries(
        Object.entries(rules)
          .filter(([k]) => k.startsWith(itemPrefix))
          .map(([k, v]) => [k.slice(itemPrefix.length), v]),
      );
      // Primitive item rules: "tags[]": ["string", 1]
      const primitiveRule = rules[`${key}[]`];
      if (primitiveRule !== undefined && Array.isArray(value?.[key])) {
        value[key].forEach((item, i) => check(item, primitiveRule, `${label}[${i}]`, errors, warnings));
      }
      if (Object.keys(itemRules).length === 0) continue;
      if (!Array.isArray(value?.[key])) {
        if (!optional || value?.[key] !== undefined) errors.push(`${label} 应为数组`);
        continue;
      }
      value[key].forEach((item, i) => {
        if (item && typeof item === "object" && !Array.isArray(item)) walk(item, itemRules, `${label}[${i}]`);
        else errors.push(`${label}[${i}] 应为对象`);
      });
    }
  };
  if (data && typeof data === "object" && !Array.isArray(data)) walk(data, schema, "");
  else errors.push("输入应为 JSON 对象");
  return { ok: errors.length === 0, errors, warnings };
}

function check(value, rule, label, errors, warnings) {
  const parts = Array.isArray(rule) ? rule : [rule];
  const kind = parts[0];
  // 只有数字项才是 min/max，字符串尾项是给人看的备注，校验忽略。
  const [min, max] = parts.slice(1).filter((x) => typeof x === "number");
  if (kind === "string") {
    if (typeof value !== "string") return errors.push(`${label} 应为字符串`);
    // 必填（min>=1）却为空 = 下游读不到可用内容，硬错误。
    if (min !== undefined && min >= 1 && value.trim() === "") return errors.push(`${label} 不能为空`);
    if (min !== undefined && value.length < min) warnings.push(`${label} 至少 ${min} 个字符（实际 ${value.length}）`);
    if (max !== undefined && value.length > max) warnings.push(`${label} 最多 ${max} 个字符（实际 ${value.length}）`);
    return;
  }
  if (kind === "array") {
    if (!Array.isArray(value)) return errors.push(`${label} 应为数组`);
    // 项数不足 = 下游读不到内容，硬错误；超上限只是越界提示。
    if (min !== undefined && value.length < min) errors.push(`${label} 至少 ${min} 项（实际 ${value.length}）`);
    if (max !== undefined && value.length > max) warnings.push(`${label} 最多 ${max} 项（实际 ${value.length}）`);
    return;
  }
  if (kind === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return errors.push(`${label} 应为数字`);
    if (min !== undefined && value < min) warnings.push(`${label} 不能小于 ${min}（实际 ${value}）`);
    if (max !== undefined && value > max) warnings.push(`${label} 不能大于 ${max}（实际 ${value}）`);
    return;
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") return errors.push(`${label} 应为布尔值`);
    return;
  }
  return errors.push(`${label} 的规则无法识别：${JSON.stringify(rule)}`);
}
