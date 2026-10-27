# 文章目录与阶段产物（v2）

> 目标：每篇文章一个独立目录，每个阶段一个固定产物；中断后看「最后一个产物」就能知道从哪继续。
>
> 流程节点（处理方法 / 模型 / I/O / 重试 / 超时 / 提示词）定义在 [`config/wechat-article/steps/`](../../config/wechat-article/steps/)（入口 [`steps.yaml`](../../config/wechat-article/steps.yaml)）；节点的 `stage` 只是节点分组标签，一个产物阶段可以由多个节点组成（选题步 = `select_topic → classify_type → gather_materials`）。
>
> 节点只引用提示词和数据结构的 id（`<文件名>.<配置项>`，例如 `topic.select_topic`），内容分别在 [`config/wechat-article/prompts/`](../../config/wechat-article/prompts/) 和 [`config/wechat-article/schemas/`](../../config/wechat-article/schemas/)。
> 数据结构注册表只收脚本真跑的校验契约，分两个口：节点的 `schema`（模型输出、02 输入、`04-step/images.json` 这类中间产物）与节点的 `result_schema`（本步 `NN-result.json` 本体）。纯文本判断、本地组装、产出 Markdown 的节点不写 `schema`，形状内联在节点的 `input_format` / `output_format` 里，只当人读备注。

## 1. 目录布局

```text
$BASE_OUTPUT_FOLDER/                 # 环境变量，默认 output/wechat-article
├── draft/                           # 进行中的文章
│   └── <slug>/                      # ← article 目录（文章标题的 slug）
└── published/                       # 已发布文章的归档包
    └── <YYYYMMDD>-<slug>.zip
```

- `BASE_OUTPUT_FOLDER` 只认环境变量/配置，**不能用命令行覆盖**；启动时自动创建 `draft/` 与 `published/`。
- `slug` 由标题生成（保留中文，去掉 `\/:*?"<>|` 等非法字符，最长 64 字）。
- 同名冲突：`<slug>` 已存在时依次尝试 `<slug>-2`、`<slug>-3`；已存在的目录不会被覆盖。
- `draft/` 下只放进行中的文章；文章一旦归档就应从这里消失。
- 选择文章：`--article <slug>`；`--article latest` 选最近一篇；分步命令省略时，只有一篇文章会自动选中，多篇则报错并列出候选。

## 2. article 目录内的产物

```text
<slug>/
├── logs/                   # 文本运行日志（与 NN-step/ 同级）
│   └── pipeline.log        # 运行日志（独立命令 review/compose/publish 也写这里）
├── 01-result.json          # 选题步结果（信封 + 选题字段 + 素材链接条目）
├── 01-step/                # 选题步的中间文件
│   ├── api/                # 本步外部调用留痕（模型 + 非模型 API）：子步骤号_轮次(尝试)-label(_F).<模型|provider>.json，主号=调用在步骤内的固定子步骤号（步骤号由目录名 NN-step 承担）、轮次=该子步骤步骤内第几次逻辑调用（按 label 计数，换模型不重置）、(尝试)=该次调用自己的重试序号（request+response 成对，重跑覆盖；每个 NN-step/ 均有）
│   ├── topic.md            # 选题的人类可读版
│   ├── proposal.json       # 自动选题的全部候选 + 热度表（仅自动选题时生成，可用 --from-proposal 复用）
│   ├── sources/            # 每条素材一份 MD（frontmatter 溯源 + 摘录正文），#sources 的 file 指向这里
│   └── web-search/           # 外部检索结果（每组关键字一个 .md，本地素材不足时才产生）
├── 02-result.json          # 初稿阶段结果（信封 + 小节数/字数/配图规划数；文件路径都在 files 地图里）
├── 02-step/                # 初稿阶段（纲要 → 初稿输入 → 初稿）的中间文件
│   ├── outline.json / outline.md
│   ├── draft-input.json    # 初稿输入（标题 + 大纲 + 资料）
│   └── draft.md            # 初稿
├── 03-result.json          # 审稿阶段结果（信封 + 每轮字数/综合评分/判定 + 是否通过）
├── 03-step/                # 审稿阶段（核稿 → 修正 → 评稿 → 判定，循环）
│   ├── api/                # 1-correct / 2-sensitive（规则接口）、3-revise / 4-score / 5-review_check 的调用留痕
│   ├── round-<n>/
│   │   ├── correct.json
│   │   ├── after-correct.md
│   │   ├── after-revise.md
│   │   ├── score.json
│   │   └── check.json      # 判断模型的去留结果（done/continue，含回退原因）
│   ├── round-<n>-diff.md   # 每轮修正前后的差异摘要
│   └── reviewed.md         # 审稿后的定稿
├── 04-result.json          # 组稿阶段结果（信封 + 去 AI 化状态与闸门判定 + 配图统计）
├── 04-step/                # 组稿阶段（去 AI 化 ∥ 配图，两路并发后组装）
│   ├── polished.md         # 去 AI 化后的稿件（图片标记尚未替换；关档/失败时可能不存在）
│   ├── images.json         # 配图清单（成功/失败、通道、文件）
│   ├── composed.md         # 组稿后的成稿（去 AI 化 + 图片标记替换）
│   └── images/             # 实际图片文件（01_xxx.png…）
├── 05-result.json          # 发布结果（信封 + status + 归档信息）
└── 05-step/
    ├── final.md            # 最终正文（发布用）
    └── final.html          # 邮件版 HTML（email 开启时）
```

