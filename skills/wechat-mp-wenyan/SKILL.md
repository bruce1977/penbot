---
name: wechat-mp-wenyan
description: 使用 @wenyan-md/cli（文颜）将 Markdown 文章发布到微信公众号草稿箱，及管理公众号凭据、主题、Server。适用于：管线终稿自动发布、草稿箱投递、CI/CD 发文、主题管理、凭据配置。
---

# 文颜发布 Skill

使用 `@wenyan-md/cli` 将 Markdown 文件一键发布到微信公众号草稿箱，自动处理图片上传与排版。

## 前置依赖

- `@wenyan-md/cli` — 可通过 `npx @wenyan-md/cli` 按需运行，无需提前安装
- 环境变量 `WECHAT_MP_APP_ID` + `WECHAT_MP_APP_SECRET`（或兼容的 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`）— 微信公众号凭证；也可通过 `--server`/`--api-key` 指定远程 Server

## 变量定义

| 变量 | 类型 | 说明 |
|------|------|------|
| `{skill}` | 系统 | 技能目录路径，运行时分派框架自动解析 |
| `{input.md}` | 输入 **必填** | 要发布的 Markdown 文件路径，必须包含 frontmatter（title 必填） |
| `{output.result}` | 输入 *可选* | 结果 JSON 文件路径；传入后脚本将发布结果（成功/失败）写入该文件 |

## 输入参数缺失处理

| 缺失参数 | 处理方式 |
|----------|----------|
| `{input.md}` | 提示用户提供要发布的 Markdown 文件路径 |
| `{output.result}` | 仅 stdout 输出结果，不写文件 |

## 可扩展命令集

`@wenyan-md/cli` 提供以下命令，本技能可在此基础上逐步扩展脚本覆盖：

| 命令 | 功能 | 封装状态 |
|------|------|----------|
| `publish` | 发布 Markdown 到公众号草稿箱（支持图文/小绿书） | ✅ `scripts/wechat-mp-wenyan.js` |
| `publish-drafts` | 将草稿箱内现有草稿发布为已发表文章 | ⏸️ `scripts/publish-drafts.js`（需微信认证开通 `freepublish/submit` 权限） |
| `render` | 仅渲染 HTML 不发布 | ⏳ 可扩展 |
| `theme` | 管理排版主题（列出/注册/删除） | ⏳ 可扩展 |
| `credential` | 管理多公众号凭据 | ⏳ 可扩展 |
| `serve` | 启动远程发布 Server | ⏳ 可扩展 |

## 关联脚本

- `{skill}/scripts/wechat-mp-wenyan.js` — 调用 `@wenyan-md/cli publish` 发布到公众号草稿箱
- `{skill}/scripts/publish-drafts.js` — 直接通过微信 API 将草稿箱内草稿发布为已发表文章（支持 DRY_RUN）
- `{skill}/scripts/*.js` — 后续可按需添加 render / theme / credential / serve 等封装

## 配置说明

必须在环境中设置以下变量之一：

### 本地模式

| 环境变量 | 说明 |
|----------|------|
| `WECHAT_MP_APP_ID` | 微信公众号 App ID（项目 .env 中使用） |
| `WECHAT_MP_APP_SECRET` | 微信公众号 App Secret（项目 .env 中使用） |
| `WECHAT_APP_ID` | 兼容别名，`@wenyan-md/cli` 原生变量 |
| `WECHAT_APP_SECRET` | 兼容别名，`@wenyan-md/cli` 原生变量 |

### 远程 Server 模式（推荐用于无固定 IP 环境）

通过参数 `--server` 和 `--api-key` 指定，或设置环境变量 `WENYAN_SERVER_URL` 和 `WENYAN_API_KEY`。

运行 CLI 的机器 IP 须在微信公众号后台加入 IP 白名单（本地模式），或由 Server 端处理（远程模式）。

## 执行步骤

### 入口 A：发布 Markdown 到草稿箱（publish）

#### 步骤 1：校验输入

检查 `{input.md}` 文件存在且非空。

#### 步骤 2：发布到草稿箱

运行发布脚本：

```
node {skill}/scripts/wechat-mp-wenyan.js "{input.md}" [{output.result}]
```

- `{input.md}` — **必填**
- `{output.result}` — *可选*；若提供则结果同时写入该文件

脚本内部调用 `npx @wenyan-md/cli publish -f "{input.md}"` 完成发布。

#### 步骤 3：输出结果

- **成功**：stdout 输出 `{"success": true, "draft_id": "<draft-id>", "timestamp": "..."}`  
- **失败**：stderr 输出 `{"success": false, "error": "<错误详情>", ...}`，退出码非 0
- 若 `{output.result}` 已指定，上述结果同时写入该文件

### 入口 B：将草稿箱内草稿发布为已发表文章（publish-drafts）

> ⚠️ **当前不可用** — 需要微信认证（服务号/订阅号）开通 `freepublish/submit` 接口权限。当前账号返回 `48001 api unauthorized`。可扩展命令表中标记为 ⏸️。

将草稿箱中已有的草稿直接发布到公众号前台（用户可见），无需预览确认。

#### 步骤 1：运行发布脚本

```
node {skill}/scripts/publish-drafts.js [{output.result}]
```

- `{output.result}` — *可选*；结果 JSON 写入路径

脚本通过微信 API 直接操作：
1. 获取 `access_token`（使用 `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET`）
2. 遍历草稿箱，逐篇调用 `freepublish/submit` 发布
3. 空内容草稿自动跳过

#### 步骤 2：输出结果

`{"success": true/false, "total": N, "published": N, "skipped": N, "failed": N, "results": [...]}`

## 失败场景与处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 环境变量未设置 | 提示 `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` 缺失 | 检查 .env 或环境变量 |
| access_token 获取失败 | 微信 API 返回 errcode | 检查 APP_ID/APP_SECRET 是否正确 |
| 草稿箱读取失败 | API 返回错误 | 确保 IP 已在公众号白名单 |
| 某篇草稿发布失败 | 该篇标记 error，继续处理其余草稿 | 查看具体 errmsg 定位问题 |
| `freepublish/submit` 返回 48001 | 接口无权限 | 需完成微信认证后开通发布能力 |

## 输出

- 入口 A（publish）：`{"success": true, "draft_id": "<draft-id>"}` / `{"error": "<错误详情>"}`
- 入口 B（publish-drafts）：`{"success": true, "dryRun": true, "drafts": [...]}` / `{"success": true, "results": [...]}`
