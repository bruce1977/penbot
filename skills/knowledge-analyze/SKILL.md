---
name: knowledge-analyze
description: "知识库子流程 2.2 元数据提取标准：对 inbox/ 文章提取 title/date/auther/source/tags/summary/keywords → .meta.json。tagger 专用"
---

# 元数据提取标准 (knowledge-analyze)

定义知识库子流程 2.2 打标签的标准。由 `tagger` agent 对 `{KB}/articles/{profile}/inbox/` 内的文章逐篇提取元数据，产出 `.meta.json`，供后续评分与导入使用。

> 本技能**只负责元数据提取标准**。评分由 `commentator-*` 负责，元数据合并/移动见 [workflow-knowledge-analyze.md](../../workflows/workflow-knowledge-analyze.md)。

## 输入

`tagger` 扫描 `{inbox}` 目录（`{KB}/articles/{profile}/inbox/`），对每个无 `.meta.json` 的 `.md` 文件：

1. 读取 `.md` 原文
2. 调用 LLM 提取元数据
3. 写入 `{file}.meta.json`（与 `.md` 同目录并列存放）

已有 `.meta.json` 的文件跳过（缓存策略，幂等）。

## 元数据标准

每篇产出 `.meta.json`：

```json
{
  "title": "MoE架构：稀疏激活与大模型容量",
  "date": "2026-07-31T10:30:00+08:00",
  "auther": "科技兽",
  "source": "https://mp.weixin.qq.com/s/...",
  "tags": ["大模型", "开源", "MoE"],
  "summary": "MoE架构通过稀疏激活在同等算力下实现更大模型容量。",
  "keywords": ["MoE", "稀疏激活"]
}
```

| 字段 | 类型 | 必填 | 提取规则 |
|------|------|------|---------|
| `title` | string | 是 | 文章标题。**优先从文件名提取**：采集文件名格式 `{fakeid}_{index}_{date}_{account}_{title}.md`，去掉前四段（fakeid、序号、日期、公众号名）后剩余部分即标题（可含下划线/逗号等）；文件名无法解析出标题时，回退到正文首部标题（setext 标题或 `#` 标题），不含 markdown 标记 |
| `date` | string | 是 | **打标时刻**，ISO 8601 含时区（如 `2026-07-31T10:30:00+08:00`），非文章发布时间 |
| `auther` | string | 否 | 从文章**正文内检索**作者/公众号名（如"原创 xx"、"作者：xx"）；正文确实无作者信息时输出空字符串 `""` |
| `source` | string | 否 | 原文链接（正文首部或上下文可得） |
| `tags` | string[] | 是 | 2-5 个标签，精准概括文章主题，避免泛词（如"AI"）单独成标签 |
| `summary` | string | 是 | 1-2 句核心摘要，覆盖关键观点与结论 |
| `keywords` | string[] | 是 | 3-5 个关键词/短语，辅助检索 |

> **无 `category` 字段**：无固定枚举时归类值不稳定，统一以 `tags` 承载主题信息。

## 缓存策略

- `.meta.json` 已存在：跳过（不做 LLM 调用）
- 不存在：重新提取并写入

## 批量与错误处理

- 批量处理 `{inbox}` 中全部待打标文件，逐个产出 `.meta.json`
- 单篇提取失败：跳过该篇，不影响其他文章
- 中间中断：重跑即只处理仍缺 `.meta.json` 的文件（幂等可恢复）

## 产出

| 文件 | 说明 |
|------|------|
| `{inbox}/{file}.meta.json` | 每篇的元数据缓存，供 `analyze_to_marked.js` 合并为 frontmatter |

Base directory for this skill: skills/knowledge-analyze
