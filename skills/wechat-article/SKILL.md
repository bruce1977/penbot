---
name: 微信公众号文章自动化
description: 从知识库（本地文档目录或 WeKnora 远程知识库）自动选题并生成微信公众号文章：选题 → 素材检索 → 纲要 → 初稿 → 核稿/评稿/修正循环（≤3 轮）→ 自动配图（1-5 张）→ 发布到邮箱与公众号草稿箱。当用户要写公众号文章、做选题、批量产出图文稿、或要求"根据知识库写一篇 XX 类型文章并发布"时使用。支持手动指定主题与要求，也支持按文章类型（AI 深度观点 / AI 资讯快评 / 技术解读 / Homelab 实践）全自动运行。
---

# 微信公众号文章自动化

这是一个脚本驱动的端到端管线。**机械流程全部由 `scripts/wechat-article.mjs` 完成**，只有在需要判断的地方（选题、纲要、初稿、评稿、修正、备用校对）才调用模型。不要手工重写脚本已经生成的中间产物。

```
选题 ──► 资料收集 ──► 纲要 ──► 初稿 ──► 核稿/评稿/修正(≤3) ──► 配图(1-5) ──► 发布(邮件+公众号草稿)
 │         │            │        │              │                    │              │
模型   本地目录/WeKnora  模型     模型      correct-cn+模型      图像 API      Resend/wenyan
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

# 2) 看知识库里有哪些候选主题 / 有哪些 WeKnora 知识库
node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-insight
node skills/wechat-article/scripts/wechat-article.mjs kbs

# 3) 用 mock 模型跑通全流程（不发真实请求）
node skills/wechat-article/scripts/wechat-article.mjs auto --type ai-news --mock

# 4) 入口 1（自动）：从知识库最新文档选题 + 自动纲要，再往下写
node skills/wechat-article/scripts/wechat-article.mjs auto --type ai-insight

# 5) 入口 2（手动）：你给标题 + 提纲，直接往下写
node skills/wechat-article/scripts/wechat-article.mjs manual --type ai-news \
  --title "某模型正式开源" --outline-file outline.md
```

- 两个入口之后的步骤**完全一致**（资料 → 初稿 → 审稿 → 配图 → 发布），都支持 `--stage draft` 之类的提前停止。
- `--type` 也可以不写在命令行：在 `.env` 里设 `PB_ARTICLE_TYPE=ai-news` 即可（命令行 `--type` 优先）。
- 手动入口的提纲支持三种来源：`--outline-file outline.md`、`--outline "# 标题\n## 小节\n- 要点"`、或直接给 `03-outline.json`；标题可以从提纲的 `# 标题` 行推导，省略 `--title`。

### 文章目录与断点续跑

文章根目录由环境变量 `BASE_OUTPUT_FOLDER` 决定（默认 `output/wechat-article`）：

```text
$BASE_OUTPUT_FOLDER/
├── draft/<slug>/      一篇文章一个目录，所有中间产物和终稿都在里面
└── published/         发布成功后归档的 <YYYYMMDD>-<slug>.zip
```

- 目录名取标题的 slug（保留中文，非法字符换成 `-`）；重名自动加 `-2`。
- 每个阶段只写自己的产物，**产物存在 = 该阶段完成**；中断后重跑同一条命令即可从断点继续：

```bash
node skills/wechat-article/scripts/wechat-article.mjs auto  --type ai-news --article <slug>
node skills/wechat-article/scripts/wechat-article.mjs draft --article <slug>
```

- `--article latest` 选最近一篇；分步命令省略 `--article` 时，若 `draft/` 下只有一篇文章会自动选中。

### 分步执行

每一步都能单独跑、单独检查，产物都追加到同一篇文章目录：

```bash
# 1) 选题（自动选题；生成的目录名 = 标题 slug）
node skills/wechat-article/scripts/wechat-article.mjs topic   --type ai-news

# 2) 资料收集（本地目录 / WeKnora / 两者都要，见下）
node skills/wechat-article/scripts/wechat-article.mjs sources --article <slug>

# 3) 纲要
node skills/wechat-article/scripts/wechat-article.mjs outline --article <slug>

# 4) 准备初稿输入（标题 + 大纲 + 资料 → 04-draft-input.json）
node skills/wechat-article/scripts/wechat-article.mjs bundle  --article <slug>

# 5) 初稿（读 04-draft-input.json）
node skills/wechat-article/scripts/wechat-article.mjs draft   --article <slug>
```

