# 敏感词审查 (sensitive-check)

## 功能简介

使用 sensitive-lexicon-mcp 进行敏感词审查，覆盖 15 个分类、67038 个词条，按风险等级分级输出。

## 文件结构

```
sensitive-check/
└── SKILL.md        # 技能定义
```

## 使用方法

在 opencode 中输入以下指令触发：

- "敏感词检查"
- "内容审核"
- "合规检查"

## 工作原理

1. 获取待检查文本
2. 调用 MCP 工具 `sensitive-lexicon_detect_sensitive_words` 检测
3. 按风险等级分级（高危/中危/低危）
4. 输出结构化报告

## 风险分级

| 等级 | 包含分类 | 处理要求 |
|------|---------|---------|
| 高危 | political / subversive / violence / weapons / pornography | 必须修改 |
| 中危 | advertisement / corruption / tencent / gfw | 建议修改 |
| 低危 | covid19 / livelihood / supplementary / illegal-urls / other | 视情况处理 |

## 输出格式

```
## 敏感字审查报告
- 工具: sensitive-lexicon
- 高危: X处 | 中危: X处 | 低危: X处 | 合计: X处
- 列表:
  1. [高危] "敏感词" — 建议替换为"..." (分类: political)
  2. ...
```

## 前置依赖

需要配置 MCP 服务器 `sensitive-lexicon`，在 `opencode.json` 中添加：

```json
{
  "mcp": {
    "sensitive-lexicon": {
      "type": "local",
      "command": ["npx", "-y", "@opencode/plugin-sensitive-lexicon"],
      "enabled": true
    }
  }
}
```

## 可用工具

| MCP 工具 | 功能 |
|----------|------|
| `sensitive-lexicon_detect_sensitive_words` | 检测文本中的敏感词 |
| `sensitive-lexicon_filter_sensitive_words` | 过滤敏感词 |
| `sensitive-lexicon_get_categories` | 获取敏感词分类列表 |
| `sensitive-lexicon_get_word_count` | 获取词库词条数量 |

## 注意事项

- 建议先做敏感词审查，再做错别字检测
- 高危词必须修改，中危建议修改，低危视上下文决定
