# 04 组稿步（stage `compose`）

一句话：**去 AI 化**和**配图**两条分支并发跑，都结束后把图片替换进润色稿，产出 `composed.md`——
**它是整条管线唯一的最终稿**（05 只是把它搬进 `05-step/final.md` 并投递）。

这一步也是全管线唯一「失败只降级、不中断」的阶段：两条分支各写各的，任一失败都不阻塞发布。

## 命令

```bash
npm run wechat-article -- compose --article <slug>                  # 两分支并发
npm run wechat-article -- compose --article <slug> --de-ai-level deep
npm run wechat-article -- compose --file path/to/reviewed.md        # 对散落稿件单跑
npm run wechat-article -- auto --stage compose                      # 管线入口，停在 04
```

## 执行序列

```
03-step/reviewed.md ──┬──► ① 去 AI 化（de_ai 分支）──► polished.md ──┐
                      │        档位 + 本地质量闸门，最多 N 次采样      │
02-step/outline.json ─┴──► ② 生成配图（image 分支）──► images.json ──┼─► composed.md
    image_plan               每图内部 primary→fallback 串行降级         │   （图片标记替换进正文）
                             图与图之间按 concurrency 并发            ──┘
```

| # | 做什么 | 实现 | 关键配置 |
| --- | --- | --- | --- |
| ① | 按档位改写表达（不改事实、结构、frontmatter、配图标记） | `de_ai.models.de_ai`，子步骤 `01` | 模型 `llm.large`，`timeout: 900000`，`retry_limit: 3`（light 档 `1`，deep 档 `temperature: 0.9`） |
| ② | 按纲要的 `image_plan` 生成封面与正文配图 | `image_generation`（**无模型调用**，走图片 HTTP 通道），子步骤 `02` | `defaults.illustrations.*`（通道、场景尺寸、并发、失败策略） |

两分支由 `Promise.all` 同时发起；`de_ai` 只读 `reviewed.md`，配图只读 `outline.json` 的 `image_plan`，互不依赖。

## 去 AI 化：三档 + 零 token 质量闸门

档位单源 `40-compose.yaml` 的 `handler_options.level`（`${PB_DE_AI_LEVEL:-light}`），
可被 `--de-ai-level` 与类型层 `steps.de_ai.handler_options.level` 覆盖。档位名大小写敏感，写 `Light` 会当未定义档位抛错。

| 档 | 强度 | 提示词 id | 与原稿逐字重叠上限 | 实测取向 |
| --- | --- | --- | --- | --- |
| `light`（默认） | 只换词 | `revision.de_ai_light` | 0.85 | 出稿风险最低，读起来最接近原稿 |
| `standard` | 改到句子 | `revision.de_ai` | 0.50 | 常规 |
| `deep` | 整篇重述 | `revision.de_ai_deep` | 0.35 | 温度 0.9，靠多次重试压重叠率 |

改写得不合格就换一次采样重调，总尝试上限 = 该档的 `models.de_ai...retry_limit`（含首轮）。
**判据全部本地算，零 token**（三条共同硬约束，与档位无关）：

1. 与原稿 20 字窗口逐字重叠 ≤ 本档 `max_verbatim_overlap`（整篇复读在这里被抓；不看禁用词计数——整篇誊抄时禁用词数量和原稿一样）；
2. 字数落在 `type.length` 区间；
3. 原稿数字全部保留。

不合格且次数耗尽 → 取**最接近合格**的一版继续（先比违规条数，再按 `polishSeverity` 比离各阈值的距离）。
闸门**只标记不阻塞**：`04-result.json#polish.gate` 记 `passed / attempts_used / attempts_allowed / picked_attempt / echo / max_echo / lost_numbers / violations`。

`polished.md` 只在**真出润色稿**时落盘：关档（`enabled: false`）和调用失败回退都不写——那时手里就是审稿稿，复制一份改名属于造假中间产物，`04-result.json#files.polished` 记 `null`。

## 配图：张数、尺寸、通道降级

张数优先级（结果始终 clamp 到类型 `image_count.min~max`）：

```
--images  >  纲要 image_plan 实排张数  >  类型 image_count.default（= illustrations.count）  >  min
```

尺寸只有两种场景（第 1 张固定封面）：`wechat-cover` 900×383、`article-inline` 1080×810；
`width/height` 进请求参数，`composition` 进提示词模板。

通道：**每张图内部串行降级**（`primary: modelscope` 失败才落到 `fallback: [pollinations]`），
**图与图之间并发**（`PB_IMAGE_CONCURRENCY`，默认 2）。留痕里降级调用尾部标 `_F`
（首选被 `enabled: false` 摘掉后，新首位不算降级）。

| 通道 | 模型 | 实测 |
| --- | --- | --- |
| ModelScope（主选） | `Tongyi-MAI/Z-Image-Turbo` | 单张 10–45s；异步任务轮询 `poll_interval_ms` × `max_polls`，单次 HTTP 限时 120s；**轮询拿到非 2xx 当场抛错**并降级，不继续睡 |
| Pollinations（兜底） | `turbo` | 免费档每 IP 45 秒 1 张且只允许 1 张在飞 → 进程内排队 + 按 `Retry after Ns` 退避（`min_interval_ms` / `max_retries`） |