- **手动选题只有一步**：`outline --type ai-news --topic "主题" --requirements "..."` 会跳过选题模型，直接生成纲要。
- 实际顺序是 `topic → sources → outline → draft`；`sources` 需要选题（`01-topic.json` 或 `--topic`），`outline`/`draft` 需要素材（`02-sources.json`）。
- 复用已有产物：`--topic-file` / `--sources-file` / `--outline-file` 指定具体文件，覆盖自动查找。

### 手动入口的提纲格式

最简形式即可（`# 标题` 可省略，用 `--title` 代替）：

```markdown
# 文章标题

> 一句话核心判断（可选）

- 读者：中小团队工程师（可选）
- 开篇钩子：一个具体场景（可选）

## 第一个小节
- 要点一
- 要点二

## 第二个小节
- 要点三

## 结论
最后要落到的一句话。

## 配图
- cover：封面画面说明
- inline_1：正文配图说明
```

- `## 结构` + 编号列表、`（约 400 字）` 标注、`## 反方观点`、`## 配图` 下的 `- prompt:` 行都兼容——也就是管线自己渲染的 `03-outline.md` 能原样喂回来。
- 小节字数没写时，会把该类型的目标字数均分到各小节。
- 配图数量仍受类型配置约束（`--images` 可覆盖）。

### 第一步：一次生成多个候选主题 + 提纲

定选题之前，先让脚本给几个方向挑：

```bash
# 生成 3 个候选主题，每个都带提纲，写成 Markdown
node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-news --count 3 --output output

# 只看不落盘（直接打印 Markdown）
node skills/wechat-article/scripts/wechat-article.mjs topics --type ai-news --count 3 --md
```

- 产物路径：`--output` 是目录时写 `output/topics-<type>-<YYYYMMDD>.md`；是 `.md` 文件时按该路径写。
- 每个候选主题包含：核心判断、切入角度、为什么现在写、关键词、素材线索、备选标题、逐小节提纲（含建议字数）。
- **提纲不是凭空猜的**：每个主题会按关键词与素材线索从知识库挑 3 篇最相关的文章，抽 2 段最相关正文喂给纲要模型，日志里会打印「参考素材」。
- 这一步只做选题与提纲，不检索 WeKnora、不写正文；资料收集在选定主题之后进行。
- 不给 `--count` / `--output` / `--md` 时保持原行为：打印候选文章表格。

## 初稿输入格式（`04-draft-input.json`）

写初稿前必须先准备好三样东西，它们全部装在一个 JSON 里，初稿阶段**只读这个文件**：

1. `title` — 文章标题
2. `outline` — 文章大纲（小节 + 要点 + 可选建议字数）
3. `materials` — 相关资料（整篇或若干段落）

```jsonc
{
  "type": "ai-news",                     // 决定文风/篇幅/评分维度
  "title": "文章标题",                    // 1) 标题
  "thesis": "核心判断（可选）",
  "audience": "目标读者（可选）",
  "hook": "开篇钩子（可选）",
  "requirements": "额外要求（可选）",

  "outline": [                           // 2) 大纲
    { "heading": "小节标题", "points": ["要点一", "要点二"], "target_words": 300 }
  ],
  "counterpoint": "要回应的反方观点（可选）",
  "takeaway": "结尾要落到的一句话（可选）",

  "materials": [                         // 3) 资料
    { "title": "来源标题", "date": "2026-10-18", "source": "D:/knowledge/.../x.md",
      "paragraphs": ["相关段落原文", "再一段"] }
  ],

  "images": [                            // 可选，缺省按类型配置规划
    { "position": "cover", "description": "中文画面说明", "prompt": "English prompt" }
  ]
}
```

**提示词和校验规则都在 `config/prompts/draft.json`**，一个文件两段：`prompt`（system / user / retry）和 `schema`（一行一个字段）。改文案、调字段上限都不用动代码：

```jsonc
{
  "prompt": {
    "system": "你是「{{type_name}}」栏目的作者……",
    "user":   "# 任务\n……\n## 纲要\n{{outline}}\n## 可用素材\n{{materials}}\n……",
    "retry":  "上一稿不合格（第 {{retry_tag}} 次尝试）：\n{{errors}}\n……\n## 原稿\n{{article}}"
  },
  "schema": {
    "title": ["string", 1, 64],
    "outline": ["array", 1, 12],
    "outline[].heading": ["string", 1],
    "outline[].points": ["array", 1, 8],
    "materials": ["array", 1, 20],
    "materials[].paragraphs": ["array", 1, 20],
    "requirements?": "string"
  }
}
```

