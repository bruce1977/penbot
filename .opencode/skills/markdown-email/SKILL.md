# Skill: markdown-email

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

### 步骤 2：Markdown → HTML 转换

运行转换脚本：

```
node {skill}/convert.js {input.md} {output.html}
```

该脚本自动完成所有 Markdown 元素的转换：

| Markdown | HTML |
|----------|------|
| `# title` | `<h1>title</h1>` |
| `## title` | `<h2>title</h2>` |
| `### title` | `<h3>title</h3>` |
| `**bold**` | `<strong>bold</strong>` |
| `*italic*` | `<em>italic</em>` |
| `` `code` `` | `<code>code</code>` |
| `[text](url)` | `<a href="url">text</a>` |
| `![alt](src)` | `<img src="src" alt="alt" style="max-width:100%">` |
| `- item` | `<li>item</li>` 包裹 `<ul>` |
| `1. item` | `<li>item</li>` 包裹 `<ol>` |
| `> quote` | `<blockquote><p>quote</p></blockquote>` |
| `---` | `<hr>` |
| 表格 | `<table><thead><tr><th>...</th></tr></thead><tbody>...</tbody></table>` |
| 空行分隔段落 | `<p>...</p>` |

### 步骤 3：发送邮件

调用 `resend_send_email` 发送：

| 参数 | 值 |
|------|-----|
| `to` | 收件人邮箱（用户提供） |
| `subject` | 邮件标题（用户提供或从文件名提取） |
| `html` | 步骤 2 生成的完整 HTML |
| `from` | `公众号汇集小能手 <{env:PB_RESEND_FROM}>` |

## 输出

- 成功：`{"success": true, "id": "<resend-message-id>"}`
- 失败：返回错误信息供用户排查
