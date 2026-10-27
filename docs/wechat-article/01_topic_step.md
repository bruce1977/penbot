# 01 选题步（stage `topic`）

一句话：从知识库挑出一篇值得写的主题，定好文章类型，把写作素材收齐。
这一步是五步里唯一产生**身份**的地方——`title` 与 `type` 从 `01-result.json` 诞生，之后四步只顺延、不重新发明。

## 命令

```bash
npm run wechat-article -- topic  --type ai-news              # 只跑这一步
npm run wechat-article -- topic  --topic "手动主题"           # 跳过选题模型
npm run wechat-article -- topics --type ai-news --count 3 --output output   # 只看候选，不落文章目录
npm run wechat-article -- auto   --stage topic               # 管线入口，停在 01
```

## 执行序列

`auto` 入口的顺序是**先选题、后定类**（定类需要标题 + 论点）；`manual` / `--topic` 直接定类。
括号里是 `01-step/api/` 留痕文件的子步骤号。

```
本地候选池扫描 ──► ① WeKnora 检索(仅需要时) ──► ② 生成 3 个候选主题 ──► ③ 判断模型择一
        │                                                              │
        └── 词频热度表 + 已写文章清单（查重）──► 候选池 + 热度一起进提示词   ▼
                                                     ④ 判断模型定文章类型
                                                              │
                                                     ⑤ 素材收集（本地段落 → 充分性闸门 → 外部检索）
```

| # | 做什么 | 实现 | 关键配置 |
| --- | --- | --- | --- |
| — | 候选池：按文件日期窗口扫本地知识库目录，截取段落（本地路径不产生外部调用，无留痕） | `lib/knowledge.mjs` | `types/<id>.yaml` 的 `knowledge_base_path`、`topic.candidate_days` / `fresh_days` / `max_candidates` |
| ① | 远程候选（可选）：WeKnora 关键字检索 | `lib/knowledge.mjs#searchWeKnora`，子步骤 `01` | `PB_USE_WEKNORA=true` 且 `knowledge.source` 含 weknora |
| ② | 一次模型调用产出 3 个候选主题（含 `thesis` / `angle` / `rationale` / `keywords` / `source_hints` / `score`） | `select_topic.models.select`，子步骤 `02` | 模型 `llm.local`，提示词+契约 `topic.select_topic`，`retry_limit: 2`、`timeout: 900000` |
| ③ | 判断模型从 3 个候选里择一；置信度不足升级二次判断 | `select_topic.models.best`，子步骤 `03` | `systemone.classifier`，提示词 `topic.select_best`，`escalate_below: 0.65` → `deep: systemone.classifier-deep` |
| ④ | 按「标题 + 论点」定类型 | `classify_type.models.classify`，子步骤 `04` | `systemone.classifier`，提示词 `topic.classify_type`，`escalate_below: 0.65`、`min_confidence: 0.5` |
| ⑤ | 素材收集：本地段落 → 排序截取 → 充分性闸门 → 外部检索补充 | `gather_materials`（无模型调用），子步骤 `05` | `knowledge.max_sources` / `excerpt_chars`、`knowledge.web-search.*` |

候选池的两个窗口：`candidate_days`（大样本，按文件修改日期）与 `fresh_days`（小样本，按采集日期，进提示词时标 `fresh`）。
词频热度表由 `knowledge.mjs#termHeatmap` 本地算出，不花 token。
查重清单 = `published/*.zip` + `draft/*/`（在写的也算写过），由 `lib/zip.mjs#listWrittenArticles` 提供。

外部检索走 **opencode 的 `websearch` 工具节点**（不是 `config/models.yaml` 里的模型）：
`defaults.knowledge.web-search.model` 是 opencode 侧的 provider/model 名，默认跟随 `OPENCODE_DEFAULT_MODEL`。
只有充分性闸门判「本地不够」才出门（命中数 / 摘录总字数 / `source_hints` 覆盖率 / 新鲜度四条判据）。

## 节点表（`config/wechat-article/steps/10-topic.yaml`）

