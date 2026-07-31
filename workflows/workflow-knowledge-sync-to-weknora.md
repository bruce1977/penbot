---
name: knowledge-sync-to-weknora
description: "知识库子流程 2.3：同步导入 WeKnora（文章+标签 → weknora），输入 profile 即可"
---

# 子流程 2.3：同步导入知识库

知识库管线四子流程之一。由 `coordinator` 使用 `knowledge-sync-weknora` 技能，将 `{marked}` 中带 frontmatter 的终稿逐篇导入 WeKnora（文章 + 标签），导入成功后移动到 `{weknora}/`。本流程只接受 `{profile}`，目标知识库 ID 与提交间隔由 `{base}/weknora.json` 读取（不依赖任何 config 文件）。

## 变量定义

| 变量 | 来源 | 说明 |
|------|------|------|
| `{profile}` | 输入参数 | 知识库 profile 名称 |
| `{kb_id}` | `{base}/weknora.json` | profile 目标知识库 ID（可被命令行第 4 参覆盖） |
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

优先使用命令行第 4 参 `kb_id`；否则读取 `{base}/weknora.json` 的 `kb_id`；再回退按 `KB.name == {profile}` 匹配。未找到时脚本报错并列出可用 KB。

### 2. 逐篇导入

```
node skills/knowledge-sync-weknora/scripts/sync_to_weknora.js {marked} {weknora} {profile} [{kb_id}]
```

每篇执行：

1. 解析 frontmatter：`hash`、`title`、`tags`、正文 `body`
2. **导入前查重（hash+title）**：以 `${hash}_${title}` 为提交标题（hash 随标题进入 WeKnora，可被标题集合精确匹配）；先调用 `GET /knowledge-bases/{kb}/knowledge` 分页拉取库内已有标题，命中 `${hash}_${title}` 则 `SKIP`（不建标签、不提交），直接移动
3. 创建/复用标签：`GET /knowledge-bases/{kb}/tags` 查找，缺失则 `POST` 创建
4. 导入文章：`POST /knowledge-bases/{kb}/knowledge/manual`，body 携带 `{ title: "${hash}_${title}", content, status: "publish", tag_ids: [...] }`（`status: "publish"` 立即入队解析，避免草稿不可检索）
5. **提交间隔**：每篇提交成功后等待 `submit_interval_ms`（默认 `10000`）再提交下一篇，给知识库留出处理时间
6. 成功后 `Move` 到 `{weknora}/`，失败保留在 `{marked}` 待重试

> **查重键 = hash + title**：hash 由子流程 2.2 计算（3 轮 sha256 取 12 位，写于 frontmatter `hash` 字段与文件名前缀）。提交标题 `${hash}_${title}` 使 hash 随标题进入 WeKnora，库内标题集合即可精确判断重复。无 `hash` 字段的旧格式文件回退为仅按 `title` 查重。
>
> **不做 hash 提交为独立字段**：已实测 WeKnora manual 导入不持久化自定义 metadata，无法按 hash 字段查询，故采用"hash 嵌入标题"方案。

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
| `SUBMIT_INTERVAL_MS` | `10000` | 提交间隔（`weknora.json` 的 `submit_interval_ms` 优先于该变量） |
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |

## 配置：`{base}/weknora.json`

目标知识库 ID 与提交间隔由 `{base}/weknora.json` 读取，**不依赖 config 文件**。若该文件不存在，脚本会自动创建默认配置：

```
{
  "kb_id": "",
  "submit_interval_ms": 10000
}
```

| 字段 | 说明 |
|------|------|
| `kb_id` | 目标知识库 ID（留空时回退按 `KB.name == {profile}` 匹配，匹配成功会自动回填到本文件） |
| `submit_interval_ms` | 每篇提交后的等待间隔（毫秒），优先于环境变量 `SUBMIT_INTERVAL_MS`（默认 `10000`） |

> 首次运行（`kb_id` 为空）会尝试按知识库名匹配 `{profile}`：匹配成功自动写回 `kb_id`；匹配失败则报错并列出可用 KB 供你填写。

## 错误处理

| 场景 | 处理 |
|------|------|
| KB 未匹配 | 报错退出，提示配置 `weknora.json` 的 `kb_id` |
| 单篇导入失败 | 记录 FAIL，保留在 `{marked}`，继续处理其他篇 |
| 标签创建失败 | 该篇 FAIL，重跑可恢复 |
| 内容重复（hash+title 命中库内已有文章） | SKIP 并移动至 `{weknora}`，不重复提交 |
