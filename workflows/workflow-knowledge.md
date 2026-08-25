---
name: workflow-knowledge
---

# 知识库管线

> **入口命令**：`/cmd-knowledge <profile>`
> **技能加载**：`skills/knowledge/SKILL.md`
> **脚本目录**：`skills/knowledge/scripts`
> **基准目录**：`{PB_KNOWLEDGE_BASE_PATH}/{profile}/`

---

## 目录结构

```
{PB_KNOWLEDGE_BASE_PATH}/{profile}/
├── inbox/      ← 用户手动放置 .md 文档
├── marked/     ← 分析后带 frontmatter 的文档
├── weknora/    ← 已同步到 WeKnora 的文档
├── archive/    ← 归档的旧文档
└── config.json ← 知识库配置
```

---

## config.json

```json
{
  "weknora": {
    "source_folder": "marked",
    "target_folder": "weknora",
    "kb_id": "",
    "wiki_kb_id": "",
    "score_threshold": 3.5,
    "submit_interval_ms": 6000,
    "sync_enabled": true,
    "custom_metas": {
      "source": "$source",
      "author": "$auther",
      "aliases": "$aliases",
      "score": "$score",
      "channel": "wechat-mp"
    }
  },
  "archive": {
    "days": 90
  },
  "analyze": {
    "batch_size": 30
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `weknora.source_folder` | string | `"marked"` | 待同步文档目录 |
| `weknora.target_folder` | string | `"weknora"` | 已同步文档目录 |
| `weknora.kb_id` | string | `""` | 目标知识库 ID |
| `weknora.wiki_kb_id` | string | `""` | wiki 知识库 ID（可选，配了启用评分分流） |
| `weknora.score_threshold` | number | `0` | 评分阈值（score ≥ 阈值 → wiki） |
| `weknora.submit_interval_ms` | number | `6000` | 每篇提交间隔（毫秒） |
| `weknora.sync_enabled` | boolean | `true` | 是否启用 WeKnora 同步 |
| `weknora.custom_metas` | object | `{}` | 自定义元数据字段映射 |
| `archive.days` | number | `90` | 归档文件年龄阈值（天） |
| `analyze.batch_size` | number | `30` | 分析批处理文件数上限 |

---

## 流程一：初始化

自动创建 `{profile}/` 下的目录结构和默认 `config.json`。幂等操作——已存在的目录/文件不会被覆盖。

### 脚本

```bash
node skills/knowledge/scripts/init_start.js <base_dir>
```

### 示例

```bash
node skills/knowledge/scripts/init_start.js D:/knowledge/articles/ai
```

### 自动初始化

以下流程在执行前会检查目标目录是否存在，若不存在则自动调用初始化：

| 流程 | 检查目录 | 自动初始化触发条件 |
|------|---------|-------------------|
| 流程三（分析） | `{inbox}` | `inbox/` 不存在时自动创建 |
| 流程四（同步） | `{marked}`、`{weknora}` | `marked/` 或 `weknora/` 不存在时自动创建 |
| 流程五（归档） | `{weknora}`、`{archive}` | `weknora/` 或 `archive/` 不存在时自动创建 |

---

## 流程二：采集（手动）

用户将待处理的 `.md` 文档手动放入 `{inbox}/` 目录。无自动化脚本。

---

## 流程三：文档分析

对 `{inbox}/` 内 `.md` 批量执行 **元数据提取 + 五维评分 + 合并 frontmatter**，终稿移动到 `{marked}/`。

### 脚本

```bash
node skills/knowledge/scripts/analyze_start.js <source_dir> <target_dir> [batch_size]
```

### 示例

```bash
node skills/knowledge/scripts/analyze_start.js \
  D:/knowledge/articles/ai/inbox \
  D:/knowledge/articles/ai/marked
```

### 参数说明

| 参数 | 必填 | 说明 | 配置来源 |
|------|------|------|---------|
| `<source_dir>` | 是 | 源文章目录 | 固定为 `{profile}/inbox` |
| `<target_dir>` | 是 | 终稿输出目录 | 固定为 `{profile}/marked` |
| `[batch_size]` | 否 | 批处理文件数上限 | `config.json → analyze.batch_size`，默认 30 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `KB_LLM_BASE_URL` | 否 | `http://localhost:11434/v1` | LLM API 地址 |
| `KB_LLM_API_KEY` | 否 | 空 | LLM API 密钥 |
| `KB_LLM_MODEL` | 否 | `qwen2.5:3b` | 默认模型 |
| `KB_LLM_META_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 元数据提取专用模型 |
| `KB_LLM_RATE_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 评分提取专用模型 |
| `KB_LLM_TIMEOUT_MS` | 否 | `120000` | 单次 LLM 请求超时（毫秒） |

