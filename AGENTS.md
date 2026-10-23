# penbot — 项目规范

脚本驱动的写作管线集合。三条管线各自独立：

1. `wechat-article` 微信公众号文章流水线
2. `micro-news` 微新闻文章流水线
3. `web-novel` 网络小说篇章连续流水线

编排一律由 Node 脚本完成，**不使用 agent/skill 编排**（不稳定且 token 开销大）。
opencode 只作为工具节点（如 websearch）被脚本调用，不作为编排器。

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
│   ├── wechat-article.mjs           # 入口 ×3，一管线一文件
│   ├── micro-news.mjs
│   └── web-novel.mjs
├── tests/<feature>/*.test.mjs
├── docs/<feature>/
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

### 步骤节点配置统一标准（steps/steps/*.yaml）

- **模型调用**：节点用 `models: { <调用名>: { id: <模型 id>, options: {…} } }`
  声明该步骤的每一次真实模型调用（一个节点可多次、跨模板调用）。模板由模型
  id 前缀选择：`llm.*` 的 options 只允许 `retry_limit / timeout / temperature /
  max_tokens`；`systemone.*` 只允许 `deep / escalate_below / min_confidence`。
  options 未配置的参数吃 models.yaml 端点默认；写了就覆盖。加载期对不合规写法
  （未知调用名/模板外参数/未定义模型 id/非法取值）直接抛错。
- **运行时优先级**：`--model`（遗留，待测试脚本环节移除）> 节点
  `models.<调用名>.id` > `type.model`。代码不得绕过节点调用配置。
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
- 节点 `modes / enabled / stage / handler / depends_on / artifacts` 是 steps 注册表
  **元数据**（validate、文档、独立命令展示用），管线实际执行由入口代码手写调度，
  这些字段不作为运行时开关。产物路径的单源是入口 `ARTIFACT` 表。
- type 层 `steps.<step>` 只覆盖 `prompt / schema / enabled / handler_options /
  input_format / output_format`；模型调用不在 type 层覆盖（单源 = 节点）。

## 产物布局

- 每步产物：`NN-step/result.json` + `NN-step/` 子目录（sources/、web-search/ 等）。
  无 state.json。
- `result.json#sources` 条目只存 `{index, title, link}`，link 为相对文章目录
  的路径（`/` 分隔）；读取端通过 baseDir 解析。
- LLM/API 调用记录落所属步骤目录 `NN-step/llm/M-label(_F).<model>.json`（请求+响应成对）：
  目录名自带步骤号；M = 本步骤内实际执行顺序递增编号（第 1 次调用 1-，重试/下一轮依次 +1，
  直接可读先后次序）；label = 代码固化的调用名（入口 `LLM_SLOT`，其 slot id 只记在 JSON 里，
  不进文件名）；降级兜底调用尾部标 `_F`。管线增删或调整步骤时必须同步 `LLM_SLOT` 归属。
  **绝不能包含 Authorization / API key**。
- 文本运行日志收进文章根目录 `logs/`（`logs/pipeline.log`；独立命令 review/illustrate/publish 的
  日志同样写这里，不再单独落文件）。
- 产物文件名不带时间戳，重跑覆盖同一路径。

## 运行环境

- 根目录 `.env`（不入库、不打印值）；脚本经 `loadDotEnv` 加载。
- llm.local 走自建网关：Bearer 鉴权，**仅放出 `/api/chat` 与 `/api/tags`**，
  `/api/generate` 返回 403 属预期，管线不使用它。
- 管线不自行起常驻服务：opencode serve 用一次性生命周期，端口/进程必须显式回收。

## 测试

- 根目录 `npm test` 跑全量；按阶段有 `test:topic`、`test:sources` 等分脚本。
- 改 lib 路径常量时保持各功能可注入自己的 config 根目录，入口不得硬编码
  其他功能的配置路径。
