---
name: 微信公众号文章自动化
description: 从本地知识库自动选题并生成微信公众号文章：选题 → 素材检索 → 纲要 → 初稿 → 核稿/评稿/修正循环（≤3 轮）→ 自动配图（1-5 张）→ 发布到邮箱与公众号草稿箱。当用户要写公众号文章、做选题、批量产出图文稿、或要求"根据知识库写一篇 XX 类型文章并发布"时使用。支持手动指定主题与要求，也支持按文章类型（AI 深度观点 / AI 资讯快评 / 技术解读 / Homelab 实践）全自动运行。
---

# 微信公众号文章自动化

这是一个脚本驱动的端到端管线。**机械流程全部由 `scripts/wechat-article.mjs` 完成**，只有在需要判断的地方（选题、纲要、初稿、评稿、修正、备用校对）才调用模型。不要手工重写脚本已经生成的中间产物。

```
选题 ──► 检索 ──► 纲要 ──► 初稿 ──► 核稿/评稿/修正(≤3) ──► 配图(1-5) ──► 发布(邮件+公众号草稿)
 │        │        │         │              │                    │              │
模型     规则     模型      模型      correct-cn+模型      图像 API      Resend/wenyan
```

## 何时使用

- 用户要求"写公众号文章""帮我出个选题""把知识库里的内容整理成文章"。
- 用户要求按某个类型（观点 / 快评 / 技术解读 / Homelab）批量或定时产出图文。
- 用户提供了主题或写作要求，希望自动完成并投递到邮箱 / 公众号草稿箱。

## 快速开始

在本仓库根目录执行（脚本默认从当前工作目录向上寻找项目根）：

