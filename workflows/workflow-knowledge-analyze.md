---
name: mp-knowledge-analyze
description: "知识库子流程 2.2：文档分析（打标签+评分+合并元数据 → marked），输入 profile 即可"
---

# 子流程 2.2：文档分析

知识库管线四子流程之一。对 `{inbox}` 中的文章批量完成 **打标签 → 评分 → 合并元数据**，终稿移动到 `{marked}/`。本流程**只接受 `{profile}`**，所有处理均在其知识库目录下，不读取任何配置文件。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{inbox}` | `{base}/inbox` | 原始文章目录 |
| `{marked}` | `{base}/marked` | 已分析终稿目录 |
| `{scripts}` | `skills/wechat-mp-knowledge/scripts` | 预置脚本目录 |

> 调用方式：`coordinator` 仅需告知 `{profile}`（如 `ai`），即处理 `D:/knowledge/articles/ai/` 下 `inbox/ → marked/`。

## 执行者

| 执行者 | 动作 | 产出 |
|--------|------|------|
| `tagger` | 批量对 `{inbox}` 中无 `.meta.json` 的文章打标签（标签/摘要/关键词/作者/日期） | `{file}.meta.json` |
| `coordinator` | 并行触发 5 位 `commentator-*` 对每篇已打标文章评分 | `{file}.rate.json` |
| `coordinator` | 运行标准脚本 `analyze_to_marked.js`，合并元数据为 frontmatter 并批量移动 | `{marked}/*.md` |

## 处理方式：批量两阶段（可恢复）

**先全部打标，再全部评分，最后一次性合并移动**，而非逐篇处理。每篇的状态由 `.meta.json` / `.rate.json` 是否存在独立记录，中途中断后重跑本流程会**自动跳过已完成步骤**：

| 中断点 | 已有产物 | 重跑时 |
|--------|---------|--------|
| 打标中 | 部分 `.meta.json` | 已打标的跳过，只处理剩余篇 |
| 评分中 | `.meta.json` 齐、部分 `.rate.json` | 已评分的跳过，只评剩余篇 |
| 合并中 | 部分文件已移动 | 已移动的（`{marked}` 内）不再重复处理 |

> 原则：`inbox/` 内已生成 `.meta.json` 的文件即为"已打标"，已出现在 `{marked}/` 的文件即为"已完成"。脚本幂等，可安全重复运行。

## 步骤

### 1. 打标签（tagger 批量）

`tagger` 扫描 `{inbox}` 中所有 `.md` 文件，跳过已有 `.meta.json` 的，对剩余文章**先计算内容 hash**（`node skills/knowledge-analyze/scripts/hash_content.js {file}.md`，3 轮 sha256 取 12 位十六进制），再批量提取元数据并写入 `{file}.meta.json`：

```json
{
  "hash": "c1b3a308d5b8",
  "title": "iPhone 20 多方爆料汇总",
  "date": "2026-07-31T10:30:00+08:00",
  "auther": "科技兽",
  "source": "https://mp.weixin.qq.com/s/...",
  "tags": ["iPhone 20", "苹果", "产品爆料"],
  "summary": "汇总iPhone 20多方爆料，涵盖玻璃机身、固态按键、屏下Face ID等设计。",
  "keywords": ["iPhone 20", "固态按键", "屏下Face ID"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hash` | string | 是 | **内容 hash**（12 位十六进制），用脚本 `node skills/knowledge-analyze/scripts/hash_content.js {file}.md` 计算，不得手写 |
| `title` | string | 是 | 文章标题。**优先从文件名提取**（采集文件名 `{fakeid}_{index}_{date}_{account}_{title}.md` 去掉前四段）；无法解析时回退正文首部标题（setext/`#` 标题），不含 markdown 标记 |
| `date` | string | 是 | **打标签的时刻**（ISO 8601 含时区），非文章发布时间 |
| `auther` | string | 是 | 从文章正文内检索作者/公众号名，**找不到时填空字符串 `""`** |
| `source` | string | 是 | 原文链接（正文或上下文可得） |
| `tags` | string[] | 是 | 2-5 个标签，精准概括主题 |
| `summary` | string | 是 | 1-2 句核心摘要 |
| `keywords` | string[] | 否 | 3-5 个关键词/短语，辅助检索 |

> **说明**：`auther` 需从文章正文内检索（如"原创 xx"、"作者：xx"），不可只依赖文件名；正文确实无作者信息时输出 `""`。不设 `category` 字段——无固定枚举时归类值不稳定，统一以 `tags` 承载主题信息。

### 2. 评分（coordinator 批量）

对 `{inbox}` 中**已有 `.meta.json` 但无 `.rate.json`** 的文章，`coordinator` 并行触发 5 位 `commentator-*`（商业/技术/公众/学术/伦理）打分（1-5），汇总写入 `{file}.rate.json`：

```json
{ "ratings": { "value": 4, "tech": 5, "public": 3, "academic": null, "ethics": 5 } }
```

某维评分失败则该维为 `null`，不影响其他维度与其他文章。

### 3. 合并元数据 + 批量移动

**本步骤必须完全由标准脚本 `analyze_to_marked.js` 执行**，禁止手工编辑 frontmatter 或手工移动文件：

```
node {scripts}/analyze_to_marked.js {inbox} {marked}
```

`analyze_to_marked.js` 将 `.meta.json` / `.rate.json` 合并为 frontmatter 嵌入 `.md`，**以 `${hash}_` 前缀重命名**后批量移动到 `{marked}/` 并清理侧车文件。无 `.meta.json` 的文件标记 `WAIT`，留在 `{inbox}` 待打标。脚本幂等：已出现在 `{marked}/` 的文件（`${hash}_` 前缀命中）不再重复处理。

> 文件名格式：`{marked}/{hash}_{原文件名}.md`。hash 来自 `.meta.json`，缺失时脚本按内容重新计算（`skills/knowledge-analyze/scripts/lib/content_hash.js`，与 `hash_content.js` 同源）。

### 4. 汇总结果

返回移动/等待/失败数量。失败文件保留在 `{inbox}` 或 `{marked}` 原状态，重跑本流程即可续处理。

## 说明

- **只接受 `{profile}`**，无 config 参数
- **幂等可恢复**：`.meta.json`/`.rate.json` 为已完成标记，`{marked}/` 内文件不再重复处理
- 单篇失败不影响其他文章（脚本逐文件 try/catch）
- 产出文件为带 frontmatter 的终稿（格式见总索引 [workflow-knowledge.md](workflow-knowledge.md)）

## 产出

| 文件 | 说明 |
|------|------|
| `{marked}/{hash}_*.md` | 带 frontmatter（含 `hash`）的已分析终稿，文件名带 hash 前缀 |

## 错误处理

| 场景 | 处理 |
|------|------|
| `.meta.json` 缺失 | 文件留在 `{inbox}`，脚本标记 `WAIT` |
| 某篇打标/评分失败 | 跳过该篇，不影响其他 |
| 某维评分失败 | 该维为 `null`，`rating` 未评分维度置空 |
| 中间中断 | 重跑本流程，自动跳过已完成篇（依据 `.meta.json`/`.rate.json`/`{marked}` 状态） |
