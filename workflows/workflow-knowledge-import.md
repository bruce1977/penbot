---
name: kb-import
description: "知识库子流程 2.3：导入 WeKnora（文章+标签 → weknora），输入 profile 即可"
---

# 子流程 2.3：导入知识库

知识库管线四子流程之一。由 `coordinator` 使用 `wechat-mp-sync-weknora` 技能，将 `{marked}` 中带 frontmatter 的终稿逐篇导入 WeKnora（文章 + 标签），导入成功后移动到 `{weknora}/`。本流程只接受 `{profile}`，`weknora_kb_id` 由约定路径 `configs/{profile}-config.json` 读取。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{config}` | `configs/{profile}-config.json` | 约定配置文件（含 `settings.weknora_kb_id`） |
| `{KB}` | 环境变量 `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录 |
| `{base}` | `{KB}/articles/{profile}` | profile 知识库根目录 |
| `{marked}` | `{base}/marked` | 待导入终稿目录 |
| `{weknora}` | `{base}/weknora` | 已导入文章目录 |

> 调用方式：`coordinator` 仅需告知 `{profile}`（如 `ai`），即处理 `D:/knowledge/articles/ai/marked/ → weknora/`。

## 前置条件

| 环境变量 | 说明 |
|---------|------|
| `WEKNORA_BASE_URL` | WeKnora API 基础地址 |
| `WEKNORA_API_KEY` | API 密钥 |

## 步骤

### 1. 确定目标知识库

优先使用 `{config}` 中 `settings.weknora_kb_id`；否则按 `KB.name == {profile}` 匹配。未找到时脚本报错并列出可用 KB。

### 2. 逐篇导入

```
node skills/wechat-mp-sync-weknora/scripts/sync_to_weknora.js {marked} {weknora} {profile} [{kb_id}]
```

每篇执行：

1. 解析 frontmatter：`title`、`tags`、正文 `body`
2. 创建/复用标签：`GET /knowledge-bases/{kb}/tags` 查找，缺失则 `POST` 创建
3. 导入文章：`POST /knowledge-bases/{kb}/knowledge/manual`，body 携带 `{ title, content, tag_ids: [...] }`
4. 成功后 `Move` 到 `{weknora}/`，失败保留在 `{marked}` 待重试

### 3. 结果汇总

输出同步成功/失败数量。失败篇可在修复后重新运行本子流程。

## 说明

- 导入成功才移动，失败保留在 `{marked}` 可重试
- 标签关联已验证：manual 导入 body 传 `tag_ids` 数组即完成多标签关联

## 产出

| 文件 | 说明 |
|------|------|
| `{weknora}/*.md` | 已成功导入 WeKnora 的文章 |

## 超时与环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `SYNC_SCRIPT_TIMEOUT_MS` | `600000` | 同步脚本整体超时 |
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |

## 错误处理

| 场景 | 处理 |
|------|------|
| KB 未匹配 | 报错退出，提示配置 `settings.weknora_kb_id` |
| 单篇导入失败 | 记录 FAIL，保留在 `{marked}`，继续处理其他篇 |
| 标签创建失败 | 该篇 FAIL，重跑可恢复 |
