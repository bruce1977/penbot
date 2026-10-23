# 文章目录与阶段产物（v2）

> 目标：每篇文章一个独立目录，每个阶段一个固定产物；中断后看「最后一个产物」就能知道从哪继续。
>
> 流程节点（处理方法 / 模型 / I/O / 重试 / 超时 / 提示词）定义在 [`config/wechat-article/steps/`](../config/wechat-article/steps/)（入口 [`steps.yaml`](../config/wechat-article/steps.yaml)）；节点的 `stage` 只是节点分组标签，一个产物阶段可以由多个节点组成（选题步 = `select_topic → classify_type → gather_materials`）。
>
> 节点只引用提示词和数据结构的 id（`<文件名>.<配置项>`，例如 `topic.classify_type`），内容分别在 [`config/wechat-article/prompts/`](../config/wechat-article/prompts/) 和 [`config/wechat-article/schemas/`](../config/wechat-article/schemas/)。

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
│   └── pipeline.log        # 运行日志（独立命令 review/illustrate/publish 也写这里）
├── 01-result.json          # 选题步结果（标题 + 类型 + systemone 选中项 + sources 链接条目）
├── 01-step/                # 选题步的中间文件
│   ├── llm/                # 本步 LLM/API 调用留痕：M-label(_F).<model>.json，M 按步骤内实际执行顺序递增（request+response 成对，重跑覆盖；每个 NN-step/ 均有）
│   ├── topic.md            # 选题的人类可读版
│   ├── proposal.json       # 自动选题的全部候选 + 热度表（仅自动选题时生成，可用 --from-proposal 复用）
│   ├── sources/            # 每条素材一份 MD（frontmatter 溯源 + 摘录正文），#sources 的 file 指向这里
│   └── web-search/           # 外部检索结果（每组关键字一个 .md，本地素材不足时才产生）
├── 02-result.json          # 初稿阶段结果（标题 / 小节数 / 字数 / 中间文件索引）
├── 02-step/                # 初稿阶段（纲要 → 初稿输入 → 初稿）的中间文件
│   ├── outline.json / outline.md
│   ├── draft-input.json    # 初稿输入（标题 + 大纲 + 资料）
│   └── draft.md            # 初稿
├── 03-result.json          # 审稿阶段结果（每轮字数/问题/得分、最终结论）
├── 03-step/                # 审稿阶段（核稿 → 修正 → 评稿 → 判定，循环）
│   ├── round-<n>/
│   │   ├── correct.json
│   │   ├── after-correct.md
│   │   ├── after-revise.md
│   │   ├── score.json
│   │   └── check.json      # 判断模型的去留结果（done/continue，含回退原因）
│   ├── round-<n>-diff.md   # 每轮修正前后的差异摘要
│   └── reviewed.md         # 审稿后的定稿
├── 05-result.json          # 配图阶段结果
├── 05-step/
│   ├── images.json         # 配图清单（成功/失败、通道、文件）
│   ├── illustrated.md      # 配图后的稿件
│   └── images/             # 实际图片文件（01_xxx.png…）
├── 06-result.json          # 发布结果（status + 归档信息）
├── 06-step/
│   ├── final.md            # 最终正文（发布用）
│   └── final.html          # 邮件版 HTML（email 开启时）
└── （04 = 去 AI 化 de_ai，配置就绪、执行层未接线；接入后为 04-result.json + 04-step/polished.md）
```

> **布局约定**：不使用 `state.json`——文章身份、类型、进度全部从产物文件推导。每个阶段根目录只输出一个 `NN-result.json`（完成标记 + 结构化摘要），中间文件一律收进 `NN-step/` 子目录；`06-result.json` 被去重/归档逻辑依赖，名称固定。

`01-result.json` 是扁平结构（选题字段直接铺在根上，素材收在 `sources` 数组里）：

```jsonc
{
  "step": "topic",
  "slug": "...",
  "generated_at": "...",            // 文章创建时间（列表/去重用它排序）
  "title": "...", "topic": "...", "thesis": "...", "angle": "...", "rationale": "...",
  "keywords": ["..."], "source_hints": ["..."],
  "type": {                          // 判断模型结果（选题后才分类）
    "id": "ai-news", "name": "...", "source": "classifier", "confidence": 0.8, "reason": "..."
  },
  "picked": { "choice": "1", "first_choice": "3", "escalated": true },  // systemone 3 选 1 的过程
  "sources": [                       // 收集素材的纯链接条目（其余信息都在落地 MD 里）
    { "index": 1, "title": "...", "link": "01-step/sources/1-....md" }  // 相对文章目录
  ]
}
```

> 素材正文与出处（`origin/source/date/score`）只存 `01-step/sources/*.md`：frontmatter
> 溯源 + 摘录段正文（不整篇复制原文）；下游经 `loadSource` 按 `link` 回读（相对路径
> 以文章目录为 `baseDir`），旧格式的内嵌 `excerpts` 仍兼容。

### 阶段产物与完成判据

| 阶段 | 产物 | 完成判据（续跑依据） | 下一步读什么 |
| --- | --- | --- | --- |
| `topic`（选题 → 定类 → 收集素材） | `01-result.json` + `01-step/topic.md`、`01-step/sources/*.md`（自动选题另存 `01-step/proposal.json`，外部检索另存 `01-step/web-search/*.md`，LLM 调用留痕在 `01-step/llm/`） | 文件存在且 `title` 非空、`sources` 为数组 | `01-result.json` |
| `draft`（纲要 → 初稿输入 → 初稿） | `02-result.json` + `02-step/outline.json`/`.md`、`02-step/draft-input.json`、`02-step/draft.md` | `02-result.json` 存在；阶段内中断看 `02-step/` 里的中间文件复用 | `02-step/draft.md`（稿件）、`02-step/outline.json`（配图规划） |
| `review`（核稿 → 修正 → 评稿 → 判定） | `03-result.json` + `03-step/round-<n>/…`、`03-step/reviewed.md` | `03-result.json` 存在 | `03-step/reviewed.md` |
| `polish`（规划，未接线） | `04-result.json` + `04-step/polished.md` | `04-step/polished.md` 存在 | `04-step/polished.md` |
| `illustrate` | `05-result.json` + `05-step/images.json`、`05-step/illustrated.md`、`05-step/images/` | `05-step/illustrated.md` 存在 | `05-step/illustrated.md` |
| `publish` | `06-result.json` + `06-step/final.md`、`final.html` | `06-result.json` 存在 | `06-result.json` |
| `archive` | `published/<date>-<slug>.zip` | zip 存在，`draft/<slug>/` 已删除 | `06-result.json` |

规则：

- **文件即状态**：续跑只看上表产物是否存在；没有 `state.json`，文章身份/类型/进度全部从 `01-result.json` 和阶段产物推导。
- **写入要原子**：zip 先写 `<file>.tmp` 再 rename，避免中断后留下半截包。
- **阶段名即 `--stage` 取值**（`--stage topic|draft|review|illustrate|publish`）；纲要/初稿输入/初稿是同一个 `draft` 阶段的三个节点，不再单独提供停点。收集素材是 `topic` 步的第三个节点（`select_topic → classify_type → gather_materials`）。
- `de_ai` 节点已定义（`40-polish.yaml`），但执行层接入前 `polish` 阶段不参与续跑；产物链仍是 `03-step/reviewed.md` → `05-step/illustrated.md`。
- 字数校验内置在修正环节（`30-review.yaml` 的 `revision`）：修正可能增删内容，返回稿由本地函数计字，不在区间就带原因重试（`--length-attempts` 默认 3 次），耗尽仍不合格中断流程；不再有独立的 `length_adjust` 节点。

## 3. 续跑规则

再次对同一个 article 目录执行 `auto` / `run` / `manual`（带 `--article <slug>`）时：

```text
有 06-result.json 且 status=published → archive（幂等，见 4.2）
否则有 06-result.json / 06-step/final.md / 05-step/illustrated.md → publish
否则有 03-result.json                 → illustrate
否则有 02-result.json                 → review
否则有 02-step/ 内任一中间文件或 01-result.json → draft（阶段内按文件复用已完成的节点）
否则                                   → topic
```

- 单步命令（`draft` / `review` / …）总是执行自己那一步：前置产物存在就复用，缺了才补跑。
- `publish` / `review` / `illustrate` 不给 `--article` 时，默认取最新/唯一的文章目录，并按阶段挑稿件文件。

## 4. 发布与归档

### 4.1 发布成功判定

`06-result.json` 的 `status`：

| 取值 | 含义 | 是否归档 |
| --- | --- | --- |
| `published` | 所有启用的渠道都真实投递成功 | ✅ |
| `partial` | 部分渠道成功（如邮件成功、公众号失败） | ❌（等待重试或人工决定） |
| `skipped` | email/wechat 未启用，或 `auto_publish=false` | ❌ |
| `dry_run` | 演练（含渠道级 `dry_run`） | ❌ |
| `failed` | 渠道全部失败 | ❌ |

**只有 `published` 才触发归档删除**；其余状态文章留在 `draft/`，可以修好后重跑。

### 4.2 归档序列（幂等）

发布成功后，按顺序执行：

1. 把最终稿复制到知识库归档目录（**按文章类型配置**，见 4.3）；失败只记录，不阻塞。
2. 把 zip 路径与知识库结果写进 `06-result.json`（这份清单因此会进入 zip）。
3. 打包整个 article 目录 → `published/<YYYYMMDD>-<slug>.zip`。
4. 删除 `draft/<slug>/`。

幂等依据：

- zip 路径在打包前就写进 `06-result.json`；重跑时该文件已存在 → 跳过打包，直接删目录。
- 知识库目标是固定文件名，重复复制会覆盖，不会产生副本。
- 打包走 `<zip>.tmp` → rename，不会留下半截 zip。

> 崩溃恢复：`06-result.json` 里的 `archive.zip` 是第一执行标记，zip 文件是第二执行标记；两者都在时只需删目录。

### 4.3 知识库归档（统一落到 pipeline 待入库目录）

```yaml
# defaults.yaml → defaults.publish.archive
publish:
  archive:
    enabled: true
    knowledge_dir: "${KNOWLEDGE_PIPELINE_DIR:-D:/knowledge/pipeline}"  # 空 = 跳过这一步
    filename: "{date}-{slug}.md"
```

- 所有类型统一落到本地知识库的 `pipeline/` 目录，由后续入库脚本扫描处理；类型文件不单独配置归档目录。
- 写入时基于 `06-step/final.md` 补一层 frontmatter（`title` / `type` / `published_at`），供入库脚本消费。
- `knowledge_dir` 为空就跳过，不影响打包与删除——**这一步失败不应阻塞归档**（记录到 `archive.knowledge.error`）。

## 5. 已确认

1. 发布成功口径：只有真实投递成功（`published`）才归档删除；`skipped` 不归档。
2. 归档形式：`published/<YYYYMMDD>-<slug>.zip`。
3. 编号重排：01–06 与阶段一一对应，每阶段 `NN-result.json` + `NN-step/`（04 留给未接线的去 AI 化）。
4. 输出根目录：只认 `BASE_OUTPUT_FOLDER`（环境变量/配置），取消 `--output`；用 `--article <slug>` 选择文章。
5. 知识库归档目录：统一用 `defaults.publish.archive.knowledge_dir`（`KNOWLEDGE_PIPELINE_DIR`），等于本地知识库的 `pipeline/` 待入库目录；留空则跳过。
