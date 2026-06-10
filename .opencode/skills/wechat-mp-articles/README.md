# 微信公众号文章抓取与报告生成 (wechat-mp-articles)

## 功能简介

从配置的微信公众号中抓取文章，按时间范围筛选，下载为 Markdown 文件，并生成结构化汇总报告和主题分析文件。

## 文件结构

```
wechat-mp-articles/
├── SKILL.md                         # 技能定义和工作流
├── README.md                        # 本文件
├── config.json                      # 目标公众号和配置参数
├── scripts/
│   ├── filter_article_list.js       # 步骤 2：富化 + 清洗文章列表字段
│   ├── gen_download_report.js       # 步骤 4：生成下载汇总报告（JSON）
│   ├── gen_topic_report.js          # 步骤 7.1：生成主题分析报告
│   ├── gen_summary_report.js        # 步骤 7.2：生成汇总报告
│   └── clean_dirs.js                # 步骤 7.3：清空临时目录
└── templates/
    ├── template_summary.md          # 汇总报告模板（Mustache 语法）
    ├── template_topic.md            # 主题分析文件模板
    └── template_download_report.json # 下载汇总报告 JSON 结构参考
```

## 脚本一览

| 脚本 | 功能 | 对应步骤 | 参数说明 |
|------|------|----------|----------|
| `scripts/filter_article_list.js` | 富化（补齐 account_name/category）+ 清洗文章列表 | 步骤 2 | `<raw.json> <config.json> <output.json>` |
| *（已合并到步骤 3.2 内联操作）* | 按规则构造文件名并保存 | 步骤 3.2 | - |
| `scripts/gen_download_report.js` | 扫描实际下载情况，生成 JSON 报告 | 步骤 4 | `<article_list.json> <output.json> [articles_dir]` |
| `scripts/gen_topic_report.js` | 去重 + 评分关联 + 遴选 Top N 主题 + 生成报告 | 步骤 7.1 | `<articles_dir> <output_dir> <analysis.json> [config] [article_list.json]` |
| `scripts/gen_summary_report.js` | 汇总文章元数据 + 主题文件，生成总报告 | 步骤 7.2 | `<articles_dir> <output_dir> [analysis.json] [config] [date_suffix] [article_list.json]` |
| `scripts/clean_dirs.js` | 清空指定目录下所有文件和子目录 | 步骤 7.3 | `<dir1> [dir2] ...` |

## 变量定义

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `{cwd}` | 项目当前运行目录（项目根目录） | 当前工作目录 |
| `{temp}` | 临时文件根目录，即 `{cwd}/.temp` | .temp |
| `{download-articles}` | 文章下载目录，即 `{cwd}/.temp/{name}/wechat_articles` | .temp/{name}/wechat_articles |
| `{output}` | 报告输出根目录，即 `{cwd}/output` | output |
| `{skill}` | 技能目录所在目录，即 `{cwd}/.opencode/skills/wechat-mp-articles` | .opencode/skills/{skill_name} |

## 使用方法

### 1. 配置目标公众号

编辑 `config.json`，添加目标公众号 fake_id：

```json
{
  "accounts": [
    {
      "name": "公众号名称",
      "fake_id": "公众号fake_id",
      "category": "分类标签",
      "enabled": true
    }
  ],
  "settings": {
    "days_to_filter": 3,
    "max_articles_per_account": 10,
    "top_n_articles": 5,
    "topic_count": 3,
    "similarity_threshold": 0.8,
    "language": "zh-CN"
  }
}
```

**参数说明**

| 参数 | 别名 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `accounts[].name` | `${account_name}` | string | 必填 | 公众号显示名称 |
| `accounts[].fake_id` | `${fake_id}` | string | 必填 | 公众号唯一标识 |
| `accounts[].category` | `${account_category}` | string | 无 | 分类标签，用于报告分组 |
| `accounts[].enabled` | `${enabled}` | bool | `true` | 设为 `false` 则跳过该公众号 |
| `settings.days_to_filter` | `${days_to_filter}` | int | `3` | 筛选最近 N 天的文章 |
| `settings.max_articles_per_account` | `${max_articles_per_account}` | int | `5` | 每号最多拉取文章数 |
| `settings.name` | `${name}` | string | 空 | 输出目录名称前缀 |
| `settings.top_n_articles` | `${top_n_articles}` | int | `5` | 热门文章榜数量 |
| `settings.topic_count` | `${topic_count}` | int | `3` | 聚类主题数量 |
| `settings.similarity_threshold` | `${similarity_threshold}` | float | `0.8` | 去重阈值（编辑距离，0-1） |
| `settings.language` | `${language}` | string | `zh-CN` | 输出语言 |

### 2. 触发技能

在 opencode 中输入类似以下指令：

- "从配置的公众号抓取文章并生成报告"
- "拉取微信公众号最新文章汇总"
- "执行 wechat-mp-articles 技能生成日报"

### 3. 输出文件

```
{output}/{name}/
└── {yyyyMMdd}/
    ├── summary_report_{yyyyMMdd}.md     # 汇总报告
    ├── topic_{标签名1}.md               # 主题分析文件（主题名 = 标签名）
    └── topic_{标签名2}.md               # 主题分析文件

{download-articles}/
├── {aid}_{yyyyMMdd}_{公众号名称}_{title}.md  # 文章原始内容（无头信息，元数据存于 JSON）
├── download_report_{yyyyMMdd}.json          # 下载汇总报告（JSON 格式）
└── ...
```

## 工作流概要

| 步骤 | 说明 | 产出 |
|------|------|------|
| 1. 读取配置 | 解析 `config.json`，过滤已禁用的公众号 | - |
| 2. 拉取文章列表 | 调用 MCP 拉取 → `scripts/filter_article_list.js` 富化+清洗 | `article_list_{yyyymmdd}_{NN}.json` |
| 3. 逐篇下载文章 | MCP 获取内容 → 按规则构造文件名并保存 | `{aid}_{yyyyMMdd}_{account}_{title}.md` |
| 4. 生成下载汇总报告 | 扫描实际下载情况 | `download_report_{yyyymmdd}.json` |
| 5. 内容评分与标签提取 | AI 逐篇评分(1-5) + 提取标签(2-5个) | `analysis_report_{yyyymmdd}.json` |
| 6. 主题遴选 | 标签排名 → 遴选 Top N → 自动命名 | - |
| 7. 生成报告 | 主题报告 → 汇总报告 → 清理 | `summary_report_{yyyyMMdd}.md` + `topic_*.md` |

## 注意事项

- 需要先配置好 `wechat-mp-mcp` MCP 服务
- fake_id 通过 `wechat-mp-mcp_search_account(keyword="公众号名称")` 获取
- 已下载的文章会跳过重复下载
- 下载失败自动重试 2 次，仍失败则记入 `download_report_{yyyyMMdd}.json` 的失败列表
- 主题报告和汇总报告模板使用 Mustache 语法（`{{变量}}` / `{{#循环}}...{{/循环}}`）