> **布局约定**：不使用 `state.json`——文章身份、类型、进度全部从产物文件推导。每个阶段根目录只输出一个 `NN-result.json`（完成标记 + 结构化摘要），中间文件一律收进 `NN-step/` 子目录；`05-result.json` 被去重/归档逻辑依赖，名称固定。组稿阶段的两条分支并发跑，`polished.md` 只代表分支进度，`composed.md` 存在才算 04 完成。

### 2.1 信封：五份 result 的公共骨架

每份 `NN-result.json` 的根上都有同一组四个字段（`scripts/lib/article-store.mjs → buildEnvelope`）：

```jsonc
{
  "stage": "draft",                   // 阶段名，与 --stage 取值同词表
  "generated_at": "2026-10-26T…Z",    // 本步落盘时间（01 的那份 = 文章创建时间）
  "title": "…",                       // 只在 01 产生，之后原样顺延
  "type": "ai-news",                  // 文章类型 id（不是对象），同样只在 01 产生
  "files": {                          // 累积的产物地图，相对文章根目录、"/" 分隔
    "topicMd": "01-step/topic.md",
    "outline": "02-step/outline.json",
    "draft": "02-step/draft.md"
  },
  // —— 以下是本步自己的载荷 ——
}
```

规则（对应「每步只读上一步的 result」这条输入顺序）：

