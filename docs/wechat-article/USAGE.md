
# 微信公众号文章自动化

这是一个脚本驱动的端到端管线。**机械流程全部由 `scripts/wechat-article.mjs` 完成**，只有在需要判断的地方（选题、纲要、初稿、修正、评稿/判定）才调用模型。不要手工重写脚本已经生成的中间产物。

```
选题 + 收集素材 ──► 纲要 + 初稿 ──► 核稿/修正/评稿/判定(≤3 轮) ──► 组稿(去 AI 化 ∥ 配图) ──► 发布(邮件+公众号草稿)
      │                  │                    │                        │                  │
 模型 + 本地目录/WeKnora   模型      correct-cn(规则) + 模型     模型 + 图像 API     Resend/wenyan
```

## 何时使用

- 用户要求"写公众号文章""帮我出个选题""把知识库里的内容整理成文章"。
- 用户要求按某个类型（观点 / 快评 / 技术解读 / Homelab）批量或定时产出图文。
- 用户提供了主题或写作要求，希望自动完成并投递到邮箱 / 公众号草稿箱。

## 快速开始

在本仓库根目录执行（脚本默认从当前工作目录向上寻找项目根）：

```bash
# 1) 校验配置与环境（先做这一步）
node scripts/wechat-article.mjs validate
node scripts/wechat-article.mjs doctor

# 2) 看知识库里有哪些候选主题 / 有哪些 WeKnora 知识库
node scripts/wechat-article.mjs topics --type ai-insight
node scripts/wechat-article.mjs kbs

# 3) 用 mock 模型跑通全流程（不发真实请求）
node scripts/wechat-article.mjs auto --type ai-news --mock

# 4) 入口 1（自动）：从知识库最新文档选题 + 自动纲要，再往下写
node scripts/wechat-article.mjs auto --type ai-insight

# 5) 入口 2（手动）：你给标题 + 提纲，直接往下写
node scripts/wechat-article.mjs manual --type ai-news \
  --title "某模型正式开源" --outline-file outline.md
```

- 两个入口之后的步骤**完全一致**（初稿 → 审稿 → 组稿 → 发布），都支持 `--stage draft` 之类的提前停止。
- `--type` 也可以不写在命令行：在 `.env` 里设 `PB_ARTICLE_TYPE=ai-news` 即可（命令行 `--type` 优先）。
- 手动入口的提纲支持三种来源：`--outline-file outline.md`、`--outline "# 标题\n## 小节\n- 要点"`、或直接给 `02-step/outline.json`；标题可以从提纲的 `# 标题` 行推导，省略 `--title`。

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
node scripts/wechat-article.mjs auto  --type ai-news --article <slug>
node scripts/wechat-article.mjs draft --article <slug>
```

- `--article latest` 选最近一篇；分步命令省略 `--article` 时，若 `draft/` 下只有一篇文章会自动选中。

### 分步执行

每一步都能单独跑、单独检查，产物都追加到同一篇文章目录：

```bash
# 1) 选题步：选题 → 判断类型 → 收集素材（自动选题；生成的目录名 = 标题 slug）
node scripts/wechat-article.mjs topic   --type ai-news

# 2) 初稿步：生成纲要 → 组装初稿输入 → 写初稿
node scripts/wechat-article.mjs draft   --article <slug>

