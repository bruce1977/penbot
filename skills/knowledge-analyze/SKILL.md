---
name: knowledge-analyze
description: "知识库子流程 2.2：对源目录文章批量执行 元数据提取+评分+合并 frontmatter → 目标目录。调用 analyze_batch.js 即可"
---

# 知识库分析 (knowledge-analyze)

对源目录内的 `.md` 文章批量执行 **元数据提取 + 评分 + 合并 frontmatter**，终稿移动到目标目录。

> 本技能为**纯脚本驱动**，不依赖 LLM Agent。调用方只需运行 `analyze_batch.js`，脚本内部并发调用 `extract_meta.js` + `extract_rate.js`（均走 Ollama），再由 `merge_to_marked.js` 合并输出。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `LLM_BASE_URL` | 否 | `http://localhost:11434/v1` | LLM API 地址（OpenAI 兼容） |
| `LLM_API_KEY` | 否 | 空 | LLM API 密钥（Ollama 可留空） |
| `LLM_MODEL` | 否 | `qwen2.5:3b` | 默认模型（meta 和 rate 共用） |
| `LLM_META_MODEL` | 否 | 继承 `LLM_MODEL` | 元数据提取专用模型（覆盖默认） |
| `LLM_RATE_MODEL` | 否 | 继承 `LLM_MODEL` | 评分提取专用模型（覆盖默认） |
| `LLM_TIMEOUT_MS` | 否 | `120000` | 单次 LLM 请求超时（毫秒） |

> 兼容任何 OpenAI 兼容 API（Ollama、DeepSeek、OpenAI 等）。Ollama 无需 API Key，留空即可。

## 调用方式

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js <source_dir> <target_dir> [batch_size]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 源文章目录 |
| `<target_dir>` | 是 | 终稿输出目录 |
| `[batch_size]` | 否 | 批处理文件数上限，默认 30 |

## 脚本架构

```
analyze_batch.js          ← 主入口：编排全流程
├── lib/llm.js            ← LLM 客户端 + 工具函数
├── lib/content_hash.js   ← 内容 hash（3 轮 sha256，12 位 hex）
├── extract_meta.js       ← 元数据提取（sub-process）
├── extract_rate.js       ← 评分提取（sub-process）
├── merge_to_marked.js    ← 合并 frontmatter（sub-process）
└── prompts/
    ├── meta_prompt.txt   ← 元数据提取 prompt
    └── rate_prompt.txt   ← 评分 prompt
```

## 提示词与功能映射

| 提示词文件 | 调用脚本 | 功能 | 接收变量 |
|-----------|---------|------|---------|
| `prompts/meta_prompt.txt` | `extract_meta.js` | 元数据提取（标题/作者/标签/摘要/关键词） | `{{title}}`、`{{content}}` |
| `prompts/rate_prompt.txt` | `extract_rate.js` | 五维评分（商业/技术/传播/学术/伦理） | `{{content}}` |

## 处理流程

```
source_dir/*.md
  │
  ▼  剥离 frontmatter → 写 .tmp/ 临时文件
  │
  ├──→ extract_meta.js（Ollama） → .tmp/{ts}*.meta.json
  ├──→ extract_rate.js（Ollama） → .tmp/{ts}*.rate.json
  │         （并发执行）
  ▼
merge_to_marked.js → 合并为 frontmatter JSON
  │
  ▼  主流程：写入 target_dir/{hash}_{原文件名}.md
  │         删除源 .md + .meta.json + .rate.json
  │         清理 .tmp/
  ▼
done
```

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
  "model": "qwen2.5:3b"
}
```

| 字段 | 类型 | 必填 | 提取规则 |
|------|------|------|---------|
| `hash` | string | 是 | 由 `lib/content_hash.js` 自动计算（3 轮 sha256），无需手动指定 |
| `title` | string | 是 | 优先从文件名提取（`{fakeid}_{index}_{date}_{account}_{title}.md` 去掉前四段）；回退正文首部标题 |
| `date` | string | 是 | **打标时刻**（ISO 8601 含时区），非文章发布时间 |
| `auther` | string | 否 | 从正文检索作者/公众号名；无则 `""` |
| `source` | string | 否 | 原文链接 |
| `tags` | string[] | 是 | 2-5 个标签，精准概括主题，避免泛词单独成标签 |
| `summary` | string | 是 | 1-2 句核心摘要，覆盖关键观点与结论 |
| `keywords` | string[] | 是 | 3-5 个关键词/短语，辅助检索 |
| `model` | string | 是 | Ollama 模型名称（自动读取环境变量） |

## 评分标准

每篇产出 `.rate.json`：

```json
{
  "ratings": { "value": 4, "tech": 5, "public": 3, "academic": null, "ethics": 5 },
  "model": "qwen2.5:3b"
}
```

| 维度 | 含义 | 评分范围 |
|------|------|---------|
| `value` | 商业与市场价值 | 1-5 |
| `tech` | 技术创新与工程实现 | 1-5 |
| `public` | 公众传播与社会影响力 | 1-5 |
| `academic` | 学术研究价值 | 1-5 或 null |
| `ethics` | 伦理合规与社会责任 | 1-5 |

某维评分失败则该维为 `null`，不影响其他维度与其他文章。

## 缓存与幂等

- `.meta.json` 已存在 → 跳过该篇元数据提取
- `.rate.json` 已存在 → 跳过该篇评分
- `{target_dir}` 内已有 `${hash}_` 前缀文件 → 不再重复处理
- 中断后重跑自动续处理

## 产出

| 文件 | 说明 |
|------|------|
| `{target_dir}/{hash}_{原文件名}.md` | 带 frontmatter 的终稿，hash 前缀用于去重 |

## 错误处理

| 场景 | 处理 |
|------|------|
| 单篇提取失败 | 跳过该篇，不影响其他 |
| 单维评分失败 | 该维为 `null` |
| 中间中断 | 重跑自动跳过已完成篇 |

Base directory for this skill: skills/knowledge-analyze