```bash
# 1) 校验配置与环境（先做这一步）
node skills/wechat-article/scripts/wechat-article.mjs validate
node skills/wechat-article/scripts/wechat-article.mjs doctor

# 2) 看知识库里有哪些候选主题（不生成内容）
node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-insight

# 3) 用 mock 模型跑通全流程（不发真实请求）
node skills/wechat-article/scripts/wechat-article.mjs run --type ai-news --mock --output .temp/demo

# 4) 真实运行：自动从知识库选题
node skills/wechat-article/scripts/wechat-article.mjs run --type ai-insight

# 5) 真实运行：手动指定主题与要求
node skills/wechat-article/scripts/wechat-article.mjs run --type ai-news \
  --topic "某模型正式开源" --requirements "重点写对独立开发者的影响，1000 字以内"
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `run` | 完整管线：选题 → 检索 → 纲要 → 初稿 → 审稿 → 配图 → 发布 |
| `topics` | 只列出知识库中的候选主题，不调用模型 |
| `outline` | 只生成选题 + 纲要（等价 `run --stage outline`） |
| `draft` | 生成到初稿为止（等价 `run --stage draft`） |
| `review` | 对已有稿件执行核稿/评稿/修正循环 |
| `illustrate` | 为已有稿件生成并替换配图 |
| `publish` | 发布已有稿件到邮件 / 公众号草稿箱 |
| `validate` | 校验配置文件（类型、知识库目录、模型引用等） |
| `doctor` | 检查环境依赖、知识库可达性、各服务连通性 |

### 通用参数

- `--config <path>` 配置文件，默认 `skills/wechat-article/config/article-types.json`
- `--type <id>` 文章类型 id（`run`/`outline`/`draft`/`review`/`illustrate`/`publish` 需要）
- `--topic <text>` 手动主题（省略则自动选题）
- `--requirements <text>` 手动补充写作要求
- `--article <path>` 已有稿件路径（`review`/`illustrate`/`publish` 用；也可从路径推断 `--type`）
- `--output <dir>` 输出目录，默认 `output/wechat-article/<type>/<date>-<slug>`
- `--model <profile>` 覆盖写作模型 profile
- `--review-model <profile>` 覆盖评稿模型 profile
- `--rounds <n>` 审稿循环最大轮次（1-5，默认取配置 `review.max_rounds`）
- `--images <n>` 配图数量（1-5）
- `--stage <name>` `run` 的终止阶段：`topic|outline|draft|review|illustrate|publish`
- `--mock` 用 mock 模型（不发真实网络请求，用于验证流程）
- `--verbose` 输出调试日志

### 发布参数

- `--email` / `--no-email` 覆盖邮件开关
- `--to <address>` 收件人（可多次或用逗号分隔）
- `--wechat` / `--no-wechat` 覆盖公众号草稿开关
- `--dry-run` 发布演练：生成 HTML/命令但不真正投递
- `--auto-publish` 跳过配置里的 `auto_publish=false` 门槛（显式要求发布）

> 安全默认：配置里 `publish.auto_publish=false`，且 `email`/`wechat` 默认关闭。只有显式传 `--email`/`--wechat`/`--auto-publish`，或直接运行 `publish` 命令，才会真正发布。

## 产出物

每个 `run` 会创建一个输出目录（默认 `output/wechat-article/<type>/<日期>-<slug>/`），包含：

```
01-topic.json / 01-topic.md        选题
02-sources.json                    命中的知识库素材
02-outline.json / 02-outline.md    纲要
03-draft.md                        初稿
04-review/round-N/{before,after-correct,after-revise}.md + correct.json + score.json
04-reviewed.md                     审稿后的稿件
05-images.json / 05-illustrated.md 配图元数据与替换后的稿件
06-publish.json                    发布结果（邮件 / 公众号草稿）
article.md / article-final.md      终稿
article-final.html                 邮件用 HTML（启用邮件时生成）
images/                            生成的图片
state.json                         管线最终状态（各阶段成功与否）
pipeline.log                       运行日志
```

## 文章类型与配置

所有类型定义在 `config/article-types.json`（结构见 `config/article-types.schema.json`）。内置类型：

| id | 名称 | 知识库目录 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 800-1300 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

每个类型可配置：

- `knowledge_dirs`：本地知识库目录（相对项目根或绝对路径）
- `style`：人格 / 语气 / 受众 / 标题风格 / 结构 / 该做与不该做
- `length`：`min` / `max` / `target` 字数
- `scoring.dimensions`：评分维度与权重，`pass_score` 通过线
- `review`：`max_rounds`、`pass_score`、`correct_cn`（核稿服务）
- `illustrations`：`min`/`max`/`cover`/`style`/`negative_prompt`/图像服务
- `topic`：`keywords`、`exclude_keywords`、`lookback_days`、`candidates`
- `publish`：`auto_publish`、`email`（Resend）、`wechat`（wenyan）

新增一个类型：复制 `types` 里的一段，改 `id`/`name`/`knowledge_dirs`/`length`/`scoring` 即可，然后 `validate`。

## 模型 profile

写在配置的 `models` 段，按需切换：

| profile | provider | 说明 |
| --- | --- | --- |
| `local` | ollama | 默认写作模型，`qwen3.5:4b`，走 `http://localhost:11434` |
| `local-9b` | ollama | 更大的本地模型，质量更好、更慢 |
| `opencode` | opencode | 以 `opencode run --format json --file <prompt>` 调用代理，仅返回文本 |
| `remote` | openai | 任意 OpenAI 兼容端点（`PB_LLM_BASE_URL`/`PB_LLM_API_KEY`） |
| `mock` | mock | 不发请求，返回固定内容，用于验证流程 |

覆盖用法：`--model opencode --review-model local-9b`。若某次模型调用失败，脚本会按阶段降级（规则纲要 / 分节生成 / 规则评分），不会中断整条管线。

## 配图

- 初稿中用标记占位：`[[img:N|中文说明|English prompt]]`（兼容旧格式 `[图N：说明]`）。
- 纲要阶段规划 1-5 张（含封面），`--images N` 可指定数量。
- 优先 ModelScope（`PB_MODEL_API_KEY`），失败回退 Pollinations，并行生成。
- 生成成功后标记被替换为本地图片相对路径；失败按 `illustrations.on_failure`（`comment`/`remove`）处理。

## 审稿循环

每轮：**核稿 → 评稿 → 修正**，最多 `review.max_rounds`（默认 3）轮。

