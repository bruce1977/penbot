# 文章目录与阶段产物（v2）

> 目标：每篇文章一个独立目录，每个阶段一个固定产物；中断后看「最后一个产物」就能知道从哪继续。
>
> 流程节点（处理方法 / 模型 / I/O / 重试 / 超时 / 提示词）定义在 [`config/steps/`](../config/steps/)（入口 [`steps.yaml`](../config/steps.yaml)）；节点的 `stage` 字段对应下表的阶段。

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
├── state.json              # 文章身份 + 各阶段状态（派生数据，删了也能续跑）
├── pipeline.log            # 运行日志
├── 01-topic.json           # 选题
├── 01-topic.md
├── 02-sources.json         # 素材
├── 03-outline.json         # 纲要
├── 03-outline.md
├── 04-draft-input.json     # 初稿输入（标题 + 大纲 + 资料）
├── 05-draft.md             # 初稿
├── 06-review/              # 审稿过程
│   └── round-<n>/
│       ├── before.md
│       ├── correct.json
│       ├── after-correct.md
│       ├── score.json
│       └── after-revise.md
├── 06-reviewed.md          # 审稿后的定稿
├── 06-polished.md          # 去 AI 化后的稿件（de_ai 接入后）
├── 07-images.json          # 配图清单（成功/失败、通道、文件）
├── 07-illustrated.md       # 配图后的稿件
├── images/                 # 实际图片文件
│   └── 01_modelscope.png
├── 08-final.md             # 最终正文（发布用）
├── 08-final.html           # 邮件版 HTML（email 开启时）
└── 09-publish.json         # 发布结果（status + 归档信息）
```

`state.json` 只用于展示和排错，核心字段：

```jsonc
{
  "version": "1.0.0",
  "article": { "slug": "...", "title": "...", "type": "ai-news", "entry": "auto", "createdAt": "..." },
  "stages": { "topic": { "ok": true }, "draft": { "ok": true, "words": 1100 }, "...": {} },
  "error": null,
  "finishedAt": "..."
}
```

### 阶段产物与完成判据

| 阶段 | 产物 | 完成判据（续跑依据） | 下一步读什么 |
| --- | --- | --- | --- |
| `topic` | `01-topic.json` + `.md` | 文件存在且 `title` 非空 | `01-topic.json` |
| `sources` | `02-sources.json` | 文件存在且为数组 | `02-sources.json` |
| `outline` | `03-outline.json` + `.md` | 文件存在且 `outline` 非空 | `03-outline.json` |
| `bundle`（准备） | `04-draft-input.json` | 文件存在且通过 schema 校验 | `04-draft-input.json` |
| `draft` | `05-draft.md` | 文件存在且字数 > 0 | `05-draft.md` |
| `review` | `06-reviewed.md` + `06-review/` | `06-reviewed.md` 存在 | `06-reviewed.md` |
| `polish`（规划） | `06-polished.md` | `06-polished.md` 存在 | `06-polished.md` |
| `illustrate` | `07-illustrated.md` + `07-images.json` + `images/` | `07-illustrated.md` 存在 | `07-illustrated.md` |
| `publish` | `08-final.md`、`09-publish.json` | `09-publish.json` 存在 | `09-publish.json` |
| `archive` | `published/<date>-<slug>.zip` | zip 存在，`draft/<slug>/` 已删除 | `09-publish.json` |

规则：

- **文件即状态**：续跑只看上表产物是否存在，不依赖 `state.json`；`state.json` 只用于展示和排错。
- **写入要原子**：zip 先写 `<file>.tmp` 再 rename，避免中断后留下半截包。
- **阶段名保持不变**（`--stage topic|sources|outline|bundle|draft|review|illustrate|publish`），编号只是给人和续跑逻辑看的。
- `de_ai` 节点已定义，但执行层接入前 `polish` 阶段不参与续跑；产物链仍是 `06-reviewed.md` → `07-illustrated.md`。

## 3. 续跑规则

再次对同一个 article 目录执行 `auto` / `run` / `manual`（带 `--article <slug>`）时：

```text
有 09-publish.json 且 status=published → archive（幂等，见 4.2）
否则有 08-final.md                      → publish
否则有 07-illustrated.md                → publish
否则有 06-reviewed.md                   → illustrate
否则有 05-draft.md                      → review
否则有 04-draft-input.json              → draft
否则有 03-outline.json                  → bundle
否则有 02-sources.json                  → outline
否则有 01-topic.json                    → sources
否则                                     → topic
```

- 单步命令（`draft` / `review` / …）总是执行自己那一步：前置产物存在就复用，缺了才补跑。
- `publish` / `review` / `illustrate` 不给 `--article` 时，默认取最新/唯一的文章目录，并按阶段挑稿件文件。

## 4. 发布与归档

### 4.1 发布成功判定

`09-publish.json` 的 `status`：

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
2. 把 zip 路径与知识库结果写进 `09-publish.json`（这份清单因此会进入 zip）。
3. 打包整个 article 目录 → `published/<YYYYMMDD>-<slug>.zip`。
4. 删除 `draft/<slug>/`。

幂等依据：

- zip 路径在打包前就写进 `09-publish.json`；重跑时该文件已存在 → 跳过打包，直接删目录。
- 知识库目标是固定文件名，重复复制会覆盖，不会产生副本。
- 打包走 `<zip>.tmp` → rename，不会留下半截 zip。

> 崩溃恢复：`09-publish.json` 里的 `archive.zip` 是第一执行标记，zip 文件是第二执行标记；两者都在时只需删目录。

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
- 写入时基于 `08-final.md` 补一层 frontmatter（`title` / `type` / `published_at`），供入库脚本消费。
- `knowledge_dir` 为空就跳过，不影响打包与删除——**这一步失败不应阻塞归档**（记录到 `archive.knowledge.error`）。

## 5. 已确认

1. 发布成功口径：只有真实投递成功（`published`）才归档删除；`skipped` 不归档。
2. 归档形式：`published/<YYYYMMDD>-<slug>.zip`。
3. 编号重排：统一为 `01`–`09`，与阶段一一对应。
4. 输出根目录：只认 `BASE_OUTPUT_FOLDER`（环境变量/配置），取消 `--output`；用 `--article <slug>` 选择文章。
5. 知识库归档目录：统一用 `defaults.publish.archive.knowledge_dir`（`KNOWLEDGE_PIPELINE_DIR`），等于本地知识库的 `pipeline/` 待入库目录；留空则跳过。
