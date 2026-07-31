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
            tags: { type: "array", required: true, minLength: 0, item: { type: "string", nonEmpty: true } },
            summary: { type: "string", required: false, nullable: true }
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
  },
  config: {
    filename: /^config\.json$/,
    label: "account(s)",
    countKey: "accounts",
    fields: {
      accounts: {
        type: "array", required: true, minLength: 1,
        item: {
          type: "object",
          fields: {
            name: { type: "string", required: true, nonEmpty: true },
            fake_id: { type: "string", required: true, nonEmpty: true },
            category: { type: "string", required: false },
            enabled: { type: "boolean", required: false }
          }
        }
      },
      settings: {
        type: "object", required: true,
        fields: {
          name: { type: "string", required: true, nonEmpty: true },
          days_to_filter: { type: "number", required: false, min: 1 },
          max_articles_per_account: { type: "number", required: false, min: 1 },
          top_n_articles: { type: "number", required: false, min: 1 },
          topic_count: { type: "number", required: false, min: 1 },
          topic_selection_guidance: { type: "string", required: false },
          similarity_threshold: { type: "number", required: false, min: 0, max: 1 },
          language: { type: "string", required: false },
          max_accounts: { type: "number", required: false, min: 1 },
          email: { type: "string", required: false },
          email_summary_enabled: { type: "boolean", required: false },
          email_final_enabled: { type: "boolean", required: false }
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
  console.error("Usage: node validate.js <report|topic|config> <file.json>");
  process.exit(1);
}

const config = SCHEMAS[type];
if (!config) {
  console.error(`Unknown type: "${type}". Expected "report", "topic" or "config".`);
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
