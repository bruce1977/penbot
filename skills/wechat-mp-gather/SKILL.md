---
name: wechat-mp-gather
description: 从微信公众号拉取文章列表并下载 Markdown 原文。适用于：资讯日报/周报采集、公众号内容监控、微信文章自动下载。
---

# 微信公众号文章抓取

从指定公众号拉取文章列表，下载 Markdown 原文，返回下载文件清单。

## 前置条件

| 环境变量 | 说明 |
|---------|------|
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 |
| `PB_WECHAT_MP_AUTH_KEY` | API 认证密钥（X-Auth-Key 头） |

## 输入

你会收到两个 JSON 数据：

### 1) accounts — 公众号列表

```json
[
  { "name": "公众号名称", "fake_id": "公众号唯一标识", "category": "分类标签", "enabled": true }
]
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 公众号显示名称 |
| `fake_id` | string | 是 | 公众号唯一标识 |
| `category` | string | 否 | 分类标签 |
| `enabled` | bool | 否 | 设为 `false` 则跳过 |

### 2) settings — 配置参数

```json
{
  "save_path": "D:/path/to/knowledge",
  "days_to_filter": 3,
  "max_articles_per_account": 5,
  "max_accounts": 5
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `save_path` | string | 是 | — | **文章存放目录**，下载的 .md 文件直接写入此目录 |
| `days_to_filter` | int | 否 | `3` | 只拉取最近 N 天的文章 |
| `max_articles_per_account` | int | 否 | `5` | 每号最多拉取几篇 |
| `max_accounts` | int | 否 | `5` | 当天最多选几个号（日期轮换） |

## 变量

| 变量 | 说明 |
|------|------|
| `{save-path}` | `settings.save_path` — 文章存放目录（调用者显式指定） |
| `{temp}` | 自动解析为 `(全局临时目录/.temp) / {32位UUID}` — 用完即删 |
| `{scripts}` | `skills/wechat-mp-gather/scripts` — 脚本目录 |

> `{temp}` 自动决定：有全局临时目录则在其下创建 `{UUID}`，否则在 `.temp/` 下创建。UUID 为随机 32 位十六进制。调用者无需、也不应显式声明。

## 你需要做的事情

按顺序执行以下步骤：

### 步骤 1：初始化

创建 `{temp}` 和 `{save-path}` 目录（递归创建），将收到的完整输入（accounts + settings）写入 `{temp}/config.json`。

### 步骤 2：拉取文章列表

```
node {scripts}/fetch_and_prepare.js  {temp}/config.json  {temp}/article_list.json
```

脚本按日期轮换选出当天公众号，拉取文章列表，过滤已删除/超期文章，生成文件名（格式 `{aid}_{update_yyyyMMdd}_{account_name}_{title}.md`），输出 keyed by aid 的 JSON。

**产出**：`{temp}/article_list.json`

```json
{
  "aid_12345_1": {
    "aid": "12345_1", "title": "文章标题", "file_name": "aid_12345_1_20260315_某号_标题.md",
    "link": "https://...", "digest": "...", "create_time": 1780899900,
    "account_name": "公众号名称", "account_category": "分类标签"
  }
}
```

### 步骤 3：批量下载

```
node {scripts}/download_articles.js  {temp}/article_list.json  {save-path}  {temp}
```

这个脚本会：
逐篇检查文件是否存在且有效（含 `![cover_image]`），已存在则跳过；否则通过 API 下载，内容无效重试最多 2 次，HTTP 错误重试最多 3 次（间隔 10s），仍失败则跳过。全部完成后输出 `download_list.json`。

**产出**

| 文件 | 说明 |
|------|------|
| `{save-path}/{file_name}` | 下载好的 Markdown 原文 |
| `{temp}/download_list.json` | 本次下载的文件清单 |

清单格式：

```json
{
  "base_path": "D:/path/to/save_path",
    "files": [ "aid_12345_1_20260315_某号_标题.md" ]
}
```

### 步骤 4：校验并返回结果

读取 `{temp}/download_list.json`，逐文件确认存在于 `{save-path}/` 下，通过后将完整内容返回给调用者。格式：

```json
{ "base_path": "...", "files": ["file1.md", "file2.md"] }
```

### 步骤 5：清理

递归删除 `{temp}` 目录。

## 错误处理

| 问题 | 你该怎么做 |
|------|-----------|
| 某公众号拉取失败 | 跳过它，继续处理其他号 |
| 某篇文章下载失败 | 脚本自动重试，仍失败则跳过该篇，不影响其余文章 |
| `article_list` 为空 | 直接报错退出，不继续下载 |
| 校验时发现文件缺失 | 从 `files` 中移除缺失项，记录日志，继续返回剩余清单 |
| 流程中途出错中断 | 检查 `{temp}` 下的临时文件（`list_pending.txt`、`list_failed.txt`、`article_list.json` 等），推断出错原因，返回 Error Report JSON 给调用者 |

> 即使流程出错，`{temp}` 也无需清理，保留现场供排查。调用者通过 `temp_path` 访问临时文件。
>
> **Error Report 格式**：
> ```json
> { "error": true, "message": "原因描述", "temp_path": "实际路径", "stage": "init/fetch/download/verify" }
> ```
