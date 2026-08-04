---
name: knowledge
description: "知识库管线技能：文档分析（元数据提取+评分+合并）、同步导入 WeKnora、归档旧文件。通过不同提示词选择功能。"
---

# 知识库管线 (knowledge)

知识库管线的核心技能，提供三大功能：

| 功能 | 脚本 | 说明 |
|------|------|------|
| **analyze** | `analyze_start.js` | 元数据提取 + 五维评分 + 合并 frontmatter |
| **sync** | `weknora_start_to_sync.js` | 将终稿导入 WeKnora 远程知识库 |
| **archive** | `archive_start.js` | 按文件年龄归档旧文件 |

> 本技能为**纯脚本驱动**，不依赖 LLM Agent。调用方通过不同命令选择功能。

## 功能一：文档分析 (analyze)

对源目录内的 `.md` 文章批量执行 **元数据提取 + 评分 + 合并 frontmatter**，终稿移动到目标目录。

### 调用方式

```bash
node skills/knowledge/scripts/analyze_start.js <source_dir> <target_dir> [batch_size]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 源文章目录 |
| `<target_dir>` | 是 | 终稿输出目录 |
| `[batch_size]` | 否 | 批处理文件数上限，默认 30 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `KB_LLM_BASE_URL` | 否 | `http://localhost:11434/v1` | LLM API 地址（OpenAI 兼容） |
| `KB_LLM_API_KEY` | 否 | 空 | LLM API 密钥（Ollama 可留空） |
| `KB_LLM_MODEL` | 否 | `qwen2.5:3b` | 默认模型（meta 和 rate 共用） |
| `KB_LLM_META_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 元数据提取专用模型（覆盖默认） |
| `KB_LLM_RATE_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 评分提取专用模型（覆盖默认） |
| `KB_LLM_TIMEOUT_MS` | 否 | `120000` | 单次 LLM 请求超时（毫秒） |

### 脚本架构

```
analyze_start.js                 ← 主入口：编排全流程
├── lib/llm.js                   ← LLM 客户端 + 工具函数
├── lib/content_hash.js          ← 内容 hash（3 轮 sha256，12 位 hex）
├── analyze_extract_meta.js      ← 元数据提取（in-process 模块）
├── analyze_extract_rate.js      ← 评分提取（in-process 模块）
└── analyze_merge.js             ← 合并 frontmatter（in-process 模块）
```

### 提示词与功能映射

| 提示词文件 | 调用脚本 | 功能 | 接收变量 |
|-----------|---------|------|---------|
| `prompts/meta_prompt.txt` | `analyze_extract_meta.js` | 元数据提取（标题/作者/标签/摘要/关键词） | `{{title}}`、`{{content}}` |
| `prompts/rate_prompt.txt` | `analyze_extract_rate.js` | 五维评分（商业/技术/传播/学术/伦理） | `{{content}}` |

### 处理流程

```
source_dir/*.md
  │
  ▼  剥离 frontmatter → 写 .tmp/ 临时文件
  │
  ├──→ analyze_extract_meta.js（Ollama） → .tmp/{ts}*.meta.json
  ├──→ analyze_extract_rate.js（Ollama） → .tmp/{ts}*.rate.json
  │         （并发执行）
  ▼
analyze_merge.js → 合并为 frontmatter JSON
  │
  ▼  主流程：写入 target_dir/{hash}_{title}.md
  │         删除源 .md + .meta.json + .rate.json
  │         清理 .tmp/
  ▼
done
```

### 元数据标准

每篇产出 `.meta.json`：

```json
{
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
| `title` | string | 是 | 优先从文件名提取（`{fakeid}_{index}_{date}_{account}_{title}.md` 去掉前四段）；回退正文首部标题 |
| `date` | string | 是 | **打标时刻**（ISO 8601 含时区），非文章发布时间 |
| `auther` | string | 否 | 从正文检索作者/公众号名；无则 `""` |
| `source` | string | 否 | 原文链接 |
| `tags` | string[] | 是 | 2-5 个标签，精准概括主题，避免泛词单独成标签 |
| `summary` | string | 是 | 1-2 句核心摘要，覆盖关键观点与结论 |
| `keywords` | string[] | 是 | 3-5 个关键词/短语，辅助检索 |
| `model` | string | 是 | Ollama 模型名称（自动读取环境变量） |

> `hash` 不写入 `.meta.json`：它在 `analyze_merge` 阶段由**正文内容**（已剥离元数据）经 `lib/content_hash.js` 计算，写入最终 `.md` 的 frontmatter，并作为文件名前缀 `${hash}_${title}`。

### 评分标准

每篇产出 `.rate.json`：

```json
{
  "ratings": { "value": 4, "tech": 5, "public": 3, "academic": 2, "ethics": 5 },
  "model": "qwen2.5:3b"
}
```

| 维度 | 含义 | 评分范围 |
|------|------|---------|
| `value` | 商业与市场价值 | 0.5-5 |
| `tech` | 技术创新与工程实现 | 0.5-5 |
| `public` | 公众传播与社会影响力 | 0.5-5 |
| `academic` | 学术研究价值 | 0.5-5 |
| `ethics` | 伦理合规与社会责任 | 0.5-5 |

每个维度都必须给出 0.5-5 之间的分数，**禁止输出 null**。若模型仍输出 null 或越界值，视为该次评分失败并自动重试（最多 3 次）；重试仍失败则该篇标记为 `failed`。

### 缓存与幂等

- `.meta.json` 已存在 → 跳过该篇元数据提取
- `.rate.json` 已存在 → 跳过该篇评分
- 终稿文件名 `${hash}_${title}.md`：`hash` 由正文内容计算，相同正文必产生相同文件名，天然去重
- 中断后重跑自动续处理

---

## 功能二：同步导入 WeKnora (sync)

将 `{source}` 目录中带 frontmatter 的终稿逐篇导入 WeKnora 知识库（文章 + 标签），导入成功后移动到 `{target}` 目录。

### 调用方式

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js <source_dir> <target_dir> <category_id>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 带 frontmatter 的终稿目录（如 `marked/`） |
| `<target_dir>` | 是 | 已同步文章存放目录（导入成功后 move 到此） |
| `<category_id>` | 是 | WeKnora 知识库 ID |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WEKNORA_BASE_URL` | 是 | — | WeKnora API 基础地址 |
| `WEKNORA_API_KEY` | 是 | — | API 密钥（X-API-Key 头） |
| `SUBMIT_INTERVAL_MS` | 否 | `10000` | 每篇提交后等待间隔（毫秒） |
| `SYNC_SCRIPT_TIMEOUT_MS` | 否 | `600000` | 脚本整体超时 |