# 3) 审稿步：每轮 核稿 → 修正 → 评稿 → 判定
node scripts/wechat-article.mjs review  --article <slug>
```

- **手动选题只有一步**：`topic --type ai-news --topic "主题" --requirements "..."` 会跳过选题模型，直接记录主题并收集素材；纲要在下一步 `draft` 里生成。
- **自动选题是辅助路径**（双窗口 + 词频热度表，一次模型调用出 3 个候选），设计取舍见 `docs/topic-selection.md`。
- 实际顺序是 `topic（含素材收集）→ draft（纲要 → 初稿输入 → 初稿）`；素材正文与出处（origin/source/date/score）落 `01-step/sources/*.md`，`01-result.json` 的 `sources` 只留 `{index, title, link}`（`link` 相对文章目录），后续 `outline`/`draft_writing` 节点经 `loadSource` 按 `link` 回读。
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

- `## 结构` + 编号列表、`（约 400 字）` 标注、`## 反方观点`、`## 配图` 下的 `- prompt:` 行都兼容——也就是管线自己渲染的 `02-step/outline.md` 能原样喂回来。
- 小节字数没写时，会把该类型的目标字数均分到各小节。
- 配图数量仍受类型配置约束（`--images` 可覆盖）。

### 第一步：一次生成多个候选主题 + 提纲

定选题之前，先让脚本给几个方向挑：

```bash
# 生成 3 个候选主题，每个都带提纲，写成 Markdown
node scripts/wechat-article.mjs topics --type ai-news --count 3 --output output

# 只看不落盘（直接打印 Markdown）
node scripts/wechat-article.mjs topics --type ai-news --count 3 --md
```

- 产物路径：`--output` 是目录时写 `output/topics-<type>-<YYYYMMDD>.md`；是 `.md` 文件时按该路径写。
- 每个候选主题包含：核心判断、切入角度、为什么现在写、关键词、素材线索、备选标题、逐小节提纲（含建议字数）。
- **提纲不是凭空猜的**：每个主题会按关键词与素材线索从知识库挑 3 篇最相关的文章，抽 2 段最相关正文喂给纲要模型，日志里会打印「参考素材」。
- 这一步只做选题与提纲，不检索 WeKnora、不写正文；资料收集在选定主题之后进行。
- 不给 `--count` / `--output` / `--md` 时保持原行为：打印候选文章表格。

## 初稿输入格式（`02-step/draft-input.json`）

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

**提示词在 `config/wechat-article/prompts/draft.yaml` 的 `draft_writing`**（`system` / `user` / `retry`），**校验规则在 `config/wechat-article/schemas/draft.yaml` 的 `draft_input`**（一行一个字段）。改文案、调字段上限都不用动代码：

```yaml
# config/wechat-article/prompts/draft.yaml
prompts:
  draft_writing:
    system: "你是「{{type_name}}」栏目的作者……"
    user: |
      # 任务
      ……
      ## 纲要
      {{outline}}
      ## 可用素材
      {{materials}}
    retry: |
      上一稿不合格（第 {{retry_tag}} 次尝试）：
      {{errors}}
      ……
      ## 原稿
      {{article}}
```

```yaml
# config/wechat-article/schemas/draft.yaml
schemas:
  draft_input:
    "title": ["string", 1, 64]
    "outline": ["array", 1, 12]
    "outline[].heading": ["string", 1]
    "outline[].points": ["array", 1, 8]
    "materials": ["array", 1, 20]
    "materials[].paragraphs": ["array", 1, 20]
    "requirements?": "string"
```

schema 语法：`"string"` / `["string", 最短]` / `["string", 最短, 最长]` / `["array", 最少, 最多]` / `["number", 最小, 最大]` / `"boolean"`；键尾加 `?` 表示可选；`list[]` 校验数组元素，`list[].field` 校验对象数组的每个字段。

用法：

```bash
# 初稿步会依次产出 02-step/outline.json → draft-input.json → draft.md；
# 想只做到输入包，可先 auto/manual --stage draft 停掉再检查 02-step/draft-input.json

# 校验这份输入（硬错误 + 软警告逐条列出）；也可直接给已有文件
node scripts/wechat-article.mjs validate --input <article>/02-step/draft-input.json

# 用它写初稿（可以手改 JSON 后再跑；类型从文件推断，目录用 --article 指定）
node scripts/wechat-article.mjs draft --article <slug> --input <article>/02-step/draft-input.json
```

- `run` / `auto` / `manual` 也会在初稿前自动写出 `02-step/draft-input.json`，每一步都可审查、可手改。
- **硬错误**（会中止）：缺 `title`、`outline` 为空或某节缺 `heading`/`points`、`materials` 为空或素材缺 `paragraphs`、字段超长或超项数上限。
- **软警告**（不中止）：大纲字数与目标相差过大、某节没有要点、缺 `thesis`/`takeaway`/`requirements`。
- 只给段落、没有整篇文章时，把段落放进 `paragraphs` 即可。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `auto` | **入口 1**：自动选题（3 个候选 + 评分，判断模型择一）+ 自动纲要，然后往下写（等价于原来的 `run`） |
| `manual` | **入口 2**：用 `--title` + `--outline`/`--outline-file` 直接往下写，跳过选题与纲要模型 |
| `run` | 完整管线（保留兼容，等同 `auto`） |
| `topics` | 列出候选文章；`--count N --output <目录>` 生成 N 个候选主题（含提纲）的 Markdown |
| `classify` | 只用判断模型（systemone）根据标题 + 提纲选类型，打印选择与得分 |
| `kbs` | 列出 WeKnora 知识库（获取 `kb_ids`） |
| `topic` | 选题步：选题 → 判断类型 → 收集素材（自动选题，或 `--topic` 手动记录；新文章目录按标题 slug 创建） |
| `draft` | 初稿步：生成纲要 → 组装初稿输入 → 写初稿（读 `02-step/draft-input.json`，或 `--input` 指定一份） |
| `review` | 对已有稿件执行核稿 → 修正 → 评稿 → 判定循环（字数校验内置在修正里） |
| `compose` | 组稿步（04）：去 AI 化 + 生成配图，两路并发后组装成稿 |
| `publish` | 发布已有稿件到邮件 / 公众号草稿箱 |
| `validate` | 校验配置文件（类型、知识库目录、模型引用等） |
| `doctor` | 检查环境依赖、知识库可达性、各服务连通性 |

### 通用参数

- `--config <path>` 类型注册表，默认 `config/wechat-article/article-types.yaml`
- `--defaults <path>` 全局默认配置，默认 `config/wechat-article/defaults.yaml`
- `--models <path>` 模型总表，默认 `config/models.yaml`
- `--steps <path>` 步骤配置，默认 `config/wechat-article/steps.yaml`
- `--type <id>` 文章类型 id；**仅作回退提示**——正常定权交给判断模型（System One），分类不可用时才按 `--type` → `PB_ARTICLE_TYPE` → `classifier.default_type` 兜底
- `--topic <text>` 手动主题（省略则自动选题；手动时**跳过选题模型**）
- `--from-proposal <n>` 复用文章目录 `01-step/proposal.json` 里第 n 个候选（需配合 `--article`）
- `--requirements <text>` 手动补充写作要求
- `--topic-file <path>` 复用已有选题 JSON（如 `01-result.json`）
- `--sources-file <path>` 复用已有素材 JSON（数组，直接并入 `01-result.json` 的 `sources`，跳过检索）
- `--outline-file <path>` `manual` / `classify` 的提纲文件（Markdown 或 `02-step/outline.json`）
- `--input <path>` 初稿输入 JSON（标题 + 大纲 + 资料，如 `02-step/draft-input.json`）；`draft` / `run` 用，跳过前置步骤
- `--knowledge-source <s>` 覆盖知识来源：`local` | `weknora` | `both`
- `--article <slug>` 选择/续跑 `draft/<slug>/` 这篇文章；`latest` = 最近一篇；分步命令省略时自动选中唯一一篇
- `--file <path>` `review`/`compose`/`publish` 直接指定稿件文件（`--article <path>` 仍兼容）
- `--slug <name>` 新建文章时覆盖目录名（默认取标题 slug）
- `--model <id>` 全局覆盖各节点模型 id（如 `llm.local`、`llm.large`；优先级 `--model` > 节点 `models.<调用名>.rounds.<轮次>.id` > `models.<调用名>.levels.<档位>.id` > `models.<调用名>.id` > `type.model`；遗留参数）
- `--review-model <id>` 覆盖评稿模型 id
- `--rounds <n>` 核稿/修正/评稿/判定循环最大轮次（1-5，默认取配置 `review.max_rounds`，即 `${PB_REVIEW_ROUNDS:-3}`）
- `--length-attempts <n>` 修正稿字数校验不过时的重试次数（默认 3，0 表示不重试；重试耗尽仍不合格则**中断流程**）
- `--images <n>` 配图数量（1-5）
- `--de-ai-level <l>` `compose` 去 AI 化档位：`light` | `standard` | `deep`（省略则用节点 `handler_options.level`，当前配置为 `${PB_DE_AI_LEVEL:-light}`；档位决定提示词、重叠上限与采样参数，见「组稿」一节）
- `--stage <name>` `run` 的终止阶段：`topic|draft|review|compose|publish`（素材收集属于 `topic` 步，纲要与初稿输入属于 `draft` 步，不再单列阶段）
- `--mock` 用 mock 模型（不发真实网络请求，用于验证流程）
- `--verbose` 输出调试日志

> 文章根目录只认环境变量/配置里的 `BASE_OUTPUT_FOLDER`，`--output` 已取消。

### 发布参数

- `--email` / `--no-email` 覆盖邮件开关
- `--to <address>` 收件人（可多次或用逗号分隔）
- `--wechat` / `--no-wechat` 覆盖公众号草稿开关
- `--dry-run` 发布演练：生成 HTML/命令但不真正投递（`05-result.json` 记 `status: dry_run`，不触发归档）
- `--auto-publish` 跳过配置里的 `auto_publish=false` 门槛（显式要求发布）

> 安全默认：配置里 `publish.auto_publish=false`，且 `email`/`wechat` 默认关闭。只有显式传 `--email`/`--wechat`/`--auto-publish`、`.env` 里抬起对应的 `PB_*` 开关，或直接运行 `publish` 命令，才会真正发布。
> 三个开关在 `defaults.yaml` 写成 `${PB_AUTO_PUBLISH:-false}` / `${PB_EMAIL_ENABLED:-false}` / `${PB_WECHAT_ENABLED:-false}`，无人值守跑管线时改 `.env` 即可，不用动配置也不用带 flag；命令行 flag 仍优先于环境变量。
> 环节级开关在 `steps` 节点：`50-publish.yaml` 的 `publish.enabled=false` 时整个发布环节不执行（不落 05 产物、不投递），`archive.enabled=false` 时不入库、不打包、不删除，产物留在 `draft/`。

## 产出物

一篇文章 = `$BASE_OUTPUT_FOLDER/draft/<slug>/` 一个目录：

```
01-result.json                             选题步结果（信封 + 选题字段 + sources 链接条目；择题过程在 proposal.json）
01-step/topic.md                           选题的人类可读版
01-step/proposal.json                      自动选题的全部候选 + 热度表（仅自动选题时生成，可用 --from-proposal 复用）
01-step/sources/<n>-<slug>.md              每条素材一份：frontmatter 记 title/origin/source/date/score，正文只放摘录段（不整篇复制）
01-step/web-search/<slug>.md                 外部检索结果（每组关键字一份，本地素材不足时才产生）
02-result.json                             初稿步结果（小节数 + 字数 + 配图规划数；路径在信封 files 地图里）
02-step/outline.json / outline.md          纲要
02-step/draft-input.json                   初稿输入（标题 + 大纲 + 资料）
02-step/draft.md                           初稿
03-result.json                             审稿结果（每轮字数/综合评分/判定 + 是否通过；核稿候选数等过程明细在 03-step/）
03-step/round-N/{after-correct,after-revise}.md + correct.json + score.json + check.json
03-step/reviewed.md                        审稿后的稿件
04-result.json                             组稿步结果（去 AI 化状态 + 闸门判定 + 配图统计；每张图的明细在 04-step/images.json）
04-step/polished.md                        去 AI 化后的稿件（配图标记尚未替换）
04-step/images.json                        配图生成结果（每张图的 provider、路径、失败原因）
04-step/composed.md                        组稿后的成稿（去 AI 化 + 图片标记替换）
04-step/images/                            生成的图片
05-result.json                             发布结果与状态（含归档信息；去重/归档依赖它）
05-step/final.md                           终稿（发布用）
05-step/final.html                         邮件用 HTML（启用邮件时生成）
logs/pipeline.log                          运行日志（独立命令 review/compose/publish 也写这里）
NN-step/api/子步骤号_轮次(尝试)-label(_F).<模型|provider>.json  所属步骤每次外部调用的 request+response 留痕（重跑覆盖）
                                            步骤号只由目录名 NN-step 提供，不进文件名；主号=子步骤号
                                            （该调用在步骤内的固定执行次序，同记在 JSON 的 slot 字段）；
                                            轮次=该子步骤步骤内第几次逻辑调用（下一轮 +1）；
                                            单次调用内的重试以 (尝试) 标注（如 2_1(2)-revise）：
                                            01: 1-knowledge_search(weknora)/2-topic/3-select_best/
                                                4-classify_type/5-websearch、
                                            02: 1-outline/2-draft(-section-N)、
                                            03: 1-correct(correct-cn)/2-sensitive(correct-cn)/
                                                3-revise/4-score/5-review_check、
                                            04: 1-de_ai/2-illustrate(modelscope|pollinations)、
                                            05: 1-email(resend)
```

> 没有 `state.json`：文章身份、类型、进度全部从产物文件推导（文件存在 = 该阶段完成）。每步固定「根目录一个 `NN-result.json` + `NN-step/` 中间文件」。组稿（04）内部去 AI 化与配图两路并发，`composed.md` 存在才算这一步完成。

> 五份 `NN-result.json` 共用一个**信封**：`stage / generated_at / title / type / files`。`title` 与 `type`（类型 id 字符串）只在 01 产生，02–05 从上一份 result 顺延；`files` 是累积的产物地图（相对文章根目录），后面任何一步要读前面的文件都从这里取路径。过程明细留在 `NN-step/`，result 里不放 `step`、`slug`、`picked` 或单文件指针。详见 [`artifacts.md` 2.1](./artifacts.md)。

### 发布成功后的归档

只有 `05-result.json` 的 `status` 为 `published`（至少一个渠道**真实投递成功**）才会归档：

1. 终稿复制到本地知识库的 pipeline 待入库目录（`defaults.publish.archive.knowledge_dir`，即 `KNOWLEDGE_PIPELINE_DIR`；失败只记录，不阻塞）；
2. 整个文章目录打包到 `published/<YYYYMMDD>-<slug>.zip`；
3. 删除 `draft/<slug>/`。

`skipped`（未启用发布 / `auto_publish=false`）、`dry_run`、`partial`、`failed` 都留在 `draft/`，修好后可重跑。归档是幂等的：zip 路径先写进 `05-result.json`，重跑时已存在的 zip 直接复用。

## 流程节点（`config/wechat-article/steps/`）

`config/wechat-article/steps.yaml` 只保留阶段文件顺序（模型、重试、超时的默认值吃 `config/models.yaml`，调用级覆盖在各节点 `models.<调用名>.options`）；节点按大步骤拆到 `config/wechat-article/steps/`。只有步骤文件带 `number-` 前缀，其他配置目录不带：

| 阶段文件 | 节点 |
| --- | --- |
| `10-topic.yaml` | `select_topic` → `classify_type` → `gather_materials` |
| `20-draft.yaml` | `outline` → `bundle_draft_input` → `draft_writing` |
| `30-review.yaml` | `review` → `revision` → `scoring`（含 `check` 判定调用） |
| `40-compose.yaml` | `de_ai` ∥ `image_generation`（并发，完成后组装 `04-step/composed.md`） |
| `50-publish.yaml` | `publish` → `archive` |

每个阶段文件里的节点用 `key → value` 写，key 就是 `step_name`。节点只引用提示词和数据结构 id，不在步骤文件里展开内容：

```yaml
steps:
  select_topic:
    label: 选题
    stage: topic
    handler: builtin:select_topic
    models:
      select:                              # 一次真实模型调用一个条目
        id: llm.local
        prompt: topic.select_topic         # 提示词/校验契约写在调用级
        schema: topic.select_topic
        options:
          retry_limit: 2
          timeout: 900000
      best:
        id: systemone.classifier
        prompt: topic.select_best
    artifacts:
      reads: []
      writes: ["01-result.json"]
    depends_on: []
```

节点还可以挂 `result_schema`（如 `select_topic` 的 `topic.result`）：它校验的是本节点落盘的那份 `NN-result.json` 本体（信封 + 本步载荷），与调用级 `schema`（模型输出契约）是两个互不替代的口——`image_generation` 就同时挂着 `revision.image_generation`（`04-step/images.json`）与 `compose.result`（`04-result.json`）。只有 `artifacts.writes` 里真的写了 result 的节点能挂，契约条目必须带可执行 `output` DSL，两者任一不成立都是加载期错误；运行期在落盘前校验，不合格只警告不阻塞，结果如实记进同一份 result 的 `validation`。详见 [`schemas/README.md`](../../config/wechat-article/schemas/README.md) 与根目录 `AGENTS.md`。

只有一个模型调用（或没有调用）的节点可以把 `prompt` / `schema` 写在节点级（如 `draft_writing`）；两个以上调用必须逐调用写，同一份节点级提示词会被第二个调用误继承，加载期直接抛错（`models.<调用名>.prompt 必须单独声明提示词 id`）。

### 提示词与数据结构 id

id 的格式是 `<文件名>.<配置项名>`，能直接定位到文件里的某一项：

| id | 文件 | 配置项 |
| --- | --- | --- |
| `topic.classify_type` | `config/wechat-article/prompts/topic.yaml` | `prompts.classify_type` |
| `topic.select_topic` | `config/wechat-article/prompts/topic.yaml` | `prompts.select_topic` |
| `review.scoring` | `config/wechat-article/prompts/review.yaml` | `prompts.scoring` |
| `publish.publish` | `config/wechat-article/schemas/publish.yaml` | `schemas.publish` |

提示词文件：

```yaml
# config/wechat-article/prompts/topic.yaml
prompts:
  select_topic:
    system: |
      你是「{{type_name}}」栏目的选题编辑。
    user: |
      {{mode_line}}
      {{candidates}}
```

数据结构文件（截取，完整字段见该文件）：

```yaml
# config/wechat-article/schemas/topic.yaml
schemas:
  select_topic:
    input:
      type: "ArticleType"
      mode: "auto|manual"
      candidates: "Array<{title: string, days_ago: number, fresh: boolean}>"
    output:
      topics: ["array", 1]
      "topics[].topic": ["string", 1, 64, "一句话主题（不超过 64 字）"]
      "topics[].thesis": ["string", 1, "核心判断，一句话，必须可证伪"]
```

注册表只收**脚本真会跑**的校验契约，三个消费方：`models.jsonValidated`（模型输出，带失败原因修复重试）、`validateDraftInput`（`02-step/draft-input.json`）、`validateProduced`（04/05 自己产出的 JSON，只警告不阻塞）。不写 `schema` 的节点：判断模型调用（`classify_type` / `select_best`，回答由 `classify.mjs` 按固定规则解析）、本地检索与组装节点（`gather_materials` / `bundle_draft_input` 之外的本地段）、产出自由 Markdown 的节点（`draft_writing` / `revision` / `de_ai`，由代码里的计字、小节标题、配图标记、重叠率等闸门把关）。它们的形状内联在节点 `input_format` / `output_format` 里，`steps --step` 会标明「形状备注，脚本不校验」，与「校验契约 `<id>`」区分开。

初稿提示词在 `prompts/draft.yaml` 的 `draft_writing`，初稿输入校验规则在 `schemas/draft.yaml` 的 `draft_input`，都按普通 id 注册。

节点顺序就是正常执行顺序：

| step_name | 作用 | 处理方式 | 默认模型 |
| --- | --- | --- | --- |
| `select_topic` | 选题 | `builtin:select_topic` | `llm.local` |
| `classify_type` | 判断文章类型 | `builtin:classify_type` | `systemone.classifier` |
| `gather_materials` | 收集素材 | `builtin:gather_materials` | `none`（本地检索） |
| `outline` | 生成纲要 | `builtin:generate_outline` | `llm.large` |
| `bundle_draft_input` | 组装初稿输入 | `builtin:build_draft_input` | `none`（本地脚本） |
| `draft_writing` | 写初稿 | `builtin:write_draft` | `llm.large` |
| `review` | 核稿（错别字/敏感词候选） | `builtin:review_article` | `none`（并行调两个规则端点） |
| `revision` | 修正（内置字数校验，不合格带原因重试） | `builtin:revise_article` | `llm.large`（可按轮次覆盖） |
| `scoring` | 评稿 + 循环去留判定 | `builtin:score_article` | score `llm.large`，check `systemone.classifier` |
| `de_ai` | 去 AI 化（三档强度，本地三判据闸门，不合格换采样重调） | `builtin:de_ai` | `llm.large`（可按档位覆盖） |
| `image_generation` | 配图（模板渲染 + 两种尺寸场景，产物按 schema 校验） | `builtin:generate_images` | `none`（图片通道见 `defaults.illustrations`；提示词模板 = `revision.image_generation`） |
| `publish` | 发布 | `builtin:publish_article` | `none`（渠道 API） |
| `archive` | 归档 | `builtin:archive_article` | `none`（本地脚本） |

> `de_ai` 与 `image_generation` 同属组稿（04）阶段，运行时并发：前者改写 `03-step/reviewed.md` → `04-step/polished.md`，后者按 `02-step/outline.json` 的 `image_plan` 生成图片；两路都结束后把图片标记替换进润色稿，落 `04-step/composed.md`。去 AI 化失败退回审稿稿，配图失败按 `illustrations.on_failure` 处理标记，两条分支都不阻塞流程。**两条分支各有一个 `enabled` 开关**（节点上写成 `${PB_DE_AI_ENABLED:-true}` / `${PB_IMAGES_ENABLED:-true}`，类型层 `steps.<step>.enabled` 可覆盖）：`de_ai` 关掉不产出 `polished.md`、组稿直接用审稿稿；`image_generation` 关掉不调任何图片通道、标记按 `on_failure` 处理（想出纯文字稿就关它）。
>
> **改写强度分三档**，选档 = `handler_options.level`（节点上写成 `${PB_DE_AI_LEVEL:-light}`），命令行 `--de-ai-level light|standard|deep` 与类型层 `steps.de_ai.handler_options.level` 可覆盖。当前节点默认 **`light`**——策略是功能保持打开、先用最低档跑起来，闸门不合格照样发稿，效果后续再往 `standard`/`deep` 抬（无人值守长期抬档改 `.env`，临时试档用命令行）：
>
> | 档位 | 提示词 | 重叠上限 | 采样参数 |
> | --- | --- | --- | --- |
> | `light`（默认） | `revision.de_ai_light`（只换词，保句子骨架与段落顺序） | 0.85 | `retry_limit: 1`（一轮出稿） |
> | `standard` | `revision.de_ai`（改到句子层面） | 0.5 | 节点默认 `retry_limit: 3` |
> | `deep` | `revision.de_ai_deep`（整篇重述，可重排段落） | 0.35 | `temperature: 0.9` |
>
> 提示词 id 与阈值单源在 `handler_options.levels.<档>`，档位没定义、缺 prompt 或阈值越界都在运行时抛错（不静默退回默认档）。三档共同的硬约束与档位无关：字数落在 `type.length` 区间、原稿数字全部保留、frontmatter/小节标题/配图标记不变。
>
> `de_ai` 的产出用**本地零 token 三判据**把关：与原稿逐字重叠率 ≤ 本档 `max_verbatim_overlap`、字数在 `type.length` 区间、原稿数字全部保留。任一不合格就换一次采样重新调用，总尝试上限 = 本档的 `models.de_ai...retry_limit`（含首轮）；耗尽后取违规最少的一版继续，并在 `04-result.json` 的 `polish` 里记 `level` 与 `gate.passed: false` 及具体违规（只标记，不阻塞）。

### handler

```yaml
handler: builtin:select_topic              # 内置实现（当前默认）
handler: scripts/steps/select-topic.mjs    # 独立本地脚本
handler: https://example.com/api/step      # HTTP 接口
```

### model

所有模型统一在 `config/models.yaml` 定义；steps 节点用 `models:` 声明每一次真实模型调用：

```yaml
# config/wechat-article/steps/10-topic.yaml
steps:
  select_topic:
    models:
      select:                    # 调用名 = 该步骤里这次调用的语义标签
        id: llm.large
        options:
          retry_limit: 2
          timeout: 900000
      best:
        id: systemone.classifier # systemone 模板：低置信度时升级重模型再判一次
        options:
          deep: systemone.classifier-deep
          escalate_below: 0.65
```

运行时优先级：`--model`（遗留）> `rounds.<轮次>.id` > 节点 `models.<调用名>.id` > `type.model`。
节点调用配置是该步骤模型的单源，代码不会绕过它去吃 type/defaults。
统一标准（详见根目录 `AGENTS.md`）：

- 模板由模型 id 前缀选择：`llm.*` 的 `options` 只允许 `retry_limit / timeout /
  temperature / max_tokens`；`systemone.*` 只允许 `deep / escalate_below /
  min_confidence`。不合规写法在配置加载期直接抛错。
- `retry_limit`：结构化输出调用的总尝试上限（含首轮），1 = 不做修复重试。
- `timeout`（ms）：本调用总限时，覆盖 models.yaml profile 的 `timeout_ms` 默认。
- options 未配置的参数吃 models.yaml 端点默认；写了就覆盖。
- 已废弃：节点扁平 `model / retry_limit / timeout`、steps.yaml
  `defaults.model / retry_limit / timeout`（都是加载期硬错误）。
- 无模型调用的节点不写 `models`：`gather_materials` 的检索模型单源在 defaults.yaml
  `defaults.knowledge.web-search.model`（websearch 是 opencode 工具节点，不算模型
  调用），闸门/超时同段；纯本地节点（如 `bundle_draft_input`）无调用。

#### 按轮次覆盖模型

带轮次语义的调用（`revision.revise`、`scoring.score`）可按轮次换模型/参数：

```yaml
models:
  revise:
    id: llm.large
    options: { timeout: 900000, temperature: 0.2 }
    rounds:
      1:
        id: llm.local                 # 首轮换 9b
        options: { timeout: 600000 }
```

轮次从 1 起；只写要覆盖的字段，`id` 缺省继承默认模型，`options` 按键合并。
覆盖项与默认调用必须同模板，加载期校验；`--model` 仍优先于轮次覆盖。
其他调用没有轮次语义，写了 `rounds` 不会生效。

`config/models.yaml` 按两类组织，每类下可以有多个子类型（models.yaml 是端点级默认配置，运行时的模型/超时以 steps 节点为准）：

```yaml
llm:                 # 文本模型：Ollama / OpenAI 兼容端点
  local: { ... }
  small: { ... }
  large: { ... }
  remote: { ... }

systemone:           # System One 决策模型（两段式判断）
  classifier:        # 一次判断（轻量）
    base_url: "${SYSTEMONE_BASE_URL}"
    model: "${SYSTEMONE_MODEL1:-tev1}"
  classifier-deep:   # 二次判断（重模型），一次置信度低于 escalate_below 时使用
    base_url: "${SYSTEMONE_BASE_URL}"
    model: "${SYSTEMONE_MODEL2:-nimble}"
    timeout_ms: 30000
```

- `llm.*`：`provider` 写 `ollama` 或 `openai`；`remote` 可以指向 DeepSeek 等兼容端点。
- `systemone.*`：走 `/v1/systemone`，用于自动分类；models.yaml 只放端点默认，行为参数
  （`deep / escalate_below / min_confidence`）配在 steps 节点 `models.<调用名>.options`。
- 配图通道不在 `models.yaml` 里，配置在 `defaults.illustrations.modelscope` / `pollinations`。
- **端点参数单源在本文件与 `defaults.illustrations`，代码里没有兜底副本**：`llm.*` 必填
  `base_url / model / timeout_ms / temperature / max_tokens / stream_idle_ms`（ollama 还要
  `num_ctx`），配图通道必填 `base_url / model / timeout_ms` 与各自的节流字段（`poll_interval_ms`
  / `max_polls` / `min_interval_ms` / `max_retries`）。缺一个就直接抛错并点名配置路径，不会静默
  吃代码里的默认值——历史教训是两边各写一份且互相冲突（配图 `timeout_ms` 90000 vs 120000）。
- `stream_idle_ms`（ms）：流式响应的块间隔上限，超过它就判定连接已死并中断，不必等 `timeout_ms`
  总限时耗尽；与总限时是两个旋钮。

`--model` 也用同样的 id（如 `--model llm.large`），全局覆盖所有已接线节点的模型 id（遗留参数，后续测试脚本环节可能移除）。

### 类型覆盖

类型文件可以把某个节点切换到另一份提示词或数据结构，也可覆盖 `enabled` / `handler_options`；模型调用不在 type 层覆盖（单源 = 节点 `models.<调用名>`）：

```yaml
# config/wechat-article/types/ai-news.yaml
steps:
  select_topic:
    prompt: ai-news.select_topic   # 对应 config/wechat-article/prompts/ai-news.yaml 的 select_topic
    schema: ai-news.select_topic   # 对应 config/wechat-article/schemas/ai-news.yaml 的 select_topic
```

类型专用提示词放在 `config/wechat-article/prompts/<类型 id>.yaml`：

```yaml
# config/wechat-article/prompts/ai-news.yaml
prompts:
  select_topic:
    system: |
      你是「AI 资讯快评」栏目的选题编辑，先事实后观点。
    extra: "只选 48 小时内、能落到具体产品变化的事件。"
```

覆盖按字段合并：只写 `extra` 时，仍保留基础提示词的 `system` / `user`。旧字段 `prompts.outline_extra` / `draft_extra` / `revise_extra` 仍然生效，会追加到对应节点的 `prompt.extra`。

### 查看节点

```bash
# 全部节点
node scripts/wechat-article.mjs steps

# 看某个类型覆盖后的配置
node scripts/wechat-article.mjs steps --type ai-news

# 看单个节点的模型、I/O 和最终提示词
node scripts/wechat-article.mjs steps --step draft_writing --type ai-news

# 机器可读
node scripts/wechat-article.mjs steps --json
```

`validate` 和 `doctor` 也会校验 `steps.yaml`。当前版本已经完成节点清单、加载、模型继承、类型覆盖、校验和展示；执行层会按这些节点逐步接入（先把契约固定下来）。

## 文章类型与配置

- 全局默认：`config/wechat-article/defaults.yaml`（输出目录、判断模型行为、文章级默认值）。
- 模型总表：`config/models.yaml`（`llm` / `systemone` 两类）。
- 类型注册表：`config/wechat-article/article-types.yaml`，`types:` 是 `id → 文件名` 的映射，顺序即加载顺序。
- 类型明细：`config/wechat-article/types/<id>.yaml`，一个类型一个文件；`types:` 决定加载顺序，省略时自动扫描目录。
- 提示词：`config/wechat-article/prompts/<命名空间>.yaml`，id = `命名空间.配置项`。
- 数据结构：`config/wechat-article/schemas/<命名空间>.yaml`，id 规则同上。
- 字段说明：`config/wechat-article/types/README.md`、`config/wechat-article/prompts/README.md`、`config/wechat-article/schemas/README.md`。

```yaml
# config/wechat-article/article-types.yaml
types:
  ai-insight: ai-insight.yaml
  ai-news: ai-news.yaml
  tech-explainer: tech-explainer.yaml
  homelab-practice: homelab-practice.yaml
```

内置类型：

| id | 名称 | 知识库目录 | 目标字数 | 通过分 |
| --- | --- | --- | --- | --- |
| `ai-insight` | AI 深度观点 | `D:/knowledge/obsidian/ai` | 1500-2200 | 82 |
| `ai-news` | AI 资讯快评 | `D:/knowledge/obsidian/ai` | 1500-2000 | 78 |
| `tech-explainer` | 技术解读 | `ai` + `homelab` | 1800-2800 | 82 |
| `homelab-practice` | Homelab 实践笔记 | `D:/knowledge/obsidian/homelab` | 1200-2000 | 78 |

每个类型文件可配置：

- `type`：中文类型名（`id` 缺省取文件名）
- `description`：一句话说明，判断模型用它分类
- `knowledge_base_path`：本地知识库目录（字符串或数组）
- `style`：风格描述，字符串或 `persona`/`tone`/`audience`/`title_style`/`structure`/`dos`/`donts`
- `word_limit`：`800-1300`、`1500` 或 `{ min, max, target }`
- `scoring_criteria`：评分维度数组（`id`/`name`/`weight`/`description`/`criteria`）
- `pass_score`：通过线，写成 `"${PB_PASS_SCORE:-78}"`——`.env` 设了就统一四类，不设时吃本类型的默认。裸数字会被测试拦下（同值副本掩盖 `.env`）
- `review`：只覆盖 `correct_cn`（核稿服务）。`max_rounds` 单源 `defaults.yaml`（`PB_REVIEW_ROUNDS`），通过线用上面的顶层 `pass_score`
- `image_count`：`1-5`、`3` 或 `{ min, max, default, cover }`（`default` = 纲要没排出配图时的兜底张数，不越过纲要的小节规划）；张数不吃 `.env`，单次指定用 `--images`
- `image_position_format`：正文配图占位符模板，默认 `[[img:{index}]]`
- `topic`：`keywords`、`exclude_keywords`、`candidate_days`、`fresh_days`、`max_candidates`、`proposals`（机制见 `docs/topic-selection.md`）。四个窗口值必填，代码里没有 15/7/40/3 的副本；旧字段 `lookback_days`、`candidates` 的回退已删
- `model` / `steps`：写作模型与节点覆盖（`prompt` / `schema` 写注册表 id）

新增类型：在 `config/wechat-article/types/` 加一个 YAML，再把 `id: 文件名` 写进 `article-types.yaml` 的 `types:`，跑 `validate`。类型专用提示词/数据结构放 `config/wechat-article/prompts/<id>.yaml` 和 `config/wechat-article/schemas/<id>.yaml`，然后在 `steps` 里用 id 覆盖。

### 判断模型（System One）

`defaults.yaml` 的 `classifier` 段只留行为开关；模型 id 与判断参数配在 steps 节点（TypeSafe Jev / 基石智算 Laya / vLLM 同一协议）：

```yaml
# config/wechat-article/defaults.yaml
classifier:
  enabled: true
  question: article_type       # 定类判断在 questions 里的问题名
  topic_question: topic_pick   # 选题择一的问题名
  default_type: ai-news        # 判断失败/置信度不足时的兜底类型
```

```yaml
# config/wechat-article/steps/10-topic.yaml
steps:
  classify_type:
    models:
      classify:
        id: systemone.classifier
        options:
          deep: systemone.classifier-deep # 二次判断（重模型）；不写 = 不升级
          escalate_below: 0.65            # 一次置信度低于该值时二次判断（配了 deep 就必须写）
          min_confidence: 0.5             # 最终置信度低于该值时按 default_type 兜底
```

端点参数（`base_url: ${SYSTEMONE_BASE_URL}`、`endpoint: /v1/systemone`、可选
`${SYSTEMONE_API_KEY}`）在 `config/models.yaml` 的 `systemone.classifier` /
`systemone.classifier-deep` 定义，节点只引用模型 id；`model / endpoint / timeout_ms /
max_retries` 都由 models.yaml 提供，**缺一项就抛错点名 `config/models.yaml systemone.<id>`**
（只有 `base_url` 留空例外——那是设计好的「判断模型不可用」降级）。问题名
（`question / topic_question / check_question`）单源 `defaults.yaml classifier.*`。

请求不是 chat/completions，而是一次 `choice` 判断：

```json
{
  "model": "tev1",
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

- 两段式判断：先用一次模型（节点 `models.classify.id`）判一次；置信度低于 `options.escalate_below` 且配置了 `options.deep` 时，用重模型再判一次并采用其结果；二次判断失败时保留一次结果。`deep` 不写则始终单段（这种节点不需要 `escalate_below`）。**闸门没有代码默认**：要用就写出来，不想要就显式写 `0`（`min_confidence: 0` = 不做置信度兜底），缺了会在真正用到它的那一步抛错点名节点。`select_topic.models.best` 用同一套参数在 3 个候选主题中择一（它没有 `min_confidence` 消费点，所以节点只写 `deep / escalate_below`——写了没人读的阈值同样是说谎）；审稿阶段的 `scoring.models.check` 用同一套机制做去留判定（done/continue，见「审稿循环」）。
- `manual` / `--topic` 等已有标题或提纲的入口：直接调用判断模型定类。
- `auto` 入口**选题在前、分类在后**：先用所有启用类型知识库目录的并集做选题，再用定好的标题 + 主题调用判断模型定类，之后才进入后续阶段（见 `docs/topic-selection.md`）。
- 类型优先级：断点续跑（`01-result.json` 的 `type`）> `--input` 里的 `type` > 判断模型 > `--type`/`PB_ARTICLE_TYPE` 回退提示 > `classifier.default_type`。`--type` 只在分类不可用时兜底，不再预先定类。
- 未配置 `SYSTEMONE_BASE_URL`、请求失败或置信度低于 `min_confidence` 时，回退到 `--type`/环境变量提示，再到 `classifier.default_type`；429/503 会按 `Retry-After` 重试。`SYSTEMONE_API_KEY` 是可选项，端点不鉴权时留空即可。
- 单独验证：`classify --title "..." --outline-file outline.md`；`--mock` 不发请求。

## 资料收集（本地目录为主）

资料收集是选题步（01）的最后一个节点，不单独成阶段：每条素材正文落 `01-step/sources/*.md`，`01-result.json` 的 `sources` 只留链接条目，外部检索原文进 `01-step/web-search/<slug>.md`。

当前流程只读本地知识库目录（`knowledge_base_path`）。WeKnora 作为可选能力保留在 `defaults.knowledge`，默认关闭（`PB_USE_WEKNORA=false`）；类型文件不需要配置 `weknora`。

- 本地检索：扫描目录下的 Markdown，按关键词、标题与日期排序取最新素材。
- 发布成功后的终稿统一落到 `KNOWLEDGE_PIPELINE_DIR`（默认 `D:/knowledge/pipeline`），由后续入库脚本处理。
- `kbs` 仍可只读查看远端知识库；`--knowledge-source` 仅在显式启用 WeKnora 时有意义。

## 模型

所有模型在 `config/models.yaml`，按 `llm` / `systemone` 两类组织。节点、类型和 `defaults` 只写模型 id：

| id | provider | 说明 |
| --- | --- | --- |
| `llm.local` | ollama | 选题环节默认模型，`LOCAL_LLM_BASE_MODEL`（默认 `qwen3.5:9b`） |
| `llm.small` | ollama | 更小更快的本地模型，默认 `qwen3.5:4b`，暂无节点引用，`--model` 备选 |
| `llm.large` | ollama | 纲要/写作/修正/评稿/去 AI 化模型（节点 `outline` / `draft_writing` / `revision.revise` / `scoring.score` / `de_ai.de_ai`），默认 `qwen3.6:35b`，篇幅遵循与维度打分更稳、更慢 |
| `llm.remote` | openai | 任意 OpenAI 兼容端点（`PB_LLM_BASE_URL` / `PB_LLM_API_KEY`），暂无节点引用，`--model` 备选 |
| `systemone.classifier` | systemone | 自动分类一次判断（轻量），走 `/v1/systemone` |
| `systemone.classifier-deep` | systemone | 一次置信度不足时的二次判断（重模型） |

- `none` 是保留值，表示纯本地脚本，不调模型。
- `--mock` 会跳过真实模型调用，不需要配置 mock 模型。
- 覆盖用法：`--model llm.large --review-model llm.local`。若某次模型调用失败，脚本会按阶段降级（规则纲要 / 分节生成 / 规则评分），不会中断整条管线。

## 组稿（去 AI 化 + 配图）

- 04 阶段两条分支**并发**执行：`de_ai` 把审稿稿改写成更自然的 Markdown（`04-step/polished.md`，纯文本输出；强度按 `light`/`standard`/`deep` 三档选提示词与阈值，结果由本地三判据把关——逐字重叠率、字数区间、原稿数字保全，不合格换采样重调至本档 `retry_limit`，耗尽取最优一版并在 `polish.gate` 标记，整条分支失败或节点 `enabled: false` 时才退回审稿稿；**关档与失败回退都不产出 `polished.md`**，`04-result.json#files.polished` 记 `null`，只有真出润色稿时才有这个文件）；配图按纲要 `image_plan` 生成（`04-step/images.json`，`file` 是相对文章根目录的路径）。都结束后把图片标记替换进润色稿，落 `04-step/composed.md`。
- 初稿中用标记占位：`[[img:N|中文说明|English prompt]]`（兼容旧格式 `[图N：说明]`）；类型可用 `image_position_format` 改模板（保留 `{index}`）。
- 张数优先级：`--images N` > 纲要 `image_plan` 实际排出的张数 > 类型 `image_count.default` > `image_count.min`，结果再 clamp 到 `min`~`max`（默认 1-5 张，第 1 张固定封面）。
- 配图通道**按主备顺序串行降级**（`defaults.illustrations.primary` / `fallback`）：先 ModelScope（`PB_MODEL_IMAGE_API_KEY`，模型 = `modelscope.model`，异步任务轮询最多 `max_polls` 次、单次请求限时 `timeout_ms`），它失败才回退 Pollinations。多张图片之间仍按 `concurrency` 并发。
- Pollinations 免费档实测每 IP 45 秒只能出 1 张、且同时只允许 1 张在飞，所以进程内排队 + 按报错里的 `Retry after Ns` 退避重试（`min_interval_ms` / `max_retries`）；它返回的是 JPEG，落盘扩展名按响应 `content-type` 走（`.jpg`），发布侧才不会报错类型。
- 发给图片模型的 prompt 由**模板 + 变量**渲染：模板单源在 `prompts/revision.yaml → image_generation`（节点 `image_generation.prompt` 指过去，代码里不留副本，缺模板直接抛错）。变量由脚本给：`{{subject}}`（纲要 `image_plan[].prompt`，缺则退回中文说明/主题）、`{{style}}`、`{{negative}}`（`illustrations.style` / `negative_prompt`）、`{{composition}}`（该场景的构图说明）。调配图风格与措辞改配置即可，不用动代码。
- 只有**两种尺寸场景**（第 1 张固定封面，其余正文），单源在 `illustrations.scenes`：`wechat-cover` 900×383、`article-inline` 1080×810，`width/height` 进请求参数、`composition` 进提示词。
- **通道的每个端点参数与场景尺寸都必须写在 `defaults.illustrations` 里**，代码不留副本：`base_url` / `model` / `timeout_ms` 以及各通道的节流字段（ModelScope 的 `poll_interval_ms` / `max_polls`，Pollinations 的 `min_interval_ms` / `max_retries`）缺一个、或 `scenes` 里少了 `width/height`，就直接抛错点名 `defaults.yaml illustrations.<通道>.<字段>`（尺寸点名 `illustrations.scenes.<场景>`）。`api_key` 缺失的报错会同时点出对应的环境变量名（`PB_MODEL_IMAGE_API_KEY`）。
- 生成成功后标记被替换为本地图片相对路径；没出图的标记按 `illustrations.on_failure` 处理，取值 `comment`（换成 `<!-- 配图生成失败：说明 -->`）/ `keep`（原样保留 `[[img:N]]`）/ `drop`（删掉标记）。
- `image_generation` 节点 `enabled: false`（或类型层覆盖）时整条配图分支跳过：不调任何通道，`04-result.json#images_skipped` 记 true，标记同样按 `on_failure` 处理（注释文案是「配图已关闭」）。
- `04-step/images.json` 落盘前按节点 `schema`（`schemas/revision.yaml → image_generation.output`，紧凑 DSL）校验一次，不合格只警告不阻塞，结果记在 `04-result.json#images_validation`（`checked/ok/errors/warnings`）。

## 篇幅控制

篇幅不再是独立步骤：目标区间写进修正提示词，修正返回文章后由本地函数计字。字数不在 `type.length` 区间内时带原因重试——不足则要求在小节内补实质信息，超出则要求删减重复表述（`--length-attempts`，默认 3 次）；重试耗尽仍不合格则**中断管线**报错退出，不会带着不合格稿件往下走。

## 审稿循环

每轮：**核稿 → 修正 → 评稿 → 判定**，最多 `review.max_rounds`（默认 3）轮。评稿之后由 `scoring.models.check` 判断模型（systemone）决定是否需要再改：`done` 结束循环进入下游，`continue` 带着本轮评分进入下一轮核稿。判定不可用或置信度低于 `min_confidence` 时，回退「综合评分 ≥ `pass_score` 且无 high 级问题即 done」规则。

判定只回答「还要不要再改一轮」，不是出稿质量结论；**是否通过看 `passed` = 最后一轮 `composite_score >= pass_score`**（跑满轮次也是这个口径，`final.stop_reason` 区分 `done` / `max_rounds`）。

- **核稿**：并行调用 `correct-cn` 的两个规则端点——`POST {base_url}/api/correct`（错别字）与 `POST {base_url}/api/sensitive/check`（敏感词），鉴权 `Authorization: Bearer`。`/api/correct` 只取 `errors[]` 并经 `selectCandidates` 过滤（空项、原文与修改相同、仅大小写差异、纯 ASCII 短词、重复项），**不做字面替换**；这些候选可能误报，由修正模型逐条核实后才落笔。敏感词误报率高，只做摘要留痕（`correct.json#sensitive`），不进提示词。候选数与命中数都只记在 `03-step/round-N/correct.json`（`candidates` / `sensitive`），不进 `03-result.json`——result 只留下一步要用的。服务不可用时核稿步骤跳过、直接进入修正。
- **修正**：首轮以核稿候选为依据（提示词标注「可能误报，需逐条核实；专有名词/缩写大小写保持原样」），后续轮叠加上一轮评分意见；提示词内含篇幅区间，返回稿本地计字，不合格带原因重试（见「篇幅控制」）。
- **评稿**：按类型的 `scoring_criteria` 多维度打分；`composite_score` 由脚本按维度权重回算（模型自报的 `total` 只留痕为 `reported_score`，偏差 >5 分日志警告），`verdict` 同样由阈值重判。每条评分带 `scorer`（model/rule/mock）与 `scorer_model`，模型失败时用规则评分兜底（`scorer: "rule"`，不看内容只看篇幅/段落/配图）。
- **判定**：systemone choice 问题（done/continue），两段式（低置信度升级 `options.deep`）；问句文案在 `prompts/review.yaml` 的 `check`（id `review.check`），过程落 `round-<n>/check.json`。

## 发布

- **邮件**：Resend（`PB_RESEND_API_KEY`、`PB_RESEND_FROM`），本地图片以 CID 内联附件嵌入；发件域名必须在 Resend 里 verified（实测 `myehome.cn:verified`）。开关只看 `defaults.publish.email.enabled`（可写成 `${PB_EMAIL_ENABLED:-false}` 由 `.env` 抬起）与命令行 `--email`。
- **公众号草稿**：`npx --yes @wenyan-md/cli publish -f <稿件> --env-file .env`（依赖 `.env` 里的 `WECHAT_MP_APP_ID`/`WECHAT_MP_APP_SECRET`）。`--dry-run` 只打印命令。
  - wenyan CLI 实际读取的变量名是 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`；管线在 spawn 时自动把 `WECHAT_MP_*` 映射过去，两种命名都能用（缺映射时 CLI 报「未提供 AppID」，2026-10-26 实测）。
  - 公众号后台有 **IP 白名单**：本机 IP 不在名单里，取 access_token 就会失败（`40164 invalid ip ... not in whitelist`，本机实测如此），此时草稿箱不会有任何内容。绕过办法是自建 wenyan 的远程发布服务端并在 `defaults.publish.wechat` 配 `server` + `api_key`（代码已支持，密钥在日志与留痕里打码）。

## 环境变量（`.env`）

| 变量 | 用途 |
| --- | --- |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_BASE_MODEL` / `LOCAL_LLM_API_KEY` | 本地大模型（BASE_URL / MODEL_NAME / API_KEY） |
| `LOCAL_LLM_SMALL_MODEL` / `LOCAL_LLM_LARGE_MODEL` | 可选：`llm.small` / `llm.large` 使用的模型名 |
| `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` | WeKnora 远程知识库 |
| `PB_MODEL_IMAGE_API_KEY` | ModelScope 配图主通道（兼容旧名 `PB_MODEL_API_KEY`）；通道地址/模型/节流参数单源在 `defaults.illustrations`，不吃环境变量 |
| `PB_RESEND_API_KEY` / `PB_RESEND_FROM` | 邮件 |
| `PB_PYCORRECTOR_API_URL` / `PB_PYCORRECTOR_API_KEY` | correct-cn 核稿（`Authorization: Bearer` 鉴权） |
| `PB_LLM_BASE_URL` / `PB_LLM_MODEL` / `PB_LLM_API_KEY` | 远程 OpenAI 兼容模型 |
| `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` | 公众号草稿发布 |
| `PB_KNOWLEDGE_BASE_PATH` | 知识库根目录（配置里可用 `${...}` 引用） |
| `KNOWLEDGE_PIPELINE_DIR` | 发布成功后终稿的待入库目录，默认 `D:/knowledge/pipeline` |
| `BASE_OUTPUT_FOLDER` | 文章根目录（下面自动建 `draft/` 与 `published/`，默认 `output/wechat-article`） |
| `PB_ARTICLE_TYPE` | 默认文章类型 id（命令行 `--type` 优先；未设置时交给判断模型） |
| `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL1` / `SYSTEMONE_MODEL2` | 判断模型（System One `/v1/systemone`）：`MODEL1` 一次判断（默认 `tev1`），`MODEL2` 二次判断（默认 `nimble`）；留空 base_url 则回退 `classifier.default_type` |
| `SYSTEMONE_API_KEY` | 判断模型鉴权 key，**可选**：配置了才发送 `Authorization: Bearer`，端点不鉴权时留空 |
| `PB_USE_WEKNORA` | WeKnora 总开关，默认 `false`（只用本地知识库目录） |
| `PB_AUTO_PUBLISH` | `defaults.publish.auto_publish` 的取值来源，默认 `false`（落终稿但不投递）；命令行 `--auto-publish` 优先 |
| `PB_EMAIL_ENABLED` / `PB_WECHAT_ENABLED` | `defaults.publish.email.enabled` / `wechat.enabled` 的取值来源，默认 `false`；命令行 `--email` / `--wechat` 优先 |
| `PB_REVIEW_ROUNDS` | 审稿轮次上限（默认 3，加载期 clamp 到 1-5）；只对这一篇临时改仍用 `--rounds` |
| `PB_PASS_SCORE` | 通过线：一抬就统一四个类型；不设时各类型吃自己的 `${PB_PASS_SCORE:-78\|82}` |
| `PB_KNOWLEDGE_MAX_SOURCES` | 本地素材条数上限（默认 8），同时推导 WeKnora 的 `match_count` 与外部检索的充足性闸门分母 |
| `PB_WEB_SEARCH_ENABLED` | 外部检索开关（默认 `true`）；`false` = 闸门判不足也不出门检索，只用本地素材 |
| `PB_IMAGE_CONCURRENCY` | 配图同时在飞请求数（默认 2）。张数不吃环境变量：由纲要的 `image_plan` 小节规划决定，单次指定用 `--images` |
| `PB_DE_AI_ENABLED` / `PB_DE_AI_LEVEL` | 04 的去 AI 化分支：关档（不产出 `polished.md`，组稿用审稿稿）/ 选档 `light\|standard\|deep`。命令行 `--de-ai-level` 优先；档位名大小写敏感，写 `Light` 会当成未定义档位抛错 |
| `PB_IMAGES_ENABLED` | 04 的配图分支：`false` = 不调任何图片通道，标记按 `illustrations.on_failure` 处理，`04-result.json#images_skipped` 记 `true` |

> 上表后半段的运行时旋钮在 `defaults.yaml` / `steps/*.yaml` / `types/*.yaml` 里一律写成
> `${PB_*:-默认值}`：无人值守跑管线时只改 `.env`，配置文件保持不动。
> `expandEnv` 替换出来是字符串，加载期统一归一——布尔走 `env.mjs#toBool`（steps 节点的 `enabled`
> 也走它，`"false"` 不会被 `!== false` 当成开），数字走 `env.mjs#toNumber`（`PB_REVIEW_ROUNDS=three`
> 这种笔误直接抛错，不静默退回默认值）。代码里不再留与配置同值的兜底默认。
>
> **必填参数在真正读它的那一行抛错，不在加载期统一铺开**：判定口径是 `env.mjs#needConfig`
> （`0` / `false` 算配过，`null` / 空白串算没配）和 `needNumber`，报错点名完整配置路径
> （如 `defaults.yaml defaults.knowledge.web-search.timeout_ms`、`types/ai.yaml 的 topic.fresh_days`）。
> 这样 `defaults.yaml` 缺失时 `loadConfig` 仍能加载，关掉的功能也不必配全——
> 核稿只在 `enabled` 且真有 `base_url` 时才要求端点/鉴权/超时/重试，weknora 只在真发请求时
> 才要求 `auth_header` / `timeout_ms`。
>
> `retry_limit` 只对**声明了 `schema` 的调用**强制（按 `stepCallContract` 的 `schema_id` 判定，
> 不按 `output_format` 非空——纯文本节点的 `output_format` 是形状备注，脚本不校验）。
> `auto` 入口定类前的占位类型也不吃内置默认：`topic` / `knowledge` / `model` 一律继承第一个
> enabled 类型。
>
> **按条件二选一的整句文案全部在 `prompts/*.yaml`**，代码只挑 key（`template.mjs#pickPromptText`，
> 缺 key 抛 `缺少提示词文案 <id>.<key>`）：`topic.select_topic` 的 `audience_line` /
> `mode_line_auto` / `mode_line_manual` / `dedupe_rule_*` / `length_range`，`outline.outline` 的
> `no_materials` / `image_plan_default` / `image_plan_range` / `requirements_block`，
> `revision.revision` 的 `review_basis_*` / `retry_reason_*` / `retry_fix_*`，
> `draft.draft_writing` 的 `no_image_hint` / `section_only` / `requirements_block`。留在代码里的只有空数据占位标记（「（无候选）」「（无历史记录）」）。
> 类型没定（占位类型 `style: {}` / `length: null`）时整行省略，不换默认文案；
> `style.tone` / `audience` / `title_style` 是提示词直接引用的必填项，`validate` 缺项点名类型。
> agent CLI 通道（`provider: opencode`）发给 CLI 的任务句同规则：单源 `config/models.yaml`
> 的 `instruction`（`{prompt_file_name}` 由脚本填），没配就抛错。
>
> 换模型不吃 `PB_*` 新名字，仍用 `models.yaml` 里已有的变量：**写作/修正/评稿/去 AI 化** =
> `LOCAL_LLM_LARGE_MODEL`（`llm.large`，默认 35b）；**一次判断** = `SYSTEMONE_MODEL1`（默认 `tev1`），
> **二次判断** = `SYSTEMONE_MODEL2`（默认 `nimble`）。steps 节点只引用模型 id（`llm.large` /
> `systemone.classifier`），再加一层 `PB_MODEL_*` 别名会让两处都能改同一个模型、互相掩盖。

配置里支持 `${VAR}` 与 `${VAR:-默认值}` 展开。

## 作为 OpenCode agent 运行

- 斜杠命令：`/wechat-article <参数>`（见根目录 `opencode.json` 的 `commands`）。
- 写作代理：`wechat-article-writer`（hidden、subagent），只读附件、禁写禁命令，只返回文本/JSON。管线已改为脚本编排，不再作为模型注册在 models.yaml；可用下面的命令单独调试。
- 直接调用：`opencode run --format json --file <prompt.md> --agent wechat-article-writer --auto "完成附件任务"`（NDJSON 中取 `type=="text"` 的 `part.text` 拼接）。
- 若把它注册成 `models.yaml` 里的 `provider: opencode` profile 用 `--model` 调用：必填 `timeout_ms` 与 `instruction`（那句任务说明，`{prompt_file_name}` 由脚本换成附件名）；代码里没有默认句，缺了就抛 `模型 opencode.x 缺少 instruction`。
- 注意：写作代理**必须保留 `read` 工具**（脚本通过 `--file` 附带提示词），但禁用 shell/edit/subagent 等；若把 `read` 也 deny，OpenCode 免费层会返回 403（FreeTierError）。
- `opencode` 通道比本地模型慢（单次 1-4 分钟），适合作为质量更高的备选，不建议作为默认。

## 排障

- 先跑 `doctor`：会检查 Node 版本、配置文件、各类型知识库目录、判断模型配置、模型可达性、correct-cn / 配图 / 邮件 / 公众号配置。
- 分类结果不符合预期时，用 `classify --title "..." --outline-file <提纲>` 单独调试；再检查类型的 `description` 是否足够区分。
- 知识库索引有 mtime/size 缓存（`.temp/wechat-article/knowledge-index.json`），重复运行很快；改过文件会自动重建。
- 不确定环境是否配全时，先用 `--mock` 跑通流程，再逐步替换为真实模型与服务（mock 模式不会访问网络）。
- correct-cn 不可达时不要卡住：核稿步骤跳过候选采集，直接进入修正。

## 目录结构

```text
penbot/                               # 目录规范见仓库根 AGENTS.md
├── config/
│   ├── models.yaml                   全局模型总表：llm / systemone（端点级默认，非运行时调参入口）
│   └── wechat-article/               本管线配置（五件套）
│       ├── defaults.yaml             全局默认：输出目录 / 判断模型行为 / 文章级默认值
│       ├── article-types.yaml        类型注册表：key = 类型 id，value = types/<id>.yaml
│       ├── steps.yaml                流程入口：默认值 + phases 阶段映射
│       ├── steps/                    按大步骤拆分的节点（10-topic … 50-publish，仅这里带序号）
│       ├── prompts/                  提示词注册表：<命名空间>.yaml，id = 文件名.配置项
│       ├── schemas/                  数据结构注册表：<命名空间>.yaml，id = 文件名.配置项
│       └── types/                    各类型明细（<id>.yaml）+ 字段说明 README.md
├── scripts/
│   ├── wechat-article.mjs            命令行入口（编排全部阶段）
│   ├── lib/                          共享机制：args/env/fsx/log/markdown/models/
│   │                                 config/steps/classify/knowledge/prompts/template/
│   │                                 draft-input/article-store/archive/zip/io-record/
│   │                                 corrector/web-search
│   └── comm/                         公众号专属：wechat-publish.mjs、wechat-illustrate.mjs
├── tests/wechat-article/             分阶段测试（npm test 全量）
└── docs/wechat-article/              USAGE.md + artifacts / topic-selection / materials-collection
```
