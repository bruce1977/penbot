
# 微信公众号文章自动化

这是一个脚本驱动的端到端管线。**机械流程全部由 `scripts/wechat-article.mjs` 完成**，只有在需要判断的地方（选题、纲要、初稿、核稿、修正、评稿/判定、备用校对）才调用模型。不要手工重写脚本已经生成的中间产物。

```
选题 + 收集素材 ──► 纲要 + 初稿 ──► 核稿/修正/评稿/判定(≤3 轮) ──► 配图(1-5) ──► 发布(邮件+公众号草稿)
      │                  │                    │                        │              │
 模型 + 本地目录/WeKnora   模型          correct-cn + 模型            图像 API      Resend/wenyan
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

- 两个入口之后的步骤**完全一致**（初稿 → 审稿 → 配图 → 发布），都支持 `--stage draft` 之类的提前停止。
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
| `illustrate` | 为已有稿件生成并替换配图 |
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
- `--file <path>` `review`/`illustrate`/`publish` 直接指定稿件文件（`--article <path>` 仍兼容）
- `--slug <name>` 新建文章时覆盖目录名（默认取标题 slug）
- `--model <id>` 全局覆盖各节点模型 id（如 `llm.local`、`llm.large`；优先级 `--model` > 节点 `models.<调用名>.id` > `type.model`；遗留参数）
- `--review-model <id>` 覆盖评稿模型 id
- `--rounds <n>` 核稿/修正/评稿/判定循环最大轮次（1-5，默认取配置 `review.max_rounds`）
- `--length-attempts <n>` 修正稿字数校验不过时的重试次数（默认 3，0 表示不重试；重试耗尽仍不合格则**中断流程**）
- `--images <n>` 配图数量（1-5）
- `--stage <name>` `run` 的终止阶段：`topic|draft|review|illustrate|publish`（素材收集属于 `topic` 步，纲要与初稿输入属于 `draft` 步，不再单列阶段）
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
01-result.json                             选题步结果（标题 + 类型 + 择题过程 + sources 链接条目）
01-step/topic.md                           选题的人类可读版
01-step/proposal.json                      自动选题的全部候选 + 热度表（仅自动选题时生成，可用 --from-proposal 复用）
01-step/sources/<n>-<slug>.md              每条素材一份：frontmatter 记 title/origin/source/date/score，正文只放摘录段（不整篇复制）
01-step/web-search/<slug>.md                 外部检索结果（每组关键字一份，本地素材不足时才产生）
02-result.json                             初稿步结果（小节数 + 字数 + 阶段内文件索引）
02-step/outline.json / outline.md          纲要
02-step/draft-input.json                   初稿输入（标题 + 大纲 + 资料）
02-step/draft.md                           初稿
03-result.json                             审稿结果（每轮字数/修正条数/评分/判定 + 是否通过）
03-step/round-N/{after-correct,after-revise}.md + correct.json + score.json + check.json
03-step/reviewed.md                        审稿后的稿件
04-step/polished.md                        去 AI 化后的稿件（de_ai 接入后；编号已预留）
05-result.json                             配图步结果
05-step/images.json / illustrated.md       配图元数据与替换后的稿件
05-step/images/                            生成的图片
06-result.json                             发布结果与状态（含归档信息；去重/归档依赖它）
06-step/final.md                           终稿（发布用）
06-step/final.html                         邮件用 HTML（启用邮件时生成）
logs/pipeline.log                          运行日志（独立命令 review/illustrate/publish 也写这里）
NN-step/llm/M-label(_F).<model>.json       所属步骤 LLM/API 调用的 request+response 留痕（重跑覆盖）
                                            M = 本步骤内实际执行顺序递增编号：
                                            01: topic/select_best/classify_type(_deep)/websearch、
                                            02: outline/draft(-section-N)、03: correct(_F)/revise(-retry-N)/score/check(_F)
```

> 没有 `state.json`：文章身份、类型、进度全部从产物文件推导（文件存在 = 该阶段完成）。每步固定「根目录一个 `NN-result.json` + `NN-step/` 中间文件」；`04` 编号留给尚未接线的去 AI 化（de_ai）。

### 发布成功后的归档

只有 `06-result.json` 的 `status` 为 `published`（至少一个渠道**真实投递成功**）才会归档：

1. 终稿复制到本地知识库的 pipeline 待入库目录（`defaults.publish.archive.knowledge_dir`，即 `KNOWLEDGE_PIPELINE_DIR`；失败只记录，不阻塞）；
2. 整个文章目录打包到 `published/<YYYYMMDD>-<slug>.zip`；
3. 删除 `draft/<slug>/`。

