# web-search：用 opencode 工具节点做外部网页检索

> 公众号文章流水线（wechat-article）的**通道 2**：本地知识库素材不足时，出门做一次真实网页检索补料。
> 本文只讲这一件事——功能边界与实现方式。三通道（本地 / 外部 / 推理要点）的整体设计见
> [materials-collection.md](materials-collection.md)，产物编号与留痕命名规范见 [artifacts.md](artifacts.md)。
>
> 执行模块：[`scripts/lib/web-search.mjs`](../../scripts/lib/web-search.mjs)（共享机制层，无功能前缀）
> 管线接入点：`scripts/wechat-article.mjs` → `resolveSources` → `mergeWebSearchSources`
> 配置单源：`config/wechat-article/defaults.yaml` → `defaults.knowledge.web-search`（类型文件可覆盖）
> 步骤节点声明：`config/wechat-article/steps/10-topic.yaml` → `gather_materials`

## 1. 这个功能是什么

给一个关键字组，返回**一份 Markdown 检索结果**（若干条 `## [标题](URL)` + 页面摘录），并把它们变成
与本地素材同构的条目并入 `01-result.json#sources`，供后续纲要与初稿引用。

三个刻意的设计约束：

1. **模型只当发令员，不当转述者。** 检索结果直接取 opencode 消息里已完成的 `websearch` tool part
   的原始输出，不经过本地模型复述——避免小模型改写、摘要、编造链接。
2. **检索本身免 key。** 真正的抓取与搜索由 opencode 的托管后端完成，本地模型只负责发起一次工具调用，
   所以这条通道几乎不占我们自己的 token 预算（一次调用约 20 token）。
3. **opencode 只作为工具节点被脚本调用。** 项目的编排规范禁止用 agent/skill 编排；这里脚本自己拉起
   `opencode serve`、用完立刻回收，不留常驻服务。

因此它**不是模型调用**：不进 `config/models.yaml`，也不写进 steps 节点的 `models` 注册表；`web-search.model`
是 opencode 侧自己配置的 `provider/model`（当前 `ollama-local/qwen3.5:9b`），与流水线的写作模型互不相干。

## 2. 实现方式（一条链路）

```
闸门判定 assessSourceSufficiency(localSources)      ← 纯代码信号，不调模型
   │ ok → 跳过，不联网
   ▼ 不足
buildSearchQueries(topic, max_queries)              ← 标题一组 + 关键词一组，各带年份
   ▼
ensureServer()                                      ← 复用固定端口 / 自起临时 opencode serve
   ▼  各组并行
websearch(query)                                      ┌ OpenCode.make(baseUrl, Basic 鉴权)
   ├─ session.create(model)                          │
   ├─ session.prompt("调用一次 websearch …只回 DONE") │  一句固定 prompt，不自由发挥
   └─ 每 8s 轮询 message.list，取 completed 的 tool part 原始输出 → Markdown
   ▼
wrapSearchMarkdown → 01-step/web-search/<slug>.md   +  index.json（每组状态与命中数）
   ▼
parseSearchMarkdown（按 `## [标题](URL)` 切块，取 max_per_query 条）
   ▼
