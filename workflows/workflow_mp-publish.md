---
name: mp-publish
description: "独立的发布流程：输入已完成的 Markdown 终稿（含本地图片路径）→ 按开关发送邮件和/或发布公众号草稿箱"
---

# 发布流程

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{input}` | 输入参数 | 待发布的 Markdown 终稿路径（含本地图片路径 `![...](local_path)`） |
| `{email_final_enabled}` | 发布开关 | 默认 `true`，设为 `false` 跳过邮件发送 |
| `{wenyan_publish_enabled}` | 发布开关 | 默认 `true`，设为 `false` 跳过公众号草稿箱发布 |
| `{email}` | 收件地址 | 从 config 中 `settings.email` 读取，或由调用者指定 |
| `{wenyan_publish_result}` | 发布结果文件 | 与 `{input}` 同目录下的 `wenyan-publish-result.json` |
| `{date}` | 执行日期 | 格式 `yyyyMMdd`，如 `20260713` |
| `{topic}` | 输入参数（可选） | 主题名，用于邮件标题 `{topic} - {date}`；未提供则从文件名推导 |

## 流程图

```mermaid
flowchart TD
    classDef publish fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px,color:#1b5e20
    classDef decision fill:#f3e5f5,stroke:#6a1b9a,stroke-width:1px,color:#4a148c

    S([开始]) --> I[接收终稿路径 {input}]
    I --> E{email_final_enabled?}
    E -- true --> EM[步骤A1 发送邮件<br/>markdown-email 技能]
    E -- false --> WX
    EM --> WX{wenyan_publish_enabled?}
    WX -- true --> PUB[步骤A2 发布草稿箱<br/>wechat-mp-wenyan 技能]
    WX -- false --> F([结束])
    PUB --> F

    class S,F startend
    class EM,PUB publish
    class E,WX decision
```

## 步骤详情

### 前提

本流程接收的 `{input}` 文件必须为已嵌入图片的完整 Markdown（`![说明](本地路径)` 格式）。本地图片路径由发布步骤自行处理：
- **邮件**：`markdown-email` 技能中脚本 `convert.js` 将 Markdown 转 HTML 时，需将本地图片路径替换为可访问的 URL（当前暂不支持，详见下文数据流说明）
- **微信草稿箱**：`wechat-mp-wenyan` 技能通过 `@wenyan-md/cli` 自动读取本地图片并上传至微信 CDN

### 步骤 A1：发送邮件（可选）

| | |
|------|------|
| **执行者** | `coordinator`（直接使用 `markdown-email` 技能） |
| **说明** | 检查 `{email_final_enabled}`：若为 `false` 则跳过。若为 `true`，将 `{input}` 通过 `markdown-email` 技能发送到 `{email}`，邮件标题 `{topic} - {date}`。`{email}` 从 config 的 `settings.email` 读取；若未提供 config，询问调用者。**注意**：`markdown-email` 的 `convert.js` 当前直接输出 Markdown→HTML，本地图片路径 `![...](本地路径)` 在邮件中无法渲染，需在图床/URL 映射就绪后处理 |
| **输入** | `{input}` — 含本地图片路径的 Markdown 终稿 |
| **输出** | 已发送的终稿邮件；若跳过则无输出 |

### 步骤 A2：发布公众号草稿箱（可选）

| | |
|------|------|
| **执行者** | `coordinator` → `wechat-mp-wenyan` 技能 |
| **说明** | 检查 `{wenyan_publish_enabled}`：若为 `false` 则跳过。若为 `true`，将 `{input}` 通过 `wechat-mp-wenyan` 技能发布到微信公众号草稿箱。`@wenyan-md/cli` 自动读取 `![...](本地路径)` 中的本地图片，上传至微信 CDN 并替换地址。执行结果写入 `{wenyan_publish_result}`，不阻塞流程 |
| **输入** | `{input}` — 含本地图片路径的 Markdown 终稿 |
| **输出** | `{wenyan_publish_result}` — 发布结果（成功/失败）；若跳过则无输出 |

## 数据流说明

### 当前状态

| 发布渠道 | 图片处理方式 | 可用性 |
|---------|-------------|--------|
| **微信草稿箱** | `@wenyan-md/cli` 自动上传本地图片至微信 CDN | ✅ 可用 |
| **邮件** | `convert.js` 直接转 HTML，本地路径无法渲染 | ❌ 需图床支持 |

### 后续接入图床后

邮件端的图片 URL 可从以下来源获得：
1. **微信 CDN URL**：wenyan 发布后从返回结果提取图片 URL 映射表（需 `@wenyan-md/cli` 支持返回）
2. **独立图床**：在上传阶段将图片推送到公开图床（如阿里云 OSS、Cloudflare R2），获得可直接访问的 URL
3. **内嵌 Base64**：小图片直接 base64 嵌入 HTML（不推荐，增大邮件体积）
