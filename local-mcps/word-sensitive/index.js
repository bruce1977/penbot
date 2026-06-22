import { FastMCP } from "fastmcp";
import { z } from "zod";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

const VOCABULARY_BASE = "https://cdn.jsdelivr.net/gh/konsheng/Sensitive-lexicon@master/Vocabulary/";

const VOCABULARY_FILES = [
  { file: "COVID-19词库.txt", category: "covid19" },
  { file: "GFW补充词库.txt", category: "gfw" },
  { file: "其他词库.txt", category: "other" },
  { file: "反动词库.txt", category: "subversive" },
  { file: "广告类型.txt", category: "advertisement" },
  { file: "政治类型.txt", category: "political" },
  { file: "暴恐词库.txt", category: "violence" },
  { file: "民生词库.txt", category: "livelihood" },
  { file: "涉枪涉爆.txt", category: "weapons" },
  { file: "色情类型.txt", category: "pornography-type" },
  { file: "色情词库.txt", category: "pornography" },
  { file: "补充词库.txt", category: "supplementary" },
  { file: "贪腐词库.txt", category: "corruption" },
  { file: "零时-Tencent.txt", category: "tencent" },
  { file: "非法网址.txt", category: "illegal-urls" },
];

const wordLists = new Map();
let isInitialized = false;

function localFilePath(filename) {
  return path.join(DATA_DIR, filename);
}

function loadFromDisk(filename) {
  const fp = localFilePath(filename);
  if (!fs.existsSync(fp)) return null;
  const text = fs.readFileSync(fp, "utf-8");
  return text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

function saveToDisk(filename, words) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(localFilePath(filename), words.join("\n"), "utf-8");
}

async function fetchWordList(filename, timeoutMs = 8000) {
  const url = VOCABULARY_BASE + encodeURIComponent(filename);
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });
  return res.data.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

async function initialize() {
  if (isInitialized) return;
  const results = await Promise.allSettled(
    VOCABULARY_FILES.map(async ({ file, category }) => {
      const local = loadFromDisk(file);
      if (local) return { category, words: local };
      const words = await fetchWordList(file);
      saveToDisk(file, words);
      return { category, words };
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      wordLists.set(result.value.category, new Set(result.value.words));
    }
  }
  isInitialized = true;
}

function detect(text, categories) {
  const sensitiveWords = [];
  const cats = categories || [...wordLists.keys()];
  for (const category of cats) {
    const ws = wordLists.get(category);
    if (!ws) continue;
    for (const word of ws) {
      if (text.toLowerCase().includes(word.toLowerCase())) {
        sensitiveWords.push({ word, category });
      }
    }
  }
  return {
    isSensitive: sensitiveWords.length > 0,
    sensitiveWordsCount: sensitiveWords.length,
    sensitiveWords,
    summary: `Found ${sensitiveWords.length} sensitive word(s) in the text`,
  };
}

function filter(text, replacement = "***", categories) {
  const result = detect(text, categories);
  if (!result.isSensitive) return { ...result, originalText: text, filteredText: text, sensitiveWordsFound: 0 };
  let filtered = text;
  for (const { word } of result.sensitiveWords) {
    filtered = filtered.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replacement);
  }
  return { originalText: text, filteredText: filtered, isSensitive: true, sensitiveWordsFound: result.sensitiveWords.length, sensitiveWords: result.sensitiveWords };
}

const server = new FastMCP({
  name: "sensitive-lexicon-mcp",
  version: "1.0.0",
  transportType: "stdio",
});

server.addTool({
  name: "detect_sensitive_words",
  description: "Detect sensitive words in text",
  parameters: z.object({
    text: z.string(),
    categories: z.array(z.string()).optional(),
  }),
  execute: async (args) => {
    if (!isInitialized) await initialize();
    try {
      console.log("[sensitive-lexicon] Request detect_sensitive_words:", { textLength: args.text.length, categories: args.categories });
      const result = detect(args.text, args.categories);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error("[sensitive-lexicon] Error detect_sensitive_words:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
});

server.addTool({
  name: "filter_sensitive_words",
  description: "Filter sensitive words from text",
  parameters: z.object({
    text: z.string(),
    replacement: z.string().optional().default("***"),
    categories: z.array(z.string()).optional(),
  }),
  execute: async (args) => {
    if (!isInitialized) await initialize();
    try {
      console.log("[sensitive-lexicon] Request filter_sensitive_words:", { textLength: args.text.length, categories: args.categories });
      const result = filter(args.text, args.replacement, args.categories);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error("[sensitive-lexicon] Error filter_sensitive_words:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
});

server.addTool({
  name: "get_categories",
  description: "Get available sensitive word categories",
  parameters: z.object({}),
  execute: async () => {
    if (!isInitialized) await initialize();
    try {
      console.log("[sensitive-lexicon] Request get_categories");
      return JSON.stringify({ categories: [...wordLists.keys()], totalCategories: wordLists.size }, null, 2);
    } catch (error) {
      console.error("[sensitive-lexicon] Error get_categories:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
});

server.addTool({
  name: "get_word_count",
  description: "Get word count for a category or total",
  parameters: z.object({
    category: z.string().optional(),
  }),
  execute: async (args) => {
    if (!isInitialized) await initialize();
    try {
      const count = args.category
        ? (wordLists.get(args.category)?.size || 0)
        : [...wordLists.values()].reduce((s, w) => s + w.size, 0);
      console.log("[sensitive-lexicon] Request get_word_count:", { category: args.category || "total", count });
      return JSON.stringify({ category: args.category || "total", wordCount: count }, null, 2);
    } catch (error) {
      console.error("[sensitive-lexicon] Error get_word_count:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
});

server.start();
