# 错别字检测 (pycorrector-check)

## 功能简介

使用 pycorrector 进行中文错别字检测，支持音似、形似错误识别。

## 文件结构

```
pycorrector-check/
└── SKILL.md        # 技能定义
```

## 使用方法

在 opencode 中输入以下指令触发：

- "检查错别字"
- "校对这篇文章"
- "有没有错别字"

## 工作原理

1. 获取待检查文本
2. 调用 MCP 工具 `pycorrector_get_correct` 检测
3. 自动过滤已知误报（主角名、世界观名等专有名词）
4. 输出结构化报告

## 输出格式

```
## 错别字检查报告
- 工具: pycorrector
- 检出: X处 | 误报过滤: X处 | 净错误: X处
- 列表:
  1. "错误词" → "正确词" (位置)
  2. ...
- 建议: ...
```

## 前置依赖

需要配置 MCP 服务器 `pycorrector`，在 `opencode.json` 中添加：

```json
{
  "mcp": {
    "pycorrector": {
      "type": "local",
      "command": ["npx", "-y", "@opencode/plugin-pycorrector"],
      "enabled": true
    }
  }
}
```

## 注意事项

- 误报过滤规则引用 `docs/definition/glossary.md` 中的专有名词列表
- 建议与 sensitive-check 配合使用，先查敏感词再查错别字
