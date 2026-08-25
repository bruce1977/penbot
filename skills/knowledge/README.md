# 知识库管线 (knowledge)

知识库管线的核心技能，提供四大功能：初始化、文档分析、同步导入 WeKnora、归档旧文件。

## 功能一览

| 功能 | 脚本 | 说明 |
|------|------|------|
| init | `init_start.js` | 初始化目录结构和 `.config/config.json` |
| analyze | `analyze_start.js` | 元数据提取 + 五维评分 + 合并 frontmatter |
| sync | `weknora_start_to_sync.js` | 将终稿导入 WeKnora 远程知识库 |
| archive | `archive_start.js` | 按文件年龄归档旧文件 |

## 目录结构

```
${profile}/
├── .config/
│   ├── config.json              ← 主配置文件
│   ├── prompts/                 ← 自定义提示词（可选）
│   │   ├── meta.json
│   │   └── rate.json
│   └── schema/                  ← 自定义数据结构（可选）
│       ├── meta.json
│       └── rate.json
├── inbox/                       ← 原始文档
├── marked/                      ← 已分析文档
├── weknora/                     ← 已同步文档
└── archive/                     ← 归档文档
```

## 快速开始

### 初始化

```bash
node skills/knowledge/scripts/init_start.js <base_dir>
```

### 文档分析

```bash
node scripts/kb-analyze.js <profile> [batch_size]
```

### 同步到 WeKnora

```bash
node scripts/kb-weknora.js <profile> [submit_interval_ms]
```

### 归档

```bash
node scripts/kb-archive.js <profile> [days]
```

## 环境变量

### 分析功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KB_LLM_BASE_URL` | `http://localhost:11434/v1` | LLM API 地址 |
| `KB_LLM_API_KEY` | 空 | LLM API 密钥 |
| `KB_LLM_MODEL` | `qwen2.5:3b` | 默认模型 |
| `KB_LLM_META_MODEL` | 继承 `KB_LLM_MODEL` | 元数据提取专用模型 |
| `KB_LLM_RATE_MODEL` | 继承 `KB_LLM_MODEL` | 评分提取专用模型 |
| `KB_LLM_TIMEOUT_MS` | `120000` | 单次 LLM 请求超时 |
| `KB_LLM_PROVIDER` | `auto` | 后端类型：`auto`/`ollama`/`openai` |

### 同步功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PB_KNOWLEDGE_BASE_PATH` | 必填 | 知识库根目录 |
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |

## 自定义提示词与数据结构

在 `${profile}/.config/prompts/` 和 `${profile}/.config/schema/` 中放置同名文件可覆盖默认配置：

| 可选文件 | 作用 |
|---------|------|
| `.config/prompts/meta.json` | 覆盖元数据提取提示词 |
| `.config/prompts/rate.json` | 覆盖评分提取提示词 |
| `.config/schema/meta.json` | 覆盖元数据 JSON Schema |
| `.config/schema/rate.json` | 覆盖评分 JSON Schema |

默认文件位于 `skills/knowledge/prompts/` 和 `skills/knowledge/schemas/`。

## 跨厂商配置（LLM 后端）

LLM 客户端（`scripts/lib/llm.js`）使用 **OpenAI 兼容的 `/v1/chat/completions` 协议**，可对接任意兼容该协议的后端。

- **Ollama（`provider=ollama` 或 auto 命中）**：额外发送 Ollama 专属参数（`num_predict`、`num_ctx`、`top_k`、`repeat_penalty`、`keep_alive=-1`）
- **OpenAI 兼容（`provider=openai`）**：仅发送通用参数（`temperature`、`max_tokens`）

### 切换示例

**默认——本地 Ollama**

```bash
KB_LLM_BASE_URL=http://localhost:11434/v1
KB_LLM_MODEL=qwen2.5:3b
```

**对接 OpenAI / Azure / 通义 / DeepSeek 等**

```bash
KB_LLM_PROVIDER=openai
KB_LLM_BASE_URL=https://<your-provider>/v1
KB_LLM_MODEL=gpt-4o-mini
KB_LLM_API_KEY=<your-api-key>
```

## 脚本结构

```
skills/knowledge/
├── prompts/
│   ├── meta.json                ← 元数据提取提示词（默认）
│   └── rate.json                ← 评分提取提示词（默认）
├── schemas/
│   ├── meta.json                ← 元数据 JSON Schema（默认）
│   └── rate.json                ← 评分 JSON Schema（默认）
└── scripts/
    ├── init_start.js            ← 初始化
    ├── analyze_start.js         ← 分析主入口
    ├── analyze_extract_meta.js  ← 元数据提取模块
    ├── analyze_extract_rate.js  ← 评分提取模块
    ├── analyze_frontmatter.js   ← YAML frontmatter 生成
    ├── weknora_start_to_sync.js ← 同步 WeKnora
    ├── archive_start.js         ← 归档
    └── lib/
        ├── llm.js               ← LLM 客户端
        ├── common.js            ← 通用工具函数
        ├── content_hash.js      ← 内容 hash
        └── validate_md.js       ← Markdown 格式校验

scripts/
├── kb-weknora.js                ← Weknora 同步入口
├── kb-analyze.js                ← 分析入口
└── kb-archive.js                ← 归档入口
```

## 缓存与幂等

- `.meta.json` 已存在 → 跳过元数据提取
- `.rate.json` 已存在 → 跳过评分
- 两个缓存文件都存在 → 跳过提取，直接合并
- 终稿文件名 `${title}_${hash}.md`：hash 由正文内容计算，天然去重
