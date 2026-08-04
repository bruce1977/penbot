---
name: mp-knowledge
---

# 知识库管线 — 简化版

> **入口命令**：`/cmd-knowledge <profile>`
> **技能加载**：`skills/knowledge/SKILL.md`
> **脚本目录**：`skills/knowledge/scripts`

---

## 目录结构

```
{KB_base}/{profile}/
├── inbox/      ← 用户手动放置 .md 文档
├── marked/     ← 分析后带 frontmatter 的文档
├── weknora/    ← 已同步到 WeKnora 的文档
├── archive/    ← 归档的旧文档
└── config.json ← 子库配置（如 weknora category_id）
```

> `KB_base` 默认为环境变量 `PB_KNOWLEDGE_BASE_PATH` 或 `D:/knowledge/articles`。

---

## config.json

```json
{
  "weknora": {
    "category_id": "your-weknora-category-id"
  }
}
```

---

## 流程一：采集（手动）

用户将待处理的 `.md` 文档手动放入 `{inbox}/` 目录。无自动化脚本。

---

## 流程二：文档分析

对 `{inbox}/` 内 `.md` 批量执行 **元数据提取 + 五维评分 + 合并 frontmatter**，终稿移动到 `{marked}/`。

### 脚本

```bash
node skills/knowledge/scripts/analyze_start.js <source_dir> <target_dir> [batch_size]
```

### 示例

```bash
# 分析 AI 知识库
node skills/knowledge/scripts/analyze_start.js \
  D:/knowledge/articles/ai/inbox \
  D:/knowledge/articles/ai/marked
```

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

## 流程三：同步导入 WeKnora

将 `{marked}/` 中带 frontmatter 的终稿逐篇导入 WeKnora（文章 + 标签），导入成功后移动到 `{weknora}/`。

### 前置条件

1. 从 `config.json` 读取 `weknora.category_id`
2. 设置环境变量：`WEKNORA_BASE_URL`、`WEKNORA_API_KEY`

### 脚本

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js <source_dir> <target_dir> <category_id>
```

### 示例

```bash
node skills/knowledge/scripts/weknora_start_to_sync.js \
  D:/knowledge/articles/ai/marked \
  D:/knowledge/articles/ai/weknora \
  <category_id>
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WEKNORA_BASE_URL` | 是 | — | WeKnora API 基础地址 |
| `WEKNORA_API_KEY` | 是 | — | API 密钥 |
| `SUBMIT_INTERVAL_MS` | 否 | `10000` | 每篇提交后等待间隔（毫秒） |
| `SYNC_SCRIPT_TIMEOUT_MS` | 否 | `600000` | 脚本整体超时 |

### 执行步骤

1. 分页拉取库内已有标题，建立标题集合
2. 遍历 `{source}/*.md`，每篇：
   - 解析 frontmatter：`hash`、`title`、`tags`、正文 body
   - 提交标题 = `${hash}_${title}`；若已存在 → SKIP 并移动
   - 创建/复用标签 → 导入文章 → 成功后 Move 到 `{target}/`
3. 失败篇保留在 `{source}` 待重试

---

## 流程四：归档

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

---

## 脚本总览

| 脚本 | 对应流程 | 说明 |
|------|---------|------|
| `analyze_start.js` | 流程二 | 元数据提取 + 五维评分 + 合并 frontmatter |
| `weknora_start_to_sync.js` | 流程三 | 同步导入 WeKnora 知识库 |
| `archive_start.js` | 流程四 | 按文件年龄归档旧文件 |

所有脚本位于 `skills/knowledge/scripts/`，详细用法见 [skills/knowledge/SKILL.md](../skills/knowledge/SKILL.md)。
