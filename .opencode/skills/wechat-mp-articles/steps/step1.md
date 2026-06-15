# 步骤 1：读取配置

> 本文档为 `SKILL.md` 的步骤详情子文档。

读取 `{config}` 路径下的原始配置文件（默认 `{skill}/config.json`，支持通过命令行参数指定外部路径），复制到 `{config-runtime}`（即 `{temp-data}/config.json`），后续所有步骤统一从此路径读取。此举避免 AI 在后续步骤中推导配置文件路径或名称出错。

仅处理 `enabled: true` 的公众号，`enabled: false` 的公众号直接跳过。

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

## 流程

### 1.1 复制配置到运行时目录

将用户提供的原始配置文件复制到标准化的运行时路径：

```bash
cp "{config}" "{config-runtime}"
```

> 若 `{temp-data}` 目录不存在，自动创建。

### 1.2 校验配置

读取 `{config-runtime}` 中的 JSON，解析公众号列表和全局设置，校验字段完整性。校验规则见下方「配置字段」和「错误处理」。

## 输入/输出

| 方向 | 文件路径 | 说明 | 下游消费 |
|------|---------|------|---------|
| 输入 | `{config}` | 原始配置文件（JSON，用户提供的任意路径） | — |
| 输出 | `{config-runtime}` | 标准化后的运行时配置副本 | 步骤 2.1/2.3/3.2/4.1/4.2 |

> 本步骤输出 `{config-runtime}`（固定为 `{temp-data}/config.json`），后续步骤统一读取此路径，不再引用原始 `{config}`。

## 错误处理

- **配置缺失**：`fake_id` 为空或配置无效时报错提示用户检查配置
- **公众号禁用**：仅处理 `enabled: true` 的公众号，禁用的直接跳过并记录日志
