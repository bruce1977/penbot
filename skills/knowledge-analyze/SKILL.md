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
2. 计算内容 hash（见下方「hash 提取」）
3. 调用 LLM 提取元数据
4. 写入 `{file}.meta.json`（`{file}` = 文章文件名去 `.md` 扩展的基础名，即 `{file}.md` → `{file}.meta.json`，**不含 `.md`**，与 `.md` 同目录并列存放）

已有 `.meta.json` 的文件跳过（缓存策略，幂等）。

## hash 提取

每篇文章需计算**内容 hash**（12 位十六进制），用于导入知识库时精确去重。hash 由脚本计算，**不依赖 LLM**：

```
node skills/knowledge-analyze/scripts/hash_content.js {file}.md
```

- 对文件内容进行 **3 轮 sha256 迭代**，取前 12 位十六进制作为 hash
- 同一文章内容恒定、hash 恒定；内容不同则 hash 不同
- 将结果写入 `.meta.json` 的 `hash` 字段

> hash 计算必须使用脚本，不得由 LLM 自行"生成"（LLM 无法精确计算）。若脚本输出异常，该篇标记失败跳过。

## 元数据标准

每篇产出 `.meta.json`：

```json
{
  "hash": "c1b3a308d5b8",
  "title": "MoE架构：稀疏激活与大模型容量",
  "date": "2026-07-31T10:30:00+08:00",
  "auther": "科技兽",
  "source": "https://mp.weixin.qq.com/s/...",
  "tags": ["大模型", "开源", "MoE"],
  "summary": "MoE架构通过稀疏激活在同等算力下实现更大模型容量。",
  "keywords": ["MoE", "稀疏激活"],
  "model": "opencode/mimo-v2.5-free"
}
```

| 字段 | 类型 | 必填 | 提取规则 |
|------|------|------|---------|
| `hash` | string | 是 | **内容 hash**（12 位十六进制），用 `node skills/knowledge-analyze/scripts/hash_content.js {file}.md` 计算，不得手写 |
| `title` | string | 是 | 文章标题。**优先从文件名提取**：采集文件名格式 `{fakeid}_{index}_{date}_{account}_{title}.md`，去掉前四段（fakeid、序号、日期、公众号名）后剩余部分即标题（可含下划线/逗号等）；文件名无法解析出标题时，回退到正文首部标题（setext 标题或 `#` 标题），不含 markdown 标记 |
| `date` | string | 是 | **打标时刻**，ISO 8601 含时区（如 `2026-07-31T10:30:00+08:00`），非文章发布时间 |
| `auther` | string | 否 | 从文章**正文内检索**作者/公众号名（如"原创 xx"、"作者：xx"）；正文确实无作者信息时输出空字符串 `""` |
| `source` | string | 否 | 原文链接（正文首部或上下文可得） |
| `tags` | string[] | 是 | 2-5 个标签，精准概括文章主题，避免泛词（如"AI"）单独成标签 |
| `summary` | string | 是 | 1-2 句核心摘要，覆盖关键观点与结论 |
| `keywords` | string[] | 是 | 3-5 个关键词/短语，辅助检索 |
| `model` | string | 是 | **打标所用模型名称**，由模型**自动输出自身正在运行的模型 ID/名称**（如 `opencode/mimo-v2.5-free`），不读取任何配置、不手写虚构值；用于追溯元数据来源 |

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
| `{inbox}/{file}.meta.json` | 每篇的元数据缓存（含 `hash`），供 `analyze_to_marked.js` 合并为 frontmatter |

Base directory for this skill: skills/knowledge-analyze
