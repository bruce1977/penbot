---
name: markdown-email
description: 将 Markdown 文件转为 HTML 并通过 Resend API 发送邮件。适用于：通讯稿发送、邮件简报、Markdown 转邮件通知。
---

# Markdown 邮件发送 Skill

## 关联 MCP

- `resend_send_email`: 通过 Resend API 发送 HTML 邮件

## 触发条件

"发送邮件" / "邮件发送" / "email" / "markdown 转邮件" / "通讯稿发送"

## 配置说明

- 发件人地址从环境变量 `PB_RESEND_FROM` 读取（Resend 已验证域名），无需用户提供
- 发件人显示名称固定为 `公众号汇集小能手`
- 收件人地址由用户提供

## 执行步骤

### 原则

- **Markdown → HTML 必须完整转换，不得增减内容**。原文件中的每一段文字、每一张图片、每一个链接、每一行表格都必须原样保留；不得自行添加额外说明、标题、分隔线等；不得遗漏原文任何元素。
- 所有图片 URL 必须完整保留，含括号 `()` 的 URL 需正确处理不可截断。

### 步骤 1：读取 Markdown 文件

读取指定的 `.md` 文件内容。

### 步骤 2：安装依赖（首次使用）

首次运行需安装 Node.js 依赖：

```
cd {skill} && npm install
```

### 步骤 3：Markdown → HTML 转换

运行转换脚本：

```
node {skill}/convert.js {input.md} [{output.html}]
```

- `{output.html}` 可选，默认值为 `{input.md}` 对应文件名 + `.html`，**且与输入文件保持在同一目录**下（如 `path/to/doc.md` → `path/to/doc.html`）
- 转换引擎使用 [markdown-it](https://github.com/markdown-it/markdown-it)（支持 typographer、linkify、表格、代码块等完整 Markdown 语法）

### 步骤 4：发送邮件（带重试）

调用 `resend_send_email` 发送，最多尝试 2 次：

| 参数 | 值 |
|------|-----|
| `to` | 收件人邮箱（用户提供） |
| `subject` | 邮件标题（用户提供或从文件名提取） |
| `html` | 步骤 3 生成的完整 HTML |
| `from` | `公众号汇集小能手 <{env:PB_RESEND_FROM}>` |

**重试逻辑**（最多发送 3 次，允许 2 次失败）：

| 尝试 | 失败后的处理 |
|------|-------------|
| 第 1 次失败 | 记录错误信息，分析失败原因（如网络错误、收件地址格式、API 密钥、HTML 内容过大等），修复后立即重试 |
| 第 2 次失败 | 记录错误信息，再次分析原因并修复，修复后重试 |
| 第 3 次失败 | 记录最终错误信息，终止流程并返回错误详情供用户排查 |

## 输出

- 成功：`{"success": true, "id": "<resend-message-id>"}`
- 失败：返回最终错误信息
