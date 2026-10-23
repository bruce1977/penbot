# penbot

微信公众号文章自动化管线：从知识库（本地文档目录或 WeKnora 远程知识库）自动选题，产出可直接发布的图文稿件。

这是一个**脚本驱动**的 Skill，可运行在 OpenCode（或任何能执行 Node 的 agent 编排器）中：

```
选题 + 资料收集 ──► 纲要 + 初稿 ──► 核稿/修正/评稿/判定(≤3 轮) ──► 自动配图(1-5) ──► 邮件 + 公众号草稿
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
- 手动提纲最简格式：`# 标题` + `## 小节` + `- 要点`；也可直接喂管线生成的 `02-step/outline.json`。
- 想先看几个选题：`npm run wechat-article -- topics --type ai-news --count 3 --output output`（输出 3 个候选主题 + 提纲的 Markdown）。

文章根目录由 `.env` 的 `BASE_OUTPUT_FOLDER` 决定（默认 `output/wechat-article`），每篇文章一个目录：

```text
$BASE_OUTPUT_FOLDER/
├── draft/<slug>/      # 一篇文章一个目录：01-result.json … 06-result.json
└── published/         # 发布成功后归档的 <YYYYMMDD>-<slug>.zip
```

中断后重跑同一条命令即可从最后一个产物继续：`auto --type ai-news --article <slug>`。

### 分步执行（推荐）

各步都在同一篇文章目录里追加产物，`--article <slug>` 指定文章（只有一篇时可省略）：

```bash
npm run wechat-article -- topic   --type ai-news                    # 1 选题步：选题 → 判断类型 → 收集素材
npm run wechat-article -- draft   --article <slug>                  # 2 初稿步：纲要 → 打包初稿输入 → 初稿
npm run wechat-article -- review  --article <slug>                  # 3 审稿步：每轮 核稿 → 修正 → 评稿 → 判定
```

`draft` 步会依次写出 `02-step/outline.json`、`02-step/draft-input.json`（**标题 + 大纲 + 相关资料**）和 `02-step/draft.md`；提示词在 [`config/wechat-article/prompts/draft.yaml`](config/wechat-article/prompts/draft.yaml) 的 `draft_writing`，校验规则在 [`config/wechat-article/schemas/draft.yaml`](config/wechat-article/schemas/draft.yaml) 的 `draft_input`。可以手改这份 JSON，再用 `draft --article <slug> --input <文件>` 写初稿；也可以用 `validate --input <文件>` 先校验。

发布成功后（邮件/公众号至少一个真实投递成功）会自动归档：终稿复制到本地知识库的 `pipeline/` 待入库目录（`KNOWLEDGE_PIPELINE_DIR`）→ 整个文章目录打包到 `published/` → 删除 `draft/<slug>/`。

手动选题只有一步：`topic --type ai-news --topic "主题"`（跳过选题模型；纲要在下一步 `draft` 里生成）。

在 OpenCode 里也可以直接用斜杠命令：`/wechat-article auto --type ai-insight`。

## 文档

- 技能说明与完整命令参考：[`docs/wechat-article/USAGE.md`](docs/wechat-article/USAGE.md)
- 全局默认（输出目录 / 判断模型行为 / 文章级默认值）：[`config/wechat-article/defaults.yaml`](config/wechat-article/defaults.yaml)
- 模型总表（llm / opencode / systemone）：[`config/models.yaml`](config/models.yaml)
- 类型注册表（id → 文件名）：[`config/wechat-article/article-types.yaml`](config/wechat-article/article-types.yaml)
- 流程节点（`phases` 映射 + 节点 key/value）：[`config/wechat-article/steps/`](config/wechat-article/steps/)；入口 [`steps.yaml`](config/wechat-article/steps.yaml)
- 提示词（id = 文件名.配置项）：[`config/wechat-article/prompts/`](config/wechat-article/prompts/)
- 数据结构（id = 文件名.配置项）：[`config/wechat-article/schemas/`](config/wechat-article/schemas/)
- 类型明细与字段说明：[`config/wechat-article/types/`](config/wechat-article/types/)

## 内置文章类型

| id | 名称 | 知识库 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 1500-2000 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

类型明细在 `config/wechat-article/types/<id>.yaml`；不配置 `weknora`，默认只读本地目录。判断模型（systemone）会根据标题 + 提纲自动选类型。

流程节点按大步骤放在 `config/wechat-article/steps/`：`select_topic` → `classify_type` → `gather_materials` → `outline` → `bundle_draft_input` → `draft_writing` → `review` → `revision` → `scoring` → `de_ai` → `image_generation` → `publish` → `archive`。模型统一在 `config/models.yaml` 定义，节点只写模型 id（如 `llm.local`、`llm.large`）。用 `wechat-article.mjs steps` 查看。

## 目录结构

```text
.
├── config/
│   ├── models.yaml                  全局模型总表（三管线共享）
│   └── wechat-article/              公众号管线配置（steps/prompts/schemas/types）
├── scripts/
│   ├── lib/                         共享机制模块
│   ├── comm/                        功能专属模块（wechat-* 前缀）
│   └── wechat-article.mjs           管线入口
├── tests/wechat-article/            分阶段测试
├── docs/wechat-article/             USAGE.md 与设计文档
├── opencode.json                    OpenCode 斜杠命令与写作代理（opencode 仅作工具节点）
├── AGENTS.md                        目录规范与工程约定
└── package.json
```

## 依赖的服务（按需）

| 能力 | 服务 | 环境变量 |
| --- | --- | --- |
| 本地写作模型 | Ollama（本地或网关） | `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_BASE_MODEL` / `LOCAL_LLM_API_KEY` |
| 备用写作模型 | OpenCode agent CLI | — |
| 远程写作模型 | 任意 OpenAI 兼容端点 | `PB_LLM_BASE_URL` / `PB_LLM_MODEL` / `PB_LLM_API_KEY` |
| 资料收集（远程） | WeKnora | `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` |
| 核稿 | correct-cn | `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_API_KEY` |
| 配图（首选） | ModelScope | `PB_MODEL_IMAGE_API_KEY` |
| 配图（回退） | Pollinations | — |
| 邮件 | Resend | `PB_RESEND_API_KEY` / `PB_RESEND_FROM` |
| 公众号草稿 | @wenyan-md/cli | `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` |

每个模型 profile 都用 **BASE_URL / MODEL_NAME / API_KEY** 三项配置（`base_url` / `model` / `api_key`，`model_name` 亦可）。模型只在 `config/models.yaml` 定义（端点级默认），各步骤节点用 `models.<调用名>: { id, options }` 声明真实调用并按需覆盖默认参数（标准见 AGENTS.md）。所有服务都可在配置里单独开关；缺哪个就自动降级或跳过，不会中断整条管线。

文章类型可以用 `--type` 指定，也可以在 `.env` 里设 `PB_ARTICLE_TYPE=ai-news` 作为默认值。

WeKnora 远端知识库有总开关 `PB_USE_WEKNORA`，默认 `false`（只读本地知识库目录）；设为 `true` 才会按类型的 `knowledge.source` 使用远端。

## 测试

```bash
npm test
```
