# 知识库分析 (knowledge-analyze)

对源目录内的 `.md` 文章批量执行元数据提取 + 评分 + 合并 frontmatter，终稿移动到目标目录。纯脚本驱动，不依赖 LLM Agent。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `LLM_BASE_URL` | 否 | `http://localhost:11434/v1` | LLM API 地址（OpenAI 兼容） |
| `LLM_API_KEY` | 否 | 空 | LLM API 密钥（Ollama 可留空） |
| `LLM_MODEL` | 否 | `qwen2.5:3b` | 默认模型（meta 和 rate 共用） |
| `LLM_META_MODEL` | 否 | 继承 `LLM_MODEL` | 元数据提取专用模型 |
| `LLM_RATE_MODEL` | 否 | 继承 `LLM_MODEL` | 评分提取专用模型 |
| `LLM_TIMEOUT_MS` | 否 | `120000` | 单次 LLM 请求超时（毫秒） |

> 兼容任何 OpenAI 兼容 API（Ollama、DeepSeek、OpenAI 等）。Ollama 无需 API Key，留空即可。

## 快速开始

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js <source_dir> <target_dir> [batch_size]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 源文章目录 |
| `<target_dir>` | 是 | 终稿输出目录 |
| `[batch_size]` | 否 | 批处理文件数上限，默认 30 |

## 处理流程

```
source_dir/*.md
  │
  ▼  剥离 frontmatter → 写 .tmp/ 临时文件
  │
  ├──→ extract_meta.js（Ollama） → .tmp/*.meta.json
  ├──→ extract_rate.js（Ollama） → .tmp/*.rate.json
  │         （并发执行）
  ▼
merge_to_marked.js → 合并 frontmatter
  │
  ▼  写入 target_dir/{hash}_{原文件名}.md
  │  删除源 .md + .meta.json + .rate.json
  │  清理 .tmp/
  ▼
done
```

## 脚本结构

```
scripts/
├── analyze_batch.js        ← 主入口
├── extract_meta.js         ← 元数据提取（sub-process）
├── extract_rate.js         ← 评分提取（sub-process）
├── merge_to_marked.js      ← 合并 frontmatter（sub-process）
└── lib/
    ├── llm.js              ← LLM 客户端 + 工具函数
    └── content_hash.js     ← 内容 hash（3 轮 sha256）
```

## 缓存与幂等

- `.meta.json` 已存在 → 跳过元数据提取
- `.rate.json` 已存在 → 跳过评分
- `{target_dir}` 内已有 `{hash}_` 前缀文件 → 完全跳过
- 中断后重跑自动续处理
