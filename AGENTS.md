# penbot — 项目规范

脚本驱动的写作管线集合。三条管线各自独立：

1. `wechat-article` 微信公众号文章流水线
2. `micro-news` 微新闻文章流水线
3. `web-novel` 网络小说篇章连续流水线

编排一律由 Node 脚本完成，**不使用 agent/skill 编排**（不稳定且 token 开销大）。
opencode 只作为工具节点（如 websearch）被脚本调用，不作为编排器。

### 编排的失败处理策略（两层，不做自我修复）

脚本编排没有 agent 的自愈能力，失败只按两层处理，**不引入运行时自动改提示词**：

1. **单次大模型返回不符合预期** → 换措辞/补约束后**改提示词重试**（已有的带失败原因的
   修复重试、de_ai 换采样重调都属这一层）。修的是这次的返回，落地仍要人工把改好的
   提示词写回 `prompts/*.yaml`（代码不留副本）。
2. **某步最终结果缺少必要输出物**（产物缺失、字段拿不到、下游读不到上一步的东西）→
   **中断流程 + 记录日志**，不静默用兜底值继续往下跑，也不让后续步骤去猜。

> 「每步 result 加资源核对闸门」属于第 2 层的工程化（当前只记录未实现，见任务 #106）。
> 只有 04 的两条分支（`de_ai`/配图）是明确例外：它们失败**只降级**、不中断，汇总进
> `04-result.json`——那是设计好的降级，不是漏掉的闸门。

### 无人值守编排器（`scripts/wechat-article-pipeline.mjs`）

默认**一次性跑完即退**（`npm run pipeline`）：摄取 `BASE_INBOX_FOLDER/wechat-article/*.md`，把 inbox 素材经
判断模型分成「标题素材 / 草稿素材」路由到 `manual` / `post` 入口（进入流转即删原稿）；再巡检
`draft/` 按产物（`detectStartStage`）接力 `auto --article <slug> --stage <阶段>` 推进，每阶段
子进程带自己的超时（`defaults.yaml` `pipeline.stage_timeouts`），超时 kill 后下次调度按产物续跑。

- **默认交给系统定时任务按 job 调度**（cron / Windows 任务计划），不常驻：一轮处理完
  「inbox 快照 + 一轮 draft 巡检」即返回；失败 / 无进展时**退出码 = 1**，调度器可据此告警，
  无事可做退出码 = 0。要常驻监听需显式 `npm run pipeline:watch`（`--watch` / `PB_PIPELINE_WATCH=true`）。
- **巡检状态落盘** `<BASE_OUTPUT_FOLDER>/.pipeline-state.json`（失败 / 无进展 / 已跳过计数）：
  定时任务每次都是新进程，内存 Map 会归零——不落盘的话 `pipeline.max_fails` 形同虚设，
  一篇永远修不好的草稿会被每个周期无限重试、每次还退出码 1。已归档文章的陈旧条目在加载时清理。
- **SIGINT / SIGTERM 先按进程树杀掉正在跑的子进程再退出**：Windows 上父进程退出不会回收子进程，
  否则会留下 `wechat-article.mjs` 及其拉起的 `opencode serve` 孤儿（曾误以为"watch 进程退不干净"）。

- **它是独立入口，不 import 主入口**：lint 规则只允许 comm 模块被主入口引用，编排器另起文件
  只能 spawn `wechat-article.mjs`；子进程也天然给出「超时 kill」的边界。
- **阈值/开关单源 `defaults.yaml` 的 `pipeline` 段**（`${PB_*}` 旋钮），消费点 `needNumber` 抛错
  点名配置路径；单次子进程失败只记一次、下轮按产物续跑，同一篇连续失败/无进展达 `pipeline.max_fails`
  才标记跳过并记日志——与「编排的失败处理策略」两层一致，不自我修复提示词。
- **inbox 根目录只认 `BASE_INBOX_FOLDER`**（留空 = 关闭 inbox，仅做 draft 巡检），不是 `${PB_*}` 旋钮。
- **素材分类文案单源 `defaults.yaml` 的 `pipeline.classify`**（`state` / `instructions` / `criteria`）：
  编排器不是流程节点，提示词挂到 `prompts/` 会撞「必须被节点引用」的孤儿检查，故与 `classifier`
  的行为参数一样落 `defaults.yaml`；判断能力复用 `lib/classify.mjs#classifyChoice`（通用单选，
  文案由调用方从配置读出传入、代码不留副本），端点不可用回退本地规则（成篇正文判草稿素材），不阻塞。

## 目录规范（目标结构）

```
penbot/
├── config/
│   ├── models.yaml                  # 全局唯一模型表（端点/密钥引用），三管线共享
│   └── <feature>/                   # wechat-article | micro-news | web-novel
│       ├── defaults.yaml
│       ├── steps.yaml + steps/      # 流程节点：models 调用注册表 + 元数据（enabled/handler_options 等）
│       ├── prompts/                 # 提示词注册表，id = <文件>.<key>（含输出结构说明）
│       ├── schemas/                 # 输出校验契约（description 只给人看，不进提示词）
│       └── types/                   # 文章类型配置（公众号专用）
├── scripts/
│   ├── lib/                         # 共享机制模块，无功能前缀
│   ├── comm/                        # 功能专属模块，文件名以功能前缀开头
│   ├── lint/penbot-rules.mjs        # 自定义 ESLint 规则（本仓库不变量，不发包）
│   ├── wechat-article.mjs           # 入口 ×3，一管线一文件
│   ├── wechat-article-pipeline.mjs  # 编排器：inbox 监听 + draft 巡检（默认一次性，--watch 才常驻；spawn 主入口）
│   ├── micro-news.mjs
│   └── web-novel.mjs
├── tests/<feature>/*.test.mjs       # 含 lint.test.mjs：规则能报 + L1 分层/命名对真实目录断言
├── eslint.config.mjs                # L1/L2/L3 分层规则（L4 流程契约不 lint，见「JS/mjs 代码规范」）
├── docs/<feature>/                  # USAGE.md + NN_<stage>_step.md（分步文档）+ 设计文档
└── output/<feature>/                # 运行产物（draft/published）
```