- **`title` / `type` 单源在 01**，02–05 一律从上一份 `NN-result.json` 继承（`PREV_STAGE_RESULT`：draft←topic、review←draft、compose←review、publish←compose）。继承不到才用调用方给的兜底——那只发生在独立命令（`review` / `compose` / `publish`）对着只有散落稿件的目录跑的时候。
- **`files` 是累积的**：每一步把自己新产出的几个键并进去，后面任何一步要读前面的文件，只从地图里取，不猜文件名、不跨步回读。
- **读取端只认地图**（`article-store.mjs → fileFromResult(dir, stage, key)`，取不到返回 `null`）：续跑时复用前一步的 `draft.md` / `reviewed.md` / `composed.md` + `images.json`，以及独立命令 `review` / `compose` 回读 02 的 `outline.json` + `draft-input.json`，都按 `files` 里的路径去读；地图里没有这个键（旧产物、或对着只有散落稿件的目录跑单步命令）才回退到 `ARTIFACT` 常量。产物存在性探测与文章发现仍用常量名，那是「找哪篇文章」不是「跨步读产物」。
- **只留下一步要用的**：过程明细（核稿候选数、敏感词命中、每张配图的通道与提示词、systemone 的 3 选 1 过程）留在 `NN-step/` 里，不进 result。result 里没有 `step`（就是 `stage`）、没有 `slug`（目录名即身份）、没有 `file`/`finalFile` 这类单文件指针（统一进 `files`）。
- **每份 result 落盘前按自己的契约自检**：steps 节点的 `result_schema` 指向 schemas 注册表里的一份**紧凑 DSL**（01 `topic.result` / 02 `draft.result` / 03 `review.result` / 04 `compose.result` / 05 `publish.publish`，归档块另用 `publish.archive`），校验的是「信封 + 本步载荷」的完整形状，不合格只警告不阻塞，结果如实写进同一份 JSON 的 `validation`：`{checked, ok, errors, warnings}`。`checked: false` 表示节点没挂契约（≠ 校验通过）。契约与节点级 `schema` 是两个口：后者校验模型输出或 `04-step/images.json` 这类中间产物，同一节点要校验两份产物就必须各挂一个键；`result_schema` 只在节点级，type 层没有覆盖口。
- `type` 是**字符串 id**，判断模型的 `name/source/confidence/reason` 只存在于分类过程（`ctx.state.classification`），不进产物。

下面的各步示例省略了 `validation` 块（真实文件都有，见上一条），也省略了上游 `files` 键的累积。

`01-result.json` = 信封 + 选题字段（直接铺在根上）+ `sources` 数组。择题过程（`score`、`title_candidates`、`duplicate_of`）不在这里——它们只存在于 `01-step/proposal.json`，下游无人读取：

```jsonc
{
  "stage": "topic", "generated_at": "...", "title": "...", "type": "ai-news",
  "files": { "topicMd": "01-step/topic.md", "proposal": "01-step/proposal.json" },  // 手动选题时 proposal 为 null
  "topic": "...", "thesis": "...", "angle": "...", "rationale": "...",
  "keywords": ["..."], "source_hints": ["..."],
  "sources": [                       // 收集素材的纯链接条目（其余信息都在落地 MD 里）
    { "index": 1, "title": "...", "link": "01-step/sources/1-....md" }  // 相对文章目录
  ]
}
```

> 素材正文与出处（`origin/source/date/score`）只存 `01-step/sources/*.md`：frontmatter
> 溯源 + 摘录段正文（不整篇复制原文）；下游经 `loadSource` 按 `link` 回读（相对路径
> 以文章目录为 `baseDir`），旧格式的内嵌 `excerpts` 仍兼容。

`02-result.json` = 信封 + `{sections, images_planned, words}`（都是本地计数，配图张数优先级要看 `images_planned` 是不是 0）。

`03-result.json` = 信封 + 每轮的闸门要看的几个数 + 最终结论（分数一律用**综合评分**口径，不用模型自报总分）：

```jsonc
{
  "stage": "review", "generated_at": "...", "title": "...", "type": "ai-news",
  "files": { "reviewed": "03-step/reviewed.md" },   // 连同上游 topicMd/outline/draft 一起累积
  "rounds": [{
    "round": 1,
    "word_count": 1583,              // 本轮修正后稿件字数（本地计字）
    "composite_score": 78.5,         // 综合评分 = 脚本按维度权重回算，唯一进闸门的分数
    "scorer": "model",               // model | rule | mock：这个分是谁算出来的
    "scorer_model": "qwen3.6:35b",   // 评分模型身份；换模型 = 换量纲，历史分数不可直接比
    "decision": "continue"           // 判定模型给出的去留（只决定「还要不要再改一轮」）
  }],
  "final": {                         // 同上口径的最后一轮结论
    "composite_score": 84.0, "reported_score": 82,
    "scorer": "model", "scorer_model": "qwen3.6:35b",
    "decision": "done", "stop_reason": "done"        // done=判定提前结束 | max_rounds=跑满轮次
  },
  "passed": false,                   // 最后一轮 composite_score >= pass_score，与 decision 可以不一致
  "pass_score": 82
}
```

