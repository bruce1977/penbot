---
name: kb-collect
description: "知识库子流程 2.1：微信公众号采集入库（拉取+下载 → inbox），输入 profile 即可"
---

# 子流程 2.1：采集入库

知识库管线四子流程之一。由 `gatherer` 使用 `wechat-mp-gather` 技能（功能 1），将公众号文章下载到 `{inbox}/`。本流程只接受 `{profile}`，公众号列表由约定路径 `configs/{profile}-config.json` 读取。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{config}` | `configs/{profile}-config.json` | 约定配置文件（含公众号列表） |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{inbox}` | `{base}/inbox` | 文章存放目录 |
| `{temp}` | `.temp/{profile}` | 运行时临时目录 |
| `{scripts}` | `scripts`（项目根目录） | 预置脚本目录（`analyze_to_marked.js`、`archive_old_files.js` 等） |

> 调用方式：`coordinator` 仅需告知 `{profile}`（如 `ai`），即读取 `configs/ai-config.json` 并下载到 `D:/knowledge/articles/ai/inbox/`。

## 前置条件

| 环境变量 | 说明 |
|---------|------|
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 |
| `PB_WECHAT_MP_AUTH_KEY` | API 认证密钥（X-Auth-Key 头） |

## 步骤

### 1. 初始化

创建 `{inbox}`、`{temp}` 目录，将 `{config}` 的 `settings` + enabled accounts 写入 `{temp}/config.json`。

### 2. 采集去重

扫描 4 个目录（inbox/marked/weknora/archived）中已存在的 aid，输出跳过列表：

```
node {scripts}/check_exists_all.js {base} > {temp}/existing_aids.json
```

### 3. 拉取文章列表

```
node skills/wechat-mp-gather/scripts/fetch_and_prepare.js  {temp}/config.json  {temp}/article_list.json  {temp}/existing_aids.json
```

按日期轮换选出当天公众号，拉取文章列表，过滤已删除/超期/已存在的 aid，输出 `{temp}/article_list.json`。

### 4. 批量下载

```
node skills/wechat-mp-gather/scripts/download_articles.js  {temp}/article_list.json  {inbox}  {temp}
```

下载 Markdown 到 `{inbox}/`，逐篇校验（含 `![cover_image]`），失败自动重试后跳过。

### 5. 校验并返回结果

读取 `{temp}/download_list.json`，逐文件确认存在于 `{inbox}/` 下，返回下载清单：

```json
{ "base_path": "...", "files": ["file1.md", "file2.md"] }
```

### 6. 清理

删除 `{temp}` 目录（如被上游共享则交由管线统一管理）。

## 产出

| 文件 | 说明 |
|------|------|
| `{inbox}/*.md` | 采集的公众号文章原文 |

## 超时与环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FETCH_REQUEST_TIMEOUT_MS` | `30000` | 单次 API 请求超时 |
| `FETCH_SCRIPT_TIMEOUT_MS` | `120000` | 拉取脚本整体超时 |
| `FETCH_MAX_RETRIES` | `3` | API 错误最大重试次数 |
| `FETCH_RETRY_DELAY_MS` | `15000` | 重试间隔（频率限制） |
| `DOWNLOAD_SCRIPT_TIMEOUT_MS` | `300000` | 下载脚本整体超时 |

## 错误处理

| 场景 | 处理 |
|------|------|
| 拉取空列表 / 频率限制（`ret: 200013`） | 输出 warning 继续，后续子流程自然跳过 |
| 某公众号拉取失败 | 跳过它，继续处理其他号 |
| 某篇文章下载失败 | 自动重试，仍失败则跳过该篇 |
| `article_list` 为空 | 写入 `.NO_ARTICLES` 标志，报错退出不下载 |
