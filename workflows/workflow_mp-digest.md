---
name: mp-digest
description: "从公众号抓取文章 → 汇总报告发送（仅信息采集与报告发送，不含撰写）"
---

# MP 采集简报管线

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | `config.json` → `settings.name` | 配置名称，用于区分不同配置的输出目录前缀 |
| `{date}` | 执行日期 | 格式 `yyyyMMdd`，如 `20260616` |
| `{output}` | 输出根目录 | `output/{profile}/{date}` |
| `{temp}` | 临时文件根目录 | `.temp/{profile}` | gatherer 技能的临时目录基础路径 |
| `{config-runtime}` | 运行时配置 | `{temp}/data/config.json` | 步骤 1 从原始 config 复制至此，后续统一读取（含 email 字段） |
| `{email}` | 收件地址 | `{config-runtime}` → `settings.email` | 步骤 2 发送汇总报告的目标邮箱 |
| `{email_summary_enabled}` | 汇总邮件开关 | `{config-runtime}` → `settings.email_summary_enabled`，默认 `true` | 设为 `false` 时跳过步骤 2（汇总报告发送） |

## 流程图

```mermaid
flowchart TD
    S([开始]) --> S1[步骤1 信息采集]
    S1 --> E2{email_summary_enabled?}
    E2 -- true --> S2[步骤2 发送汇总报告]
    E2 -- false --> F
    S2 --> F([结束])
```

## 步骤详情

### 步骤 1：抓取与遴选

| | |
|------|------|
| **执行者** | `coordinator` → `gatherer` |
| **说明** | coordinator 调用 gatherer，gatherer 根据 `config.json` 先运行 `wechat-mp-gather`（抓取：拉取+下载），再运行 `wechat-mp-analyze`（选题：AI 评分+主题遴选+报告生成），生成汇总报告和 AI 遴选主题 |
| **输入** | `config.json` |
| **输出 (1)** | `{output}/summary_report.md` |
| **输出 (2)** | `{output}/topic_*.md` |

### 步骤 2：发送汇总报告

| | |
|------|------|
| **执行者** | `coordinator` |
| **说明** | 先检查 `{email_summary_enabled}`：若为 `false` 则直接跳过本步骤，不发送任何邮件。若为 `true`，使用技能 `markdown-email` 将 `{output}/summary_report.md` 发送到 `{email}`，邮件标题为 `资讯汇总 - {profile} - {date}` |
| **输入** | `{output}/summary_report.md` |
| **输出** | 已发送的汇总报告邮件（标题：`资讯汇总 - {profile} - {date}`）；若跳过则无输出 |