`skipped`（未启用发布 / `auto_publish=false`）、`dry_run`、`partial`、`failed` 都留在 `draft/`，修好后可重跑。归档是幂等的：zip 路径先写进 `06-result.json`，重跑时已存在的 zip 直接复用。

## 流程节点（`config/wechat-article/steps/`）

`config/wechat-article/steps.yaml` 只保留阶段文件顺序（模型、重试、超时的默认值吃 `config/models.yaml`，调用级覆盖在各节点 `models.<调用名>.options`）；节点按大步骤拆到 `config/wechat-article/steps/`。只有步骤文件带 `number-` 前缀，其他配置目录不带：

| 阶段文件 | 节点 |
| --- | --- |
| `10-topic.yaml` | `select_topic` → `classify_type` → `gather_materials` |
| `20-draft.yaml` | `outline` → `bundle_draft_input` → `draft_writing` |
| `30-review.yaml` | `review` → `revision` → `scoring`（含 `check` 判定调用） |
| `40-polish.yaml` | `de_ai` |
| `50-illustrate.yaml` | `image_generation` |
| `60-publish.yaml` | `publish` → `archive` |

每个阶段文件里的节点用 `key → value` 写，key 就是 `step_name`。节点只引用提示词和数据结构 id，不在步骤文件里展开内容：

```yaml
steps:
  select_topic:
    label: 选题
    handler: builtin:select_topic
    models:
      select:
        id: llm.local
        options:
          retry_limit: 2
          timeout: 900000
    prompt: topic.select_topic
    schema: topic.select_topic
```

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

数据结构文件：

```yaml
# config/wechat-article/schemas/topic.yaml
schemas:
  select_topic:
    input:
      type: ArticleType
      candidates: "Array<Candidate>"
    output:
      topic: string
      thesis: string
```

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
| `review` | 核稿（错别字/敏感词） | `builtin:review_article` | `llm.local`（校对接口优先） |
| `revision` | 修正（内置字数校验，不合格带原因重试） | `builtin:revise_article` | `llm.local` |
| `scoring` | 评稿 + 循环去留判定 | `builtin:score_article` | score `llm.local`，check `systemone.classifier` |
| `de_ai` | 去 AI 化 | `builtin:de_ai` | `llm.local` |
| `image_generation` | 配图 | `builtin:generate_images` | `none`（通道见 `defaults.illustrations`） |
| `publish` | 发布 | `builtin:publish_article` | `none`（渠道 API） |
| `archive` | 归档 | `builtin:archive_article` | `none`（本地脚本） |

> `de_ai` 先固定契约（读 `03-step/reviewed.md`，写 `04-step/polished.md`），执行层接入前不会改变现有产物链。

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

运行时优先级：`--model`（遗留）> 节点 `models.<调用名>.id` > `type.model`。
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
- `scoring_criteria`：评分维度数组（`id`/`name`/`weight`/`description`/`criteria`），`pass_score` 为通过线
- `review`：`max_rounds`、`pass_score`、`correct_cn`（核稿服务）
- `image_count`：`1-5`、`3` 或 `{ min, max, default, cover }`
- `image_position_format`：正文配图占位符模板，默认 `[[img:{index}]]`
- `topic`：`keywords`、`exclude_keywords`、`candidate_days`、`fresh_days`、`max_candidates`、`proposals`（旧字段 `lookback_days`、`candidates` 作为回退；机制见 `docs/topic-selection.md`）
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
          escalate_below: 0.65            # 一次置信度低于该值时二次判断
          min_confidence: 0.5             # 最终置信度低于该值时按 default_type 兜底