| 节点 | handler | 模型调用 | 提示词 id | 校验契约 | 写 |
| --- | --- | --- | --- | --- | --- |
| `select_topic` | `builtin:select_topic` | `select=llm.local`、`best=systemone.classifier` | `topic.select_topic`、`topic.select_best` | `topic.select_topic`（模型输出）、`topic.result`（result 本体） | `01-result.json`、`01-step/topic.md`、`01-step/proposal.json` |
| `classify_type` | `builtin:classify_type` | `classify=systemone.classifier` | `topic.classify_type` | 无（判断模型回答由 `classify.mjs` 自己解析） | `01-result.json#type` |
| `gather_materials` | `builtin:gather_materials` | 无 | 无 | 无 | `01-result.json#sources` |

## 产物地图

```
draft/<slug>/
├── 01-result.json          ← 本步唯一对外产物（信封 + 选题字段 + 素材链接）
└── 01-step/
    ├── topic.md            人读版选题
    ├── proposal.json       3 个候选 + 择题过程（score / title_candidates 只留在这里）
    ├── sources/            本地素材正文，逐条一个 .md（1-<slug>.md …）
    ├── web-search/         外部检索的 Markdown（走了才有）
    └── api/                01_1-knowledge_search、02_1-topic、03_1-select_best、04_1-classify_type、05_1-websearch
```

`01-result.json` 的字段就是下一步的输入清单，没有多余项：

| 字段 | 来源 | 谁用 |
| --- | --- | --- |
| `stage` / `generated_at` / `title` / `type` / `files` | `lib/article-store.mjs#buildEnvelope` | 每一步都顺延；`files` 是跨步取路径的唯一入口 |
| `topic` / `thesis` / `angle` / `rationale` / `keywords` | 选定的候选主题 | 02 的纲要提示词 |
| `source_hints` | 模型点名想要的素材标题 | 充分性闸门的覆盖率判据、02 纲要 |
| `sources` = `[{index, title, link}]` | `landSources` 落盘后的链接 | 02 纲要与初稿读正文（`link` 相对文章根目录） |
| `validation` | 落盘前按 `topic.result` 自检 | 人工核对产物结构；`checked:false` = 节点没挂契约，不等于通过 |

## 开关与降级

| 想改什么 | 改哪里 |
| --- | --- |
| 只用本地素材、不出门检索 | `.env` `PB_WEB_SEARCH_ENABLED=false` |
| 本地素材条数（同时推导 WeKnora `match_count` 与闸门分母） | `.env` `PB_KNOWLEDGE_MAX_SOURCES`（默认 8） |
| 用远程知识库 | `.env` `PB_USE_WEKNORA=true`，命令 `--knowledge-source local\|weknora\|both` |
| 换模型（如本地算力不足） | `config/models.yaml` 的 `LOCAL_LLM_BASE_MODEL`；steps 节点只引用 id |
| 判断模型不可用 | `base_url` 留空即按「不可用」降级：定类落到 `classifier.default_type` |

- 手动主题（`--topic`）**完全跳过**选题模型，少一次调用。
- WeKnora 候选获取失败只 `warn`，落回空候选继续。
- 外部检索任何失败（opencode 起不来 / 全组超时）只 `warn`，不中断；`--mock` 永不联网。
- 择题/定类的置信度都不够时按兜底选项落定，并把 `source` 记进 result（`classifier` / `default` / `cli` / `env` / `input` / `article`）。

## 排障

| 现象 | 先看 |
| --- | --- |
| 候选主题与素材对不上、`source_hints` 为空 | `01-step/proposal.json` 与 `01-step/api/02_1-topic.<模型>.json`（提示词里候选是否带标题） |
| 定类定错 | `01-step/api/04_1-classify_type.tev1.json` 的问句与 `confidence`；`escalate_below` 是否触发二判 |
| 素材太少就出门检索/该检索没检索 | `defaults.knowledge.web-search.gate` 四条判据 + `01-step/web-search/` 是否存在 |
| 报「缺少配置项 …」 | 必填参数在**消费点**抛错，报错点名完整配置路径，照路径补 `.env` 或配置 |

设计细节（双窗口、热度表、一次调用的取舍）见 [topic-selection.md](topic-selection.md)；
素材通道与 link 口径见 [materials-collection.md](materials-collection.md)、[web-search.md](web-search.md)。