schema 语法：`"string"` / `["string", 最短]` / `["string", 最短, 最长]` / `["array", 最少, 最多]` / `["number", 最小, 最大]` / `"boolean"`；键尾加 `?` 表示可选；`list[]` 校验数组元素，`list[].field` 校验对象数组的每个字段。

用法：

```bash
# 只做准备工作：选题 → 检索 → 纲要 → 打包成 04-draft-input.json
node skills/wechat-article/scripts/wechat-article.mjs bundle --article <slug>

# 校验这份输入（硬错误 + 软警告逐条列出）；也可直接给已有文件
node skills/wechat-article/scripts/wechat-article.mjs validate --input <article>/04-draft-input.json

# 用它写初稿（可以手改 JSON 后再跑；类型从文件推断，目录用 --article 指定）
node skills/wechat-article/scripts/wechat-article.mjs draft --article <slug> --input <article>/04-draft-input.json
```

- `run` / `auto` / `manual` 也会在初稿前自动写出 `04-draft-input.json`，每一步都可审查、可手改。
- **硬错误**（会中止）：缺 `title`、`outline` 为空或某节缺 `heading`/`points`、`materials` 为空或素材缺 `paragraphs`、字段超长或超项数上限。
- **软警告**（不中止）：大纲字数与目标相差过大、某节没有要点、缺 `thesis`/`takeaway`/`requirements`。
- 只给段落、没有整篇文章时，把段落放进 `paragraphs` 即可。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `auto` | **入口 1**：自动选题 + 自动纲要，然后往下写（等价于原来的 `run`） |
| `manual` | **入口 2**：用 `--title` + `--outline`/`--outline-file` 直接往下写，跳过选题与纲要模型 |
| `run` | 完整管线（保留兼容，等同 `auto`） |
| `topics` | 列出候选文章；`--count N --output <目录>` 生成 N 个候选主题（含提纲）的 Markdown |
| `classify` | 只用判断模型（systemone）根据标题 + 提纲选类型，打印选择与得分 |
| `kbs` | 列出 WeKnora 知识库（获取 `kb_ids`） |
| `topic` | 只做选题（自动选题，或 `--topic` 手动记录；新文章目录按标题 slug 创建） |
| `sources` | 只收集相关资料（本地目录 / WeKnora / 两者） |
| `outline` | 只生成纲要（`--topic` / `--topic-file`，或复用文章目录里的选题） |
| `bundle` | 只做准备工作：把标题 + 大纲 + 相关资料写成 `04-draft-input.json` |
| `draft` | 只生成初稿（读 `04-draft-input.json`，或 `--input` 指定一份） |
| `review` | 对已有稿件执行核稿/评稿/修正循环 |
| `illustrate` | 为已有稿件生成并替换配图 |
| `publish` | 发布已有稿件到邮件 / 公众号草稿箱 |
| `validate` | 校验配置文件（类型、知识库目录、模型引用等） |
| `doctor` | 检查环境依赖、知识库可达性、各服务连通性 |

### 通用参数

- `--config <path>` 类型注册表，默认 `skills/wechat-article/config/article-types.yaml`
- `--defaults <path>` 全局默认配置，默认 `skills/wechat-article/config/defaults.yaml`
- `--models <path>` 模型总表，默认 `skills/wechat-article/config/models.yaml`
- `--steps <path>` 步骤配置，默认 `skills/wechat-article/config/steps.yaml`
- `--type <id>` 文章类型 id；省略时依次取 `PB_ARTICLE_TYPE` → 判断模型自动分类 → `classifier.default_type`
- `--topic <text>` 手动主题（省略则自动选题；手动时**跳过选题模型**）
- `--requirements <text>` 手动补充写作要求
- `--topic-file <path>` 复用已有选题 JSON（如 `01-topic.json`）
- `--sources-file <path>` 复用已有素材 JSON（如 `02-sources.json`）
- `--outline-file <path>` `manual` / `classify` 的提纲文件（Markdown 或 `03-outline.json`）
- `--input <path>` 初稿输入 JSON（标题 + 大纲 + 资料，如 `04-draft-input.json`）；`draft` / `run` 用，跳过前置步骤
- `--knowledge-source <s>` 覆盖知识来源：`local` | `weknora` | `both`
- `--article <slug>` 选择/续跑 `draft/<slug>/` 这篇文章；`latest` = 最近一篇；分步命令省略时自动选中唯一一篇
- `--file <path>` `review`/`illustrate`/`publish` 直接指定稿件文件（`--article <path>` 仍兼容）
- `--slug <name>` 新建文章时覆盖目录名（默认取标题 slug）
- `--model <id>` 覆盖写作模型 id（如 `llm.local`、`llm.large`）
- `--review-model <id>` 覆盖评稿模型 id
- `--rounds <n>` 审稿循环最大轮次（1-5，默认取配置 `review.max_rounds`）
- `--length-attempts <n>` 初稿篇幅自动扩写/压缩的最大次数（默认 2，0 表示关闭）
- `--images <n>` 配图数量（1-5）
- `--stage <name>` `run` 的终止阶段：`topic|sources|outline|bundle|draft|review|illustrate|publish`
- `--mock` 用 mock 模型（不发真实网络请求，用于验证流程）
- `--verbose` 输出调试日志