> `decision: continue` 只说明判定模型认为还有改进空间，循环跑满轮次也会照样出稿；
> 出稿质量结论看 `passed`（阈值）与 `composite_score`，不看 `decision`。
> `reported_score` 只在 `final` 留痕（与回算差 >5 时日志警告），读取端与判定规则不得再用自报值。
> 每轮的核稿候选数、敏感词命中数、评分明细与差异摘要在 `03-step/round-<n>/` 里，不进 result。

`04-result.json` = 信封 + `polish{}` + 配图三个数（`files` 里新增 `polished`/`images`/`composed`）。

`round-<n>/correct.json` 是核稿环节摘要：`ok`、`skipped`、`errors`（两个端点各自的错误）、
`candidates`（`/api/correct` 过滤后的错别字候选，可能误报，由修正模型逐条核实）、
`sensitive`（`{count, unique, by_category}` 摘要，只留痕）、`timings`（两个端点耗时）。
本轮不做任何字面替换，`after-correct.md` 与输入稿件一致。
接口原始请求/响应在 `03-step/api/`：`1_1-correct.correct-cn.json`、`2_1-sensitive.correct-cn.json`
（子步骤号 1=错别字、2=敏感词、3=修正、4=评稿、5=判定）。`(尝试)` 是该次调用自己的重试序号
（由调用方传入），编号不扫描已有文件名；跨进程重跑从 1 重新开始。审稿阶段重跑时会先清掉旧的
`03-step/api/`、`03-step/round-<n>/`、`03-step/reviewed.md` 和 `03-result.json`，
避免上一次中断运行留下的 `(尝试)` 文件冒充本次留痕。

### 阶段产物与完成判据

| 阶段 | 产物 | 完成判据（续跑依据） | 下一步读什么 |
| --- | --- | --- | --- |
| `topic`（选题 → 定类 → 收集素材） | `01-result.json` + `01-step/topic.md`、`01-step/sources/*.md`（自动选题另存 `01-step/proposal.json`，外部检索另存 `01-step/web-search/*.md`，LLM 调用留痕在 `01-step/api/`） | 文件存在且 `title` 非空、`sources` 为数组 | `01-result.json` |
| `draft`（纲要 → 初稿输入 → 初稿） | `02-result.json` + `02-step/outline.json`/`.md`、`02-step/draft-input.json`、`02-step/draft.md` | `02-result.json` 存在；阶段内中断看 `02-step/` 里的中间文件复用 | `files.draft`（稿件）、`files.outline`（配图规划） |
| `review`（核稿 → 修正 → 评稿 → 判定） | `03-result.json` + `03-step/round-<n>/…`、`03-step/reviewed.md` | `03-result.json` 存在 | `files.reviewed` |
| `compose`（去 AI 化 ∥ 配图） | `04-result.json` + `04-step/polished.md`、`04-step/images.json`、`04-step/composed.md`、`04-step/images/` | `04-step/composed.md` 存在（`polished.md` 只是分支进度，关档/回退时不产出） | `files.composed` |
| `publish` | `05-result.json` + `05-step/final.md`、`final.html` | `05-result.json` 存在 | `05-result.json`（`status`、`files.final`） |
| `archive` | `published/<date>-<slug>.zip` | zip 存在，`draft/<slug>/` 已删除 | `05-result.json` |

规则：

