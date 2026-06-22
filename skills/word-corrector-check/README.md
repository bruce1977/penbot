# 错别字检测 (word-corrector-check)

## 功能简介

使用 word-corrector MCP 进行中文错别字检测，支持音似、形似错误识别。

## 工作原理

1. 获取待检查文本
2. 调用 MCP 工具 `word-corrector_get_correct` 检测
3. 自动过滤已知误报（主角名、世界观名等专有名词）
4. 输出结构化报告

## 输出格式

```
## 错别字检查报告
- 工具: word-corrector
- 检出: X处 | 误报过滤: X处 | 净错误: X处
- 列表:
   1. "错误词" → "正确词" (位置)
   2. ...
- 建议: ...
```

## 触发方式

在 opencode 中直接输入以下指令：

- "检查错别字"
- "校对这篇文章"
- "有没有错别字"

## 依赖

- MCP: `word-corrector`（`local-mcps/pycorrector-nodejs/`）
- 误报过滤：`docs/definition/glossary.md`