```

端点参数（`base_url: ${SYSTEMONE_BASE_URL}`、`endpoint: /v1/systemone`、可选
`${SYSTEMONE_API_KEY}`）在 `config/models.yaml` 的 `systemone.classifier` /
`systemone.classifier-deep` 定义，节点只引用模型 id。

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

- 两段式判断：先用一次模型（节点 `models.classify.id`）判一次；置信度低于 `options.escalate_below`（默认 0.65）且配置了 `options.deep` 时，用重模型再判一次并采用其结果；二次判断失败时保留一次结果。`deep` 不写则始终单段。`select_topic.models.best` 用同一套参数在 3 个候选主题中择一；审稿阶段的 `scoring.models.check` 用同一套机制做去留判定（done/continue，见「审稿循环」）。
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
| `llm.local` | ollama | 核稿/修正/评稿等环节默认模型，`LOCAL_LLM_BASE_MODEL`（默认 `qwen3.5:9b`） |
| `llm.small` | ollama | 更小更快的本地模型，默认 `qwen3.5:4b`，暂无节点引用，`--model` 备选 |
| `llm.large` | ollama | 纲要/写作模型（节点 `outline` / `draft_writing`），默认 `qwen3.6:35b`，篇幅遵循更好、更慢 |
| `llm.remote` | openai | 任意 OpenAI 兼容端点（`PB_LLM_BASE_URL` / `PB_LLM_API_KEY`），暂无节点引用，`--model` 备选 |
| `systemone.classifier` | systemone | 自动分类一次判断（轻量），走 `/v1/systemone` |
| `systemone.classifier-deep` | systemone | 一次置信度不足时的二次判断（重模型） |

- `none` 是保留值，表示纯本地脚本，不调模型。
- `--mock` 会跳过真实模型调用，不需要配置 mock 模型。
- 覆盖用法：`--model llm.large --review-model llm.local`。若某次模型调用失败，脚本会按阶段降级（规则纲要 / 分节生成 / 规则评分），不会中断整条管线。

## 配图

- 初稿中用标记占位：`[[img:N|中文说明|English prompt]]`（兼容旧格式 `[图N：说明]`）；类型可用 `image_position_format` 改模板（保留 `{index}`）。
- 纲要阶段按 `image_count` 规划（默认 1-5 张，含封面），`--images N` 可指定数量。
- 优先 ModelScope（`PB_MODEL_IMAGE_API_KEY`），失败回退 Pollinations，并行生成。
- 生成成功后标记被替换为本地图片相对路径；失败按 `illustrations.on_failure`（`comment`/`remove`）处理。

## 篇幅控制

篇幅不再是独立步骤：目标区间写进修正提示词，修正返回文章后由本地函数计字。字数不在 `type.length` 区间内时带原因重试——不足则要求在小节内补实质信息，超出则要求删减重复表述（`--length-attempts`，默认 3 次）；重试耗尽仍不合格则**中断管线**报错退出，不会带着不合格稿件往下走。

## 审稿循环

每轮：**核稿 → 修正 → 评稿 → 判定**，最多 `review.max_rounds`（默认 3）轮。评稿之后由 `scoring.models.check` 判断模型（systemone）决定是否需要再改：`done` 结束循环进入下游，`continue` 带着本轮评分进入下一轮核稿。判定不可用或置信度低于 `min_confidence` 时，回退「总分 ≥ `pass_score` 且无 high 级问题即 done」规则。

- **核稿**：`correct-cn` 的 `POST {base_url}/api/pipeline`（`Authorization: Bearer`），按 `apply: "issues"` 做字面替换；服务不可用时回退到 LLM 校对（长度异常则保留原稿）。
- **修正**：首轮以核稿改动点为依据，后续轮叠加上一轮评分意见；提示词内含篇幅区间，返回稿本地计字，不合格带原因重试（见「篇幅控制」）。
- **评稿**：按类型的 `scoring_criteria` 多维度打分；模型失败时用规则评分兜底。
- **判定**：systemone choice 问题（done/continue），两段式（低置信度升级 `options.deep`）；问句文案在 `prompts/review.yaml` 的 `check`（id `review.check`），过程落 `round-<n>/check.json`。

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

配置里支持 `${VAR}` 与 `${VAR:-默认值}` 展开。

## 作为 OpenCode agent 运行

- 斜杠命令：`/wechat-article <参数>`（见根目录 `opencode.json` 的 `commands`）。
- 写作代理：`wechat-article-writer`（hidden、subagent），只读附件、禁写禁命令，只返回文本/JSON。管线已改为脚本编排，不再作为模型注册在 models.yaml；可用下面的命令单独调试。
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
penbot/                               # 目录规范见仓库根 AGENTS.md
├── config/
│   ├── models.yaml                   全局模型总表：llm / opencode / systemone
│   └── wechat-article/               本管线配置（五件套）
│       ├── defaults.yaml             全局默认：输出目录 / 判断模型行为 / 文章级默认值
│       ├── article-types.yaml        类型注册表：key = 类型 id，value = types/<id>.yaml
│       ├── steps.yaml                流程入口：默认值 + phases 阶段映射
│       ├── steps/                    按大步骤拆分的节点（10-topic … 60-publish，仅这里带序号）
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
