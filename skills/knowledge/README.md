# 知识库管线 (knowledge)

知识库管线的核心技能，提供四大功能：初始化、文档分析、同步导入 WeKnora、归档旧文件。

## 功能一览

| 功能 | 脚本 | 说明 |
|------|------|------|
| init | `init_start.js` | 初始化目录结构和 config.json |
| analyze | `analyze_start.js` | 元数据提取 + 五维评分 + 合并 frontmatter |
| sync | `weknora_start_to_sync.js` | 将终稿导入 WeKnora 远程知识库 |
| archive | `archive_start.js` | 按文件年龄归档旧文件 |

## 快速开始

### 初始化

```bash
node skills/knowledge/scripts/init_start.js <base_dir>
```

### 文档分析

```bash
node skills/knowledge/scripts/analyze_start.js <source_dir> <target_dir> [batch_size]
```

### 同步到 WeKnora

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js <source_dir> <target_dir> <category_id>
```

### 归档

```bash
node skills/knowledge/scripts/archive_start.js <source_dir> <target_dir> [days]
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
| `KB_LLM_PROVIDER` | `auto` | 后端类型：`auto`（按 `KB_LLM_BASE_URL` 是否含 `11434`/`ollama` 自动识别）/`ollama`/`openai`。决定本次请求是否附加 Ollama 专属参数 |

### 同步功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |
| `SUBMIT_INTERVAL_MS` | `10000` | 提交间隔 |
| `SYNC_SCRIPT_TIMEOUT_MS` | `600000` | 脚本整体超时 |

## 跨厂商配置（LLM 后端）

LLM 客户端（`scripts/lib/llm.js`）使用 **OpenAI 兼容的 `/v1/chat/completions` 协议**，因此可对接任意兼容该协议的后端。参数按后端类型动态下发：

- **Ollama（`provider=ollama` 或 auto 命中）**：除通用参数（`temperature`、`max_tokens`）外，额外发送 Ollama 专属参数——`num_predict`（输出上限）、`num_ctx`（上下文窗口）、`top_k`、`repeat_penalty`、`keep_alive=-1`（模型常驻，批处理时前缀 KV cache 可跨文件复用）。这是本地 CPU 推理性能优化的关键。
- **OpenAI 兼容（`provider=openai`，如 OpenAI / Azure / 通义 / DeepSeek / vLLM / LM Studio）**：仅发送通用参数（`temperature`、`max_tokens`），不含任何 Ollama 专属字段，避免未知字段报错；`max_tokens=400` 生效，防止输出跑飞。

### 切换示例

**默认——本地 Ollama**

```bash
KB_LLM_BASE_URL=http://localhost:11434/v1
KB_LLM_MODEL=qwen2.5:3b
# KB_LLM_PROVIDER 省略即 auto，按 base_url 自动识别为 ollama
```

**换 Ollama 上的其他模型**（仅改模型名，其余不变）

```bash
KB_LLM_MODEL=qwen2.5:7b
```

**对接 OpenAI / Azure / 通义 / DeepSeek 等**

```bash
KB_LLM_PROVIDER=openai
KB_LLM_BASE_URL=https://<your-provider>/v1      # 如 https://api.openai.com/v1
KB_LLM_MODEL=gpt-4o-mini                         # 使用对方模型名
KB_LLM_API_KEY=<your-api-key>                    # 必需
```

> 注：`KB_LLM_META_MODEL` / `KB_LLM_RATE_MODEL` 可在 analyze 阶段为「元数据提取」与「评分提取」分别指定不同模型（继承自 `KB_LLM_MODEL`），与后端切换相互独立。

## 脚本结构

```
scripts/
├── init_start.js            ← 初始化
├── analyze_start.js         ← 分析主入口
├── analyze_extract_meta.js  ← 元数据提取（in-process 模块）
├── analyze_extract_rate.js  ← 评分提取（in-process 模块）
├── analyze_merge.js         ← 合并 frontmatter（in-process 模块）
├── weknora_start_to_sync.js ← 同步 WeKnora
├── archive_start.js         ← 归档
└── lib/
    ├── llm.js               ← LLM 客户端
    └── content_hash.js      ← 内容 hash
```

## 处理流程（分析功能）

```
source_dir/*.md
  │
  ▼  剥离 frontmatter → 写入临时文件（source_dir/{ts}_{basename}）
  │
  ├──→ analyze_extract_meta.js → .meta.json（并发）
  ├──→ analyze_extract_rate.js → .rate.json（并发）
  │
  ▼
analyze_merge.js → 合并 frontmatter
  │
  ▼  写入 target_dir/{hash}_{title}.md
  ▼  清理：删除源文件 + 临时文件 + JSON 副产物
  ▼
done
```

## 缓存与幂等

- `.meta.json` 已存在（源目录内） → 跳过元数据提取
- `.rate.json` 已存在（源目录内） → 跳过评分
- 两个缓存文件都存在 → 跳过提取，直接合并
- 终稿文件名 `{hash}_{title}.md`：hash 由正文内容计算，相同正文文件名一致（重跑覆盖）
- 中断后重跑：缓存文件保留，自动跳过已提取的文件
