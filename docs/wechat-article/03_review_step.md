# 03 审稿步（stage `review`）

一句话：**核稿 → 修正 → 评稿 → 判定** 循环，最多 N 轮，出稿与否只看评分阈值。
这一步是整条管线最贵的环节（实测 3 轮约 8.5 分钟），也是唯一会因字数不合格而**中断流程**的环节。

## 命令

```bash
npm run wechat-article -- review --article <slug>                 # 对 02 的初稿跑完整循环
npm run wechat-article -- review --file path/to/draft.md          # 对散落稿件单跑（独立命令）
npm run wechat-article -- review --article <slug> --rounds 1      # 临时只跑一轮
npm run wechat-article -- auto --stage review                     # 管线入口，停在 03
```

## 执行序列（每一轮内部）

```
       ┌──────────────────────── 第 n 轮 ─────────────────────────┐
初稿 ─►│ ① 核稿(规则端点) ─► ② 修正(llm) ─► ③ 评稿(llm) ─► ④ 判定(判断模型) │─► 03-step/reviewed.md
       │   错别字候选+敏感词     带字数闸门      维度分+must_fix      continue/done │
       └──────────────────────────────┬───────────────────────────┘
                                      │ continue 且未到 max_rounds
                                      └──────► 下一轮（修正依据换成上一轮评分意见）
```

| # | 做什么 | 实现 | 关键配置 |
| --- | --- | --- | --- |
| ① | 并行调用 correct-cn 的 `/api/correct`（错别字候选）与 `/api/sensitive/check`（敏感词只留痕，不进提示词）；**不做字面替换** | `review` 节点（无模型调用），子步骤 `01` / `02` | `defaults.review.correct_cn.*`（地址、`Authorization: Bearer`、`timeout_ms`、`retries`） |
| ② | 修正：首轮按核稿候选逐条核实，第二轮起叠加上一轮的评分意见与 `must_fix`；返回稿本地计字 | `revision.models.revise`，子步骤 `03`（轮次计数） | 模型 `llm.large`，`temperature: 0.2`，`timeout: 900000`，提示词 `revision.revision`，可按 `rounds.<n>` 覆盖 |
| ③ | 评稿：按类型 `scoring_criteria` 逐维度打分 | `scoring.models.score`，子步骤 `04` | 模型 `llm.large`，提示词+契约 `review.scoring`，`retry_limit: 2` |
| ④ | 去留判定：判断模型读评分与问题清单，答 `continue` / `done` | `scoring.models.check`，子步骤 `05` | `systemone.classifier`，提示词 `review.check`，`escalate_below: 0.65` → `deep` |

**两个结论互相独立**，这是设计好的口径：

- `check` 判定只决定**还要不要再改一轮**，不作为出稿质量结论；判定不可用时回退 `composite_score >= pass_score` 规则。
- `passed` = 最后一轮的 `composite_score >= pass_score`，纯确定性阈值。
- `composite_score` 由**脚本按维度权重回算**；模型自报的 `total` / `verdict` 只以 `reported_score` / `reported_verdict` 留痕（偏差 >5 记警告），读取端与闸门不得用自报值。
- 每条评分带 `scorer`（`model` / `rule` / `mock`）与 `scorer_model`——不同模型的分是不同量纲，跨模型历史分数不可比较。

## 节点表（`config/wechat-article/steps/30-review.yaml`）

| 节点 | handler | 模型调用 | 提示词 id | 校验契约 | 写 |
| --- | --- | --- | --- | --- | --- |
| `review` | `builtin:review_article` | 无 | 无 | 无 | `03-step/round-<n>/correct.json`、`after-correct.md` |
| `revision` | `builtin:revise_article` | `revise=llm.large`（可 `rounds` 覆盖） | `revision.revision` | 无（纯文本改写，形状由代码闸门保证） | `03-step/round-<n>/after-revise.md`、`round-<n>-diff.md` |
| `scoring` | `builtin:score_article` | `score=llm.large`、`check=systemone.classifier` | `review.scoring`、`review.check` | `review.scoring`（模型输出）、`review.result`（result 本体） | `round-<n>/score.json`、`round-<n>/check.json`、`03-step/reviewed.md`、`03-result.json` |

## 产物地图

```
draft/<slug>/
├── 03-result.json          rounds[]（每轮 word_count / correct / score / check）+ final + passed + pass_score
└── 03-step/
    ├── round-1/            correct.json · after-correct.md · after-revise.md · score.json · check.json
    ├── round-2/ …
    ├── round-1-diff.md     本轮相对上一稿的改动摘要
    ├── reviewed.md         ★ 交给 04 的审稿稿
    └── api/                01_<轮次>-correct.correct-cn、02_<轮次>-sensitive.correct-cn、
                            03_<轮次>-revise、04_<轮次>-score、05_<轮次>-review_check
```

`03-step/round-<n>/correct.json` 里是**过滤后的候选**与敏感词摘要（命中数、去重词、分类计数）；
`after-correct.md` 与 `after-revise.md` 是本轮的两份稿子，`round-<n>-diff.md` 给人看改动。

## 闸门与中断

| 情况 | 行为 |
| --- | --- |
| 修正稿字数不在 `type.length` 区间 | 带原因重新调用（`--length-attempts`，默认 3 次）；**耗尽仍不合格 → 抛错中断管线** |
| 评稿输出不合契约 | 前置失败原因做修复重试（`<label>-fixN` 留痕），上限 = `retry_limit` |
| 判断模型不可用 | `check` 回退 `composite_score >= pass_score` 规则，`source` 记明 |
| 达到最大轮次仍是 `continue` | 保留当前稿件并 `warn`，不判失败 |
| 核稿服务不可用 | `correct_cn.enabled: false` 或调用失败只让候选为空，循环照常跑 |

## 开关

| 想改什么 | 改哪里 |
| --- | --- |
| 轮次上限（默认 3，加载期 clamp 1-5） | `.env` `PB_REVIEW_ROUNDS`；单篇临时改用 `--rounds` |
| 通过线 | `.env` `PB_PASS_SCORE`（一抬统一四类）；不设时吃各类型 `${PB_PASS_SCORE:-78|82}` |
| 评分维度与权重 | `types/<id>.yaml` 的 `scoring_criteria`（类型身份，不做环境变量） |
| 关掉外部核稿 | `defaults.review.correct_cn.enabled: false` |
| 某轮换模型 | `30-review.yaml` 的 `models.revise.rounds.<n>` / `models.score.rounds.<n>` |

## 排障

| 现象 | 先看 |
| --- | --- |
| 每轮改动很小 | `round-<n>-diff.md`；`check.json` 的 `decision` 与理由 |
| 评分忽高忽低 | `score.json` 的 `scorer_model`；跨模型不可比，先看是否轮次换了模型 |
| 敏感词把稿子改坏 | 敏感词只留痕、从不进提示词——看 `correct.json#sensitive` 与 `03-step/api/02_*-sensitive*.json` |
| 候选全是误报 | correct-cn 长文漏报/误报是已知情况，`review_suggestions` 类 prose 字段从不消费，只吃过滤后的 `candidates` |
| 中断在字数 | 看 `03-step/api/03_*-revise*.json` 的失败原因与 `type.length`；必要时放宽区间或调 `--length-attempts` |
