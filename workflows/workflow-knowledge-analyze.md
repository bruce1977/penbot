---
name: mp-knowledge-analyze
description: "知识库子流程 2.2：文档分析（元数据提取+评分+合并 → marked），指定目录 + batch size + 提示词样例"
---

# 子流程 2.2：文档分析

知识库管线四子流程之一。对指定目录中的 `.md` 文章批量完成 **元数据提取 + 评分 + 合并 frontmatter**，终稿移动到目标目录。

> 本流程为**纯脚本驱动**，不依赖 LLM Agent。`coordinator` 加载 `knowledge-analyze` 技能后执行脚本即可。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{inbox}` | `{base}/inbox` | 源文章目录 |
| `{marked}` | `{base}/marked` | 终稿输出目录 |

## 调用方式

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js <source_dir> <target_dir> [batch_size]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 源文章目录 |
| `<target_dir>` | 是 | 终稿输出目录 |
| `[batch_size]` | 否 | 批处理文件数上限，默认 30 |

## 示例

### 基础用法

处理默认知识库，逐篇处理：

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js \
  D:/knowledge/articles/ai/inbox \
  D:/knowledge/articles/ai/marked \
  1
```

### 批量处理

处理指定知识库，每批 50 篇：

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js \
  D:/knowledge/articles/dev/inbox \
  D:/knowledge/articles/dev/marked \
  50
```

### 全量处理

不限 batch size，处理全部待分析文件：

```bash
node skills/knowledge-analyze/scripts/analyze_batch.js \
  D:/knowledge/articles/ai/inbox \
  D:/knowledge/articles/ai/marked
```

## 提示词样例

脚本内置两套提示词，定义了提取行为：

### 元数据提取（meta_prompt.txt）

```
你是资深内容编辑。为下面这篇文章提取元数据，只输出一个 JSON 对象。

字段要求：
- "title": 文章标题。参考标题 "{{title}}"，若与正文不符则以正文首部标题为准。
- "auther": 从正文检索作者/公众号名，找不到输出 ""。
- "source": 原文链接，无则 ""。
- "tags": 2-4 个主题分类标签，用于文章归类。禁止出现具体产品名、术语、人名。
- "summary": 一句话核心摘要（80-150 字）。禁止用"本文""文章""该文"开头。
- "keywords": 3-5 个从原文提取的单个词，用于搜索匹配。

只输出：{"title":"...","auther":"...","source":"...","tags":[...],"summary":"...","keywords":[...]}

文章内容：
{{content}}
```

### 五维评分（rate_prompt.txt）

```
你是内容评审员。根据文章内容，从5个维度各打1-5分（支持0.5），输出纯JSON。

评分标准：
- value（商业与市场）：1=纯技术探讨无商业路径，5=已有成熟商业模式
- tech（技术与工程）：1=无技术含量或纯搬运，5=原创技术方案或重大突破
- public（公众传播）：1=极小众专业话题，5=全民级话题
- academic（学术研究）：1=纯经验分享，5=开创性研究
- ethics（伦理合规）：1=存在严重伦理风险，5=完全合规且有积极社会价值

输出格式：{"value":n,"tech":n,"public":n,"academic":n,"ethics":n}

文章内容：
{{content}}
```

## 缓存与幂等

| 状态 | 重跑行为 |
|------|---------|
| 无 `.meta.json` | 执行元数据提取 |
| 有 `.meta.json`、无 `.rate.json` | 跳过提取，执行评分 |
| 有 `.meta.json` + `.rate.json` | 跳过提取和评分，执行合并 |
| 已在目标目录（`{hash}_` 前缀命中） | 完全跳过 |

> 中断后重跑自动续处理，无需人工判断。

## 产出

| 文件 | 说明 |
|------|------|
| `{target_dir}/{hash}_{原文件名}.md` | 带 frontmatter 的终稿，hash 前缀用于去重 |

## 错误处理

| 场景 | 处理 |
|------|------|
| 单篇提取/评分失败 | 跳过该篇，不影响其他 |
| 单维评分失败 | 该维为 `null` |
| 中间中断 | 重跑自动跳过已完成篇 |