- **文件即状态**：续跑只看上表产物是否存在；没有 `state.json`，文章身份/类型/进度全部从 `01-result.json` 和阶段产物推导。
- **写入要原子**：zip 先写 `<file>.tmp` 再 rename，避免中断后留下半截包。
- **阶段名即 `--stage` 取值**（`--stage topic|draft|review|compose|publish`）；纲要/初稿输入/初稿是同一个 `draft` 阶段的三个节点，不再单独提供停点。收集素材是 `topic` 步的第三个节点（`select_topic → classify_type → gather_materials`）。
- `compose`（04）阶段内 `de_ai` 与 `image_generation` 两条分支并发执行，都结束后组装成稿；产物链 `03-step/reviewed.md` →（润色 + 配图）→ `04-step/composed.md`。去 AI 化失败退回审稿稿，配图失败按 `illustrations.on_failure` 处理，两条分支都不阻塞流程。**两条分支各由节点 `enabled` 开关控制**，关掉的那条不调用、不产出中间文件：`04-result.json` 对应记 `polish.skipped` / `images_skipped`。`polished.md` **只在真出润色稿时落盘**——关档和调用失败回退都不写（回退时内容就是审稿稿，改名复制等于造假），两种情况 `04-result.json#files.polished` 都记 `null`。`images_planned` 记的是纲要/类型算出来的**规划张数**，与配图分支开没开无关（关时 `images` 为空数组、`images_success: 0`）。
- 配图侧的三个配置点都真驱动运行：`image_generation.prompt`（`prompts/revision.yaml → image_generation`）是发给图片模型的 prompt **模板**，变量 `{{subject}}/{{style}}/{{negative}}/{{composition}}` 由脚本填，模板缺失直接抛错（`--mock` 也走同一模板，占位图的 `prompt` 与真实同形状）；`illustrations.scenes` 只有两种尺寸（`wechat-cover` 900×383 封面、`article-inline` 1080×810 正文，第 1 张固定封面），`width/height` 进请求参数、`composition` 进模板；`image_generation.schema`（`schemas/revision.yaml → image_generation.output`）在落 `04-step/images.json` 前校验一次，不合格只警告，结果记 `04-result.json#images_validation`（`checked/ok/errors/warnings`，`checked: false` 表示没配 schema、如实说明未校验）。
- `04-step/images.json` 每张图一条：`{index, position, scene, description, prompt, success, pipeline, file, attempts[]}`（失败条目同样带 `description`，只有 `file` 缺席并改记 `error`）。`file` 与 `01-result.json#sources[].link` 同规矩：**相对文章根目录、`/` 分隔**（如 `04-step/images/01_modelscope.png`），不写机器绝对路径，打包归档后仍可读。降级到兜底通道的那次调用留痕带 `_F`（`04-step/api/2_1-illustrate.modelscope.json` 失败 + `2_1-illustrate_F.pollinations.json` 成功）。
- 去 AI 化的**改写强度按档**（`de_ai.handler_options.level`，可选 `--de-ai-level`；节点当前默认 `light`——功能打开、先用最低档跑，效果后续再抬）：`light`（只换词，重叠上限 0.85、一轮出稿）/ `standard`（改到句子，0.5）/ `deep`（整篇重述，0.35、温度 0.9），每档的提示词 id、阈值与采样参数分别单源在 `handler_options.levels.<档>` 和 `models.de_ai.levels.<档>.options`；节点 `enabled: false` 时整条分支跳过（不产出 `polished.md`，`polish.skipped: true`）。质量判定是**本地零 token 三判据**（本档 `max_verbatim_overlap` 定重叠上限）：与原稿 20 字窗口逐字重叠 ≤ 上限、字数在 `type.length` 区间、原稿数字一个不丢。不合格换一次采样重调，总尝试上限 = 本档的 `retry_limit`（含首轮）；耗尽后取最接近合格的一版继续（先比违规条数，再比离各阈值的距离），`04-result.json#polish` 记 `level`，`polish.gate` 记 `passed: false`、`attempts_used/attempts_allowed` 与具体违规（`picked_attempt` 指出成品来自第几次调用，对应 `04-step/api/` 里 `1_1`、`1_1(2)`… 那份 de_ai 留痕）。只标记，不阻塞流程。
- 字数校验内置在修正环节（`30-review.yaml` 的 `revision`）：修正可能增删内容，返回稿由本地函数计字，不在区间就带原因重试（`--length-attempts` 默认 3 次），耗尽仍不合格中断流程；不再有独立的 `length_adjust` 节点。