> 文章根目录只认环境变量/配置里的 `BASE_OUTPUT_FOLDER`，`--output` 已取消。

### 发布参数

- `--email` / `--no-email` 覆盖邮件开关
- `--to <address>` 收件人（可多次或用逗号分隔）
- `--wechat` / `--no-wechat` 覆盖公众号草稿开关
- `--dry-run` 发布演练：生成 HTML/命令但不真正投递
- `--auto-publish` 跳过配置里的 `auto_publish=false` 门槛（显式要求发布）

> 安全默认：配置里 `publish.auto_publish=false`，且 `email`/`wechat` 默认关闭。只有显式传 `--email`/`--wechat`/`--auto-publish`，或直接运行 `publish` 命令，才会真正发布。

## 产出物

一篇文章 = `$BASE_OUTPUT_FOLDER/draft/<slug>/` 一个目录：

```
01-topic.json / 01-topic.md              选题
02-sources.json                          命中的知识库素材
03-outline.json / 03-outline.md          纲要
04-draft-input.json                      初稿输入（标题 + 大纲 + 资料）
05-draft.md                              初稿
06-review/round-N/{before,after-correct,after-revise}.md + correct.json + score.json
06-reviewed.md                           审稿后的稿件
06-polished.md                           去 AI 化后的稿件（de_ai 接入后）
07-images.json / 07-illustrated.md       配图元数据与替换后的稿件
08-final.md                              终稿（发布用）
08-final.html                            邮件用 HTML（启用邮件时生成）
09-publish.json                          发布结果与状态
images/                                  生成的图片
state.json                               管线状态（文章身份 + 各阶段）
pipeline.log                             运行日志
```

### 发布成功后的归档

只有 `09-publish.json` 的 `status` 为 `published`（至少一个渠道**真实投递成功**）才会归档：

1. 终稿复制到本地知识库的 pipeline 待入库目录（`defaults.publish.archive.knowledge_dir`，即 `KNOWLEDGE_PIPELINE_DIR`；失败只记录，不阻塞）；
2. 整个文章目录打包到 `published/<YYYYMMDD>-<slug>.zip`；
3. 删除 `draft/<slug>/`。

`skipped`（未启用发布 / `auto_publish=false`）、`dry_run`、`partial`、`failed` 都留在 `draft/`，修好后可重跑。归档是幂等的：zip 路径先写进 `09-publish.json`，重跑时已存在的 zip 直接复用。

## 流程节点（`config/steps/`）

`config/steps.yaml` 只保留全局默认值（模型 id、重试、超时）和阶段文件顺序；节点按大步骤拆到 `config/steps/`：

| 阶段文件 | 节点 |
| --- | --- |
| `10-topic.yaml` | `classify_type` → `select_topic` → `gather_materials` |
| `20-outline.yaml` | `outline` → `bundle_draft_input` |
| `30-draft.yaml` | `draft_writing` → `length_adjust` |
| `40-review.yaml` | `review` → `scoring` |
| `50-revision.yaml` | `revision` → `de_ai` → `image_generation` |
| `60-publish.yaml` | `publish` → `archive` |

每个节点声明处理方式、模型、输入输出、重试、超时和默认提示词。节点顺序就是正常执行顺序：

