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

### 同步功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |
| `SUBMIT_INTERVAL_MS` | `10000` | 提交间隔 |
| `SYNC_SCRIPT_TIMEOUT_MS` | `600000` | 脚本整体超时 |

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