## 3. 续跑规则

再次对同一个 article 目录执行 `auto` / `run` / `manual`（带 `--article <slug>`）时：

```text
有 05-result.json 且 status=published → archive（幂等，见 4.2）
否则有 05-result.json / 05-step/final.md / 04-step/composed.md → publish
否则有 03-result.json                 → compose
否则有 02-result.json                 → review
否则有 02-step/ 内任一中间文件或 01-result.json → draft（阶段内按文件复用已完成的节点）
否则                                   → topic
```

- 单步命令（`draft` / `review` / …）总是执行自己那一步：前置产物存在就复用，缺了才补跑。
- `publish` / `review` / `compose` 不给 `--article` 时，默认取最新/唯一的文章目录，并按阶段挑稿件文件。

## 4. 发布与归档

### 4.1 发布成功判定

`05-result.json` 的 `status`：

| 取值 | 含义 | 是否归档 |
| --- | --- | --- |
| `published` | 所有启用的渠道都真实投递成功 | ✅ |
| `partial` | 部分渠道成功（如邮件成功、公众号失败） | ❌（等待重试或人工决定） |
| `skipped` | email/wechat 未启用，或 `handler_options.auto_publish=false` | ❌ |
| `dry_run` | 演练（含渠道级 `dry_run`） | ❌ |
| `failed` | 渠道全部失败 | ❌ |

**只有 `published` 才触发归档删除**；其余状态文章留在 `draft/`，可以修好后重跑。

`05-result.json` 的形状（契约 id `publish.publish`，由 `publish` 节点的 `result_schema` 挂上——与 01–04 同一个键；落盘前用紧凑 DSL 校验一次，不合格只警告，结果记在同一个文件的 `validation`：`{checked, ok, errors, warnings}`）：

```jsonc
{
  "stage": "publish", "generated_at": "…",
  "title": "…", "type": "ai-news",                    // 从 04-result.json 顺延
  "files": { "final": "05-step/final.md", "html": "05-step/final.html" },  // 相对文章根目录，与 sources[].link、images.json#file 同规矩；html 只在邮件渠道启用时有
  "status": "published | partial | failed | skipped | dry_run",
  "channels": { "email": true, "wechat": false },   // 布尔开关表：本次有哪些渠道参与
  "email":  { "success": true, "to": ["…"], "id": "…" },   // 未启用的渠道记 null
  "wechat": { "success": false, "code": 1, "output": "…" },
  "reason": "…",                              // 仅 skipped
  "validation": { "checked": true, "ok": true, "errors": [], "warnings": [] }
}
```

