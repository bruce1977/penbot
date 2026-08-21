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
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 | wechat-mp-generation MCP、wechat-mp-gather 各脚本 |
| `PB_PYCORRECTOR_API_URL` | 中文纠错 API 地址 | word-corrector |
| `PB_MODEL_API_KEY` | ModelScope API 密钥 | image-generation、image-generation-modelscope |
| `PB_IMAGE_GENERATION_URL` | ModelScope 文生图远端 MCP 地址 | image-generation |
| `PB_RESEND_API_KEY` | Resend 邮件发送 API 密钥 | email-resend |

## Agents

| Agent | 代号 | 模式 | 描述 |
|-------|------|------|------|
| `coordinator` | 司南 | `all` | 总调度，编排全流程：采集→评价→撰写→配图→发布 |
| `gatherer` | 拾遗 | `all` | 采集公众号文章，运行 wechat-mp-gather 技能产出报告与主题 |
| `writer` | 墨言 | `all` | 专注撰写，接收素材后独立成文，内部调用 proofreader 完成校对迭代 |
| `illustrator` | 画眉 | `all` | 根据文章主题用 `image-generation-*` MCP 工具绘制配图 |
| `proofreader` | — | `subagent` | writer 的子流程，检查敏感词、错别字、语法/逻辑，与 writer 直接闭环 |
| `silent` | — | `subagent` | 静默执行模式，禁止提问，仅供 command 内部使用 |
| `commentator-value` | 金算盘 | `subagent` | 商业与市场视角评价主题 |
| `commentator-tech` | 解码器 | `subagent` | 技术与工程视角评价主题 |
| `commentator-public` | 风向标 | `subagent` | 公众传播视角评价主题 |
| `commentator-academic` | 溯源者 | `subagent` | 学术研究视角评价主题 |
| `commentator-ethics` | 权衡者 | `subagent` | 伦理合规视角评价主题 |

## Skills

| Skill | 描述 | 依赖/说明 |
|-------|------|----------|
| `wechat-mp-gather` | **抓取**：拉取+下载公众号文章到本地 | Node 脚本直连 HTTP API，需 `axios` |
| `wechat-mp-analyze` | **选题**：AI 评分遴选、生成主题报告与汇总报告 | Node 脚本 + LLM，需 `mustache` |
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

> **注意**：`wechat-mp-generation` MCP 目前仅用于搜索公众号（获取 `fake_id`）。文章拉取和下载均通过 wechat-mp-gather 技能内的 Node 脚本直连 HTTP API，不走 MCP 通道。

## 采集管线流程（wechat-mp-gather + wechat-mp-analyze）

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
    │  *.md + download_list.json
┌─ 步骤 3 ──────────────────────────┐
│  AI 评分 & 标签提取                 │
│  merge_scored_articles.js  汇总评分缓存 │
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

完整流程定义见 [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md)。

| 步骤 | 名称 | 执行者 | 产出 |
|------|------|--------|------|
| 1 | 抓取与遴选 | `coordinator` → `gatherer` | `summary_report.md`、`topic_*.md` |
| 2 | 发送汇总报告 | `coordinator` | 汇总报告邮件（标题：`资讯汇总 - {profile} - {date}`） |
| 3 | 主题评价 | `coordinator` → `commentator-*` | `commentary.md`、`selected-topic.md` |
| 4 | 撰写与校对 | `coordinator` → `writer`（内部调用 `proofreader`） | `{topic}_proofed.md` |
| 5 | 配图 | `coordinator` → `illustrator` | `{topic}_modelscope_final.md` + `{topic}_pollinations_final.md` |
| 6 | 发送终稿 | `coordinator` | 终稿邮件（标题：`{topic} - {date}`，择优发送 ModelScope/Pollinations 版） |

## 项目结构

```
├── .opencode/                 # opencode 运行时配置
│   └── package.json           # opencode 插件依赖
├── agents/                    # 自定义 Agent（11 个）
│   ├── coordinator.md         # 总调度
│   ├── writer.md              # 撰写
│   ├── gatherer.md            # 采集
│   ├── illustrator.md         # 配图
│   ├── proofreader.md         # 校对
│   ├── commentator-*.md       # 5 位主题评论员
│   └── silent.md              # 静默执行
├── skills/                    # 自定义 Skill（5 个）
│   ├── wechat-mp-gather/
│   │   ├── scripts/           # Node.js 驱动脚本
│   │   ├── steps/             # 步骤文档
│   │   └── templates/         # 报告模板（Mustache）
│   ├── industry-news-digest/
│   ├── markdown-email/
│   ├── pdf-digest/
│   ├── word-corrector-check/
│   └── word-sensitive-check/
├── local-mcps/                # 本地 MCP 服务器（6 个）
│   ├── image-generation-modelscope/
│   ├── image-generation-pollinations/
│   ├── wechat-mp-generation/
│   ├── word-corrector/
│   ├── word-sensitive/
│   └── resend-nodejs/
├── workflows/                 # 工作流定义（2 个）
│   ├── workflow_mp-auto-pipeline.md  # 完整管线
│   └── workflow_mp-digest.md         # 采集简报管线
├── configs/                   # 配置文件（公众号配置等）
├── templates/                 # 管线模板
├── docs/                      # 文档
├── .env                       # 环境变量（不提交）
└── opencode.json              # opencode 配置
```


Good