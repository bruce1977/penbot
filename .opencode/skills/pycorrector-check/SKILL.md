---
name: pycorrector-check
description: 中文错别字检测（pycorrector），支持音似、形似错误检测
---

# 错别字检测 Skill

## 关联 MCP

- `pycorrector_get_correct`: 检测并纠正中文文本错别字，返回原文、修正文和错误列表

## 触发条件

"检查错别字" / "校对" / "文字检查" / "有没有错别字" / "pycorrector"

## 执行步骤

1. 获取待检查文本
2. 调用 `pycorrector_get_correct` 检测
3. 过滤已知误报（主角名、世界观名，详见 `docs/definition/glossary.md`）
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
