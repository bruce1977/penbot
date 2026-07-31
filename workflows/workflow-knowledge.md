---
name: mp-knowledge
description: "MP 知识库管线（总索引）：4 个独立子流程，每个可单独运行（采集→分析→导入→归档）"
---

# MP 知识库管线（四子流程总索引）

知识采集由 **4 个独立子流程** 组成，每个子流程单独运行以满足各类知识的采集要求。上一子流程的产出目录即为下一子流程的输入目录。

> 本文档是总索引。执行某个子流程时，请加载对应子流程文档并按其步骤执行。

## 子流程一览

| # | 子流程 | 输入 | 执行者 | 技能/脚本 | 产出 | 文档 |
|---|--------|------|--------|-----------|------|------|
| 2.1 | 采集入库 | `{profile}`（账号列表来自 `configs/{profile}-config.json`） | `gatherer` | `wechat-mp-gather` | `inbox/*.md` | [workflow-knowledge-collect.md](workflow-knowledge-collect.md) |
| 2.2 | 文档分析 | `inbox/*.md` | `tagger` + `coordinator` | `knowledge-analyze` + `commentator-*` | `marked/*.md` | [workflow-knowledge-analyze.md](workflow-knowledge-analyze.md) |
| 2.3 | 导入知识库 | `marked/*.md` | `coordinator` | `knowledge-sync-weknora` | `weknora/*.md` | [workflow-knowledge-import.md](workflow-knowledge-import.md) |
| 2.4 | 归档 | `weknora/*.md` | `coordinator` | `archive_old_files.js` | `archived/*.md` | [workflow-knowledge-archive.md](workflow-knowledge-archive.md) |

## 目录结构

每个 profile 知识库建立 4 个目录，文件按处理阶段单向流转：

```
{KB}/articles/{profile}/
├── inbox/       ← 原始文章（自动下载或手动放置）
├── marked/      ← 已打标+评分、元数据嵌入 MD 后的终稿
├── weknora/     ← 已成功导入 WeKnora 的文章
└── archived/    ← 旧文件归档（可配置，默认 3 个月）
```

文件流转：`inbox → marked → weknora → archived`，单向推进，无回退。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 配置名称/知识库 profile |
| `{config}` | `configs/{profile}-config.json` | 约定配置文件（公众号列表、`weknora_kb_id`、`archive_after_days` 等） |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{inbox}` | `{base}/inbox` | 原始文章目录 |
| `{marked}` | `{base}/marked` | 已分析终稿目录 |
| `{weknora}` | `{base}/weknora` | 已导入 WeKnora 目录 |
| `{archived}` | `{base}/archived` | 归档目录 |
| `{temp}` | `.temp/{profile}` | 运行时临时目录 |
| `{scripts}` | `skills/wechat-mp-knowledge/scripts` | 预置脚本目录 |

> 所有子流程均以 `{profile}` 为唯一入口：`/cmd-collect ai`、`/cmd-analyze ai`、`/cmd-import ai`、`/cmd-archive ai`。

## 数据流总览

```
{profile} ──→ [2.1 采集] ──→ {inbox}/*.md
                               ↓
                         [2.2 分析] 打标签 + 评分 + 合并元数据
                               ↓ (批量合并移动)
                          {marked}/*.md
                               ↓
                         [2.3 导入] weknora API (文章+标签)
                               ↓ (导入成功才移动)
                         {weknora}/*.md
                               ↓
                         [2.4 归档] mtime > N 天
                               ↓
                         {archived}/*.md
```

## Frontmatter 格式

```yaml
---
title: "人生周报v076：命运"
auther: "李继刚"
date: "2026-07-31T10:30:00+08:00"
source: "https://mp.weixin.qq.com/s/r7rCQB5xqalabqpAouXGlw"
tags: ["人生感悟", "金句摘录", "LLM思考"]
keywords: ["周报", "人生感悟"]
summary: "李继刚周报，摘录本周金句..."
rating:
  business: 4
  technical: 5
  social: 3
  academic: null
  ethics: 5
---
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `title` | `.meta.json`（必填，由 tagger 提取） | 文章标题 |
| `auther` | `.meta.json`（正文检索）→ 文件名回退 | 公众号名称，正文无作者时 `""` |
| `date` | `.meta.json` | **打标时刻**（ISO 8601 含时区），非发布时间 |
| `source` | `.meta.json` | 原文链接 |
| `tags` | `.meta.json` | AI 提取的标签列表 |
| `keywords` | `.meta.json` | 关键词列表（可选） |
| `summary` | `.meta.json` | AI 生成的核心摘要 |
| `rating` | `.rate.json` | 评论员五维评分，null 表示未评分 |

> 不设 `category` 字段——无固定枚举时归类值不稳定，统一以 `tags` 承载主题信息。