### 执行步骤

1. **导入前查重（hash+title）**：分页拉取库内已有标题，建立标题集合
2. **逐篇导入**：遍历 `{source}/*.md`，每篇：
   - 解析 frontmatter：`hash`、`title`、`tags`、正文 body
   - 提交标题 = `${hash}_${title}`（无 `hash` 字段的旧文件回退为 `title`）
   - 若提交标题已存在于知识库 → `SKIP`（不建标签、不提交，直接移动）
   - 创建/复用标签：查找缺失则创建
   - 导入文章：`POST /knowledge-bases/{category_id}/knowledge/manual`
   - 成功后 `Move` 到 `{target}/`
3. **结果汇总**：输出同步成功/失败数量；失败篇保留在 `{source}` 待重试

> **查重键 = hash + title**：hash 由子流程 2.2 计算（3 轮 sha256 取 12 位），写于 frontmatter `hash` 字段与文件名前缀。提交标题 `${hash}_${title}` 使 hash 随标题进入 WeKnora，库内标题集合即可精确判断重复。

### 产出

| 文件 | 说明 |
|------|------|
| `{target}/{file_name}` | 已成功导入 WeKnora 的文章 |

### 错误处理

| 场景 | 处理 |
|------|------|
| 单篇导入失败 | 记录 FAIL，保留在 `{source}`，继续处理其他篇 |
| API 频率限制 / 网络错误 | 单篇失败重试由调用方控制（可重新运行脚本） |
| 内容重复（hash+title 命中库内已有文章） | SKIP 并移动至 `{target}`，不重复提交 |

### 禁止事项

- **绝不自动删除知识库文档**：本功能只负责新增/跳过导入，不得调用 `DELETE /knowledge/:id` 或任何清理接口。

---

## 功能三：归档 (archive)

将 `{source}` 中超过指定天数的旧文件移动到 `{target}` 目录。

### 调用方式

```bash
node skills/knowledge/scripts/archive_start.js <source_dir> <target_dir> [days]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 待归档目录（如 `weknora/`） |
| `<target_dir>` | 是 | 归档输出目录（如 `archive/`） |
| `[days]` | 否 | 文件年龄阈值（默认 90 天），按文件 mtime 计算 |

### 处理逻辑

按文件 mtime 判断年龄，超过阈值天数的 `.md` 移动到 `{target}/`。支持跨分区文件移动。

### 产出

| 文件 | 说明 |
|------|------|
| `{target}/*.md` | 已归档的旧文件 |

### 错误处理

| 场景 | 处理 |
|------|------|
| 源目录不存在 | 报错退出 |
| 无文件 | 正常结束 |

---

## 脚本结构总览

```
skills/knowledge/
├── SKILL.md
├── README.md
├── prompts/
│   ├── meta_prompt.txt          ← 元数据提取 prompt
│   └── rate_prompt.txt          ← 五维评分 prompt
└── scripts/
    ├── analyze_start.js         ← 功能一：分析主入口
    ├── analyze_extract_meta.js  ← 元数据提取（in-process 模块）
    ├── analyze_extract_rate.js  ← 评分提取（in-process 模块）
    ├── analyze_merge.js         ← 合并 frontmatter（in-process 模块）
    ├── weknora_start_to_sync.js ← 功能二：同步 WeKnora
    ├── archive_start.js         ← 功能三：归档
    └── lib/
        ├── llm.js               ← LLM 客户端 + 工具函数
        └── content_hash.js      ← 内容 hash（3 轮 sha256）
```

Base directory for this skill: skills/knowledge
