---
name: word-sensitive-check
description: 敏感词审查（word-sensitive-mcp），覆盖15分类67038词
---

# 敏感字审查 Skill

## 关联 MCP

- `word-sensitive_detect_sensitive_words`: 检测文本敏感词
- `word-sensitive_filter_sensitive_words`: 过滤敏感词
- `word-sensitive_get_categories`: 获取敏感词分类
- `word-sensitive_get_word_count`: 获取词库数量

## 触发条件

"敏感词" / "敏感字" / "内容审核" / "合规检查" / "sensitive"

## 执行步骤

1. 获取待检查文本
2. 调用 `word-sensitive_detect_sensitive_words` 检测
3. 按风险等级分级（高危/中危/低危）
4. 输出结构化报告

## 风险分级

| 等级 | 分类 | 处理 |
|------|------|------|
| 高危 | political / subversive / violence / weapons / pornography | 必须修改 |
| 中危 | advertisement / corruption / tencent / gfw | 建议修改 |
| 低危 | covid19 / livelihood / supplementary / illegal-urls / other | 视情况处理 |

## 输出格式

```
## 敏感字审查报告
- 工具: word-sensitive
- 高危: X处 | 中危: X处 | 低危: X处 | 合计: X处
- 列表:
  1. [高危] "敏感词" — 建议替换为"..." (分类: political)
  2. ...
```
