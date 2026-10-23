# 资料收集方案：本地 + 外部网页 + 推理要点

> 选题阶段（01）的第 3 个节点：`select_topic → classify_type → gather_materials`。
> 素材收集**不单独成阶段**：每条素材正文落 `01-step/sources/*.md`，`01-result.json` 的
> `sources` 只留链接条目；外部检索原文落 `01-step/web-search/`，因此产物编号从 01 直接接到 02 纲要。
>
> 现状：通道 1 已有；通道 2 的执行模块 `scripts/lib/web-search.mjs` 已落地并真实验证，
> 已接进 `resolveSources`；通道 3 未实现。

## 1. 现状与目标

现状（`resolveSources` → `collectSources`）：

- 输入：定好的主题（title/thesis/keywords/source_hints）+ 定类后的类型配置；
- 检索：本地知识库目录（`searchKnowledge`）+ 可选 WeKnora（`searchWeKnora`），
  按词面相关度混排，取 `max_sources=8` 篇、每篇截取 `excerpt_chars` 段落；
- 输出：`landSources` 把每条素材写进 `01-step/sources/<index>-<slug>.md`（frontmatter 溯源 + 摘录正文），
  `01-result.json#sources` 只留 `{index, title, link}`（续跑时该字段非空就直接复用，不重复检索；
  其余字段按 `link` 回读落地 MD）。

目标：收集到**足以支撑写作**的资料，而不仅是"相关文档"——

1. 本地已写过的内容（避免重复、便于引用旧文）；
2. 外部最新事实（本地知识库没采到的新闻、数据、原文）；
3. 由前两者推理出的**知识要点**（事实/数据/引言/案例/反方观点），供大纲和初稿直接消费。

## 2. 三通道总览

```
01-result.json 的选题字段（title / thesis / keywords / source_hints / type）
   │
   ├─ 通道 1  本地 + WeKnora 检索                （已有，小改）
   │     ↓ 充分性闸门（纯代码信号，不足才出门）
   ├─ 通道 2  外部检索（opencode websearch）     （已接入，闸门控制是否出门）
   └─ 通道 3  推理知识要点（一次 LLM 调用）       （新增）
   │
   ▼
01-result.json#sources = [...通道 1/2 合并的链接条目]，#knowledge_points = [...]
01-step/sources/*.md（素材正文）、01-step/web-search/*.md + index.json、points-raw.json
```

原则：

- **先判定再出门**：通道 2 只在确定性信号显示本地不足时执行，不做"每次都搜"。
- **失败不阻塞**：任一通道失败记 warn，用其余通道继续；全空才报错（与现状一致）。
- **mock 离线**：`--mock` 下通道 2 跳过网络、通道 3 用规则要点，保证连通性测试。
- **来源可溯**：每个 excerpt / 要点都带 `source`（本地=资料 frontmatter 的 `source` 字段
  （剪存来源），没有才回退本地文件路径 / weknora:// / https://），
  终稿引用与入库脚本都能回溯。

### 充分性闸门（通道 1 → 2 的开关，不调模型）

四个确定性信号，任一不达标就走外部检索：

| 信号 | 阈值（默认） | 说明 |
| --- | --- | --- |
| 命中条数 | `≥ max_sources/2`（=4） | 本地检索结果数量 |
| 摘录字数 | `Σ excerpt ≥ 3000` 字 | 真正能喂给模型的正文量 |
| source_hints 覆盖 | `≥ 1/2` 命中 | 选题时模型点名的素材是否真找到 |
| 时效 | `≤ 90` 天内至少 1 篇命中 | 实现上不区分类型（四个类型的选题窗口都带 fresh_days，无法作为资讯特征判据）；阈值 `gate.fresh_days` 可配 |

## 3. 通道 1：本地知识库 + WeKnora（已有）

改动两点：