| step_name | 作用 | 处理方式 | 默认模型 |
| --- | --- | --- | --- |
| `classify_type` | 判断文章类型 | `builtin:classify_type` | `systemone.classifier` |
| `select_topic` | 选题 | `builtin:select_topic` | `llm.local` |
| `gather_materials` | 收集素材 | `builtin:gather_materials` | `none`（本地检索） |
| `outline` | 生成纲要 | `builtin:generate_outline` | `llm.local` |
| `bundle_draft_input` | 组装初稿输入 | `builtin:build_draft_input` | `none`（本地脚本） |
| `draft_writing` | 写初稿 | `builtin:write_draft` | `llm.local` |
| `length_adjust` | 篇幅调整（条件） | `builtin:adjust_length` | `llm.local` |
| `review` | 核稿（错别字/敏感词） | `builtin:review_article` | `llm.local`（校对接口优先） |
| `scoring` | 评稿 | `builtin:score_article` | `llm.local` |
| `revision` | 修正 | `builtin:revise_article` | `llm.local` |
| `de_ai` | 去 AI 化 | `builtin:de_ai` | `llm.local` |
| `image_generation` | 配图 | `builtin:generate_images` | `none`（通道见 `defaults.illustrations`） |
| `publish` | 发布 | `builtin:publish_article` | `none`（渠道 API） |
| `archive` | 归档 | `builtin:archive_article` | `none`（本地脚本） |

> `de_ai` 先固定契约（读 `06-reviewed.md`，写 `06-polished.md`），执行层接入前不会改变现有产物链。

### handler

```yaml
handler: builtin:select_topic              # 内置实现（当前默认）
handler: scripts/steps/select-topic.mjs    # 独立本地脚本
handler: https://example.com/api/step      # HTTP 接口
```

### model

所有模型统一在 `config/models.yaml` 定义，节点、类型和 `defaults` 只写模型 id：

```yaml
# config/steps.yaml
defaults:
  model: llm.local

# config/steps/10-topic.yaml
steps:
  - step_name: select_topic
    model: llm.large
```

`config/models.yaml` 按三类组织，每类下可以有多个子类型：

```yaml
llm:                 # 文本模型：Ollama / OpenAI 兼容端点
  local: { ... }
  small: { ... }
  large: { ... }
  remote: { ... }

opencode:            # OpenCode CLI agent
  writer:
    command: opencode
    agent: wechat-article-writer

systemone:           # System One 决策模型
  classifier:
    base_url: "${SYSTEMONE_BASE_URL}"
    model: "${SYSTEMONE_MODEL:-jev-latest}"
```

- `llm.*`：`provider` 写 `ollama` 或 `openai`；`remote` 可以指向 DeepSeek 等兼容端点。
- `opencode.*`：通过 `opencode run --agent` 调用。
- `systemone.*`：走 `/v1/systemone`，用于自动分类。
- `none`：保留值，表示纯本地脚本，不调模型。
- 配图通道不在 `models.yaml` 里，配置在 `defaults.illustrations.modelscope` / `pollinations`。

`--model` 也用同样的 id，例如 `--model llm.large`。

### 类型覆盖

类型文件可以覆盖同名节点的模型、超时、重试和提示词，优先级：`type.steps.<step>` > `steps.yaml` 的节点配置 > `defaults`。

```yaml
# config/types/ai-news.yaml
steps:
  draft_writing:
    prompt:
      system: |
        你是「AI 资讯快评」栏目的作者，先事实后观点。
      extra: "第一段不超过 80 字，直接说清事件。"
    model: llm.large
    timeout: 900000
    retry_limit: 1
```

旧字段 `prompts.outline_extra` / `draft_extra` / `revise_extra` 仍然生效，会追加到对应节点的 `prompt.extra`。

### 查看节点

```bash
# 全部节点
node skills/wechat-article/scripts/wechat-article.mjs steps

# 看某个类型覆盖后的配置
node skills/wechat-article/scripts/wechat-article.mjs steps --type ai-news

# 看单个节点的模型、I/O 和最终提示词
node skills/wechat-article/scripts/wechat-article.mjs steps --step draft_writing --type ai-news

# 机器可读
node skills/wechat-article/scripts/wechat-article.mjs steps --json
```

`validate` 和 `doctor` 也会校验 `steps.yaml`。当前版本已经完成节点清单、加载、模型继承、类型覆盖、校验和展示；执行层会按这些节点逐步接入（先把契约固定下来）。

