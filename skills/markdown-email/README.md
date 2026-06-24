# Markdown 邮件发送 (markdown-email)

将 Markdown 文件转为美观的 HTML 邮件，并通过 Resend API 发送。

## 快速开始

```bash
# 转换 Markdown → HTML
node skills/markdown-email/scripts/convert.js input.md output.html

# 省略输出路径时自动取 input.md → input.html
node skills/markdown-email/scripts/convert.js input.md

# 发送邮件
node skills/markdown-email/scripts/send.js "to@example.com" "邮件标题" output.html
```

## 文件结构

```
markdown-email/
├── SKILL.md        # 技能定义和工作流
├── package.json    # Node.js 依赖声明
├── README.md       # 本文件
└── scripts/
    ├── convert.js  # Markdown → HTML 转换脚本（markdown-it）
    └── send.js     # 发送邮件脚本（Resend API 直调）
```

## 功能特性

- **Markdown 完整转换**：标题、列表、表格、代码块、引用、链接、图片等全部元素
- **代码语法高亮**：基于 highlight.js，支持 190+ 语言
- **邮件风格模板**：内置响应式 CSS，适配主流邮件客户端
- **默认文件名推导**：省略输出路径时自动追加 `.html`

## 使用方法

在 opencode 中输入类似指令：

- "发送邮件，收件人 xxx@example.com，内容为 report.md"
- "将 weekly.md 转为邮件发送"
- "把通讯稿发送给所有人"

### 参数说明

| 参数 | 说明 |
|------|------|
| `to` | 收件人邮箱（必填，由用户提供） |
| `subject` | 邮件标题（用户提供或从文件名提取） |
| `from` | 发件人地址，从环境变量 `PB_RESEND_FROM` 读取 |
| `html` | 步骤 2 生成的完整 HTML |

## 环境变量

| 变量 | 说明 |
|------|------|
| `PB_RESEND_FROM` | Resend 已验证发件域名 |

## 注意事项

- Markdown → HTML 转换保持内容完整性，不增减任何原文元素
- 地址含括号 `()` 的图片/链接 URL 被正确处理
- 需要先配置 Resend MCP 服务