与本地素材合并、统一重排 index → landSources → 01-step/sources/*.md + 01-result.json#sources
```

### 2.1 serve 生命周期（不留孤儿是硬要求）

`ensureServer()` 四条路径，返回统一的 `{ baseUrl, password, reused, close() }`：

| 情况 | 行为 |
| --- | --- |
| 配了 `OPENCODE_SERVE_PORT` 且 `/api/session` 探测返回 200 + 口令对 | **复用**已运行的 serve，`close()` 是空操作（不关别人的进程） |
| 端口有 serve 但口令不符（401/403） | warn 提醒核对 `.env`，**降级**到随机端口临时起一个 |
| 端口空闲 | 以固定端口 + 固定口令起 serve，用完 `close()` 关掉 |
| 没配端口 | 随机端口（20000–39999）临时 serve |

自起进程的安全网：

- 启动靠轮询 stdout 解析 `server listening on …` 与 `server password …`（环境里已有
  `OPENCODE_SERVER_PASSWORD` 时 serve 不打印口令行，直接吃环境值），30s 起不来就报错。
- 启动超时 / 提前退出 / 正常收尾，一律**按进程树杀**：Windows 走 `taskkill /pid /T /F`
  （`shell:true` 下 `kill()` 只杀 shell 包装，会漏掉真正的 serve），非 Windows 走 `SIGTERM`。
- **存活看门狗** = 单组检索超时 + 60s 余量（`SERVE_LIFETIME_SLACK_MS`）。定时器到点主动回收并打 warn，
  保证调用方卡死或异常时端口不会悬着。余量必须大于超时，否则看门狗会先把还在跑的检索掐断，
  客户端只看到一个没头没尾的 `Transport: fetch failed`。定时器 `unref()`，不阻止 node 正常退出。

### 2.2 一次检索的具体动作

- 会话标题 `web-search-<ts>`，模型 = `{providerID, modelID}`（`parseModel()` 支持
  `"provider/model"` 字符串或对象，缺省读 `OPENCODE_DEFAULT_MODEL`，再兜底 9b）。
- prompt 文案固定：`调用一次 websearch 工具，query 参数原样使用：<query>。然后只回复 DONE。`
  —— 让模型没有改写检索词、也没有自由发挥的空间。
- **不用 `session.wait()`**：它的长轮询会被 fetch 的 300s `headersTimeout` 掐断。改成每 8s
  调 `message.list({ sessionID })`，扫到 `status === "completed"` 的 websearch tool part 就取文本返回；
  期间发现 assistant 消息带 `error` 立即抛出（不白等）。
- `extractSearchMarkdown()` 从消息尾部反向找**最近一次**已完成的 websearch 输出；v2 的原生形状是
  `## [标题](URL)` + 摘录，直接当 Markdown 用；旧版返回 JSON 结果列表时走 `resultsToMarkdown()` 兼容转换。
- 成功后 `session.remove()` 清理会话（失败忽略）；无论成败 `finally` 里只关闭**本次自己起的** serve。

### 2.3 超时与并发

- `searchWebSearch(queries)` 让各组**并行**（同一个 serve 上各开一个会话），所以
  `timeout_ms` 是外部检索的**总时长上限**，不随 `max_queries` 线性放大。
- 单组失败只 warn 并在 `index.json` 记 `status: failed`，其余组与本地素材照常并入。
- `timeout_ms` 单源是 defaults.yaml；模块里的 `DEFAULT_SEARCH_TIMEOUT_MS = 180000` 只在配置缺项时兜底，
  两处不各设一套互相矛盾的默认值（有单测专门盯这条：`gatherWebSearch 的单组超时来自配置，不吃代码默认值`）。

## 3. 配置

```yaml
# config/wechat-article/defaults.yaml → defaults.knowledge.web-search
web-search:
  enabled: true            # 总开关；即便如此也只在闸门判不足时才出门，--mock 永不联网
  model: "${OPENCODE_DEFAULT_MODEL:-ollama-local/qwen3.5:9b}"   # opencode 侧的 provider/model
  max_queries: 2           # 最多几组关键字（标题一组 + 关键词一组）
  max_per_query: 3         # 每组结果解析取几条
  max_sources: 6           # 外部素材并入条数上限（≠ 通道 1 的 knowledge.max_sources=8，闸门算 minHits 用后者）
  excerpt_chars: 800       # 单条摘录截断长度
  timeout_ms: 180000       # 单组超时；各组并行 → 也是外部检索总时长上限
  gate:                    # 充分性闸门阈值（决定要不要出门）
    min_hits_ratio: 0.5    # 本地命中数 < 通道 1 的 knowledge.max_sources(=8) × 该比例 = 4 → 不足
    min_excerpt_chars: 3000  # 本地摘录总字数下限
    min_hint_coverage: 0.5 # 选题 source_hints 的覆盖率下限
    fresh_days: 90         # 没有任何命中落在此窗口内 → 不足
```

- **三层取值口径**（就近覆盖，越靠后越优先）：
  1. defaults.yaml 的 `web-search` 段（`enabled` 由 `.env PB_WEB_SEARCH_ENABLED` 抬起，
     `model` / `timeout_ms` / 各阈值 / `gate` 都在这段）；
  2. 类型文件 `config/wechat-article/types/<id>.yaml` 的 `knowledge.web-search` **嵌套覆盖**
     （可只改个别阈值，资讯类开、随笔类关掉出门检索）——目前四个类型都还没有实际覆盖，单源仍是 defaults；
  3. `OPENCODE_DEFAULT_MODEL` / `OPENCODE_SERVE_PORT` / `OPENCODE_SERVER_PASSWORD` 环境变量。
- **加载器不再铺同值默认**：`scripts/lib/config.mjs` 只做 defaults+type 合并，唯一给的地板是
  `enabled`（没配 = 关，这是语义而不是配置副本）。`max_queries / max_per_query / max_sources /
  excerpt_chars / timeout_ms` 由 `web-search.mjs#gatherWebSearch` 用 `needNumber` 逐项要求，
  缺了抛错点名 `defaults.yaml defaults.knowledge.web-search.<key>`。
- `DEFAULT_SEARCH_TIMEOUT_MS` 只留给 serve 存活期与**直接调用本模块**的使用者，不再吃进配置路径。
  历史上两处各写一份 600000 互相矛盾，只会掩盖 serve 存活期冲突。
- 闸门阈值 defaults + type 两段合并后交给 `assessSourceSufficiency`；它接受的 gate map 允许只写
  个别判据（lib API 部分入参默认，缺的那条判据吃函数内的默认），管线走的路径上 defaults.yaml 四条都写满。

### 环境变量（根目录 `.env`，不入库、不打印值）

| 变量 | 用途 |
| --- | --- |
| `OPENCODE_DEFAULT_MODEL` | 检索模型（opencode 侧 `provider/model`），`web-search.model` 引用它 |
| `OPENCODE_SERVE_PORT` | 固定 serve 端口：能连上且口令对 → 复用；连不上 → 自起自关 |
| `OPENCODE_SERVER_PASSWORD` | serve 的 Basic 认证口令（复用探测与自起都用它） |

依赖：`@opencode/client@^2.1.1`（官方 v2 客户端）+ `opencode` CLI（实测 v2.0.32）。
`ollama-local` 这个 provider 要在 **opencode 自己的配置**里存在，仓库的 `opencode.json` 只定义
commands 与 agent 权限，不定义检索模型。

## 4. 产物与留痕

```
01-step/
  ├── web-search/<slugified-query>.md    # 每组关键字一份原文（重跑覆盖，不带时间戳）
  ├── web-search/index.json              # 检索清单：每组 query / file / status / hits / error
  ├── sources/<index>-<slug>.md          # 并入后的每条素材正文（frontmatter 溯源 + 摘录）
  └── api/5_<轮次>-websearch.<model>.json  # 每次外部调用的 request+response 留痕
```

- 落地文件头尾：`# 外部检索：<关键字组>` + `<!-- fetched_at: <ISO> | provider: opencode/websearch -->`。
- `index.json` 形状：`[{ query, file, status: ok|empty|failed, hits?, error? }]`——单组失败也有记录，
  不会出现「静默少了几条却查不到原因」。
- 留痕命名按全局规范：`5` 来自 `API_SLOT.topic.web_search = "05"`（01 步内的固定子步骤号），
  轮次 = 第几组关键字（按 label 计数），服务段是模型名（`ollama-local_qwen3.5_9b`，`/` 与 `:` 转下划线）。
- **留痕里没有鉴权信息**：只记 query、发出去的 prompt 文本、结果 Markdown 与耗时；
  baseUrl / password / Authorization 头一律不落（规范见 AGENTS.md 产物布局一节）。

`sources` 里的外部条目与通道 1 同构，所以下游（`formatSources` 纲要段、`buildDraftInput` 资料段、
充分性闸门回读）不区分来源：

```jsonc
{ "file": "01-step/web-search/xxx.md",   // 共享的落地文件（多条目可同属一个文件）
  "title": "网页标题", "url": "https://…", "source": "https://…",
  "date": "检索当天", "tags": [], "summary": "摘录前 160 字",
  "excerpts": ["截断到 excerpt_chars 的摘录"], "score": 0, "origin": "web" }
```

`01-result.json#sources` 对外只露 `{index, title, link}`（`link` 相对文章目录、`/` 分隔），
细节靠 `loadSource(entry, { baseDir })` 从落地 MD 回读。

## 5. 实测数据（真实模型 + 真联网，非 stub）

来自各文章目录 `01-step/api/*-websearch.*.json` 的真实留痕：

| 文章 | 留痕文件 | 耗时 | 结果字符数 |
| --- | --- | --- | --- |
| 25亿美元零收入公司…AI能耗危机 | `5_1-websearch.ollama-local_qwen3.5_9b.json` | 49.0s | 1,547 |
| Meta-AI-助手-Muse… | `5_1` / `5_2` | 41.0s / 49.0s | 17,841 / 10,725 |
| 美国禁用-DeepSeek…（= zz-04-audit 同源稿） | `5_1` / `5_2` | 41.2s / 49.2s | 24,220 / 11,527 |

要点：

- 单组耗时稳定在 **40–50s**（文档早期记的 40–170s 区间上限来自冷加载与托管后端抖动，不是模型吞吐；
  模型只出一个约 20 token 的工具调用）。
- 各组并行 → 两组关键字的外部检索总耗时 ≈ 50s，不是 100s。
- 结果体量差异很大（1.5KB–24KB），落地文件与 `index.json#hits` 都能对上；命中条数由
  `max_per_query` 截断，不等于检索结果实际条数。

## 6. 失败与降级矩阵

| 故障 | 行为 | 可观测处 |
| --- | --- | --- |
| 本地素材充足 | 跳过，不联网、不起 serve | 日志 `本地素材充足（N 篇），跳过外部检索` |
| `web-search.enabled: false` 或 `--mock` | 直接不调用（mock 永不联网） | `mergeWebSearchSources` 提前返回 |
| serve 起不来 / 整体抛错 | warn 后**用本地素材继续**，不阻塞选题 | 日志 `外部检索不可用：<原因>`；无留痕或有 `error` 留痕 |
| 单组超时（180s） | 该组记 `failed`，其他组照常并入 | `index.json#status=failed`、留痕 `error` |
| 会话内 assistant 报错 | 立即抛错，不继续轮询到超时 | 留痕 `error` |
| 固定端口被占且口令不符 | warn + 降级随机端口临时 serve | 日志提示核对 `.env` 的 `OPENCODE_SERVER_PASSWORD` |
| 结果解析为空 | 落地文件仍保留，条目为 0 | `index.json#status=empty` |

## 7. 已知限制

1. **`session.prompt()` 带 60s 超时**，早于 `timeout_ms`（180s）。实测 40–50s 安全，但托管后端若抖到
   分钟级以上会先撞上这个上限。真要放宽需同步改 prompt 调用的 signal。
2. **模型必须配在自己的 opencode 里**：`provider/model` 不存在时错误发生在 serve 侧，表现为会话报错。
3. **结果不相关不过滤**：opencode 的搜索结果原样落地，与主题的相关性判断留给下游（选题 prompt 的
   `source_hints` 覆盖信号只是间接提示，见 #61 选题质量问题）。
4. **版权口径**：只截取摘录段落地，不整篇复制。
5. **搜索 API 加速档未做**：Tavily / Bocha 等直连搜索 API（`web-search.provider: tavily` +
   `PB_WEB_SEARCH_API_KEY`）仍是保留方案，未实现。

## 8. 单独运行与测试

```bash
# 独立跑（不经管线，自行加载根目录 .env；已有环境变量优先）
node scripts/lib/web-search.mjs "Meta AI 助手 Muse 2026" "LLM agent 框架 2026" \
  [--model ollama-local/qwen3.5:9b] [--out result.md]
# exit 0 = 全部成功；exit 2 = 至少一组失败（失败原因打到 stderr）
```

单测（`npm run test:sources`，stub 掉 `searchImpl`，不联网）：

- 闸门：`assessSourceSufficiency` 四信号通过 / 全失败 / 缺失 hints 与阈值可配 三例；
- 解析：`parseSearchMarkdown` 只认 `## [标题](URL)`、丢文件尾注释；
- 关键字：`buildSearchQueries` 标题去尾标点 + 年份、关键词一组；
- 编排：`gatherWebSearch` 闸门放行时不联网、落地 `web-search/*.md` + `index.json` 并返回 web 条目、
  失败组记 `status: failed` 不抛错、单组超时吃配置不吃代码默认值；
- 下游：`landSources` 落条 + `formatSources`/闸门从 `link` 回读正文、续跑复用已落地条目。

真实验证路径：`node scripts/wechat-article.mjs topic --type <id>`（会真实起 serve、真实联网），
跑完核对 `01-step/web-search/`、`index.json` 与 `01-step/api/5_*-websearch.*.json` 三处是否自洽。
