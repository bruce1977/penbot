# Penbot

An automated writing and information processing project built on [opencode](https://opencode.ai).

基于 opencode 的自动化写作与资讯处理项目。

## 环境要求

- Node.js >= 18
- npm
- opencode CLI

## 全局安装依赖

所有 Agents、Skills、MCPs 的 Node 包统一全局安装，子目录不再保留 `node_modules`：

```bash
npm i -g axios fastmcp zod sensitive-lexicon-mcp mustache @opencode-ai/plugin
```

## 配置

1. 复制项目根目录下的 `.env` 文件，填入实际值：

```
PB_WECHAT_MP_AUTH_KEY=xxx
PB_WECHAT_MP_API_BASE=xxx
PB_PYCORRECTOR_API_URL=xxx
PB_MODEL_API_KEY=xxx
PB_IMAGE_GENERATION_URL=xxx
PB_RESEND_API_KEY=xxx
```

2. 在 `opencode.json` 中已通过 `{env:VAR_NAME}` 引用上述环境变量。

## 环境变量

| 变量 | 说明 | 使用方 |
|------|------|--------|
| `PB_WECHAT_MP_AUTH_KEY` | 微信公众号 HTTP API 认证密钥 | wechat-mp-generation MCP、`fetch_and_prepare.js` |
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 | wechat-mp-generation MCP、wechat-mp-articles 各脚本 |
| `PB_PYCORRECTOR_API_URL` | 中文纠错 API 地址 | word-corrector |
| `PB_MODEL_API_KEY` | ModelScope API 密钥 | image-generation、image-generation-modelscope |
| `PB_IMAGE_GENERATION_URL` | ModelScope 文生图远端 MCP 地址 | image-generation |
| `PB_RESEND_API_KEY` | Resend 邮件发送 API 密钥 | email-resend |

## Agents

| Agent | 代号 | 描述 |
|-------|------|------|
| `writer` | 墨言 | 主理人，编排全流程并撰写文章 |
| `gatherer` | 拾遗 | 采集公众号文章，运行 wechat-mp-articles 产出报告与主题 |
| `illustrator` | 画眉 | 根据公众号文章主题绘制配图 |
| `proofreader` | — | 错别字检测 + 敏感词审查 + 语病/标点/语法校验 |
| `silent` | — | 静默执行模式，禁止提问，仅供 command 内部使用 |

## Skills

| Skill | 描述 | 依赖/说明 |
|-------|------|----------|
| `wechat-mp-articles` | 从微信公众号抓取文章、AI 评分遴选、生成主题报告与汇总报告 | Node 脚本直连 HTTP API，无需 MCP；需 `axios`、`mustache` |
| `industry-news-digest` | 从指定行业网站抓取文章并生成新闻通讯稿 | — |
| `pdf-digest` | 从 PDF 提取内容并整理成摘要/通讯稿 | — |
| `word-corrector-check` | 中文错别字检测，支持音似、形似错误检测 | word-corrector MCP |
| `word-sensitive-check` | 敏感词审查，覆盖 15 分类 67038 词 | word-sensitive MCP |

## MCPs

| MCP | 类型 | 描述 | 依赖 |
|-----|------|------|------|
| `wechat-mp-generation` | local | 微信公众号搜索（搜 fake_id）、文章内容下载（备选） | axios, fastmcp, zod |
| `word-corrector` | local | 中文文本纠错（调用远端 pycorrector API） | axios, fastmcp, zod |
| `word-sensitive` | local | 敏感词检测/过滤/分类查询 | sensitive-lexicon-mcp |
| `image-generation-modelscope` | local | 文生图/图生图（ModelScope API，本地节点） | — |
| `image-generation-pollinations` | local | 文生图（Pollinations.AI，免费无需密钥） | — |
| `email-resend` | local | 通过 Resend API 发送邮件 | — |
| `image-generation` | remote | 文生图/图生图（ModelScope API，远端） | — |
| `playwright` | local | 浏览器自动化（由 npx 动态拉取） | npx @playwright/mcp |

> **注意**：`wechat-mp-generation` MCP 目前仅用于搜索公众号（获取 `fake_id`）。文章拉取和下载均通过 wechat-mp-articles 技能内的 Node 脚本直连 HTTP API，不走 MCP 通道。

## wechat-mp-articles 技能工作流

完整流程定义见 [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md)。

```
config.json + date
    │
    ▼
┌─ 步骤 1 ──────────────────────────┐
│  validate.js  校验配置字段完整性     │
└────────────────────────────────────┘
    │
    ▼  {config-runtime}
┌─ 步骤 2 ──────────────────────────┐
│  fetch_and_prepare.js              │
│    ├ 内置日期轮换算法选取公众号      │
│    └ HTTP API 拉取 + 过滤 + 字段精简 │
│                                    │
│  download_articles.js              │
│    ├ 初始化下载清单                 │
│    ├ 批量下载 Markdown（含校验重试） │
│    └ 自动生成下载汇总报告           │
└────────────────────────────────────┘
    │  *.md + download_report.json
┌─ 步骤 3 ──────────────────────────┐
│  AI 评分 & 标签提取                 │
│  merge_analysis_meta.js  合并元数据 │
│  AI 主题遴选                       │
└────────────────────────────────────┘
    │  analysis_report.json + analysis_topic.json
┌─ 步骤 4 ──────────────────────────┐
│  gen_topic_report.js    主题报告    │
│  gen_summary_report.js  汇总报告    │
└────────────────────────────────────┘
    │  topic_*.md + summary_report.md
┌─ 步骤 5 ──────────────────────────┐
│  clean_dirs.js  清理临时文件        │
└────────────────────────────────────┘
```

### 管线（完整流程）

| 步骤 | 名称 | 执行者 | 产出 |
|------|------|--------|------|
| 1 | 抓取与遴选 | `gatherer` | `summary_report.md`、`topic_*.md` |
| 2 | 发送汇总报告 | `writer` | 汇总报告邮件（标题：`资讯汇总 - {profile} - {date}`） |
| 3 | 主题评价 | `writer` → `commentator-*` | `commentary.md`、`selected-topic.md` |
| 4 | 撰写文章 | `writer` | `{topic}_draft.md` |
| 5 | 校对 | `writer` → `proofreader` | `{topic}_proofed.md` |
| 6 | 插图 | `writer` → `illustrator` | `{topic}_final.md`（嵌入图片） |
| 7 | 发送终稿 | `writer` | 终稿邮件（标题：`{topic} - {date}`，正文含配图） |

## 项目结构

```
├── .opencode/                 # opencode 运行时配置
│   └── package.json           # opencode 插件依赖
├── agents/                    # 自定义 Agent（10 个）
├── skills/                    # 自定义 Skill（5 个）
│   ├── wechat-mp-articles/
│   │   ├── scripts/           # Node.js 驱动脚本
│   │   ├── steps/             # 步骤文档
│   │   └── templates/         # 报告模板（Mustache）
│   ├── industry-news-digest/
│   ├── markdown-email/
│   ├── pdf-digest/
│   ├── word-corrector-check/
│   └── word-sensitive-check/
├── local-mcps/                # 本地 MCP 服务器（6 个）
│   ├── wechat-mp-nodejs/
│   ├── sensitive-lexicon-nodejs/
│   ├── pycorrector-nodejs/
│   ├── image-generation-modelscope/
│   ├── image-pollinations-nodejs/
│   └── resend-nodejs/
├── workflows/                 # 工作流定义
│   └── workflow_mp-auto-pipeline.md
├── configs/                   # 配置文件（公众号配置等）
├── templates/                 # 管线模板
├── docs/                      # 文档
├── .env                       # 环境变量（不提交）
└── opencode.json              # opencode 配置
```