1. **source_hints 加权**：选题时模型给过素材标题（`source_hints`），检索命中的
   文档标题在 hints 列表里 → `score × 1.5`，排在最前。选题的依据本来就是这几篇，
   写作时应优先吃透。
2. **命中不足时放宽窗口**：`lookback_days`（365）内不足 `max_sources/2` 篇时，
   再扫一次全量（不加日期过滤），标记 `fresh=false`。

输出结构不变（title/file/date/tags/excerpts/score/origin，均为真实字段名），`origin` 增加 `local|weknora` 已有。

## 4. 通道 2：外部检索（opencode websearch，已接入）

执行模块：`scripts/lib/web-search.mjs`（独立模块，可单独跑：
`node scripts/lib/web-search.mjs "关键字组1" "关键字组2" [--model provider/model] [--out result.md]`）。
管线接入：`resolveSources` → `mergeWebSearchSources` → `gatherWebSearch()`
（闸门 → 关键字 → `searchWebSearch` → 落地 → 转条目），模型取
defaults.yaml `defaults.knowledge.web-search.model`。

链路：脚本自起 `opencode serve` → 官方 v2 客户端 `@opencode/client` 建会话 →
一句固定 prompt 让模型**只触发一次** `websearch` 工具 → 脚本直接读消息里
已完成的 tool part 原始输出。**结果不经过模型转述**，本地模型只是"发令员"，
真正的检索由 opencode 的免 key 托管后端完成。

- 输出**原生就是 Markdown**（`## [标题](URL)` + 发布时间 + 页面摘录，单次约 11–21KB / 8 条来源），
  模块不再做格式转换；旧版 JSON 结果列表另有兼容分支。
- 时延：单关键字组 40–170s（4b/9b 都有实测；模型只出一次 ~20 token 的工具调用，
  波动主要来自冷加载与托管检索后端，不是模型吞吐）。
- serve 生命周期：配置了固定端口就复用（连上且口令对 → 不关；连不上 → 自起自关），
  自起的 serve 另有 10 分钟最大存活看门狗；启动失败/超时也会按进程树杀掉，不留孤儿。
  环境变量：`OPENCODE_DEFAULT_MODEL` / `OPENCODE_SERVE_PORT` / `OPENCODE_SERVER_PASSWORD`。

保留备选：搜索 API（Tavily / Bocha 等，`web-search.provider: tavily` + `PB_WEB_SEARCH_API_KEY`）
作为高频阶段的加速档，当前不做。

### 落地规范（已实现）

- 关键字：`buildSearchQueries(topic)` 最多 `max_queries` 组——标题去尾标点 + 年份一组、前 4 个关键词 + 年份一组；
- 目录：`01-step/web-search/<slugified-query>.md`（每组关键字一份，`wrapSearchMarkdown()` 加文件头）；
- 文件头：`# 外部检索：<关键字组>` + 结尾 `<!-- fetched_at / provider: opencode/websearch -->`；文件名不带时间戳，重跑覆盖；
- 清单：`01-step/web-search/index.json` = `[{query, file, status: ok|empty|failed, hits?, error?}]`；
- 单组失败只记清单 `status:failed`，其他组继续；整个 serve 起不来时 `mergeWebSearchSources` 捕获并 warn，素材保持本地结果。

### 进入 sources 数组（已实现）

`parseSearchMarkdown()` 按 `## [标题](URL)` 切块（正文里的非链接 `##` 小节归上一条），
每组最多取 `max_per_query` 条，全局封顶 `max_sources` 条。每条是一个与通道 1 同构的条目：

```jsonc
{ "file": "01-step/web-search/xx.md",   // 共享的落地文件
  "title": "网页标题", "url": "https://…", "source": "https://…",
  "date": "检索当天", "tags": [], "summary": "摘录前 160 字",
  "excerpts": ["截断到 excerpt_chars 的摘录"], "score": 0, "origin": "web" }
```

本地 + 外部合并后统一重排 `index`，再由 `landSources` 落地瘦身（见下）。

