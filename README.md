# penbot

微信公众号文章自动化管线：从本地知识库自动选题，产出可直接发布的图文稿件。

这是一个**脚本驱动**的 Skill，可运行在 OpenCode（或任何能执行 Node 的 agent 编排器）中：

```
选题 ──► 素材检索 ──► 纲要 ──► 初稿 ──► 核稿/评稿/修正(≤3 轮) ──► 自动配图(1-5) ──► 邮件 + 公众号草稿
```

机械流程全部由脚本完成，只在需要判断的环节（选题、纲要、初稿、评稿、修正、备用校对）调用模型。

## 快速开始

```bash
npm install                       # 安装 markdown-it（邮件 HTML 渲染）

npm run wechat-article:validate   # 校验配置文件
npm run wechat-article:doctor     # 检查环境与服务连通性

# 用 mock 模型跑通全流程（不发真实请求）
npm run wechat-article -- run --type ai-news --mock --output .temp/demo

# 真实运行
npm run wechat-article -- run --type ai-insight
npm run wechat-article -- run --type ai-news --topic "某模型正式开源" --requirements "重点写对独立开发者的影响"
```

在 OpenCode 里也可以直接用斜杠命令：`/wechat-article run --type ai-insight`。

## 文档

- 技能说明与完整命令参考：[`skills/wechat-article/SKILL.md`](skills/wechat-article/SKILL.md)
- 文章类型 / 模型 / 审稿 / 配图 / 发布配置：[`skills/wechat-article/config/article-types.json`](skills/wechat-article/config/article-types.json)
- 配置结构：[`skills/wechat-article/config/article-types.schema.json`](skills/wechat-article/config/article-types.schema.json)

## 内置文章类型

| id | 名称 | 知识库 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 800-1300 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

## 目录结构

```text
.
├── opencode.json                 OpenCode 技能路径、斜杠命令、写作代理
├── package.json
└── skills/wechat-article/        Skill（含 SKILL.md、config/、scripts/）
```

## 依赖的服务（按需）

| 能力 | 服务 | 环境变量 |
| --- | --- | --- |
| 本地写作模型 | Ollama | `PB_OLLAMA_BASE_URL` / `PB_OLLAMA_MODEL` |
| 备用写作模型 | OpenCode agent CLI | — |
| 远程写作模型 | 任意 OpenAI 兼容端点 | `PB_LLM_BASE_URL` / `PB_LLM_API_KEY` |
| 核稿 | correct-cn | `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_AUTH_KEY` |
| 配图（首选） | ModelScope | `PB_MODEL_API_KEY` |
| 配图（回退） | Pollinations | — |
| 邮件 | Resend | `PB_RESEND_API_KEY` / `PB_RESEND_FROM` |
| 公众号草稿 | @wenyan-md/cli | `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` |

所有服务都可在配置里单独开关；缺哪个就自动降级或跳过，不会中断整条管线。

## 测试

```bash
npm test
```
