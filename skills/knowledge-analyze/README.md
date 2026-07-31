# 微信公众号文章选题与报告生成 (wechat-mp-analyze)

对本地 Markdown 文章进行 AI 评分、标签提取、主题遴选并生成 Markdown 图文报告。

## 快速开始

输入分两个 JSON：

**files.json**
```json
[
  { "path": "D:/save/article1.md" },
  { "path": "D:/save/article2.md", "title": "标题", "account_name": "公众号" }
]
```

**settings.json**
```json
{
  "topic_count": 3,
  "topic_selection_guidance": "侧重国产替代方向",
  "output": "D:/output/reports"
}
```

## 工作流

1. **2.1 识别缓存** — `check_cached_scores.js`：扫描有 `.meta.json` 的文章跳过 AI 评分
2. **2.2 AI 评分** — LLM 对无缓存文章评分/标签/摘要 → `merge_scored_articles.js` 汇总
3. **2.3 主题遴选** — AI 排序遴选 Top N 主题
4. **3.1 主题报告** — `gen_topic_report.js` → `topic_*.md`
5. **3.2 汇总报告** — `gen_summary_report.js` → `summary_report.md`

## 环境变量

| 变量 | 说明 |
|------|------|
| `PB_MODEL_API_KEY` | LLM API 密钥（如 DeepSeek/OpenAI） |
| `PB_MODEL_BASE_URL` | LLM API 基础地址 |
