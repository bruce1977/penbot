---
name: wechat-mp-gather
description: "根据公众号列表拉取文章列表并下载 Markdown 原文。适用于：微信公众号采集下载。元数据提取与评分由 knowledge 技能完成"
---

# 微信公众号文章采集

本技能提供**单一功能**：根据公众号列表拉取文章 + 下载 Markdown 原文。

> **职责边界**：本技能只负责采集下载。文章的元数据提取（标签/摘要/关键词 → `.meta.json`）和评分（→ `.rate.json`）由 `knowledge` 技能的 `analyze_start.js` 脚本完成，均不在本技能范围内。

## 前置条件

| 环境变量 | 说明 |
|---------|------|
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 |
| `PB_WECHAT_MP_AUTH_KEY` | API 认证密钥（X-Auth-Key 头） |

### 输入

#### accounts — 公众号列表

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

### 调用参数

本技能由调用方传入两个参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `{save-path}` | string | 是 | **文章存放目录**，由调用方直接指定（非配置文件读取），下载的 `.md` 文件写入此目录 |
| `{temp}` | string | 否 | 临时目录，默认 `.temp/{32位UUID}` — 用完即删 |

例如在知识库管线中，调用方传入 `{save-path} = {KB}/articles/{profile}/inbox`。

#### 配置文件中的 settings

配置文件 `{config}` 的 `settings` 对象用于控制采集行为（不含 `save_path`）：

```json
{
  "days_to_filter": 3,
  "max_articles_per_account": 5,
  "max_accounts": 5
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `days_to_filter` | int | 否 | `3` | 只拉取最近 N 天的文章 |
| `max_articles_per_account` | int | 否 | `5` | 每号最多拉取几篇 |
| `max_accounts` | int | 否 | `5` | 当天最多选几个号（日期轮换） |

### 变量

| 变量 | 说明 |
|------|------|
| `{save-path}` | 调用方传入的文章存放目录 |
| `{temp}` | 临时目录，可由调用方指定或自动生成 |
| `{scripts}` | `skills/wechat-mp-gather/scripts` — 脚本目录 |

### 执行步骤

#### 步骤 1：初始化

创建 `{temp}` 和 `{save-path}` 目录（递归创建），将完整输入写入 `{temp}/config.json`。

#### 步骤 2：拉取文章列表

```
node {scripts}/fetch_and_prepare.js  {temp}/config.json  {temp}/article_list.json  [{skip_aids.json}]
```

支持可选第 3 参数 `{skip_aids.json}`，格式为 `{ "existing_aids": ["aid_1", "aid_2"] }` 或 `["aid_1", "aid_2"]`。提供后输出会自动剔除已存在的 aid（知识库管线由 `check_exists_all.js` 生成此文件）。

按日期轮换选出当天公众号，拉取文章列表，过滤已删除/超期文章，输出 keyed by aid 的 JSON。

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

#### 步骤 3：批量下载

```
node {scripts}/download_articles.js  {temp}/article_list.json  {save-path}  {temp}
```

逐篇检查文件是否存在且有效（含 `![cover_image]`），已存在则跳过；否则通过 API 下载，内容无效重试最多 2 次，HTTP 错误重试最多 3 次（间隔 10s），仍失败则跳过。全部完成后输出 `download_list.json`（不产生中间状态文件）。

**产出**

| 文件 | 说明 |
|------|------|
| `{save-path}/{file_name}` | 下载好的 Markdown 原文 |
| `{temp}/download_list.json` | 本次下载的文件清单 |

#### 步骤 4：校验并返回结果

读取 `{temp}/download_list.json`，逐文件确认存在于 `{save-path}/` 下，通过后返回下载清单：

```json
{ "base_path": "...", "files": ["file1.md", "file2.md"] }
```

#### 步骤 5：清理

递归删除 `{temp}` 目录。

> **管线调用时**：`{temp}` 可能被上游流程共享（如知识库管线的 `{temp}`），此时清理应由管线统一管理，技能内部不执行步骤 5。

---

## 错误处理

| 问题 | 处理 |
|------|------|
| 某公众号拉取失败 | 跳过它，继续处理其他号 |
| 某篇文章下载失败 | 脚本自动重试，仍失败则跳过该篇，不影响其余文章 |
| `article_list` 为空 | 直接报错退出，不继续下载 |
