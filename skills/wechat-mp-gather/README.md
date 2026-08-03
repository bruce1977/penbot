# 微信公众号文章采集 (wechat-mp-gather)

单一功能：根据公众号列表拉取文章列表并下载 Markdown 原文。

> **职责边界**：本技能只负责采集下载。元数据提取与评分由 `knowledge-analyze` 技能的 `analyze_batch.js` 脚本完成。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PB_WECHAT_MP_API_BASE` | 微信公众号 HTTP API 基础地址 |
| `PB_WECHAT_MP_AUTH_KEY` | API 认证密钥 |

## 输入

**accounts** — 公众号列表
```json
[
  { "name": "AI科技评论", "fake_id": "MzA5...", "category": "科技", "enabled": true }
]
```

**settings** — 配置参数
```json
{
  "save_path": "D:/path/to/save",
  "days_to_filter": 3,
  "max_articles_per_account": 5,
  "max_accounts": 5
}
```

## 工作流

| 步骤 | 脚本 | 说明 |
|------|------|------|
| 拉取列表 | `fetch_and_prepare.js` | 账号轮选、API 拉取、字段精简，输出 `article_list.json` |
| 批量下载 | `download_articles.js` | 逐篇校验/下载/重试，输出 `download_list.json` |
| 校验清理 | — | 校验文件存在，删除临时目录 |

## 产出

- `{save_path}/*.md` — 下载的 Markdown 原文（含 `![cover_image]`）
- 下载清单：`{base_path, files[]}`

## 账号轮换算法

`fetch_and_prepare.js` 内置分组分片 + 按日期末位数字确定性轮选，保证 `ceil(N/M)` 天内每个账号恰好被拉到一次。
