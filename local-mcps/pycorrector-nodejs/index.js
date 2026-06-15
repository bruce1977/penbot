import { FastMCP } from "fastmcp";
import { z } from "zod";
import axios from "axios";

const API_BASE = process.env.PYCORRECTOR_API_URL;
if (!API_BASE) {
  console.error("[pycorrector] Error: PYCORRECTOR_API_URL environment variable is not set");
  process.exit(1);
}

const server = new FastMCP({
  name: "pycorrector-mcp",
  version: "1.0.0",
  transportType: "stdio",
});

function splitSentences(text) {
  const raw = text.split(/(?<=[。！？；\n])/);
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}

function mergeResults(results) {
  const allErrors = [];
  const originalParts = [];
  const correctedParts = [];
  let offset = 0;

  for (const r of results) {
    originalParts.push(r.original || "");
    correctedParts.push(r.corrected || "");
    if (r.errors && Array.isArray(r.errors)) {
      for (const err of r.errors) {
        allErrors.push([err[0], err[1], err[2] + offset, err[3] + offset]);
      }
    }
    offset += (r.original || "").length;
  }

  return {
    original: originalParts.join(""),
    corrected: correctedParts.join(""),
    errors: allErrors,
  };
}

server.addTool({
  name: "get_correct",
  description: "Detect and correct Chinese text typos sentence by sentence",
  parameters: z.object({
    text: z.string(),
  }),
  execute: async (args) => {
    try {
      const { text } = args;
      const sentences = splitSentences(text);

      // Log: record request parameters
      console.log('[pycorrector] Request:', { text });

      const results = await Promise.allSettled(
        sentences.map(s =>
          axios.post(`${API_BASE}/correct`, { text: s })
            .then(res => res.data)
            .catch(() => ({ original: s, corrected: s, errors: [] }))
        )
      );

      const merged = mergeResults(
        results.map(r => r.status === "fulfilled" ? r.value : { original: "", corrected: "", errors: [] })
      );

      // Log: record response content
      console.log('[pycorrector] Response:', merged);

      return JSON.stringify(merged, null, 2);
    } catch (error) {
      // Log: record error
      console.error('[pycorrector] Error:', error);
      return JSON.stringify({ errors: [error.message] });
    }
  },
});

server.start();
