# 选题方案：双窗口 + 词频热度表

## 定位

自动选题是**辅助功能**，主要用于验证整条流水线的连通性；有明确主题时优先用
`--topic` 手动指定（跳过选题模型）。因此方案刻意保持简单：不做聚类、不做 embedding、
全流程只有**一次**选题模型调用。

## 两个日期，两个窗口

知识库每天持续采集，文档上有两种"日期"，含义不同：

| 窗口 | 数据来源 | 含义 | 默认 |
|---|---|---|---|
| 大样本（候选池） | 文件日期 = frontmatter `date` > 文件名日期 > mtime 兜底（`note.date`） | 内容新鲜度 | 近 15 天 |
| 小样本（标记） | 采集日期 ≈ 文件修改时间（`note.mtime`） | 入库活跃度 | 近 7 天 |

- 大样本：文件日期在 15 天内的文章进入候选池，封顶 40 篇（按日期倒序截取）。
- 小样本：候选池内 mtime 在 7 天内的条目标记 `[新采集]`，热度表统计"近 7 天新采集"篇数。
- 已知取舍：「旧文新采」（文件日期很旧、今天刚入库）会被 15 天文件窗口挡在池外，
  接受此行为——旧内容不应驱动选题。若采集管线会重写旧文件，mtime 会被误判为
  新采集，目前同样接受。

## 流程

```
indexKnowledge（增量缓存，全量扫描成本可忽略）
   → pickRecent(days=candidate_days, limit=max_candidates)   # 大样本池
   → 标注 days_ago / 新采集                                    # 小样本标记
   → termHeatmap(top=15, fresh_days=7)                        # 确定性热度表
   → listWrittenArticles(published/*.zip + draft/)            # 已写清单
   → 一次 LLM 调用：标题列表 + 热度表 + 已写清单 → 3 个候选主题（带评分）
   → 确定性校验（source_hints 必须来自给定标题；与已写标题撞车的候选剔除并用规则回填到 3 个）
   → systemone 择题判定：3 个候选选 1（choice = 编号，两段式升级同样生效）
   → 01-step/proposal.json（全部候选 + picked）；选定主题 → 01-result.json（下游与元信息都读它）
   → 判断模型（System One）按标题+主题定类 → 下游按类型继续
```

### systemone 择题判定

写作模型给候选和评分，最终"写哪个"交给判断模型（与定类共用端点和两段式升级策略）：

- 请求：`/v1/systemone`，question `topic_pick`，选项 `1..N`，criteria/state 里带上
  每个候选的标题、写作模型评分、核心判断与素材标题；
- instructions 明确"评分只作参考、编号只是标签"，避免照抄评分顺序或位置偏置；
- 返回的 choice 换算成 `picked.index` 写进 `01-step/proposal.json`，并并入 `01-result.json` 的 `picked` 字段；
- 判定不可用（未配置/失败/返回非法编号）时按评分第一篇，记 warn，不阻塞管线；
- 只有 1 个候选（规则回退）时跳过判定。

### 选题在前、分类在后

auto 入口进入管线时**不预设文章类型**：

- 选题阶段用所有启用类型 `knowledge_dirs` 的**并集**建池，prompt 中类型相关字段
  （栏目名、读者、篇幅）全部可缺省；
- 主题确定后再调用 System One 判断模型（`classifyOrFallback`），由它对类型**定权**；
- 类型优先级：断点续跑（`01-result.json` 的 `type`）> `--topic` 手动入口的分类结果 > 判断模型 >
  `--type`/环境变量提示 > `classifier.default_type`；
- `--type` 从"指定即生效"降级为**回退提示**（判断模型不可用/失败时才起作用）。

### 词频热度表（确定性，零模型调用）

对候选池内每篇文档跑已有的 `buildTerms`（输入 title + tags + summary + 正文前
2000 字），按 term 聚合：

```
term        篇数  最近日期        距今天数  近7天新采
本地部署      6   2026-10-12        8        3
ollama        5   2026-10-15        5        2
```

- tag 是 LLM 打的、同类内容未必同 tag——热度表按 **term 跨文档聚合**，天然绕过
  tag 不一致问题，因此候选列表本身**不再输出逐篇 tags / summary**。
- 排序：篇数优先，同分按最近日期；取 top 15，丢弃只出现在 1 篇里的孤词。

### 提交给模型的内容

