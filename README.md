# penbot

微信公众号文章自动化管线：从知识库（本地文档目录或 WeKnora 远程知识库）自动选题，产出可直接发布的图文稿件。

这是一个**脚本驱动**的 Skill，可运行在 OpenCode（或任何能执行 Node 的 agent 编排器）中：

```
选题 ──► 资料收集 ──► 纲要 ──► 初稿 ──► 核稿/评稿/修正(≤3 轮) ──► 自动配图(1-5) ──► 邮件 + 公众号草稿
```

机械流程全部由脚本完成，只在需要判断的环节（选题、纲要、初稿、评稿、修正、备用校对）调用模型。

## 快速开始

```bash
npm install                       # 安装 markdown-it（邮件 HTML 渲染）

npm run wechat-article:validate   # 校验配置文件
npm run wechat-article:doctor     # 检查环境与服务连通性

# 用 mock 模型跑通全流程（不发真实请求）
npm run wechat-article -- auto --type ai-news --mock

# 入口 1（自动）：知识库选题 + 自动纲要
npm run wechat-article -- auto --type ai-insight --stage draft

# 入口 2（手动）：你给标题 + 提纲
npm run wechat-article -- manual --type ai-news --title "某模型正式开源" --outline-file outline.md
```

- 两个入口之后步骤完全一致；`--type` 可省略，在 `.env` 设 `PB_ARTICLE_TYPE=ai-news` 即可。
- 手动提纲最简格式：`# 标题` + `## 小节` + `- 要点`；也可直接喂管线生成的 `03-outline.json`。
- 想先看几个选题：`npm run wechat-article -- topics --type ai-news --count 3 --output output`（输出 3 个候选主题 + 提纲的 Markdown）。

文章根目录由 `.env` 的 `BASE_OUTPUT_FOLDER` 决定（默认 `output/wechat-article`），每篇文章一个目录：

```text
$BASE_OUTPUT_FOLDER/
├── draft/<slug>/      # 一篇文章一个目录：01-topic.json … 09-publish.json
└── published/         # 发布成功后归档的 <YYYYMMDD>-<slug>.zip
```

中断后重跑同一条命令即可从最后一个产物继续：`auto --type ai-news --article <slug>`。

### 分步执行（推荐）

各步都在同一篇文章目录里追加产物，`--article <slug>` 指定文章（只有一篇时可省略）：

```bash
npm run wechat-article -- topic   --type ai-news                    # 1a 自动选题（目录名 = 标题 slug）
npm run wechat-article -- sources --article <slug>                  # 2  资料收集（本地目录）
npm run wechat-article -- outline --article <slug>                  # 1b 纲要
npm run wechat-article -- bundle  --article <slug>                  # 3  打包初稿输入
npm run wechat-article -- draft   --article <slug>                  # 4  初稿
```

`bundle` 会把**标题 + 大纲 + 相关资料**写成 `04-draft-input.json`；提示词与校验规则都在 [`skills/wechat-article/config/prompts/draft.json`](skills/wechat-article/config/prompts/draft.json)（`prompt` + 紧凑 `schema`）。可以手改这份 JSON，再用 `draft --article <slug> --input <文件>` 写初稿；也可以用 `validate --input <文件>` 先校验。

发布成功后（邮件/公众号至少一个真实投递成功）会自动归档：终稿复制到本地知识库的 `pipeline/` 待入库目录（`KNOWLEDGE_PIPELINE_DIR`）→ 整个文章目录打包到 `published/` → 删除 `draft/<slug>/`。

手动选题只有一步：`outline --type ai-news --topic "主题"`（跳过选题模型）。

在 OpenCode 里也可以直接用斜杠命令：`/wechat-article auto --type ai-insight`。

## 文档

- 技能说明与完整命令参考：[`skills/wechat-article/SKILL.md`](skills/wechat-article/SKILL.md)
- 全局默认（输出目录 / 判断模型行为 / 文章级默认值）：[`skills/wechat-article/config/defaults.yaml`](skills/wechat-article/config/defaults.yaml)
- 模型总表（llm / opencode / systemone）：[`skills/wechat-article/config/models.yaml`](skills/wechat-article/config/models.yaml)
- 类型注册表：[`skills/wechat-article/config/article-types.yaml`](skills/wechat-article/config/article-types.yaml)
- 流程节点（按大步骤拆分）：[`skills/wechat-article/config/steps/`](skills/wechat-article/config/steps/)；入口 [`steps.yaml`](skills/wechat-article/config/steps.yaml)
- 类型明细与字段说明：[`skills/wechat-article/config/types/`](skills/wechat-article/config/types/)

## 内置文章类型

| id | 名称 | 知识库 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 800-1300 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

类型明细在 `config/types/<id>.yaml`；不配置 `weknora`，默认只读本地目录。判断模型（systemone）会根据标题 + 提纲自动选类型。

流程节点按大步骤放在 `config/steps/`：`classify_type` → `select_topic` → `gather_materials` → `outline` → `bundle_draft_input` → `draft_writing` → `length_adjust` → `review` → `scoring` → `revision` → `de_ai` → `image_generation` → `publish` → `archive`。模型统一在 `config/models.yaml` 定义，节点只写模型 id（如 `llm.local`、`llm.large`）。用 `wechat-article.mjs steps` 查看。

## 目录结构

```text
.
├── opencode.json                 OpenCode 技能路径、斜杠命令、写作代理
├── package.json
└── skills/wechat-article/        Skill（含 SKILL.md、config/、scripts/、tests/）
```

## 依赖的服务（按需）

| 能力 | 服务 | 环境变量 |
| --- | --- | --- |
| 本地写作模型 | Ollama（本地或网关） | `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_BASE_MODEL` / `LOCAL_LLM_API_KEY` |
| 备用写作模型 | OpenCode agent CLI | — |
| 远程写作模型 | 任意 OpenAI 兼容端点 | `PB_LLM_BASE_URL` / `PB_LLM_MODEL` / `PB_LLM_API_KEY` |
| 资料收集（远程） | WeKnora | `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` |
| 核稿 | correct-cn | `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_AUTH_KEY` |
| 配图（首选） | ModelScope | `PB_MODEL_IMAGE_API_KEY` |
| 配图（回退） | Pollinations | — |
| 邮件 | Resend | `PB_RESEND_API_KEY` / `PB_RESEND_FROM` |
| 公众号草稿 | @wenyan-md/cli | `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` |

每个模型 profile 都用 **BASE_URL / MODEL_NAME / API_KEY** 三项配置（`base_url` / `model` / `api_key`，`model_name` 亦可）。流程节点默认继承 `config/steps.yaml` 的 `defaults.model`，需要特殊模型时只覆盖对应节点；也可以在节点里切换成 `opencode`。所有服务都可在配置里单独开关；缺哪个就自动降级或跳过，不会中断整条管线。

文章类型可以用 `--type` 指定，也可以在 `.env` 里设 `PB_ARTICLE_TYPE=ai-news` 作为默认值。

WeKnora 远端知识库有总开关 `PB_USE_WEKNORA`，默认 `false`（只读本地知识库目录）；设为 `true` 才会按类型的 `knowledge.source` 使用远端。

## 测试

```bash
npm test
```