> 迁移状态（2026-10-21）：wechat-article 已完成迁移，仓库即上述结构；
> `micro-news`、`web-novel` 的配置与入口目录待建。

### lib / comm 依赖规则

- `lib/` = 跨管线共享机制：config/steps 加载、模板渲染（template.mjs）、
  LLM client 与请求日志、knowledge/web-search 节点、article-store、env。
- `comm/` = 单功能拆出的专属模块（如 wechat-publish、wechat-illustrate）。
  文件名以功能前缀命名，kebab-case：`wechat-publish.mjs`。
- 依赖方向只允许 **comm → lib**，禁止 lib import comm。
- comm 模块只允许被其所属管线的入口引用；被第二条管线用到时
  必须去前缀升级进 lib。

## 配置与提示词

- 所有提示词文本放 `config/<feature>/prompts/*.yaml`，动态部分用
  `{{placeholder}}` 表示，变量由代码提供；代码里不保留提示词副本。
- **提示词全文（包括给模型看的输出 JSON 结构说明）只维护在 prompts/*.yaml**。
  `schemas/*.yaml` 的 output DSL 只做脚本校验，尾项字符串是给人看的备注——
  **禁止把 schema 内容渲染进提示词**（配置各管各的，不互为提示词来源）；
  改输出形状时 prompts（模型看到的）与 schemas（脚本校验的）两处同步改。
- 模型只在 `config/models.yaml` 定义（当前两类：llm / systemone），
  steps 与 types 只引用模型 id。models.yaml 是**端点级默认配置**
  （base_url / timeout_ms / temperature 等），不是运行时调参入口。
- YAML 块标量会去掉公共缩进：多行变量替换后行首可能顶格、空行带尾随空格，
  渲染代码需 `.replace(/[ \t]+$/gm, "")` 清理。
- 跨提示词文件引用 sibling key **不生效**，需要的结构直接内联进提示词块。

### 可变配置单源 `.env`（defaults / steps / types）

- **运行时能翻转的开关与阈值一律写成 `${PB_*:-默认值}`**，无人值守跑管线时只改 `.env`，
  配置文件保持不动。当前清单：`PB_REVIEW_ROUNDS`、`PB_PASS_SCORE`、
  `PB_KNOWLEDGE_MAX_SOURCES`、`PB_WEB_SEARCH_ENABLED`、`PB_IMAGE_CONCURRENCY`、
  `PB_DE_AI_ENABLED` / `PB_DE_AI_LEVEL` / `PB_IMAGES_ENABLED`、编排器
  （`PB_PIPELINE_WATCH` / `PB_PIPELINE_POLL_MS` / `PB_PIPELINE_INSPECT_MS`（后两个仅 `--watch` 常驻时生效）/
  `PB_PIPELINE_MAX_FAILS` / `PB_PIPELINE_CLASSIFY` / 五个 `PB_TIMEOUT_*_MS`）。inbox 根目录只认 `BASE_INBOX_FOLDER`
  （留空 = 关闭 inbox，仅做 draft 巡检），不是 `${PB_*}` 旋钮。
  **投递开关是例外**：`auto_publish` / `email` / `wechat` 是步骤节点的 `handler_options`
  （`steps/50-publish.yaml`），不是环境变量——auto 模式默认一路发布到底，改开关改配置。
  **类型身份留在类型文件里当裸值**：字数区间、评分维度与权重、`image_count` 区间、风格与
  提示词 extra——它们不是运行时旋钮（张数由纲要 `image_plan` 规划，单次指定走 `--images`）。
- **同一件事只有一个环境变量口**：换模型用 `models.yaml` 已有的
  `LOCAL_LLM_LARGE_MODEL`（写作/修正/评稿/去 AI 化）与 `SYSTEMONE_MODEL1/2`（一次/二次判断），
  **禁止再加 `PB_MODEL_*` 别名**——两处都能改同一个模型会互相掩盖。
- **`expandEnv` 替换出来的是字符串，加载期必须归一**：布尔走 `env.mjs#toBool`
  （steps 节点与 type 层的 `enabled` 也走它，`!== false` 会把 `"false"` 当成开），
  数字走 `env.mjs#toNumber`（写了但不是数字**抛错**，不静默退回默认值）。
- **读取端不留与配置同值的兜底默认**（`|| 8`、`?? 80`、`|| 2` 这类）：那是允许配置说谎，
  改了 `.env` 也看不出来。只有三类例外：语义安全下限（配图并发至少 1 个 worker，
  0 个 worker 会让队列永远跑不完）、lib API 的部分入参默认（`web-search.gate` 按约定允许
  只写个别阈值，缺的判据吃 `assessSourceSufficiency` 里的默认；`classify.mjs` 的三个
  `build*Body` / `normalizeClassifyResult` 的 `question` 签名默认同属这一类——管线里
  问题名一律由调用方从 `defaults.yaml classifier.*` 传入），以及指向**另一份配置**的继承
  （`systemone` 二次判断的 `base_url / api_key` 缺省时沿用一次判断的，不是硬编码字面量）。
- **端点级必填参数缺失 = 抛错并点名配置路径**，不吃代码里的默认值：`config/models.yaml`
  的 `base_url / model / timeout_ms / temperature / num_ctx / max_tokens / stream_idle_ms`
  由 `models.mjs#needProfile` 逐项要求（`stream_idle_ms` 已从代码副本搬进 models.yaml），
  调用方必须点名模型 id（不再兜 `llm.local`）；`defaults.yaml illustrations.<通道>` 的
  地址/模型/超时/轮询/节流参数由 `wechat-illustrate.mjs#need` 要求，尺寸只在
  `illustrations.scenes` 定义（`DEFAULT_SCENES` 副本已删）；判断模型的
  `model / endpoint / timeout_ms / max_retries` 由入口 `systemOneCallConfig` +
  `classify.mjs#needEndpointParam` 要求（错误信息带上 `systemone.<id>`），
  `base_url` 留空仍按「判断模型不可用」降级（这是设计好的回退，不是兜底值）。
  历史教训：代码副本曾与配置**取值不同**（配图 `timeout_ms` 90000 vs 120000、
  `max_polls` 18 vs 24；判断 `timeout_ms` 15000 vs 60000），改配置不生效就是这么来的；
  判断代码还写过配置里根本不存在的模型名 `jev-latest`，它会被当成真实模型落进 `api/` 留痕。
- **置信度闸门没有代码默认**：`escalate_below / min_confidence` 只来自 steps 节点
  `models.<调用名>.options`（`classify.mjs#needGateParam`）。要用闸门就必须写出来；
  **不想要闸门就显式写 `0`**（0-1 由 steps 加载期校验），代码不替配置决定"有没有阈值"。
  节点没配 `deep`（不会升级）时不要求 `escalate_below`——强制写一个没人读的阈值同样是说谎。
- **必填参数的判定口径统一在 `env.mjs`**：`needConfig(值, 配置路径)`（`0` / `false` 是合法配置，
  `null` / `undefined` / 空白串才算没配 → 抛错点名配置路径）与 `needNumber` = `toNumber(needConfig(...))`；
  各模块的同义实现（`models.mjs#needProfile`、`classify.mjs#needEndpointParam`/`needGateParam`、
  `corrector.mjs#where`、`wechat-illustrate.mjs#need`）都按这条口径走，报错里带完整配置路径。
- **抛错落在消费点，不在 `normalizeType`**：这样两条契约不被破坏——① `defaults.yaml` 缺失时
  `loadConfig` 仍能加载（缺的东西只在真被读到时报错）；② **关掉的功能不必配全**（核稿只在
  `enabled` 且真有 `base_url` 时才要求端点/鉴权/超时/重试；weknora 只在真发请求时才要求
  `auth_header`/`timeout_ms`）。
- **`retry_limit` 只对声明了 `schema` 的调用强制**：判定用 `stepCallContract` 返回的 `schema_id`
  （节点或调用声明的注册表 id），**不是** `output_format` 非空——纯文本节点的 `output_format` 是
  形状备注（脚本不校验），按非空判会逼它们配一个没人读的值。
- **类型层的单值只有一条解析链**：`pass_score` = `type.pass_score` > `defaults.review.pass_score` >
  `type.scoring.pass_score`（`scoring.pass_score` 是纯别名，加载期回写，显示与闸门不会各读一份）；
  `word_limit` 必填，缺失或解析不出区间都在加载期抛错，代码里不垫 800-2000。
- **`auto` 入口的占位类型不吃内置默认**：`topic` / `knowledge` / `model` 一律继承第一个
  enabled 类型（`types[0]`），因为代码里已经没有第二套窗口/模型默认值可兜——占位类型自己写
  `topic: {}` 会在选题阶段抛错，等于文档承诺了代码没有的兜底。

### 步骤节点配置统一标准（steps/steps/*.yaml）

- **模型调用**：节点用 `models: { <调用名>: { id: <模型 id>, prompt / schema, options: {…} } }`
  声明该步骤的每一次真实模型调用（一个节点可多次、跨模板调用）。模板由模型
  id 前缀选择：`llm.*` 的 options 只允许 `retry_limit / timeout / temperature /
  max_tokens`；`systemone.*` 只允许 `deep / escalate_below / min_confidence`。
  options 未配置的参数吃 models.yaml 端点默认；写了就覆盖。加载期对不合规写法
  （未知调用名/模板外参数/未定义模型 id/非法取值）直接抛错。
- **提示词/数据结构的落点**：单调用节点与无模型调用节点写在**节点级**
  `prompt: <id>` / `schema: <id>`；多调用节点（select_topic、scoring）逐调用写
  `models.<调用名>.prompt`（需要校验的再写 `.schema`），节点级写了 `prompt`/`schema`
  是加载期错误——节点级标量会被第二个调用误继承，判定调用会拿到写作调用的文案并
  静默降级。运行期一律经 `stepCallContract(节点, 调用名)` 取提示词块与校验 DSL，
  **代码里禁止写死 prompt/schema id**；type 层 `steps.<step>.prompt/schema` 只覆盖
  节点级值（调用级声明与 type 层无关，同"模型调用不在 type 层覆盖"）。
- **代码不留提示词副本**：写作模板（prompts.mjs）与判断请求文案（classify.mjs 的
  state / instructions / 选项文案）都只能来自上述配置；缺字段直接抛错并在报错里
  点名 prompt id，不静默退回代码默认——静默兜底等于允许配置说谎。报错定位用的
  id 也由调用方从配置传入（`promptId`），代码里不写死。
  **按条件二选一的整句文案**（首轮/后续轮的修改依据、有无历史文章时的查重规则、
  重试说明）也一样：每种说法在 prompts 块里各占一个具名 key，代码只按条件挑 key，
  缺 key 抛错（`template.mjs#pickPromptText`，报错点名 `<id>.<key>`）。
  允许留在代码的只有空数据的占位标记（如「（无候选）」「（无具体问题…）」）。
  agent CLI 通道（provider: opencode）发给 CLI 的那句任务说明同规则：单源
  `config/models.yaml` 的 `instruction`（`{prompt_file_name}` 由脚本填附件名），
  缺了由 `needProfile` 抛错，代码不铺副本。
  类型没定（auto 占位类型 `style: {}` / `length: null`）时**整行省略**，不许换成
  代码里的「通用」文案；`type.style.tone / audience / title_style` 是提示词直接引用的
  必填项，`validate` 缺项点名类型，去 AI 化的目标风格/读者在消费点 `needConfig` 抛错。
- **按轮次覆盖**：调用项可加 `rounds: { <轮次>: { id?, options? } }`（轮次从 1 起），
  用于同一节点在不同轮次换模型/参数。只覆盖写出的字段：`id` 缺省继承默认模型，
  `options` 按键合并；覆盖项沿用与默认调用相同的模板白名单，模型 id 必须同模板。
  只有运行时会传入轮次的调用（wechat-article 的 revision / scoring）使用它。
- **按档位覆盖**：调用项可加 `levels: { <档位名>: { id?, options? } }`（档位名是
  小写标识符），与 `rounds` 同构，用于同一调用在不同强度下换模型/参数。档位的
  **选择项与提示词**放在节点的 `handler_options.level` + `handler_options.levels.<档>.prompt`
  （单源），采样参数放在 `models.<调用名>.levels.<档>.options`；档位没定义 = 配置说谎，
  运行时直接抛错，不静默退回默认档。只有传档位的调用（wechat-article 的 de_ai）使用它。
- **运行时优先级**：`--model`（遗留，待测试脚本环节移除）> `rounds.<轮次>.id` >
  `levels.<档位>.id` > 节点 `models.<调用名>.id` > `type.model`。代码不得绕过节点调用配置。
  （轮次与档位同时命中时轮次后应用：它更贴近本次运行的真实上下文。）
- **`rounds` / `levels` 只允许 llm 调用**：判断调用（systemone）按标签逐次发起，
  运行时既不传轮次也不传档位，写了是加载期硬错误（配置写了没人读 = 说谎）。
- **`retry_limit`**：结构化输出调用的**总尝试上限（含首轮）**，1 = 不做修复重试；
  代码里传给 `jsonValidated` 的 `attempts`，不再叫"重试次数"。
- **`timeout`**（ms）：本调用总限时，**覆盖** models.yaml profile 的
  `timeout_ms`（后者只是默认值）。不同提示词/模型响应时长不一，调用级更灵活。
- **扁平字段已废弃**：节点上的 `model / retry_limit / timeout` 与 steps.yaml
  `defaults.model / retry_limit / timeout` 都是加载期硬错误。
- **无模型调用的节点**（纯本地组装、external handler 等）不写 `models`；
  web-search 不是模型调用（opencode 工具节点自带模型），检索模型单源在
  defaults.yaml `defaults.knowledge.web-search.model`，闸门/超时同段。
  判断模型（systemone）端点默认在 models.yaml `systemone.*`，行为参数
  （deep/escalate_below/min_confidence）在各调用节点；defaults.classifier 只留
  行为开关（enabled/question/topic_question/default_type）。
- 节点 `modes / stage / handler / depends_on / artifacts` 是 steps 注册表
  **元数据**（validate、文档、独立命令展示用），管线实际执行由入口代码手写调度，
  这些字段不作为运行时开关。产物路径的单源是入口 `ARTIFACT` 表。
  例外：`enabled` 必须真的驱动运行——04 两条分支各用一个：`de_ai.enabled` 关闭去 AI 化
  （跳过润色、不产出 `polished.md`，组稿直接用审稿稿），`image_generation.enabled` 关闭配图
  （不调任何通道、`04-result.json#images_skipped` 记 true，标记按 `on_failure` 处理）。
- **元数据词汇表由入口校验**（lib 不写死某条管线的词表）：`validateSteps(steps, { stages, skippable })`
  - `stages` = `--stage`/分步命令的名字（wechat-article：`topic|draft|review|compose|publish`）。
    节点 `stage` 必须是其中之一，含义是"属于哪一次停止边界"；10 的三个节点都属 `topic`，
    归档属 `publish`（05 步内的另一分支）。
  - `skippable` = 入口支持"关掉即跳过"的节点（wechat-article：`de_ai / image_generation / publish / archive`）。
    **只有这些节点可以写 `enabled`**（节点级与 type 层覆盖都算）；其它节点写了是硬错误——
    关掉流程就走不下去，留着 `enabled: true` 只会让人以为能关。
  - 配置文件的 `version` 字段与 `defaults.knowledge.lookback_days` 属无人读取的死配置，已删除
    （本地检索本来就不做日期过滤，时效由充足性闸门 `gate.fresh_days` 单独负责）。
- **`schema` 指针 = 脚本真跑的校验契约**：只有代码按它校验的节点才写 `schema`
  （消费方三个：`models.jsonValidated` 校验模型输出、`validateDraftInput` 校验 draft-input.json、
  `validateProduced` 校验脚本自己落盘的中间产物，如 `04-step/images.json`）。纯文本输出（`draft_writing` / `revision` / `de_ai`）、
  判断调用（`classify_type` / `select_topic.best` / `scoring.check`）和无模型节点（`gather_materials`）
  **不写 schema**——挂了没人读的契约，比不挂更坏（读起来像"本节点输出受校验"）。
  这些节点的形状备注写在节点内联 `input_format` / `output_format`，`steps --step` 打印时
  明确区分「校验契约 <id>」与「形状备注，脚本不校验」。
- **`result_schema` = 本步 `NN-result.json` 本体的校验契约**（信封之外的那段载荷）。它与节点级
  `schema` 是两个不同的口，不能合并：01–04 的 `schema` 已被模型输出/中间产物占用，同一节点要校验
  两份不同产物（`04-step/images.json` 与 `04-result.json`）必须各挂一个键。
  只有**真正把 result 落盘的那个节点**可以挂（`validateSteps` 检查 `artifacts.writes` 里有没有
  `NN-result.json`），且引用的注册表条目必须有可执行的 `output` DSL——挂了没有 DSL 的条目就是说谎，
  加载期抛错。运行期在落盘前跑 `validateProduced`，不合格**只警告不阻塞**，结果如实写进
  该 result 的 `#validation`（`checked:false` 表示节点没挂契约，不是"校验通过"）。
  `result_schema` 只在节点级，type 层没有覆盖口（一份 result 的形状不随文章类型变）。
- **数据结构注册表不留孤儿条目**：`schemas/*.yaml` 的每个 id 都必须被某个节点（节点级 `schema` /
  `result_schema` / 调用级 / `handler_options.levels.<档>.prompt` / type 层覆盖）引用，测试守住这一条。
- **type 层没有模型覆盖口**：类型里写 `review.model` 是加载期硬错误（审稿各环节调用的模型
  单源 = steps 节点）；`doctor` 的模型连通性检查覆盖节点里出现的**所有**模型 id
  （默认调用 + `rounds` + `levels`，llm 与 systemone 都算，含升级用的 deep 判断模型）。
- type 层 `steps.<step>` 只覆盖 `prompt / schema / enabled / handler_options /
  input_format / output_format`；模型调用不在 type 层覆盖（单源 = 节点）。
  节点按档出提示词时（de_ai）不写节点级 `prompt`，档位提示词单源在
  `handler_options.levels.<档>.prompt`；type 层写了 `prompt` 时优先于档位默认值。

## 产物布局

- 每步产物：`NN-result.json`（文章根目录）+ `NN-step/` 子目录（sources/、web-search/ 等）。
  无 state.json。阶段编号 01 选题 → 02 初稿 → 03 审稿 → 04 组稿 → 05 发布/归档。
- **每份 `NN-result.json` 共用一个信封**（`article-store.mjs → buildEnvelope`）：根上是
  `stage / generated_at / title / type / files`，再挂本步自己的载荷。
  - `title` 与 `type`（**类型 id 字符串**，不是对象）**只在 01 产生**，02–05 从上一份 result
    原样顺延（`PREV_STAGE_RESULT`：draft←topic、review←draft、compose←review、publish←compose）；
    继承不到才用调用方的兜底，那只允许发生在独立命令对着散落稿件跑的时候。
  - `files` 是**累积的产物地图**（相对文章根目录、`/` 分隔）：后面任何一步要读前面的文件，
    只从这里取路径，不猜文件名、不跨步回读中间文件。
  - **result 只留下一步要用的**：过程明细（核稿候选数、敏感词命中、每张配图的通道与提示词、
    systemone 的 3 选 1 过程）留在 `NN-step/`，不进 result。
    因此没有 `step`（就是 `stage`）、没有 `slug`（目录名即身份）、没有 `file`/`finalFile`
    这类单文件指针（一律进 `files`）。
- **跨步读取只认 `files`**（`article-store.mjs → fileFromResult(dir, stage, key)`，取不到返回 `null`）：
  续跑复用前一步产物、独立命令读 02 的纲要/初稿输入，都从上一步 `NN-result.json#files` 拿路径；
  回退 `ARTIFACT` 常量只允许发生在「地图里没有」（旧产物或对散落稿件目录跑单步命令）时。
  产物存在性探测与文章发现（`detectStartStage`/`pickArticleFile`）仍用常量名——那是发现，不是跨步读取。
- **每份 result 落盘前按自己的契约自检**（`result_schema` → `validateProduced`，规则见上一节）：
  结果记进同一份 JSON 的 `#validation`（`{checked,ok,errors,warnings}`），不合格只警告不阻塞。
  05 沿用同一机制（`publish` 校验 `05-result.json` 本体，`archive` 校验 `#archive`）。
  `01-result.json` 因此被剪掉三个无人读取的字段（`score`、`title_candidates`、`duplicate_of`）——
  择题过程只留 `01-step/proposal.json`，result 只留 `topic/thesis/angle/rationale/keywords/source_hints/sources`。
- 组稿（04）阶段内 `de_ai` 与配图两条分支**并发**执行，同写 `04-step/`：`polished.md` 只是分支
  进度，`composed.md` 存在才算该阶段完成；两条分支各自失败只降级（退回审稿稿 / 保留图片标记），
  不阻塞流程，汇总进同一份 `04-result.json`。
  `polished.md` **只在真出润色稿时落盘**：`de_ai.enabled: false`（关档）与调用失败回退都不写——
  回退时手里就是审稿稿，复制一份改名 `polished.md` 属于造假中间产物；此时 `04-result.json#files.polished`
  记 `null`。`images_planned` 记纲要/类型算出来的**规划张数**，与配图分支开没开无关（关时
  `images`/`images_success` 为空、`images_skipped: true` 说明原因）。
- 配图**每张图内部按通道串行降级**：`illustrations.primary`（ModelScope，质量主选）失败才落到
  `fallback`（Pollinations 免费档）；多张图之间仍按 `concurrency` 并发。免费档实测每 IP 45 秒 1 张
  且同时只允许 1 张在飞，故进程内排队 + 按报错 `Retry after Ns` 退避（`min_interval_ms`/`max_retries`），
  落盘扩展名跟随响应 content-type（JPEG 存 `.jpg`，否则发布侧 mime 与内容不符）。
  首选之外的通道 = 降级调用，留痕按下面的 `_F` 规则命名（`resolveChannels` 给通道标 `fallback`，
  调用方传给 recorder；首选被 `enabled: false` 摘掉后新首位不算降级）。异步任务**轮询拿到非 2xx
  当场抛错**，不许继续睡 `max_polls`——白等两分钟既掩盖真因又推迟降级。
- 配图节点**没有模型调用，但三个配置点都必须真驱动**（04 审计的结论：代码实现不完整时
  补代码，不删配置点）：`prompt` = 发给图片模型的 **prompt 模板**（单源
  `prompts/revision.yaml → image_generation`，变量 `{{subject}}/{{style}}/{{negative}}/{{composition}}`
  由脚本填；模板缺失直接抛错，**代码里不留提示词副本**；`--mock` 也走同一模板，产物形状不与真实分叉）；
  `illustrations.scenes` = 只有
  两种尺寸（`wechat-cover` 封面、`article-inline` 正文，第 1 张固定封面），`width/height`
  进请求参数、`composition` 进模板；`schema` = 落 `04-step/images.json` 前用紧凑 DSL 校验
  脚本自己的产物，不合格只警告不阻塞，结果记 `04-result.json#images_validation`
  （`checked:false` 如实表示「没校验过」）。
- 配图张数优先级：`--images` > 纲要 `image_plan` 实排张数 > 类型 `image_count.default`
  （= `illustrations.count`，只在纲要没规划时兜底，不越过模型的小节规划）> `min`；
  结果始终 clamp 到 `image_count.min`~`max`。
- `de_ai` 的改写强度分**三档**（light 只换词 / standard 改到句子 / deep 整篇重述）：选档 =
  `handler_options.level`，可被 `--de-ai-level` 与 type 层 `steps.de_ai.handler_options.level`
  覆盖；每档自带提示词 id 与重叠上限（`handler_options.levels.<档>`）和采样参数
  （`models.de_ai.levels.<档>.options`）。三档共同的硬约束与档位无关：字数在 `type.length`
  区间、原稿数字全部保留、frontmatter/小节标题/配图标记不变。
  改写质量用**本地零 token 三判据**判定（不看禁用词计数——整篇誊抄时禁用词数量和原稿一样）：
  与原稿 20 字窗口逐字重叠 ≤ 本档 `max_verbatim_overlap`、字数在 `type.length` 区间、
  原稿数字全部保留。不合格换一次采样重调，总尝试上限 = 本档的 `models.de_ai...retry_limit`（含首轮）；
  耗尽后取最接近合格的一版继续（先比违规条数，再比离各阈值的距离），`04-result.json#polish`
  （`level` + `gate`：`passed/attempts_used/attempts_allowed/picked_attempt/echo/violations`）记录判定结果——
  **闸门只标记不阻塞**，`polish.ok` 表示有没有稿子。
- `result.json#sources` 条目只存 `{index, title, link}`，link 为相对文章目录
  的路径（`/` 分隔）；读取端通过 baseDir 解析。`04-step/images.json` 的 `file` 同规矩
  （相对文章目录，如 `04-step/images/01_modelscope.png`），不写机器绝对路径——归档打包后仍能读。
- 每步的**外部调用留痕**（大模型 + 其他 API：核稿、知识检索、配图、邮件…）统一落所属步骤目录
  `NN-step/api/子步骤号_轮次(尝试)-label(_F).<模型|provider>.json`（请求+响应成对）：
  步骤号只由目录名 `NN-step`（及 JSON 的 `step` 字段）承担，不进文件名；主号 = 子步骤号 = 该调用在
  所属步骤内的固定执行次序（取自 `API_SLOT` id，去零填充），同一子步骤的多次循环用轮次区分：轮次 =
  该子步骤在本步骤内第几次「逻辑调用」（按 label 独立计数，换模型/provider 不重置，如 `03-step/api/3_1-revise`
  → `3_2-revise`）；单次调用内的重复（校验失败重试、升级二判、HTTP 重试）用 `(尝试)` 标注且不推轮次
  （如 `3_1(2)-revise`），编号由调用方传入的本次调用重试序号决定；
  label = 代码固化的调用名；降级兜底调用尾部标 `_F`；服务段模型调用记模型名、非模型调用记 provider 名。
  管线增删或调整步骤/子步骤时必须同步 `API_SLOT` 的归属与编号。
  **绝不能包含 Authorization / API key**（大 body 只记摘要，如邮件记 html_chars、附件只记文件名与字节数）。
- 发布（05）与归档的开关全部落在 steps 节点上：`publish.enabled=false` = 整个发布环节不执行
  （不落 `05-step/final.md` / `05-result.json`、不投递），`archive.enabled=false` = 不入库、不打包、
  不删 `draft/`。**投递开关单源在 `publish.handler_options` 的 `auto_publish` / `email` / `wechat`**
  （默认全 `true` = auto 模式一路发布到归档；类型层 `steps.publish.handler_options` 可按类型关），
  CLI `--auto-publish` / `--email` / `--wechat` 只做临时覆盖，**不再有 `PB_AUTO_PUBLISH` /
  `PB_EMAIL_ENABLED` / `PB_WECHAT_ENABLED` 环境变量口**（同一件事只留一处）。
  `defaults.publish.email` / `wechat` 只放渠道参数（收件人、发件人、命令串、超时重试）；
  禁止在 `defaults.publish.archive` 里放第二个同名 `enabled`。知识库入库只由
  `defaults.publish.archive.knowledge_dir` 决定：留空 = 跳过复制（`05-result.json#archive.knowledge`
  记 `{ok:true,skipped:true}`），仍照常打包与清理；入库失败只记录、不阻塞打包。
- 05 产物落盘前用紧凑 DSL 校验**脚本自己产出的 JSON**：`publish` 节点 `schema` 校验
  `05-result.json` 本体（结果记 `#validation`），`archive` 节点 `schema` 校验 `#archive`
  （结果记 `#archive.validation`）；不合格只警告不阻塞，`checked:false` 如实表示「没校验过」。
- `05-result.json` 的路径口径分三种，别混：`files.final` 与 `files.html` 相对**文章目录**；
  `archive.zip` 相对**项目根**；`archive.knowledge.file` 是**绝对路径**（知识库目录在项目外，
  相对化会得到 `../../…`，读取端无法还原）。
- 终稿从 `composed.md`（基准=文章根）挪进 `05-step/final.md`（基准=05-step）时，正文图片引用
  必须跟着换基准（`relocateLocalImages` → `../04-step/images/…`）：wenyan CLI 按**稿件文件所在目录**
  解析相对路径，不改写就上传不到配图。邮件侧同理——CID 内联按 HTML 里出现的引用串替换，
  串与 `collect` 出的路径不一致就静默丢图（旧实现拿绝对路径去找相对引用，永远不命中）。
- 公众号发布是 spawn 外部 CLI（`npx --yes @wenyan-md/cli`），占 `API_SLOT.publish.wechat`、
  provider 记 `wenyan-md`；命令行参数与 CLI 回显里的密钥一律打码（`--api-key` 等 flag + `redact`），
  留痕绝不能落 API key 原文。CLI 只认 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`，管线配的
  `WECHAT_MP_*` 由 `wechatChildEnv` 在 spawn 时补别名；Windows 下命令串自己加引号（args+shell:true 会被 cmd 拆路径且触发 DEP0190）。
- 文本运行日志收进文章根目录 `logs/`（`logs/pipeline.log`；独立命令 review/compose/publish 的
  日志同样写这里，不再单独落文件）。
- 产物文件名不带时间戳，重跑覆盖同一路径。
- `NN-step/api/` 留痕同样重跑覆盖：轮次由进程内计数器推导（不扫描已有文件名），跨进程重跑会重新从 1 开始，
  不追加、不归档历史。审稿阶段重跑时会先清掉旧的 `03-step/api/`、`round-N/` 与
  `reviewed.md` / `03-result.json`，避免上一次中断运行留下的 `(尝试)` 文件冒充本次留痕。
- 评分字段口径：`composite_score`（脚本按维度权重回算）是**唯一进闸门**的分数，
  `passed` = 最后一轮 `composite_score >= pass_score`；模型自报的 `total`/`verdict`
  只以 `reported_score`/`reported_verdict` 留痕（偏差 >5 记警告），读取端与判定规则
  不得再用自报值。每条评分必须带 `scorer`（model|rule|mock）与 `scorer_model`——
  不同模型的分是不同量纲，跨模型的历史分数不可直接比较。

## 文档（README 与分步文档）

- **`README.md` 三块内容缺一不可**（顺序也是这个顺序，读者从上往下就是这条学习曲线）：
  1. **背景 + 应用场景 + 工作流程**：为什么是脚本编排而不是 agent 编排、各自代价，
     以及一张端到端流程图（mermaid，五个阶段为 subgraph，标出模型/闸门/并发分支）；
  2. **主入口**：`node scripts/wechat-article.mjs <command>` 的启动顺序
     （`parseArgs` → `loadDotEnv` → `loadConfig` → 分发）与命令表
     （入口 / 分步 / 查看 / 诊断四类），npm 脚本与参数分组同表呈现；
  3. **各阶段概览**：**表格 + 产物地图**——每阶段给「节点 / 对外产物 / 完成判据 / 失败策略」
     一览，再加文章目录树（`NN-result.json` + `NN-step/` 内容 + `logs/`），
     细节一律指向分步文档，不在 README 里复述。
- **分步文档命名 `docs/<feature>/NN_<stage>_step.md`**（`01_topic_step.md` … `05_publish_step.md`）：
  前缀 = 该阶段的产物编号，与 `PIPELINE_STAGES`、`stage` 词汇一一对应；名字带 `_step`
  表示写的是"这一步"，不是设计论证（设计文档另有 `topic-selection.md`、`artifacts.md` 等）。
  每份固定含：命令、执行序列图、每次外部调用的表（含真实 `NN-step/api/` 留痕文件名）、
  节点配置表、产物地图、闸门与降级表、排障表。
- **文档不许说谎**：文件路径、命令、参数名、留痕文件名、默认值都必须能在代码/配置/产物里
  对上；写之前实测（`steps` / `validate` / 真跑产物），拿不准就不写。
  仓库里没有的东西不要写成前提（例如没有 `.env.example` 就不能写 `cp .env.example .env`）。
- **谁守哪条配置不变量要写清楚**：加载期（`normalizeCalls`）、`validate`（`validateSteps`）、
  运行期消费点（`stepCallConfig`/`pickPromptText`/`needConfig`）、单测（孤儿 id 等）
  各查什么，别把测试守的不变量算到 `validate` 头上。
- **改行为/契约/命名时同一遍同步文档**：改了阶段、节点、产物字段、留痕命名、环境变量旋钮，
  就同步改 `README.md` + 对应 `NN_*_step.md` + `docs/<feature>/USAGE.md`，
  与「改契约同一遍同步 AGENTS.md 与项目记忆」是同一条纪律。

## JS/mjs 代码规范（lint）

工具链：ESLint 10 flat config（根目录 `eslint.config.mjs`）+ 本地插件
`scripts/lint/penbot-rules.mjs`（不发包）。命令：`npm run lint`、`npm run lint:fix`、
`npm run check`（lint → validate → 全量单测）。**不引入 Prettier/ESBFmt 等格式化器**：
`--fix` 只允许做与规则直接相关的空白/引号/分号改动，风格之外的整体重排会把 diff 变成噪音，
审查不到真实变更。

规则按四层分工，**只有 L1–L3 进 lint**：

| 层 | 内容 | 谁来守 |
| --- | --- | --- |
| L1 分层与命名 | `lib/` 不得 import `comm/`（依赖方向只允许 comm → lib）；`comm/*.mjs` 必须带功能前缀；comm 模块只被所属管线入口与 `tests/` 引用 | `no-restricted-imports`（config 的 `scripts/lib/**` 块）+ `tests/wechat-article/lint.test.mjs` 对真实目录结构断言 |
| L2 语法与风格 | Node ESM（相对 `import`/`export` 必须带 `.mjs`）、缩进 2、双引号（模板串与转义例外）、分号、`no-var`/`prefer-const`/`eqeqeq`/`no-unused-vars`/`no-empty`(允许空 catch)/`no-undef`/`no-shadow` | 内置规则 + `no-restricted-syntax` 三条 esquery 选择器 |
| L3 本仓库不变量 | 留痕载荷不许出现鉴权字段名或鉴权值读取（`api_key`/`authorization`/`secret`/`token`…）；成句中文文案（默认 ≥60 个中日韩字符）不许抄进代码——提示词与整句文案单源 `prompts/*.yaml` | `penbot/trace-no-secrets`、`penbot/no-prompt-literals`（均为本地插件规则） |
| L4 流程契约 | 配置读取端不留同值兜底、`ARTIFACT` 产物路径单源、`API_SLOT` 与步骤增删同步、类型字段必填 | **不 lint**——AST 判不出来，硬写规则等于配一条没人读的规则；由 `validate`（加载期 + `validateSteps`）与 220 条单测守 |

- **豁免必须写明理由，且不许腐烂**：`linterOptions.reportUnusedDisableDirectives = "error"`，
  一条已经不需要的 `eslint-disable` 本身就是错误。优先用 config 里的**具名文件块**开口
  （如 `scripts/lib/log.mjs` = 日志 sink 本身，`no-console` 对它没有意义），
  其次用**作用域尽量小**的文件内注释（如 `scripts/lib/web-search.mjs` 的独立 CLI 分支
  只在 `if (import.meta.url === …)` 块内 `/* eslint-disable no-console -- 理由 */` 包住）。
  **禁止整文件 `/* eslint-disable */`**，也禁止为了跑通而关掉整条规则。
- **`no-console` 的口径**：`lib/**` 一律 error（管线输出走 `createLogger`，落 `logs/pipeline.log`），
  入口脚本不限制（它就是给人看的那一层），`lib/log.mjs` 与 lib 文件自带的独立 CLI 分支按上条豁免。
- **L3 两条规则自己要有测试**：`tests/wechat-article/lint.test.mjs` 用 `Linter` API
  喂违规样例与干净样例，确认规则真的会报（也确认报错/日志/帮助文本语境、`HELP`
  这类豁免变量、非留痕调用不产误报）。这与「配置点了必须真驱动」是同一条纪律——
  配了不报的规则和配了不读的配置一样是说谎。
- 基线（2026-10-27 落地时）：`scripts/` + `tests/` 全量 **0 error / 0 warning**，
  所以这四层从第一天就是 error 级、不存在"先容忍存量再收紧"的过渡态。新增文件必须直接达标；
  真要放宽某条规则，先想清楚这条规则是不是有消费方，而不是先加 `--fix` 修不掉的豁免。

## 运行环境

- 根目录 `.env`（不入库、不打印值）；脚本经 `loadDotEnv` 加载。
- llm.local 走自建网关：Bearer 鉴权，**仅放出 `/api/chat` 与 `/api/tags`**，
  `/api/generate` 返回 403 属预期，管线不使用它。
- 管线不自行起常驻服务：opencode serve 用一次性生命周期，端口/进程必须显式回收。

## 测试

- 根目录 `npm test` 跑全量；按阶段有 `test:topic`、`test:sources` 等分脚本。
- `npm run check` = lint → `wechat-article:validate` → 全量单测；改完代码默认跑这条，
  三道闸门各守一面（见「JS/mjs 代码规范」与「配置与提示词」）。
- 改 lib 路径常量时保持各功能可注入自己的 config 根目录，入口不得硬编码
  其他功能的配置路径。