- 投递开关（`auto_publish` / `email` / `wechat`）单源在 `steps/50-publish.yaml` 的 `publish.handler_options`（默认全 `true`，auto 模式一路发布到归档；`--email/--wechat/--auto-publish` 临时覆盖）；`steps` 节点 `publish.enabled: false` 是**整个环节的开关**，关掉时连 `05-step/final.md` 都不落、`05-result.json` 也不写，04 的 `composed.md` 保持为最终稿。
- 两个渠道都是外部调用，都进 `05-step/api/` 留痕：`1_1-email.resend.json`（邮件）、`2_1-publish.wenyan-md.json`（公众号 CLI，`API_SLOT.publish`）。CLI 的 `--api-key` 参数与输出里回显的密钥一律打码成 `***`，日志与留痕都不落原文。演练（`--dry-run`）不发生真实调用，因此**不产生留痕**。
- `05-step/final.md` 的图片引用基准是 **`05-step/` 自己**（正文写成 `../04-step/images/01_x.png`），与 `04-step/composed.md`（基准=文章根目录）差一层；落盘时由 `relocateLocalImages` 改写，缺失或远程的图片原样保留。`final.html` 用同一套串，邮件发送时按这个串替换成 `cid:`。wenyan CLI 按稿件文件所在目录解析相对路径，所以这一步不做就传不上图。
- wenyan CLI 读的是 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`；管线配的 `WECHAT_MP_APP_ID`/`WECHAT_MP_APP_SECRET` 在 spawn 时自动映射（`wechatChildEnv`）。公众号正文一张图都没有时 CLI 会报「你必须指定一张封面图或者在正文中至少出现一张图片」——配图环节关掉或全部失败时，公众号渠道必然失败，邮件不受影响。

### 4.2 归档序列（幂等）

发布成功后，按顺序执行（`steps` 节点 `archive.enabled: false` 时**整段跳过**：不入库、不打包、不删除，产物留在 `draft/`——这是归档的唯一整体开关）：

1. 把最终稿复制到知识库归档目录（目录配置见 4.3）；失败只记录，不阻塞。
2. 把 zip 路径与知识库结果写进 `05-result.json`（这份清单因此会进入 zip）。
3. 打包整个 article 目录 → `published/<YYYYMMDD>-<slug>.zip`。
4. 删除 `draft/<slug>/`。

归档结果记在 `05-result.json#archive`（契约 id `publish.archive`，由 `archive` 节点的 `result_schema` 挂；校验对象是 `#archive` 这一块，结果记 `archive.validation`）：`{ zip（相对项目根目录）, knowledge: { ok, skipped? , file?（知识库绝对路径，在工程外不相对化）| error? }, validation }`。`knowledge_dir` 留空时 `knowledge` 记 `{ok: true, skipped: true}`，不是缺键。

幂等依据：

- zip 路径在打包前就写进 `05-result.json`；重跑时该文件已存在 → 跳过打包，直接删目录。
- 知识库目标是固定文件名，重复复制会覆盖，不会产生副本。
- 打包走 `<zip>.tmp` → rename，不会留下半截 zip。

> 崩溃恢复：`05-result.json` 里的 `archive.zip` 是第一执行标记，zip 文件是第二执行标记；两者都在时只需删目录。

### 4.3 知识库归档（统一落到 pipeline 待入库目录）

```yaml
# defaults.yaml → defaults.publish.archive
publish:
  archive:
    knowledge_dir: "${KNOWLEDGE_PIPELINE_DIR:-D:/knowledge/pipeline}"  # 留空 = 不入库
    filename: "{date}-{slug}.md"
```

- 所有类型统一落到本地知识库的 `pipeline/` 目录，由后续入库脚本扫描处理；类型文件不单独配置归档目录。
- 写入时基于 `05-step/final.md` 补一层 frontmatter（`title` / `type` / `published_at`），供入库脚本消费。图片引用保持 `../04-step/…`（在知识库目录里指不到文件，图在 zip 里）；知识库只吃正文文本。
- `knowledge_dir` 为空就跳过入库，不影响打包与删除——**这一步失败也不阻塞归档**（记到 `archive.knowledge.error`）。
- 这里没有 `enabled` 开关：整段归档（入库 + 打包 + 清理）的开关只有一个，就是 `steps` 节点的 `archive.enabled`。

## 5. 已确认

1. 发布成功口径：只有真实投递成功（`published`）才归档删除；`skipped` 不归档。
2. 归档形式：`published/<YYYYMMDD>-<slug>.zip`。
3. 编号重排：01–05 与阶段一一对应，每阶段 `NN-result.json` + `NN-step/`（04 = 组稿：去 AI 化与配图两路并发后组装）。
4. 输出根目录：只认 `BASE_OUTPUT_FOLDER`（环境变量/配置），取消 `--output`；用 `--article <slug>` 选择文章。
5. 知识库归档目录：统一用 `defaults.publish.archive.knowledge_dir`（`KNOWLEDGE_PIPELINE_DIR`），等于本地知识库的 `pipeline/` 待入库目录；留空则跳过。
