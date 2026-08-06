const path = require("path");
const { llmChat, extractJSON } = require("./lib/llm");
const { sleep, toNum, writeJsonFile, validateWithSchema } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL = process.env.KB_LLM_RATE_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const PROMPT_DIR = path.resolve(SCRIPT_DIR, "..", "prompts");
const MAX_ATTEMPTS = 3;

const SCHEMA_PATH = path.join(PROMPT_DIR, "rate.schema.json");

// Per-process nonce: unique per invocation, defeats Ollama serving cached completions.
function genNonce() {
    return Math.random().toString(36).slice(2, 12);
}

// ─── Prompt Loading ──────────────────────────────────────────────────────────

const prompts = require(path.join(PROMPT_DIR, "rate.prompt.json"));

// ─── Prompt Building ─────────────────────────────────────────────────────────

function buildPrompt(content) {
    const userPrompt = prompts.user.replace("{{content}}", content.slice(0, 6000));

    return `[run-id:${genNonce()}]\n\n${userPrompt}`;
}

function buildRetryPrompt(retryTag, errors) {
    const errorList = errors.map((e) => `- ${e}`).join("\n");
    return prompts.retry
        .replace("{{retry_tag}}", retryTag)
        .replace("{{errors}}", errorList);
}

// ─── Rating Construction ─────────────────────────────────────────────────────

function buildRate(parsed) {
    return {
        ratings: {
            value: toNum(parsed.value),
            tech: toNum(parsed.tech),
            public: toNum(parsed.public),
            academic: toNum(parsed.academic),
            ethics: toNum(parsed.ethics),
        },
        model: MODEL,
    };
}

// ─── LLM Extraction with Retry ──────────────────────────────────────────────

async function extractWithRetry(content) {
    let lastErrors = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let userPrompt = buildPrompt(content);

        // Prepend error feedback on retries.
        if (attempt > 1 && lastErrors.length > 0) {
            const retryTag = attempt === 2 ? "2nd retry" : "3rd retry";
            const errorBlock = buildRetryPrompt(retryTag, lastErrors);
            userPrompt = `${errorBlock}\n\n${userPrompt}`;
        }

        // Temperature jitter: 0.1 -> 0.2 -> 0.5 to break greedy determinism.
        const temperature = attempt === 1 ? 0.1 : attempt === 2 ? 0.2 : 0.5;

        if (attempt > 1) {
            console.log(`... [rate] requesting LLM (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        }


        let raw;
        try {
            raw = await llmChat(prompts.system, userPrompt, MODEL, { temperature });
        } catch (e) {
            if (attempt < MAX_ATTEMPTS) {
                await sleep(1000);
            }

            continue;
        }

        let candidate;
        try {
            candidate = buildRate(extractJSON(raw.trim()));
        } catch (e) {
            lastErrors = [`Output is not valid JSON: ${e.message}`];
            continue;
        }

        // Schema validation
        const schemaErrors = validateWithSchema(candidate, SCHEMA_PATH);
        if (schemaErrors.length > 0) {
            lastErrors = schemaErrors;
            continue;
        }

        return candidate;
    }

    throw new Error(`Validation failed after ${MAX_ATTEMPTS} attempts: ${lastErrors.join("; ")}`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// Extract rating from content and write to target file.
// @param {string} content - markdown content to rate
// @param {string} targetFile - path to write .rate.json output
// @returns {Promise<void>}
// @throws {Error} if extraction or validation fails
async function processFile(content, targetFile) {
    const rate = await extractWithRetry(content);
    writeJsonFile(targetFile, rate);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { processFile };