---

## 流程四：同步导入 WeKnora

将 `{marked}/` 中带 frontmatter 的终稿逐篇导入 WeKnora：创建临时库（无摘要模型）→ 导入解析 → PUT 本地摘要/元数据 → 按评分分流到目标库 → 删除临时库。

> 前置条件：`config.json → weknora.kb_id` 非空且 `weknora.sync_enabled` 为 `true`。

### 脚本

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js <source_dir> <target_dir> <config.json>
```

### 示例

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js \
  D:/knowledge/articles/ai/marked \
  D:/knowledge/articles/ai/weknora \
  D:/knowledge/articles/ai/config.json
```

### config.json 结构

```json
{
  "kb_id": "目标知识库 ID",
  "wiki_kb_id": "wiki 知识库 ID（可选）",
  "score_threshold": 3.5,
  "custom_metas": {
    "source": "$source",
    "author": "$auther",
    "aliases": "$aliases",
    "score": "$score",
    "channel": "wechat-mp"
  }
}
```

### 参数说明

| 参数 | 必填 | 说明 | 配置来源 |
|------|------|------|---------|
| `<source_dir>` | 是 | 带 frontmatter 的终稿目录 | 固定为 `{profile}/marked` |
| `<target_dir>` | 是 | 已同步文章存放目录 | 固定为 `{profile}/weknora` |
| `<config.json>` | 是 | 配置文件路径 | `config.json → weknora` 字段 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WEKNORA_BASE_URL` | 是 | — | WeKnora API 基础地址 |
| `WEKNORA_API_KEY` | 是 | — | API 密钥（导入/PUT/临时库创建删除均使用此 key） |
| `SYNC_POLL_INTERVAL_MS` | 否 | `10` | 解析状态轮询间隔（毫秒） |
| `SYNC_POLL_TIMEOUT_MS` | 否 | `30000` | 单篇解析超时（毫秒） |
| `SYNC_SCRIPT_TIMEOUT_MS` | 否 | `600000` | 脚本整体超时 |

### 执行步骤

1. 创建临时库（无摘要模型，零 LLM 调用）
2. 分页拉取目标库已有 hash，建立去重集合
3. 遍历 `{source}/*.md`，每篇：
   - 解析 frontmatter → title = `${title}_${hash}`
   - `POST /knowledge/manual` 导入临时库
   - 轮询 parse_status（10ms/30s）直到向量化完成
   - `PUT /knowledge/:id` 上传 description + custom_metadata
   - 记录目标库（score ≥ threshold → wiki_kb_id，否则 → kb_id）
4. 按目标库分组，批量 `POST /knowledge/move`（reuse_vectors）
5. 删除临时库
6. 失败篇保留在 `{source}` 待重试

---

## 流程五：归档

将 `{weknora}/` 中超过指定天数的旧文件移动到 `{archive}/`。

### 脚本

```bash
node skills/knowledge/scripts/archive_start.js <source_dir> <target_dir> [days]
```

### 示例

```bash
node skills/knowledge/scripts/archive_start.js \
  D:/knowledge/articles/ai/weknora \
  D:/knowledge/articles/ai/archive \
  90
```

### 参数说明

| 参数 | 必填 | 说明 | 配置来源 |
|------|------|------|---------|
| `<source_dir>` | 是 | 待归档目录 | 固定为 `{profile}/weknora` |
| `<target_dir>` | 是 | 归档输出目录 | 固定为 `{profile}/archive` |
| `[days]` | 否 | 文件年龄阈值（天） | `config.json → archive.days`，默认 90 |

---

## 脚本总览

| 脚本 | 对应流程 | 说明 |
|------|---------|------|
| `init_start.js` | 流程一 | 初始化目录结构和 config.json |
| `analyze_start.js` | 流程三 | 元数据提取 + 五维评分 + 合并 frontmatter |
| `weknora_start_to_sync.js` | 流程四 | 同步导入 WeKnora 知识库 |
| `archive_start.js` | 流程五 | 按文件年龄归档旧文件 |

所有脚本位于 `skills/knowledge/scripts/`，详细用法见 [skills/knowledge/SKILL.md](../skills/knowledge/SKILL.md)。
