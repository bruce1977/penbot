# 步骤 1：读取配置

> 本文档为 `SKILL.md` 的步骤详情子文档。

> ⚠️ **`{config}` 无默认值，用户必须通过命令行参数指定路径。** 技能不提供内置配置文件。

核心任务：
1. 根据变量定义确定 `{profile}`（来自 `{config}` 的 `settings.name`）
2. 构造 `{temp-data}` = `.temp/{profile}/~data`，确定 `{config-runtime}` = `{temp-data}/config.json`
3. 将 `{config}` 复制到 `{config-runtime}`
4. 校验配置字段完整性

后续所有步骤统一从 `{config-runtime}` 读取，不再引用原始 `{config}`。

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
| `settings.topic_selection_guidance` | string | 无 | 主题遴选指导说明，会合并到 `analysis_report.json`，供 AI 在遴选主题时参考。例如：`"侧重国产替代和开源生态方向"` |
| `settings.similarity_threshold` | float | `0.8` | 去重阈值（编辑距离，0-1） |
| `settings.language` | string | `zh-CN` | 输出语言 |
| `settings.max_accounts` | int | `5` | 每次最多抓取的公众号数量（用于日期轮换算法） |
| `settings.email` | string | 无 | 收件邮箱地址，供工作流发送邮件 |
| `settings.email_summary_enabled` | bool | `true` | 汇总报告邮件开关。设为 `false` 时跳过汇总报告发送（步骤 2） |
| `settings.email_final_enabled` | bool | `true` | 终稿邮件开关。设为 `false` 时跳过终稿发送（步骤 7） |

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
    "name": "ai-daily",    # 配置名称（必填），取自用户提供的配置文件，用于生成 `{profile}`
    "days_to_filter": 3,
    "max_articles_per_account": 5,
    "max_accounts": 5,
    "topic_count": 3,
    "email": "user@example.com",
    "email_summary_enabled": true,
    "email_final_enabled": true
  }
}
```

## 流程

### 1.1 复制配置到运行时目录

`{profile}` 已在 [SKILL.md#变量定义](../SKILL.md#变量定义) 中定义（取 `{config}` 的 `settings.name`）。据此构造路径并复制：

1. **构造路径**：`{temp-data}` = `.temp/{profile}/~data`，`{config-runtime}` = `{temp-data}/config.json`
2. **断言 `{profile}` 非空**：若为空则报错退出
3. **检查源文件**：确认 `{config}` 存在，不存在则报错退出
4. **创建目标目录**：确保 `.temp/{profile}/~data/` 目录存在
5. **复制文件**：将 `{config}` 复制到 `.temp/{profile}/~data/config.json`
6. **交叉校验**：读取复制后的 `config.json`，确认 `settings.name` 与变量定义中 `{profile}` 一致；不一致则报错退出

> `{config-runtime}` 固定位于 `{temp-data}/config.json`（即 `.temp/{profile}/~data/config.json`），后续所有步骤统一从此路径读取，不再引用原始 `{config}`。

### 1.2 校验配置

读取 `{config-runtime}` 中的 JSON，解析公众号列表和全局设置，校验字段完整性。校验规则见下方「配置字段」和「错误处理」。重点关注：

- `settings.name` **必须非空**（已在 1.0 中校验）
- `accounts[].fake_id` 每个启用的公众号都必须填写
- `settings.days_to_filter`、`max_articles_per_account` 等数值字段需为正整数

校验通过后运行 `validate.js` 确认：

```
node {skill}/scripts/validate.js config {config-runtime}
```

校验通过输出 `Valid: config.json (N account(s))`，失败则 exit 1 并列出问题。

## 输入/输出

| 方向 | 文件路径 | 说明 | 下游消费 |
|------|---------|------|---------|
| 输入 | `{config}` | 原始配置文件（JSON，用户提供的任意路径） | — |
| 输出 | `{config-runtime}` | 标准化后的运行时配置副本 | 步骤 2.1/3.2/4.1/4.2 |

> 本步骤输出 `{config-runtime}`（固定为 `{temp-data}/config.json`），后续步骤统一读取此路径，不再引用原始 `{config}`。

## 错误处理

- **配置缺失**：`fake_id` 为空或配置无效时报错提示用户检查配置
- **公众号禁用**：仅处理 `enabled: true` 的公众号，禁用的直接跳过并记录日志
