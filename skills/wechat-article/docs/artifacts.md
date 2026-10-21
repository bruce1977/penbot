# 文章目录与阶段产物（v2）

> 目标：每篇文章一个独立目录，每个阶段一个固定产物；中断后看「最后一个产物」就能知道从哪继续。
>
> 流程节点（处理方法 / 模型 / I/O / 重试 / 超时 / 提示词）定义在 [`config/steps/`](../config/steps/)（入口 [`steps.yaml`](../config/steps.yaml)）；节点的 `stage` 只是节点分组标签，一个产物阶段可以由多个节点组成（选题步 = `select_topic → classify_type → gather_materials`）。
>
> 节点只引用提示词和数据结构的 id（`<文件名>.<配置项>`，例如 `topic.classify_type`），内容分别在 [`config/prompts/`](../config/prompts/) 和 [`config/schemas/`](../config/schemas/)。

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
├── pipeline.log            # 运行日志
├── 01-result.json          # 选题步结果（标题 + 类型 + systemone 选中项 + sources 链接条目）
├── 01-step/                # 选题步的中间文件
│   ├── topic.md            # 选题的人类可读版
│   ├── proposal.json       # 自动选题的全部候选 + 热度表（仅自动选题时生成，可用 --from-proposal 复用）
│   ├── sources/            # 每条素材一份 MD（frontmatter 溯源 + 摘录正文），#sources 的 file 指向这里
│   ├── web-search/           # 外部检索结果（每组关键字一个 .md，本地素材不足时才产生）
│   └── llm/                # 本步 LLM/API 调用留痕：<label>.<model>.json（request+response 成对，重跑覆盖）
├── 02-outline.json         # 纲要
├── 02-outline.md
├── 03-draft-input.json     # 初稿输入（标题 + 大纲 + 资料）
├── 04-draft.md             # 初稿
├── 05-review/              # 审稿过程
│   └── round-<n>/
│       ├── before.md
│       ├── correct.json
│       ├── after-correct.md
│       ├── score.json
│       └── after-revise.md
├── 05-reviewed.md          # 审稿后的定稿
├── 05-polished.md          # 去 AI 化后的稿件（de_ai 接入后）
├── 06-images.json          # 配图清单（成功/失败、通道、文件）
├── 06-illustrated.md       # 配图后的稿件
├── images/                 # 实际图片文件
│   └── 01_modelscope.png
├── 07-final.md             # 最终正文（发布用）
├── 07-final.html           # 邮件版 HTML（email 开启时）
└── 08-publish.json         # 发布结果（status + 归档信息）
```

> **过渡期约定**：不再使用 `state.json`——文章身份、类型、进度全部从产物文件推导。选题步（01）已完成改造：根目录只输出 `01-result.json`，中间文件收进 `01-step/`；02–08 暂时沿用旧文件名，后续逐步收敛为「每步一个 `NN-result.json` + `NN-step/` 子目录」。`08-publish.json` 名称固定保留（去重/归档依赖它）。

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
| `outline` | `02-outline.json` + `.md` | 文件存在且 `outline` 非空 | `02-outline.json` |
| `bundle`（准备） | `03-draft-input.json` | 文件存在且通过 schema 校验 | `03-draft-input.json` |
| `draft` | `04-draft.md` | 文件存在且字数 > 0 | `04-draft.md` |
| `review` | `05-reviewed.md` + `05-review/` | `05-reviewed.md` 存在 | `05-reviewed.md` |
| `polish`（规划） | `05-polished.md` | `05-polished.md` 存在 | `05-polished.md` |
| `illustrate` | `06-illustrated.md` + `06-images.json` + `images/` | `06-illustrated.md` 存在 | `06-illustrated.md` |
| `publish` | `07-final.md`、`08-publish.json` | `08-publish.json` 存在 | `08-publish.json` |
| `archive` | `published/<date>-<slug>.zip` | zip 存在，`draft/<slug>/` 已删除 | `08-publish.json` |

规则：

- **文件即状态**：续跑只看上表产物是否存在；没有 `state.json`，文章身份/类型/进度全部从 `01-result.json` 和阶段产物推导。
- **写入要原子**：zip 先写 `<file>.tmp` 再 rename，避免中断后留下半截包。
- **阶段名保持不变**（`--stage topic|outline|bundle|draft|review|illustrate|publish`），编号只是给人和续跑逻辑看的。收集素材不再是独立阶段：它是 `topic` 步的第三个节点（`select_topic → classify_type → gather_materials`）。
- `de_ai` 节点已定义，但执行层接入前 `polish` 阶段不参与续跑；产物链仍是 `05-reviewed.md` → `06-illustrated.md`。

## 3. 续跑规则

再次对同一个 article 目录执行 `auto` / `run` / `manual`（带 `--article <slug>`）时：

```text
有 08-publish.json 且 status=published → archive（幂等，见 4.2）
否则有 07-final.md                      → publish
否则有 06-illustrated.md                → publish
否则有 05-reviewed.md                   → illustrate
否则有 04-draft.md                      → review
否则有 03-draft-input.json              → draft
否则有 02-outline.json                  → bundle
否则有 01-result.json                   → outline（其 sources 为空则先补收素材）
否则                                     → topic
```

- 单步命令（`draft` / `review` / …）总是执行自己那一步：前置产物存在就复用，缺了才补跑。
- `publish` / `review` / `illustrate` 不给 `--article` 时，默认取最新/唯一的文章目录，并按阶段挑稿件文件。

## 4. 发布与归档

### 4.1 发布成功判定

`08-publish.json` 的 `status`：

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
2. 把 zip 路径与知识库结果写进 `08-publish.json`（这份清单因此会进入 zip）。
3. 打包整个 article 目录 → `published/<YYYYMMDD>-<slug>.zip`。
4. 删除 `draft/<slug>/`。

幂等依据：

- zip 路径在打包前就写进 `08-publish.json`；重跑时该文件已存在 → 跳过打包，直接删目录。
- 知识库目标是固定文件名，重复复制会覆盖，不会产生副本。
- 打包走 `<zip>.tmp` → rename，不会留下半截 zip。

> 崩溃恢复：`08-publish.json` 里的 `archive.zip` 是第一执行标记，zip 文件是第二执行标记；两者都在时只需删目录。

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
- 写入时基于 `07-final.md` 补一层 frontmatter（`title` / `type` / `published_at`），供入库脚本消费。
- `knowledge_dir` 为空就跳过，不影响打包与删除——**这一步失败不应阻塞归档**（记录到 `archive.knowledge.error`）。

## 5. 已确认

1. 发布成功口径：只有真实投递成功（`published`）才归档删除；`skipped` 不归档。
2. 归档形式：`published/<YYYYMMDD>-<slug>.zip`。
3. 编号重排：统一为 `01`–`09`，与阶段一一对应。
4. 输出根目录：只认 `BASE_OUTPUT_FOLDER`（环境变量/配置），取消 `--output`；用 `--article <slug>` 选择文章。
5. 知识库归档目录：统一用 `defaults.publish.archive.knowledge_dir`（`KNOWLEDGE_PIPELINE_DIR`），等于本地知识库的 `pipeline/` 待入库目录；留空则跳过。