落盘扩展名跟随响应 `content-type`（JPEG 存 `.jpg`），否则发布侧 mime 与内容不符。
`images.json` 的 `file` 相对文章根目录（`04-step/images/01_modelscope.jpg`），不写机器绝对路径。

发给图片模型的提示词模板单源 `prompts/revision.yaml → image_generation`，
变量 `{{subject}}` / `{{style}}` / `{{negative}}` / `{{composition}}` 由脚本填；模板缺失直接抛错，`--mock` 也走同一模板。

## 标记替换

正文里只有裸 `[[img:N]]`（说明文字不进正文，字数统计也排除标记）。组稿时按结果替换：

| `illustrations.on_failure` | 失败的那个标记变成 |
| --- | --- |
| `comment`（默认） | `<!-- 配图生成失败：alt -->`（配图分支关闭时 alt 说明是「配图已关闭」） |
| `keep` | 原样保留 `[[img:N]]` |
| `drop` | 删除 |

alt 优先取纲要 `image_plan[].description`，其次标记自带说明，最后 `配图 N`。

## 节点表（`config/wechat-article/steps/40-compose.yaml`）

| 节点 | handler | 模型调用 | 提示词 id | 校验契约 | 写 |
| --- | --- | --- | --- | --- | --- |
| `de_ai` | `builtin:de_ai` | `de_ai=llm.large`（可 `levels` 覆盖） | 按档位：`revision.de_ai_light` / `revision.de_ai` / `revision.de_ai_deep` | 无（纯文本改写） | `04-step/polished.md` |
| `image_generation` | `builtin:generate_images` | 无 | `revision.image_generation`（**图片 prompt 模板**） | `revision.image_generation`（校验 `images.json`）、`compose.result`（result 本体） | `04-step/images.json`、`composed.md`、`images/`、`04-result.json` |

## 产物地图

```
draft/<slug>/
├── 04-result.json          polish{} + images_planned / images_success / images_skipped / images_validation
└── 04-step/
    ├── polished.md          润色稿（仅真有润色稿时存在）
    ├── images.json          每张图的通道、提示词、尺寸、耗时（明细只在这里，不进 result）
    ├── images/              01_modelscope.jpg、02_modelscope.png …
    ├── composed.md          ★ 最终稿
    └── api/                 01_1-de_ai、02_1-illustrate.modelscope、02_1-illustrate_F.pollinations（每张图一次逻辑调用递增轮次，降级带 _F）
```

`images_planned` 记**规划张数**（纲要/类型算出来的），与配图分支开没开无关；
关时 `images_success` 为 0、`images_skipped: true` 说明原因。

## 开关

| 想改什么 | 改哪里 |
| --- | --- |
| 关档去 AI 化（组稿直接用审稿稿） | `.env` `PB_DE_AI_ENABLED=false`；临时用 `--de-ai-level` 换档 |
| 关配图分支 | `.env` `PB_IMAGES_ENABLED=false` |
| 配图并发 | `.env` `PB_IMAGE_CONCURRENCY`（至少 1 个 worker，这是语义安全下限） |
| 单次指定张数 / 档位 | `--images 1-5`、`--de-ai-level light|standard|deep` |
| 通道顺序与凭据 | `defaults.illustrations.primary` / `fallback` / `<通道>.enabled`，密钥 `PB_MODEL_IMAGE_API_KEY` |
| 重叠上限与各档采样参数 | `handler_options.levels.<档>.max_verbatim_overlap`、`models.de_ai.levels.<档>.options` |

- 两条分支的 `enabled` 是全管线**唯一**允许写在流程中间节点上的开关（词汇表由入口 `SKIPPABLE_STEPS` 校验：`de_ai` / `image_generation` / `publish` / `archive`）。
- `--mock`：去 AI 化跳过模型调用（润色稿沿用审稿稿，`polish.mock: true`），配图落占位 PNG 但照常渲染提示词模板。

## 排障

| 现象 | 先看 |
| --- | --- |
| 稿子像整篇誊抄 | `04-result.json#polish.gate.echo` 与 `violations`；档位是否还在 `light` |
| 数字丢了 | `gate.lost_numbers`（原稿数字逐个比对） |
| 图片全是失败标记 | `04-step/images.json` 的 `error` + `04-step/api/02_*-illustrate*.json`；ModelScope 密钥、Pollinations 限速 |
| 邮件/公众号里没图 | `images.json` 的 `file` 与正文引用是否一致（见 [05_publish_step.md](05_publish_step.md) 的基准切换） |

实测背景（哪家快、为什么 45 秒 1 张）见 [USAGE.md](USAGE.md)；
产物结构总表见 [artifacts.md](artifacts.md)。
