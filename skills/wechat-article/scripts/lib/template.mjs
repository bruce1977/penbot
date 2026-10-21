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
 *   ["array", min]          数组，最少 min 项
 *   ["array", min, max]     数组，项数区间
 *   ["number", min, max]    数字区间
 *   "boolean"               布尔
 *   "key?"                  可选字段（末尾问号）
 *   "list[]"                校验 list 的每个元素（标量数组）
 *   "list[].field"          校验 list 每个元素的 field（对象数组）
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

/** Validate data against the compact schema DSL. Returns { ok, errors }. */
export function validateTemplateSchema(data, schema) {
  const errors = [];
  const walk = (value, rules, prefix) => {
    for (const [rawKey, rule] of Object.entries(rules || {})) {
      const optional = rawKey.endsWith("?");
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      if (key.includes("[]")) continue; // item rules are applied by the array branch below
      const label = prefix ? `${prefix}.${key}` : key;

      if (value?.[key] === undefined || value?.[key] === null) {
        if (!optional) errors.push(`${label} 缺失`);
      } else {
        check(value[key], rule, label, errors);
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
        value[key].forEach((item, i) => check(item, primitiveRule, `${label}[${i}]`, errors));
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
  return { ok: errors.length === 0, errors };
}

function check(value, rule, label, errors) {
  const [kind, min, max] = Array.isArray(rule) ? rule : [rule];
  if (kind === "string") {
    if (typeof value !== "string") return errors.push(`${label} 应为字符串`);
    if (min !== undefined && value.length < min) errors.push(`${label} 至少 ${min} 个字符`);
    if (max !== undefined && value.length > max) errors.push(`${label} 最多 ${max} 个字符`);
    return;
  }
  if (kind === "array") {
    if (!Array.isArray(value)) return errors.push(`${label} 应为数组`);
    if (min !== undefined && value.length < min) errors.push(`${label} 至少 ${min} 项`);
    if (max !== undefined && value.length > max) errors.push(`${label} 最多 ${max} 项`);
    return;
  }
  if (kind === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return errors.push(`${label} 应为数字`);
    if (min !== undefined && value < min) errors.push(`${label} 不能小于 ${min}`);
    if (max !== undefined && value > max) errors.push(`${label} 不能大于 ${max}`);
    return;
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") return errors.push(`${label} 应为布尔值`);
    return;
  }
  return errors.push(`${label} 的规则无法识别：${JSON.stringify(rule)}`);
}
