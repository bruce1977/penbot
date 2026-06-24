---
name: markdown-email
description: 将 Markdown 文件转为 HTML 并通过 Resend API 发送邮件。适用于：通讯稿发送、邮件简报、Markdown 转邮件通知。
---

# Markdown 邮件发送 Skill

## 变量定义

| 变量 | 类型 | 说明 |
|------|------|------|
| `{skill}` | 系统 | 技能目录路径，运行时分派框架自动解析 |
| `{input.md}` | 输入 **必填** | 要转换的 Markdown 文件路径，相对于当前工作目录 |
| `{output.html}` | 输入 *可选* | 输出 HTML 文件路径，省略时自动取 `{input.md}` 同名 + `.html` |
| `{to}` | 输入 **必填** | 收件人邮箱地址 |
| `{subject}` | 输入 **必填** | 邮件标题 |

## 输入参数缺失处理

执行前必须确认 3 个必填参数 `{input.md}`、`{to}`、`{subject}` 全部齐备。如有缺失：

| 缺失参数 | 处理方式 |
|----------|----------|
| `{input.md}` | 询问用户要发送哪个 Markdown 文件 |
| `{to}` | 询问用户收件人邮箱地址 |
| `{subject}` | 询问用户邮件标题 |

**原则**：不猜测、不脑补缺失参数。例如用户只说"发邮件"，应逐一询问三个参数；用户只说"把 report.md 发邮件"，应询问收件人和标题。

## 关联脚本

- `{skill}/scripts/convert.js` — 将 Markdown 转为 HTML
- `{skill}/scripts/send.js` — 通过 Resend API 发送邮件（直接 HTTP 调用，不依赖 MCP）

## 触发条件

"发送邮件" / "邮件发送" / "email" / "markdown 转邮件" / "通讯稿发送"

## 配置说明

- 发件人地址从环境变量 `PB_RESEND_FROM` 读取，无需用户提供
- API 密钥从 `PB_RESEND_API_KEY` 读取
- 发件人显示名称固定为 `公众号汇集小能手`

## 执行步骤

### 原则（违反任一将导致重新发送）

- **Markdown → HTML 必须完整转换，不得增减内容**。原文件中的每一段文字、每一张图片、每一个链接、每一行表格都必须原样保留；不得自行添加额外说明、标题、分隔线等；不得遗漏原文任何元素。
- **禁止手动重写或简化 HTML**：发送时必须使用 `convert.js` 生成的 `.html` 文件内容，禁止手写简化版 HTML（历史教训：多次因手动省略导致文章总览丢失）。
- **发送前校验完整性**：发送前确认 `.html` 文件中关键段落（如 `文章总览` 表格、`重点文章推荐` 列表）存在且完整。
- 所有图片 URL 必须完整保留，含括号 `()` 的 URL 需正确处理不可截断。

### 步骤 1：读取 Markdown 文件

读取 `{input.md}` 文件内容。

### 步骤 2：Markdown → HTML 转换

运行转换脚本：

```
node {skill}/scripts/convert.js {input.md} [{output.html}]
```

- `{input.md}` — **必填**
- `{output.html}` — *可选*；省略时自动取 `{input.md}` 同名 + `.html`，且与输入文件保持在同一目录

示例（假设工作目录为项目根目录）：

```
node {skill}/scripts/convert.js output/ai/20260624/summary_report_20260624.md
```

输出：`output/ai/20260624/summary_report_20260624.html`

### 步骤 3：读取生成的 HTML 文件

读取步骤 2 输出的 `.html` 文件全文，**确认包含完整内容**（如 `文章总览` 表格、`重点文章推荐` 列表等），不得手动重写或简化。

### 步骤 4：发送邮件

```
node {skill}/scripts/send.js "{to}" "{subject}" "{output.html}"
```

- `{output.html}` 为步骤 2 生成的文件路径

完整示例（假设工作目录为项目根目录）：

```
node {skill}/scripts/send.js "jiangyifeng@myehome.cn" "测试汇总邮件" "output/ai/20260624/summary_report_20260624.html"
```

**重试逻辑**（`send.js` 内置，最多发送 3 次）：

| 尝试 | 失败后的处理 |
|------|-------------|
| 第 1 次失败 | 输出错误信息，等待 2 秒后重试 |
| 第 2 次失败 | 输出错误信息，等待 2 秒后重试 |
| 第 3 次失败 | 输出最终错误信息，exit 1 |

## 失败场景与处理

### 写入阶段（步骤 1-2）

| 场景 | 表现 | 处理 |
|------|------|------|
| 输入文件不存在 | `convert.js` exit 1，`ENOENT` | 检查路径拼写，确保 `{input.md}` 路径正确 |
| 输出目录不可写 | `convert.js` exit 1，`EACCES` / `ENOENT` | 检查父目录是否存在 |
| `scripts/convert.js` 缺失 | `node` 报模块未找到 | 检查 `{skill}/scripts/` 下文件完整 |
| markdown-it 依赖未安装 | `require` 报 `MODULE_NOT_FOUND` | 运行 `npm run setup` |
| 转换后 HTML 为空 | 文件大小 0 字节或缺失关键内容 | 检查 `文章总览` 等关键段落是否存在并重试 |

### 读取阶段（步骤 3）

| 场景 | 表现 | 处理 |
|------|------|------|
| HTML 文件路径错误 | `fs.readFileSync` `ENOENT` | 确认步骤 2 的输出路径与步骤 3 的读取路径一致 |
| 内容截断/编码乱码 | 邮件中某些段落消失或出现乱码 | 用 `read` 工具检查 .html 文件对应位置是否完整 |
| 关键段落缺失（遗漏校验） | 发送后收件人看到不完整内容 | 必须返回步骤 2 重新转换，不得手动拼凑 |

### 发送阶段（步骤 4）

| 场景 | 表现 | 处理 |
|------|------|------|
| `PB_RESEND_API_KEY` 未设置 | `send.js` exit 1，提示 key 缺失 | 检查环境变量 `PB_RESEND_API_KEY` 是否正确设置 |
| `PB_RESEND_FROM` 未设置 | `send.js` 使用 fallback 地址 | 非致命，默认值可用 |
| 收件人邮箱无效 | Resend 返回 422/400 | 要求用户提供正确的邮箱地址 |
| 网络超时 | `send.js` 重试 3 次后 exit 1 | 等待网络恢复后重试 |
| Resend 返回 401 | API key 无效或过期 | 检查 `PB_RESEND_API_KEY` 环境变量是否正确 |
| Resend 返回 403 | 发件域名未验证 | 检查 `PB_RESEND_FROM` 对应域名是否在 Resend 已验证 |
| Resend 返回 429 | 请求频率超限 | 等待一分钟后重试 |

### 事后校验

- 若发送成功但收件人反馈邮件格式异常，先检查 `.html` 文件原文是否正常，再检查 `send.js` 发送时是否做了额外编码
- 所有失败都应记录具体错误信息，不要静默忽略

## 输出

- 成功：`{"success": true, "id": "<resend-message-id>"}`
- 失败：`{"error": "<错误详情>"}`
