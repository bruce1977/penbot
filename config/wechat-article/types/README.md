# 文章类型配置（`config/wechat-article/types/*.yaml`）

全局默认在 `config/wechat-article/defaults.yaml`，模型在 `config/models.yaml`（三管线共享），类型注册表在 `config/wechat-article/article-types.yaml`；这里只放**单个类型**的写作要求。
文件名建议与 `id` 一致（`ai-news.yaml` → `id: ai-news`），加载顺序由 `article-types.yaml` 的 `types:` 决定。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 类型标识，命令行 `--type` 用它；缺省取文件名 |
| `type` | 是 | 中文类型名，用于日志和提示词（兼容旧字段 `name`） |
| `enabled` | 否 | 默认 `true`；`false` 时不会被判断模型选中 |
| `description` | 否 | 一句话说明，判断模型会用它做分类 |
| `knowledge_base_path` | 是 | 本地知识库目录，字符串或数组 |
| `style` | 是 | 风格描述：字符串，或 `persona/tone/audience/title_style/structure/dos/donts` 对象。`tone`、`audience`、`title_style` **必填**（`validate` 缺项点名类型）：写作/纲要/评稿提示词直接引用它们，去 AI 化的目标风格与读者在消费点 `needConfig` 抛错，代码里不铺「自然、克制」这类副本；引用它们的整句（「文风：…」「目标风格：…」）只在 `prompts/*.yaml` |
| `word_limit` | 是 | `800-1300`、`1500`，或 `{ min, max, target }`；`target` 没写取区间中点。缺了或写成解析不出来的样子都在加载期抛错——字数区间是写作提示词和 de_ai 闸门的依据，代码里不垫 800-2000 |
| `pass_score` | 否 | 及格分，写成 `"${PB_PASS_SCORE:-78}"`：`.env` 设了就统一四类，没设时吃这里的默认。裸数字会掩盖环境变量，测试 `类型文件不复制 defaults 的轮次与裸通过线` 守住这一条 |
| `scoring_criteria` | 是 | 评分维度数组，每项 `{ id, name, weight, description?, criteria? }` |
| `image_count` | 否 | `1-5`、`3`，或 `{ min, max, default, cover }` |
| `image_position_format` | 否 | 配图标记模板，`{index}` 会替换成序号，默认 `[[img:{index}]]` |
| `topic` | 是 | `keywords` / `exclude_keywords` / `candidate_days` / `fresh_days` / `max_candidates` / `proposals`（机制见 `docs/topic-selection.md`）；`keywords`、`exclude_keywords` 可省略，四个窗口值**必填**：代码里没有 15/7/40/3 的副本，缺了选题直接抛错点名 `types/<id>.yaml 的 topic.<key>`。`auto` 入口定类前的占位类型也按这条走——它继承第一个 enabled 类型的 `topic`/`knowledge`/`model`，不吃内置默认。旧字段 `lookback_days` / `candidates` 的回退已删（没有任何类型用过） |
| `model` | 否 | 模型 id 的**末位回退**（运行时优先级 `--model` > 节点 `models.<调用名>.id` > `type.model`；类型没写时吃 `defaults.yaml defaults.model`）；正常情况下各步骤模型以节点配置为准。代码里不留 `"llm.local"` 这类同值副本：defaults.yaml 写的是 `llm.large`，配置被清空时静默换模型就是第三份真相 |
| `review` | 否 | 只覆盖 `correct_cn`（核稿端点/鉴权/超时）。`max_rounds` 与 `pass_score` 不在这里写：前者单源 `defaults.yaml review.max_rounds`（`PB_REVIEW_ROUNDS`），后者用上面的顶层 `pass_score`；评稿/修正模型在 steps 节点配置 |
| `steps` | 否 | 按节点覆盖 `enabled` / `handler_options` / `prompt` / `schema`（`prompt` 和 `schema` 写注册表 id）；模型调用不在 type 层覆盖 |
| `prompts` | 否 | 旧字段：`outline_extra` / `draft_extra` / `revise_extra`，会追加到对应节点的 `prompt.extra` |
| `publish` | 否 | 一般不用配；邮件/公众号渠道开关与知识库归档目录统一在 `config/wechat-article/defaults.yaml` 的 `defaults.publish`。环节级开关是 steps 节点 `publish.enabled` / `archive.enabled`，type 层要关就在 `steps:` 里覆盖 |

## 例子

```yaml
id: ai-news
type: AI 资讯快评
knowledge_base_path: D:/knowledge/obsidian/ai
style:
  persona: 科技媒体主编，能在信息噪音里快速指出真正重要的变化。
  tone: 干脆、直接、信息密度高。
  audience: 每天用碎片时间跟踪 AI 动态的从业者。
  title_style: 事件 + 影响，不超过 26 字。
word_limit: 800-1300
pass_score: "${PB_PASS_SCORE:-78}"
scoring_criteria:
  - id: timeliness
    name: 时效与新闻性
    weight: 25
    description: 事件是否足够新、足够重要。
image_count: 1-2
image_position_format: "[[img:{index}]]"
model: llm.local
```

## 覆盖步骤（可选）

`config/wechat-article/steps/` 定义每个节点的处理方法、模型调用（`models.<调用名>`）以及提示词/数据结构的 id。类型只需要写有差异的部分，优先级高于阶段文件：

```yaml
steps:
  select_topic:
    prompt: ai-news.select_topic   # 对应 config/prompts/ai-news.yaml 的 select_topic
    schema: ai-news.select_topic   # 对应 config/schemas/ai-news.yaml 的 select_topic
  draft_writing:
    enabled: false                 # 或覆盖 handler_options / input_format
```

提示词 id 的格式是 `<文件名>.<配置项>`，能直接定位到文件里的某一项：

```yaml
# config/prompts/ai-news.yaml
prompts:
  select_topic:
    system: |
      你是「AI 资讯快评」栏目的选题编辑，先事实后观点。
    extra: "只选 48 小时内、能落到具体产品变化的事件。"
```

只写 `extra` 时，会保留基础提示词的 `system` / `user`；写 `system` / `user` 则覆盖对应字段。

- `step_name` 必须与 `config/wechat-article/steps/` 里的节点一致。
- 只写要覆盖的字段；模型调用（含 id、retry_limit、timeout 等参数）单源在 steps 节点，type 层不覆盖。
- 提示词/数据结构只写 id，不在这里展开内容。
- 查看合并后的结果：`wechat-article.mjs steps --type <id>`。

## 配图标记

`image_position_format` 是写进正文的占位符模板，`{index}` 是 1..N 的序号。
正文只保留裸占位符（例如 `[[img:1]]`）；图片说明与英文 prompt 存放在纲要的
`image_plan` 中，配图阶段由程序按序号回填，不进正文、不计入字数。
解析器仍兼容旧稿里 `[[img:1|说明|prompt]]` 带载荷的写法。

自定义模板时请保留 `{index}`；解析器只把它当作占位符，不会识别其它变量。

## 终稿归档

类型文件不需要配置归档目录。发布成功后，终稿会按 `config/wechat-article/defaults.yaml` 里的
`defaults.publish.archive.knowledge_dir`（环境变量 `KNOWLEDGE_PIPELINE_DIR`）
复制到本地知识库的 `pipeline/` 待入库目录，后续由入库脚本统一处理。