## 文章类型与配置

- 全局默认：`config/defaults.yaml`（输出目录、判断模型行为、文章级默认值）。
- 模型总表：`config/models.yaml`（`llm` / `opencode` / `systemone` 三类）。
- 类型注册表：`config/article-types.yaml`，只保留 `types:` 列表和加载顺序。
- 类型明细：`config/types/<id>.yaml`，一个类型一个文件；`types:` 决定加载顺序，省略时自动扫描目录。
- 字段说明：`config/types/README.md`。

内置类型：

| id | 名称 | 知识库目录 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 800-1300 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

每个类型文件可配置：

- `type`：中文类型名（`id` 缺省取文件名）
- `description`：一句话说明，判断模型用它分类
- `knowledge_base_path`：本地知识库目录（字符串或数组）
- `style`：风格描述，字符串或 `persona`/`tone`/`audience`/`title_style`/`structure`/`dos`/`donts`
- `word_limit`：`800-1300`、`1500` 或 `{ min, max, target }`
- `scoring_criteria`：评分维度数组（`id`/`name`/`weight`/`description`/`criteria`），`pass_score` 为通过线
- `review`：`max_rounds`、`pass_score`、`correct_cn`（核稿服务）
- `image_count`：`1-5`、`3` 或 `{ min, max, default, cover }`
- `image_position_format`：正文配图占位符模板，默认 `[[img:{index}]]`
- `topic`：`keywords`、`exclude_keywords`、`lookback_days`、`candidates`
- `model` / `prompts`：写作模型与追加要求

新增类型：在 `config/types/` 加一个 YAML，再把 id 写进 `article-types.yaml` 的 `types:`，跑 `validate`。

### 判断模型（System One）

`defaults.yaml` 的 `classifier` 段配置 System One 决策模型端点（TypeSafe Jev / 基石智算 Laya / vLLM 同一协议）：

```yaml
classifier:
  enabled: true
  base_url: "${SYSTEMONE_BASE_URL}"      # 例：https://routellm.abacus.ai/v1
  endpoint: "/v1/systemone"
  api_key: "${SYSTEMONE_API_KEY}"
  model: "${SYSTEMONE_MODEL:-jev-latest}"
  question: article_type
  min_confidence: 0.5
  default_type: ai-news
```

请求不是 chat/completions，而是一次 `choice` 判断：

```json
{
  "model": "jev-latest",
  "state": "标题：…\n\n提纲：\n## …",
  "questions": {
    "article_type": {
      "type": "choice",
      "instructions": "判断这篇公众号文章最适合归入哪个类型…",
      "criteria": { "ai-news": "…", "ai-insight": "…" }
    }
  }
}
```

响应取 `answers.article_type.choice` / `probabilities` / `confidence`；`base_url` 已带 `/v1` 时不会重复拼接。

- `manual` 入口有标题 + 提纲，未显式给 `--type` 时会先调用判断模型。
- `auto` 入口只有在提供了 `--topic` 时才会尝试分类；否则直接用 `classifier.default_type`。
- 未配置 `SYSTEMONE_*`、请求失败或置信度低于 `min_confidence` 时，回退到 `classifier.default_type`；429/503 会按 `Retry-After` 重试。
- 单独验证：`classify --title "..." --outline-file outline.md`；`--mock` 不发请求。

## 资料收集（本地目录为主）

当前流程只读本地知识库目录（`knowledge_base_path`）。WeKnora 作为可选能力保留在 `defaults.knowledge`，默认关闭（`PB_USE_WEKNORA=false`）；类型文件不需要配置 `weknora`。

- 本地检索：扫描目录下的 Markdown，按关键词、标题与日期排序取最新素材。
- 发布成功后的终稿统一落到 `KNOWLEDGE_PIPELINE_DIR`（默认 `D:/knowledge/pipeline`），由后续入库脚本处理。
- `kbs` 仍可只读查看远端知识库；`--knowledge-source` 仅在显式启用 WeKnora 时有意义。

## 模型

所有模型在 `config/models.yaml`，按 `llm` / `opencode` / `systemone` 三类组织。节点、类型和 `defaults` 只写模型 id：