- **核稿**：`correct-cn` 的 `POST {base_url}/api/pipeline`（`X-Auth-Key`），按 `apply: "issues"` 做字面替换；服务不可用时回退到 LLM 校对（长度异常则保留原稿）。
- **评稿**：按类型的 `scoring.dimensions` 多维度打分，加权/总分 ≥ `pass_score` 且无 high 级问题即通过；模型失败时用规则评分兜底。
- **修正**：按评分意见改写，长度比例异常（<0.55 或 >1.6）时保留原稿。

## 发布

- **邮件**：Resend（`PB_RESEND_API_KEY`、`PB_RESEND_FROM`），本地图片以 CID 内联附件嵌入。
- **公众号草稿**：`npx --yes @wenyan-md/cli publish -f <稿件> --env-file .env`（依赖 `.env` 里的 `WECHAT_MP_APP_ID`/`WECHAT_MP_APP_SECRET`）。`--dry-run` 只打印命令。

## 环境变量（`.env`）

| 变量 | 用途 |
| --- | --- |
| `PB_OLLAMA_BASE_URL` / `PB_OLLAMA_MODEL` / `PB_OLLAMA_LARGE_MODEL` | 本地模型 |
| `PB_MODEL_API_KEY` | ModelScope 配图 |
| `PB_RESEND_API_KEY` / `PB_RESEND_FROM` | 邮件 |
| `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_AUTH_KEY` | correct-cn 核稿 |
| `PB_LLM_BASE_URL` / `PB_LLM_MODEL` / `PB_LLM_API_KEY` | 远程 OpenAI 兼容模型 |
| `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` | 公众号草稿发布 |
| `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录（配置里可用 `${...}` 引用） |

配置里支持 `${VAR}` 与 `${VAR:-默认值}` 展开。

## 作为 OpenCode agent 运行

- 斜杠命令：`/wechat-article <参数>`（见根目录 `opencode.json` 的 `commands`）。
- 写作代理：`wechat-article-writer`（hidden、subagent），只读附件、禁写禁命令，供 `opencode` 模型 profile 调用，只返回文本/JSON。
- 直接调用：`opencode run --format json --file <prompt.md> --agent wechat-article-writer --auto "完成附件任务"`（NDJSON 中取 `type=="text"` 的 `part.text` 拼接）。
- 注意：写作代理**必须保留 `read` 工具**（脚本通过 `--file` 附带提示词），但禁用 shell/edit/subagent 等；若把 `read` 也 deny，OpenCode 免费层会返回 403（FreeTierError）。
- `opencode` 通道比本地模型慢（单次 1-4 分钟），适合作为质量更高的备选，不建议作为默认。

## 排障

- 先跑 `doctor`：会检查 Node 版本、配置文件、各类型知识库目录、模型可达性、correct-cn / 配图 / 邮件 / 公众号配置。
- 知识库索引有 mtime/size 缓存（`.temp/wechat-article/knowledge-index.json`），重复运行很快；改过文件会自动重建。
- 不确定环境是否配全时，先用 `--mock` 跑通流程，再逐步替换为真实模型与服务。
- correct-cn 不可达时不要卡住：脚本会自动回退到 LLM 校对。

## 目录结构

```text
skills/wechat-article/
├── SKILL.md                     本文件
├── config/
│   ├── article-types.json       文章类型 / 模型 / 审稿 / 配图 / 发布配置
│   └── article-types.schema.json
└── scripts/
    ├── wechat-article.mjs       命令行入口（编排全部阶段）
    └── lib/
        ├── args.mjs             参数解析
        ├── config.mjs           配置加载/归一化/校验
        ├── env.mjs              .env 与项目根探测
        ├── fsx.mjs              文件工具
        ├── log.mjs              日志
        ├── markdown.mjs         frontmatter 与 [[img:N|...]] 标记
        ├── models.mjs           ollama/openai/opencode/mock 客户端
        ├── knowledge.mjs        知识库索引、检索、摘录
        ├── prompts.mjs          选题/纲要/初稿/评分/修正提示词
        ├── corrector.mjs        correct-cn 客户端与修正应用
        ├── illustrate.mjs       ModelScope + Pollinations 配图
        └── publish.mjs          Resend 邮件 + wenyan 公众号草稿
```
