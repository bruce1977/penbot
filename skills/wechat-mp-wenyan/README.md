# wechat-mp-wenyan

基于 `@wenyan-md/cli`（文颜）的微信公众号发布技能，支持将 Markdown 排版发布到草稿箱、以及将草稿箱内草稿发布为已发表文章。

## 功能

- **发布 Markdown → 草稿箱** — 调用 `@wenyan-md/cli` 自动上传图片、排版并存入草稿箱
- **发布草稿箱 → 已发表** — 通过微信 API 将草稿箱内草稿批量发布为已发表文章（⏸️ 需微信认证开通权限）
- **结果记录** — 成功/失败结果写入 JSON 文件

## 用法

```bash
# 发布 Markdown 到草稿箱
node skills/wechat-mp-wenyan/scripts/wechat-mp-wenyan.js "<input.md>" ["<result.json>"]

# 发布草稿箱内草稿（需开通 freepublish/submit 权限）
node skills/wechat-mp-wenyan/scripts/publish-drafts.js ["<result.json>"]
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `WECHAT_MP_APP_ID` | 微信公众号 App ID |
| `WECHAT_MP_APP_SECRET` | 微信公众号 App Secret |

首次使用前需将运行机器 IP 加入公众号后台 IP 白名单。

## 可扩展命令

`@wenyan-md/cli` 支持 `publish` / `render` / `theme` / `credential` / `serve`，本技能后续可按需扩展。

## 相关文档

- [SKILL.md](SKILL.md) — 技能定义与执行步骤
- [@wenyan-md/cli 文档](https://github.com/caol64/wenyan-cli)