| id | provider | 说明 |
| --- | --- | --- |
| `llm.local` | ollama | 默认写作模型，`LOCAL_LLM_BASE_MODEL`（默认 `qwen3.5:9b`） |
| `llm.small` | ollama | 更小更快的本地模型，默认 `qwen3.5:4b`，适合快速试跑 |
| `llm.large` | ollama | 更大的本地模型，默认 `qwen3.6:35b`，质量更好、更慢 |
| `llm.remote` | openai | 任意 OpenAI 兼容端点（`PB_LLM_BASE_URL` / `PB_LLM_API_KEY`） |
| `opencode.writer` | opencode | 以 `opencode run --format json --file <prompt>` 调用写作代理 |
| `systemone.classifier` | systemone | 自动分类，走 `/v1/systemone` |

- `none` 是保留值，表示纯本地脚本，不调模型。
- `--mock` 会跳过真实模型调用，不需要配置 mock 模型。
- 覆盖用法：`--model llm.large --review-model llm.local`。若某次模型调用失败，脚本会按阶段降级（规则纲要 / 分节生成 / 规则评分），不会中断整条管线。

## 配图

- 初稿中用标记占位：`[[img:N|中文说明|English prompt]]`（兼容旧格式 `[图N：说明]`）；类型可用 `image_position_format` 改模板（保留 `{index}`）。
- 纲要阶段按 `image_count` 规划（默认 1-5 张，含封面），`--images N` 可指定数量。
- 优先 ModelScope（`PB_MODEL_IMAGE_API_KEY`），失败回退 Pollinations，并行生成。
- 生成成功后标记被替换为本地图片相对路径；失败按 `illustrations.on_failure`（`comment`/`remove`）处理。

## 初稿与篇幅控制

初稿生成后会自动做**篇幅适配**：字数低于 `word_limit.min` 时扩写、高于 `word_limit.max` 时压缩，最多 `--length-attempts`（默认 2）次；每次只保留确有改善的结果（扩写后更短 / 压缩后更长则丢弃）。扩写提示词要求"补实质信息、不注水、不得编造数据、每段 2-5 句"，同时抑制一句一段的碎片化。若用尽次数仍不达标，日志会给出明确告警，随后的审稿循环里 `length` 维度也会继续扣分。

## 审稿循环

每轮：**核稿 → 评稿 → 修正**，最多 `review.max_rounds`（默认 3）轮。

- **核稿**：`correct-cn` 的 `POST {base_url}/api/pipeline`（`X-Auth-Key`），按 `apply: "issues"` 做字面替换；服务不可用时回退到 LLM 校对（长度异常则保留原稿）。
- **评稿**：按类型的 `scoring_criteria` 多维度打分，加权/总分 ≥ `pass_score` 且无 high 级问题即通过；模型失败时用规则评分兜底。
- **修正**：按评分意见改写，长度比例异常（<0.55 或 >1.6）时保留原稿。

## 发布

- **邮件**：Resend（`PB_RESEND_API_KEY`、`PB_RESEND_FROM`），本地图片以 CID 内联附件嵌入。
- **公众号草稿**：`npx --yes @wenyan-md/cli publish -f <稿件> --env-file .env`（依赖 `.env` 里的 `WECHAT_MP_APP_ID`/`WECHAT_MP_APP_SECRET`）。`--dry-run` 只打印命令。

## 环境变量（`.env`）

| 变量 | 用途 |
| --- | --- |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_BASE_MODEL` / `LOCAL_LLM_API_KEY` | 本地大模型（BASE_URL / MODEL_NAME / API_KEY） |
| `LOCAL_LLM_SMALL_MODEL` / `LOCAL_LLM_LARGE_MODEL` | 可选：`llm.small` / `llm.large` 使用的模型名 |
| `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` | WeKnora 远程知识库 |
| `PB_MODEL_IMAGE_API_KEY` | ModelScope 配图（兼容旧名 `PB_MODEL_API_KEY`） |
| `PB_IMAGE_BASE_URL` / `PB_IMAGE_MODEL` | 配图主通道的 BASE_URL / MODEL_NAME（默认 ModelScope + Z-Image-Turbo） |
| `PB_POLLINATIONS_BASE_URL` / `PB_POLLINATIONS_MODEL` | 配图回退通道（默认 Pollinations / turbo） |
| `PB_EMAIL_ENABLED` / `PB_WECHAT_ENABLED` / `PB_AUTO_PUBLISH` | 发布节点默认开关（命令行 `--email` / `--wechat` / `--auto-publish` 优先） |
| `PB_RESEND_API_KEY` / `PB_RESEND_FROM` | 邮件 |
| `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_AUTH_KEY` | correct-cn 核稿 |
| `PB_LLM_BASE_URL` / `PB_LLM_MODEL` / `PB_LLM_API_KEY` | 远程 OpenAI 兼容模型 |
| `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` | 公众号草稿发布 |
| `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录（配置里可用 `${...}` 引用） |
| `KNOWLEDGE_PIPELINE_DIR` | 发布成功后终稿的待入库目录，默认 `D:/knowledge/pipeline` |
| `BASE_OUTPUT_FOLDER` | 文章根目录（下面自动建 `draft/` 与 `published/`，默认 `output/wechat-article`） |
| `PB_ARTICLE_TYPE` | 默认文章类型 id（命令行 `--type` 优先；未设置时交给判断模型） |
| `SYSTEMONE_BASE_URL` / `SYSTEMONE_API_KEY` / `SYSTEMONE_MODEL` | 判断模型（System One `/v1/systemone`，默认 `jev-latest`）；留空则回退 `classifier.default_type` |
| `PB_USE_WEKNORA` | WeKnora 总开关，默认 `false`（只用本地知识库目录） |

