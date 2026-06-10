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
WECHAT_MP_API_BASE=xxx
PB_PYCORRECTOR_API_URL=xxx
PB_MODEL_API_KEY=xxx
PB_IMAGE_GENERATION_URL=xxx
```

2. 在 `opencode.json` 中已通过 `{env:VAR_NAME}` 引用上述环境变量。

## 环境变量

| 变量 | 说明 | 使用方 |
|------|------|--------|
| `PB_WECHAT_MP_AUTH_KEY` | 微信公众号 API 认证密钥 | wechat-mp-mcp |
| `WECHAT_MP_API_BASE` | 微信公众号 API 基础地址 | 外部脚本 |
| `PB_PYCORRECTOR_API_URL` | 中文纠错 API 地址 | pycorrector |
| `PB_MODEL_API_KEY` | ModelScope API 密钥 | image-generation |
| `PB_IMAGE_GENERATION_URL` | ModelScope 文生图 MCP 地址 | image-generation |

## Agents

| Agent | 描述 |
|-------|------|
| `writer` | 根据采集的主题信息和文章列表，撰写不同题材的公众号文章 |
| `gatherer` | 按需从公众号/网页/文章采集原始信息，输出结构化素材 |
| `illustrator` | 根据公众号文章主题绘制配图 |
| `proofreader` | 错别字检测 + 敏感词审查 + 语病/标点/语法校验 |
| `silent` | 静默执行模式，禁止提问，仅供 command 内部使用 |

## Skills

| Skill | 描述 | 依赖 |
|-------|------|------|
| `wechat-mp-articles` | 从微信公众号抓取文章、筛选、下载并生成报告 | mustache |
| `industry-news-digest` | 从指定行业网站抓取文章并生成新闻通讯稿 | — |
| `pdf-digest` | 从 PDF 提取内容并整理成摘要/通讯稿 | — |
| `pycorrector-check` | 中文错别字检测，支持音似、形似错误检测 | pycorrector MCP |
| `sensitive-check` | 敏感词审查，覆盖15分类67038词 | sensitive-lexicon MCP |

## MCPs

| MCP | 类型 | 描述 | 依赖 |
|-----|------|------|------|
| `wechat-mp-mcp` | local | 微信公众号文章列表查询、内容下载、账号搜索 | axios, fastmcp, zod |
| `pycorrector` | local | 中文文本纠错（调用远端 pycorrector API） | axios, fastmcp, zod |
| `sensitive-lexicon` | local | 敏感词检测/过滤/分类查询 | sensitive-lexicon-mcp |
| `playwright` | local | 浏览器自动化（由 npx 动态拉取） | npx @playwright/mcp |
| `image-generation` | remote | 文生图/图生图（ModelScope API） | — |

## 项目结构

```
├── .opencode/
│   ├── agents/                # 自定义 Agent
│   ├── skills/                # 自定义 Skill（5 个）
│   └── package.json           # opencode 插件依赖
├── local-mcps/                # 本地 MCP 服务器（3 个）
│   ├── wechat-mp-nodejs/
│   ├── pycorrector-nodejs/
│   └── sensitive-lexicon-nodejs/
├── configs/                   # 配置文件（公众号配置等）
├── docs/                      # 文档模板
├── .env                       # 环境变量（不提交）
└── opencode.json              # opencode 配置
```
