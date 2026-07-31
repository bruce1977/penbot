---
name: kb-archive
description: "知识库子流程 2.4：归档（旧文件 → archived），输入 profile 即可"
---

# 子流程 2.4：归档

知识库管线四子流程之一。由 `coordinator` 将 `{weknora}` 中的旧文件（可配置，默认 3 个月 = 90 天）移动到 `{archived}/`。本流程只接受 `{profile}`，归档天数由约定路径 `configs/{profile}-config.json` 读取。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{config}` | `configs/{profile}-config.json` | 约定配置文件（含 `settings.archive_after_days`） |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{weknora}` | `{base}/weknora` | 待归档目录 |
| `{archived}` | `{base}/archived` | 归档目录 |

> 调用方式：`coordinator` 仅需告知 `{profile}`（如 `ai`），即处理 `D:/knowledge/articles/ai/weknora/ → archived/`。

## 步骤

```
node scripts/archive_old_files.js {weknora} {archived} [{archive_after_days}]
```

按文件 mtime 判断年龄，超过阈值天数的 `.md` 移动到 `{archived}/`。

## 天数来源优先级

1. 命令行参数 `{archive_after_days}`
2. `{config}` 中 `settings.archive_after_days`
3. 默认 `90` 天

## 产出

| 文件 | 说明 |
|------|------|
| `{archived}/*.md` | 已归档的旧文件 |

本子流程为知识库管线的最后一个阶段。

## 错误处理

| 场景 | 处理 |
|------|------|
| 源目录不存在 | 报错退出 |
| 归档目标已存在 | 覆盖写入 |
| 无文件 | 正常结束 |
