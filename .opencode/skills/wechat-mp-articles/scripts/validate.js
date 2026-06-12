const fs = require("fs");
const path = require("path");

const SCHEMAS = {
  report: {
    filename: /^analysis_report_\d{8}\.json$/,
    label: "article(s)",
    countKey: "articles",
    fields: {
      timestamp: { type: "string", required: true },
      articles: {
        type: "array", required: true,
        item: {
          type: "object",
          fields: {
            link: { type: "string", required: true, pattern: /^https?:\/\// },
            score: { type: "number", required: false, nullable: true, min: 1, max: 5 },
            tags: { type: "array", required: true, minLength: 1, item: { type: "string", nonEmpty: true } }
          }
        }
      }
    }
  },
  topic: {
    filename: /^analysis_topic_\d{8}\.json$/,
    label: "topic(s)",
    countKey: "topics",
    fields: {
      topics: {
        type: "array", required: true, minLength: 1,
        item: {
          type: "object",
          fields: {
            name: { type: "string", required: true },
            reasoning: { type: "string", required: true },
            topic_overview: { type: "string", required: false },
            insights: {
              type: "array", required: false,
              item: {
                type: "object",
                fields: {
                  title: { type: "string", required: true },
                  detail: { type: "string", required: true }
                }
              }
            }
          }
        }
      }
    }
  }
};

function validate(value, schema, p) {
  const errors = [];
  if (value === undefined) {
    if (schema.required) errors.push(`${p}: missing required field`);
    return errors;
  }
  if (value === null) {
    if (!schema.nullable) errors.push(`${p}: unexpected null`);
    return errors;
  }
  const type = Array.isArray(value) ? "array" : typeof value;
  if (schema.type && type !== schema.type) {
    errors.push(`${p}: expected ${schema.type}, got ${type}`);
    return errors;
  }
  if (schema.type === "string") {
    if (schema.nonEmpty && !value.trim()) errors.push(`${p}: empty string`);
    if (schema.pattern && !schema.pattern.test(value)) errors.push(`${p}: does not match required pattern`);
  }
  if (schema.type === "number") {
    if (schema.min != null && value < schema.min) errors.push(`${p}: too small (min ${schema.min})`);
    if (schema.max != null && value > schema.max) errors.push(`${p}: too large (max ${schema.max})`);
  }
  if (schema.type === "array") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${p}: too few items (min ${schema.minLength})`);
    if (schema.item) value.forEach((v, i) => errors.push(...validate(v, schema.item, `${p}[${i}]`)));
  }
  if (schema.type === "object" && schema.fields) {
    Object.entries(schema.fields).forEach(([k, s]) => errors.push(...validate(value[k], s, `${p}.${k}`)));
  }
  return errors;
}

const type = process.argv[2];
const filePath = process.argv[3];

if (!type || !filePath) {
  console.error("Usage: node validate.js <report|topic> <file.json>");
  process.exit(1);
}

const config = SCHEMAS[type];
if (!config) {
  console.error(`Unknown type: "${type}". Expected "report" or "topic".`);
  process.exitCode = 1;
  process.exit(1);
}

const basename = path.basename(filePath);
if (!config.filename.test(basename)) {
  console.error(`Invalid filename: expected ${config.filename}, got ${basename}`);
  process.exit(1);
}

let data;
try { data = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
catch (e) { console.error(`Invalid JSON: ${e.message}`); process.exit(1); }

const errors = validate(data, { type: "object", fields: config.fields }, "root");

if (errors.length > 0) {
  console.error(`Validation failed (${errors.length} issue(s)):`);
  errors.forEach(e => console.error(`  - ${e}`));
  process.exit(1);
}

console.log(`Valid: ${basename} (${data[config.countKey].length} ${config.label})`);
