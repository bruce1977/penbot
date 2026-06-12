# 步骤 1：读取配置

> 本文档为 `SKILL.md` 的步骤详情子文档。

读取 `{config}` 路径下的配置文件（默认 `{skill}/config.json`，支持通过命令行参数指定外部路径），解析公众号列表和全局设置。仅处理 `enabled: true` 的公众号，`enabled: false` 的公众号直接跳过。

### 配置字段

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `accounts[].name` | string | 必填 | 公众号显示名称 |
| `accounts[].fake_id` | string | 必填 | 公众号唯一标识 |
| `accounts[].category` | string | 无 | 分类标签，仅用于组织管理，与最终主题无关 |
| `accounts[].enabled` | bool | `true` | 设为 `false` 则跳过该公众号 |
| `settings.name` | string | 空 | 输出目录名称前缀 |
| `settings.days_to_filter` | int | `3` | 筛选最近 N 天的文章 |
| `settings.max_articles_per_account` | int | `5` | 每号最多拉取文章数 |
| `settings.top_n_articles` | int | `5` | 热门文章榜数量 |
| `settings.topic_count` | int | `3` | 遴选主题数量 |
| `settings.similarity_threshold` | float | `0.8` | 去重阈值（编辑距离，0-1） |
| `settings.language` | string | `zh-CN` | 输出语言 |

### 配置示例

```json
{
  "accounts": [
    {
      "name": "AI科技评论",
      "fake_id": "gh_xxxxxx",
      "category": "科技",
      "enabled": true
    }
  ],
  "settings": {
    "name": "ai-daily",
    "days_to_filter": 3,
    "max_articles_per_account": 5,
    "topic_count": 3
  }
}
```

## 输入/输出

| 方向 | 文件路径 | 说明 | 下游消费 |
|------|---------|------|---------|
| 输入 | `{config}` | 原始配置文件（JSON） | — |
| 输出 | `{config}`（验证后） | 验证通过的原文件，路径不变 | 步骤 2.1/2.3/4.1/4.2 |

> 本步骤只做配置校验，不产生新文件。输出路径仍为 `{config}`，但已确认其格式正确、字段完整。

## 错误处理

- **配置缺失**：`fake_id` 为空或配置无效时报错提示用户检查配置
- **公众号禁用**：仅处理 `enabled: true` 的公众号，禁用的直接跳过并记录日志
