# 敏感词审查 (word-sensitive-check)

## 功能简介

使用 word-sensitive MCP 进行敏感词审查，覆盖 15 个分类、67038 个词条，按风险等级分级输出。

## 工作原理

1. 获取待检查文本
2. 调用 MCP 工具 `word-sensitive_detect_sensitive_words` 检测
3. 按风险等级分级（高危/中危/低危）
4. 输出结构化报告

## 风险分级

| 等级 | 包含分类 | 处理要求 |
|------|---------|---------|
| 高危 | political / subversive / violence / weapons / pornography | 必须修改 |
| 中危 | advertisement / corruption / tencent / gfw | 建议修改 |
| 低危 | covid19 / livelihood / supplementary / illegal-urls / other | 视情况决定 |

## 输出格式

```
## 敏感词审查报告
- 工具: word-sensitive
- 高危: X处 | 中危: X处 | 低危: X处 | 合计: X处
- 列表:
   1. [高危] "敏感词" — 建议替换为"..." (分类: political)
   2. ...
```

## 触发方式

在 opencode 中直接输入以下指令：

- "敏感词检查"
- "内容审核"
- "合规检查"

## 依赖

- MCP: `word-sensitive`（`local-mcps/sensitive-lexicon-nodejs/`）
