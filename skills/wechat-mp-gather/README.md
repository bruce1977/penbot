# 微信公众号文章抓取 (wechat-mp-gather)

从配置的公众号拉取文章列表并下载 Markdown 原文。由单 Agent 串行执行两个脚本。

## 快速开始

输入分两个 JSON：

**accounts.json**
```json
[
  { "name": "公众号名称", "fake_id": "公众号fake_id", "category": "分类", "enabled": true }
]
```

**settings.json**
```json
{
  "save_path": "D:/path/to/knowledge",
  "days_to_filter": 3,
  "max_articles_per_account": 5,
  "max_accounts": 5
}
```

## 工作流

1. **阶段 1** — `fetch_and_prepare.js`：账号轮选、API 拉取文章列表、字段精简
2. **阶段 2** — `download_articles.js`：批量下载 Markdown 原文（含校验重试）、生成下载清单

## 输出

- `{save_path}/*.md` — 文章原文
- `{temp}/download_list_{yyyyMMdd}.json` — 当前批次文件清单（`{base_path, files[]}`）

## 环境变量

| 变量 | 说明 |
|------|------|
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 |
| `PB_WECHAT_MP_AUTH_KEY` | API 认证密钥 |

## 账号轮换算法

`fetch_and_prepare.js` 内置分组分片 + 逐周期确定性洗牌策略，保证 `ceil(N/M)` 天内每个账号恰好被拉到一次。