1. 候选列表：`编号. 《标题》 · N天前 [新采集]`（只有标题和时效标注）；
2. 热度表（如上）；
3. 已写过的文章列表（见下）；
4. 栏目类型、目标读者、目标篇幅、补充要求（auto 入口未定类时各项留空）。

**实时性约束**：所有日期一律换算成"距今天数"随条目给出，system prompt 写明
「时效以给定的距今天数为准，不要自行推断当前日期或文章新鲜度」。模型只消费
计算好的数字，不猜。

### 已写清单（避免写重）

`listWrittenArticles()` 从两处收集已写/在写文章标题（按日期倒序，默认封顶 60 条）：

- `output/published/*.zip`：直接解析 zip 中央目录，读取包内 `06-result.json` →
  `01-result.json` 中的标题（旧归档回退 `01-topic.json`，逐个回退）；
- `output/draft/*/`：尚未归档的文章目录。

用途有两层：

1. 提示词层：整段列表随候选一起给模型，并要求「严禁与已写过的文章重复：事件、
   标题、核心判断任一撞车的候选会被程序直接作废」；
2. 校验层（确定性）：候选主题的 title 与任一已写标题做 `buildTerms` 词面重合，
   重合比例 ≥ 0.6 时回填 `duplicate_of` 并**直接剔除**（systemone 不做查重，撞车
   候选不允许进入择题环节；仅当全部候选都撞车时才原样保留兜底）。剔除后不足
   3 个选项时，由本地按时间顺序用规则候选回填并再校验一次，保证 systemone
   始终拿到 3 个非重复选项。人工续写旧题仍可绕过：`--topic` 或 `--from-proposal`。

### 模型输出与校验

输出 3 个候选主题，每个含 `score`（0-100）、`topic/title/thesis/angle/rationale/
keywords/title_candidates` 和 `source_hints`。确定性校验：

- `source_hints` 与给定候选标题做包含匹配，剔除无效引用；
- 与已写标题词面重合 ≥ 0.6 的候选标记 `duplicate_of` 并剔除（全部撞车时才保留兜底）；
- 校验后不足 3 个时用最新候选文章按规则回填，再校验一次；
- 剔除后无有效引用、或引用条目全部非 `[新采集]` 且热度表无支撑的候选降为末位；
- 模型失败时退回规则选题（最新文章标题），与现状一致——保证连通性测试总能跑完。

## 配置字段（config/wechat-article/types/*.yaml）

```yaml
topic:
  keywords: [...]        # 既有
  exclude_keywords: [...] # 既有
  candidate_days: 15     # 大样本：文件日期窗口
  fresh_days: 7          # 小样本：采集窗口
  max_candidates: 40     # 候选池封顶
  proposals: 3           # 模型输出候选数
  # lookback_days / candidates 为旧字段，作为对应新字段的回退值
```

## 改动点

| 文件 | 改动 |
|---|---|
| `scripts/lib/knowledge.mjs` | 新增 `daysAgo()` / `isFreshlyCollected()` / `termHeatmap()` / `formatHeatmap()` |
| `scripts/lib/zip.mjs` | 新增 `readZipEntry()`：解析中央目录读取归档内单文件 |
| `scripts/lib/article-store.mjs` | 新增 `listWrittenArticles()`；`ARTIFACT.topicProposal` |
| `scripts/lib/prompts.mjs` | `buildTopicPrompt` 改为标题列表 + 热度表 + 已写清单输入，输出多候选带 score；类型字段可缺省 |
| `scripts/wechat-article.mjs` | `selectTopic` 走新窗口配置、写 `01-step/proposal.json` + `01-result.json`、校验 source_hints/查重；auto 入口 deferred 定类（选题在前、分类在后） |
| `config/wechat-article/prompts/topic.yaml` / `config/wechat-article/schemas/topic.yaml` | 与运行时的模板/结构保持同步 |
| `config/wechat-article/steps/10-topic.yaml` | `select_topic` artifacts 为 `01-result.json` + `01-step/` 中间文件 |
| `config/wechat-article/types/*.yaml` | topic 段增加 `candidate_days / fresh_days / max_candidates / proposals` |

## 明确不做（等选题升级成真需求再说）

- 文档聚类 / 主题簇 / 簇命名；
- 多维加权打分公式（查重只做标题词面重合，不做内容级相似度）；
- embedding 检索；
- `01-result.json` 与 `01-step/`（topic.md、proposal.json）之外的新产物层级。