### 素材落地与瘦身（已实现）

合并后的完整条目（含 `excerpts`）交给 `landSources(articleDir, sources)`：

- 每条写 `01-step/sources/<index>-<slug>.md`：frontmatter 带
  `title / origin / source / date / score`，**正文只放摘录段**（版权考虑，不整篇复制；
  `source` 字段保证可追溯——本地=资料 frontmatter 的 `source`（剪存来源），缺失才用知识库文件绝对路径，
  web=原文 URL，weknora=weknora://）；
- `01-result.json#sources` 瘦身为纯链接条目（其余信息全在 MD 里）：

```jsonc
{ "index": 1, "title": "…", "link": "01-step/sources/1-….md" }
```

（`link` 是相对文章目录的路径、统一 `/` 分隔：文章目录由输出配置固定，绝对前缀
不进 JSON，产物目录整体搬迁也不失效。）

- 下游读取统一走 `loadSource(entry, { baseDir })`：内嵌字段优先（运行中的完整条目、旧格式
  01-result.json、`--sources-file`），缺失的 `origin/source/date/score/excerpts`
  从 `link` 指向的落地 MD 回读（相对 `link` 按 `baseDir`=文章目录解析）；
  `formatSources`（纲要 prompt）、`buildDraftInput`
  （03 资料段）、充分性闸门的字数/时效信号都已接入；
- `--sources-file` 给定的数组同样走落地，统一转成链接条目；
- 文件名不带时间戳，重跑覆盖。

## 5. 通道 3：推理知识要点（新增，一次 LLM 调用）

输入：主题 + 论点 + 通道 1/2 的资料（截断到 ~12k 字）；
输出（schema：`topic.gather_materials` 之外的新增节点 `knowledge_points`）：

```json
{
  "points": [
    { "point": "一句话事实/数据/观点",
      "kind": "fact|data|quote|case|counterpoint",
      "sources": ["本地路径或 URL", "..."],
      "confidence": "confirmed|inferred" }
  ],
  "gaps": ["资料里没有但写作需要的事实类型"]
}
```

规则：

- `sources` 必须引用给定资料的 path/url，无引用的要点标 `inferred`；
- `gaps` 供大纲阶段提示"此处需要作者补充或另查"，不编造数字；
- 要点条数 5–12 条，`kind` 至少覆盖 fact + counterpoint（有反方素材时）。
- 模型：`llm.large`（这一步是全链路唯一"读资料后推理"的环节，质量优先；
  9b 已验证能按 schema 出 JSON，35b 更好但要接受分钟级耗时）；
  stub/mock：按资料标题生成 2 条占位要点，不联网。

## 6. 产物与续跑

```
01-result.json              # 选题步唯一公开产物：选题 + 类型 + sources 链接条目 + knowledge_points
01-step/
  ├── topic.md              # 选题人类可读版
  ├── proposal.json         # 候选与热度表
  ├── sources/*.md          # 每条素材一份（frontmatter 溯源 + 摘录正文）
  ├── web-search/*.md         # 外部检索落地（按关键字组）
  ├── web-search/index.json   # 检索清单（含失败记录）
  └── points-raw.json       # 要点模型原始输出（排错用）
NN-step/llm/M-label(_F).<model>.json  # 所属步骤 LLM/API 调用 request+response 留痕（M 按步骤内执行顺序递增）
```

- 完成判据不变：`01-result.json` 存在且 `title` 非空即选题步完成。
- 续跑：`sources` 非空 → 直接复用（`resolveSources` 读回，不重复检索）；
  为空数组（如旧版本写的 01）→ 本步补收一次。
- `--sources-file` 照旧覆盖：给定的素材数组直接并入，跳过检索。
- 步骤声明（10-topic.yaml）：`gather_materials.writes: ["01-result.json#sources"]`。

## 7. 配置（已落地）