配置里支持 `${VAR}` 与 `${VAR:-默认值}` 展开。

## 作为 OpenCode agent 运行

- 斜杠命令：`/wechat-article <参数>`（见根目录 `opencode.json` 的 `commands`）。
- 写作代理：`wechat-article-writer`（hidden、subagent），只读附件、禁写禁命令，供 `opencode.writer` 模型调用，只返回文本/JSON。
- 直接调用：`opencode run --format json --file <prompt.md> --agent wechat-article-writer --auto "完成附件任务"`（NDJSON 中取 `type=="text"` 的 `part.text` 拼接）。
- 注意：写作代理**必须保留 `read` 工具**（脚本通过 `--file` 附带提示词），但禁用 shell/edit/subagent 等；若把 `read` 也 deny，OpenCode 免费层会返回 403（FreeTierError）。
- `opencode` 通道比本地模型慢（单次 1-4 分钟），适合作为质量更高的备选，不建议作为默认。

## 排障

- 先跑 `doctor`：会检查 Node 版本、配置文件、各类型知识库目录、判断模型配置、模型可达性、correct-cn / 配图 / 邮件 / 公众号配置。
- 分类结果不符合预期时，用 `classify --title "..." --outline-file <提纲>` 单独调试；再检查类型的 `description` 是否足够区分。
- 知识库索引有 mtime/size 缓存（`.temp/wechat-article/knowledge-index.json`），重复运行很快；改过文件会自动重建。
- 不确定环境是否配全时，先用 `--mock` 跑通流程，再逐步替换为真实模型与服务（mock 模式不会访问网络）。
- correct-cn 不可达时不要卡住：脚本会自动回退到 LLM 校对。

## 目录结构

```text
skills/wechat-article/
├── SKILL.md                     本文件
├── config/
│   ├── defaults.yaml            全局默认：输出目录 / 判断模型行为 / 文章级默认值
│   ├── models.yaml              模型总表：llm / opencode / systemone
│   ├── article-types.yaml       类型注册表：只保留 types: 列表
│   ├── steps.yaml               流程入口：默认值 + 阶段文件顺序
│   ├── steps/                   按大步骤拆分的节点（10-topic … 60-publish）
│   ├── types/                   各类型明细（<id>.yaml）+ 字段说明 README.md
│   └── prompts/                 提示词与初稿 schema（draft.json 等）
└── scripts/
    ├── wechat-article.mjs       命令行入口（编排全部阶段）
    └── lib/
        ├── args.mjs             参数解析
        ├── config.mjs           配置加载/归一化/校验（YAML + types/*.yaml）
        ├── classify.mjs         判断模型（systemone）客户端与回退
        ├── env.mjs              .env 与项目根探测
        ├── fsx.mjs              文件工具
        ├── log.mjs              日志
        ├── markdown.mjs         frontmatter 与 [[img:N|...]] 标记
        ├── models.mjs           ollama/openai/opencode/mock 客户端
        ├── knowledge.mjs        知识库索引、检索、WeKnora 检索、摘录
        ├── prompts.mjs          选题/纲要/初稿/评分/修正提示词
        ├── corrector.mjs        correct-cn 客户端与修正应用
        ├── illustrate.mjs       ModelScope + Pollinations 配图
        └── publish.mjs          Resend 邮件 + wenyan 公众号草稿
```
