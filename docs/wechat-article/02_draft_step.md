# 02 初稿步（stage `draft`）

一句话：把 01 的主题 + 素材变成一份**可手改的输入包**，再按它写出完整初稿。
这一步不改字数——初稿只管按纲要写完，篇幅由 03 的修正环节校验。

## 命令

```bash
npm run wechat-article -- draft --article <slug>                  # 纲要 → 输入包 → 初稿
npm run wechat-article -- draft --article <slug> --input my.json  # 跳过纲要，用手改过的输入包
npm run wechat-article -- validate --input 02-step/draft-input.json   # 只校验输入包（硬错误 + 软警告）
npm run wechat-article -- auto --stage draft                      # 管线入口，停在 02
```

## 执行序列

```
01-result.json ──► ① 生成纲要 ──► ② 组装初稿输入（本地，无模型）──► ③ 写初稿
   topic/来源链接    outline.json     draft-input.json                draft.md
                     outline.md        可手改后 --input 喂回来            │
                                                              失败 → 分节逐节生成（兜底）
```

> `manual` 入口给了提纲时走 `--outline-file`/`--outline` 里的提纲（跳过 ①）；不给提纲则正常执行 ①③。
> `post` 入口**不跑本步**：草稿在导入时直接落 `02-step/draft.md` 与 `02-result.json`（`files` 里 `outline`/`outlineMd`/`draftInput` 如实记 `null`），从这里直接续 review。

| # | 做什么 | 实现 | 关键配置 |
| --- | --- | --- | --- |
| ① | 纲要：小节 + 要点 + `image_plan`（配图计划） | `outline.models.outline`，子步骤 `01` | 模型 `llm.large`，提示词+契约 `outline.outline`，`retry_limit: 2`、`timeout: 1200000` |
| ② | 组装初稿输入：标题 + 大纲 + 相关资料 + 类型要求 → `02-step/draft-input.json` | `bundle_draft_input`（纯本地，无模型调用） | 契约 `draft.draft_input`，校验失败直接报错不重试 |
| ③ | 写初稿：一次调用输出完整 Markdown（frontmatter + 小节 + 裸 `[[img:N]]` 标记） | `draft_writing.models.draft`，子步骤 `02` | 模型 `llm.large`，提示词 `draft.draft_writing`，`timeout: 1200000`，`max_tokens` 至少 `type.length.max × 2` |

③ 的模型调用抛错时降级为**分节生成**：按纲要逐节各调一次（提示词加上 `section_only` 约束句），最后拼接。
两种路径产出同一形状的 `draft.md`。

## 节点表（`config/wechat-article/steps/20-draft.yaml`）

| 节点 | handler | 模型调用 | 提示词 id | 校验契约 | 写 |
| --- | --- | --- | --- | --- | --- |
| `outline` | `builtin:generate_outline` | `outline=llm.large` | `outline.outline` | `outline.outline`（模型输出） | `02-step/outline.json`、`02-step/outline.md` |
| `bundle_draft_input` | `builtin:build_draft_input` | 无 | 无 | `draft.draft_input`（校验中间产物） | `02-step/draft-input.json` |
| `draft_writing` | `builtin:write_draft` | `draft=llm.large` | `draft.draft_writing` | `draft.result`（result 本体） | `02-step/draft.md`、`02-result.json` |

初稿正文是自由 Markdown，没有可执行形状可校验，所以 `draft_writing` **不挂模型输出契约**；
形状由代码闸门保证（`normalizeArticle` 补 frontmatter、`ensureSectionHeadings` 补齐小节、`normalizeImageMarkers` 对齐配图标记）。

## 产物地图

```
draft/<slug>/
├── 02-result.json          sections / images_planned / words + 顺延的信封
└── 02-step/
    ├── outline.json        纲要（含 image_plan）
    ├── outline.md          人读版
    ├── draft-input.json    ★ 标题 + 大纲 + 资料，可以手改
    ├── draft.md            初稿（frontmatter + 正文 + [[img:N]]）
    └── api/                01_1-outline.<模型名>.json、02_1-draft…（分节生成时同槽位递增轮次）
```

`02-result.json#files` 里多了 `outline` / `outlineMd` / `draftInput` / `draft` 四个路径；
后续任何一步要读这些文件，只从 `files` 取，不猜文件名。
`images_planned` 记纲要实际排出的配图张数（04 的规划依据），与配图分支开没开无关。

## 开关与降级

| 想改什么 | 改哪里 |
| --- | --- |
| 补充写作要求（如「重点写对开发者的影响」） | 命令 `--requirements <text>`，进纲要与初稿的 `requirements_block` |
| 指定配图张数 | 命令 `--images <1-5>`（优先级高于纲要规划，仍 clamp 到类型 `image_count` 区间） |
| 换写作模型 | `.env` 的 `LOCAL_LLM_LARGE_MODEL`（`llm.large` 默认 35b） |
| 类型字数区间 / 纲要 extra | `types/<id>.yaml` 的 `word_limit`、`prompts.outline_extra` |

- 缺 `02-step/draft-input.json` 又没给 `--input` 时直接报错，让你先跑 01/02 或指定文件——不静默用兜底大纲。
- 模型输出不合契约时按失败原因做修复重试（`<label>-fixN` 留痕），重试用尽落到上一步的降级路径。
- `auto` 入口在定类前跑选题，用的是**占位类型**（`style: {}` / `length: null`）；此时提示词里相关整行省略，不换代码默认文案。

## 排障

| 现象 | 先看 |
| --- | --- |
| 初稿没有某个小节 | `02-step/outline.json` 的 `outline[].heading`；`ensureSectionHeadings` 会补齐缺失标题 |
| 正文里配图标记数量与规划不符 | `normalizeImageMarkers` 按 `resolveImageCount` 的结果补齐/裁剪，看 `02-result.json#images_planned` |
| 想改资料再写 | 手改 `02-step/draft-input.json` → `validate --input` → `draft --input` |