```yaml
# defaults.yaml → defaults.knowledge.web-search（类型文件可个别覆盖，含 gate 阈值）
web-search:
  enabled: true            # 闸门判定不足且开启时才走通道 2；--mock 永不联网
  max_queries: 2           # 最多几组关键字
  max_per_query: 3         # 每组结果解析取几条
  max_sources: 6           # 最多并入几条外部素材
  excerpt_chars: 800
  timeout_ms: 600000
  gate:
    min_hits_ratio: 0.5    # 命中数 < max_sources × 该比例 → 不足
    min_excerpt_chars: 3000
    min_hint_coverage: 0.5
    fresh_days: 90
# 通道 3（推理要点）仍未实现：
# points: { enabled: true, max_input_chars: 12000 }
```

```yaml
# config/wechat-article/defaults.yaml → defaults.knowledge.web-search
    model: "${OPENCODE_DEFAULT_MODEL:-ollama-local/qwen3.5:9b}"   # 已落地
```

`web-search.model` 是 opencode 自己配置的模型（`provider/model`），与 `config/models.yaml`
无关；websearch 是 opencode 工具节点、不算模型调用，所以配置收在 defaults.yaml，
不进 steps 节点的 `models` 注册表（后者只认 models.yaml 的 id）。

类型文件（`config/wechat-article/types/*.yaml`）可各自覆盖 `web-search.enabled`（如 ai-news 开、随笔类关）。

## 8. 错误处理与降级矩阵

| 故障 | 行为 |
| --- | --- |
| 本地/WeKnora 全空 | 闸门必然不通过 → 通道 2 顶上；仍空则报错提示加 `--sources-file` |
| opencode 不可用 / 超时 | warn，`web-search/index.json` 记 `status:failed`，跳过通道 2 |
| 固定端口被别的 serve 占用且口令不符 | warn 后降级随机端口临时 serve（提醒核对 `.env`） |
| 单组关键字检索失败 | 只记清单，其他组继续 |
| 要点模型失败 | warn，`knowledge_points: []`，下游照常跑（资料本身够用） |

## 9. 测试

- 纯函数：闸门判定（四个信号）、hints 加权排序、web-search→sources 转换、
  要点 schema 校验（无引用 → inferred）；
- `web-search.mjs`：已真实验证（4b/9b 真模型 + 真联网，冷启动自起自关、固定端口复用、
  口令不符降级、启动失败不留孤儿四条路径都跑过）；
- 接入后 stub：桩掉 `searchWebSearch` 返回固定 Markdown，核对 `01-step/web-search/` 落地与合并结果；
- 真实验证：跑一次真实 `auto --stage topic`（披露真实模型），核对三通道产物。

## 10. 实施拆分（状态）

1. `knowledge.mjs`：hints 加权 + 放宽窗口（通道 1 小改）——未做；
2. 闸门：`assessSourceSufficiency()` 纯函数 + `web-search.gate` 阈值配置——已完成；
3. `wechat-article.mjs`：`resolveSources` 扩成闸门 + 通道 2（`gatherWebSearch` 落地
   `01-step/web-search/` 并并入 `01-result.json#sources`）——已完成；
4. 要点推理：prompt/schema + 一次 `json()` 调用，写 `#knowledge_points`——未做；
5. 测试：闸门/解析/编排 8 个单测进 `sources.test.mjs`（stub searchImpl）——已完成；真实 `topic` 全链路验证——见运行记录。
6. 素材落地：`landSources` 写 `01-step/sources/*.md`、`01-result.json#sources` 瘦身为链接条目、
   `formatSources`/`buildDraftInput`/闸门经 `sourceExcerpts` 回读正文——已完成。

## 待确认

1. ~~`web-search.enabled` 默认关还是全开？~~ 已定（2026-10-21）：默认开，由闸门决定要不要出门。
2. 通道 3 是否对 `--topic` 手动入口也生效（建议是，手动选题更需要补资料）？
3. 通道 3 放本轮还是等通道 2 跑顺后再做？
