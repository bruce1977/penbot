import { FastMCP } from "fastmcp";
import { z } from "zod";
import axios from "axios";

const API_BASE = process.env.PB_WECHAT_MP_API_BASE || "https://mp.myehome.top/api/public/v1";
const AUTH_KEY = process.env.PB_WECHAT_MP_AUTH_KEY;

if (!AUTH_KEY) {
  console.error("[wechat-mcp] Error: PB_WECHAT_MP_AUTH_KEY environment variable is not set");
  process.exit(1);
}

const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "X-Auth-Key": AUTH_KEY },
});

const server = new FastMCP({
  name: "wechat-mp-mcp",
  version: "1.0.0",
  transportType: "stdio",
});

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function fetchSingleAccount(fakeid, size, days_to_filter, filter_deleted) {
  const res = await apiClient.get("/article", { params: { fakeid, size } });
  let articles = res.data?.articles || [];
  if (filter_deleted) {
    articles = articles.filter((a) => a.is_deleted !== true);
  }
  if (days_to_filter && days_to_filter > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - days_to_filter * 86400;
    articles = articles.filter((a) => a.update_time >= cutoff);
  }
  return articles.map((a) => ({ ...a, fake_id: fakeid }));
}

server.addTool({
  name: "get_article_list",
  description: "Get article lists from WeChat official accounts. Supports batch (fake_ids) or single (fakeid).",
  parameters: z.object({
    fake_ids: z.array(z.string()).optional(),
    fakeid: z.string().optional(),
    size: z.number().optional().default(5),
    days_to_filter: z.number().optional(),
    filter_deleted: z.boolean().optional().default(true),
  }),
  execute: async (args) => {
    try {
      const { fake_ids, fakeid, size, days_to_filter, filter_deleted } = args;
      const ids = fake_ids || (fakeid ? [fakeid] : []);
      if (ids.length === 0) {
        return JSON.stringify({ error: "Must provide either fake_ids (array) or fakeid (string)" });
      }
      console.log("[wechat-mcp] Request get_article_list:", { ids_count: ids.length, size, days_to_filter, filter_deleted });
      const allArticles = [];
      const chunks = chunkArray(ids, 10);
      for (const chunk of chunks) {
        const results = await Promise.all(
          chunk.map((id) => fetchSingleAccount(id, size, days_to_filter, filter_deleted))
        );
        for (const articles of results) {
          allArticles.push(...articles);
        }
      }
      return JSON.stringify({ articles: allArticles, total_count: allArticles.length }, null, 2);
    } catch (error) {
      console.error("[wechat-mcp] Error get_article_list:", error.response?.data || error.message);
      return JSON.stringify({ error: error.response?.data || error.message });
    }
  },
});

server.addTool({
  name: "get_article_content",
  description: "Get WeChat article content by URL. Returns plain text for html/markdown/text formats.",
  parameters: z.object({
    url: z.string(),
    format: z.string().optional().default("markdown"),
  }),
  execute: async (args) => {
    try {
      const { url, format } = args;
      console.log("[wechat-mcp] Request get_article_content:", { url, format });
      const res = await apiClient.get("/download", { params: { url, format } });
      console.log("[wechat-mcp] Response get_article_content: [success]");
      let content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      if (format === "markdown") {
        const idx = content.indexOf("![cover_image]");
        if (idx !== -1) {
          content = content.substring(idx);
        }
      }
      return content;
    } catch (error) {
      console.error("[wechat-mcp] Error get_article_content:", error.response?.data || error.message);
      return JSON.stringify({ error: error.response?.data || error.message });
    }
  },
});

server.addTool({
  name: "search_account",
  description: "Search WeChat official accounts by keyword, returns account info including fakeid",
  parameters: z.object({
    keyword: z.string(),
  }),
  execute: async (args) => {
    try {
      const { keyword } = args;
      console.log("[wechat-mcp] Request search_account:", { keyword });
      const res = await apiClient.get("/account", { params: { keyword } });
      console.log("[wechat-mcp] Response search_account:", res.data);
      return JSON.stringify(res.data, null, 2);
    } catch (error) {
      console.error("[wechat-mcp] Error search_account:", error.response?.data || error.message);
      return JSON.stringify({ error: error.response?.data || error.message });
    }
  },
});

server.start();
