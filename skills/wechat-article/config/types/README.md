# 文章类型配置（`config/types/*.yaml`）

全局默认在 `config/defaults.yaml`，模型在 `config/models.yaml`，类型注册表在 `config/article-types.yaml`；这里只放**单个类型**的写作要求。
文件名建议与 `id` 一致（`ai-news.yaml` → `id: ai-news`），加载顺序由 `article-types.yaml` 的 `types:` 决定。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 类型标识，命令行 `--type` 用它；缺省取文件名 |
| `type` | 是 | 中文类型名，用于日志和提示词（兼容旧字段 `name`） |
| `enabled` | 否 | 默认 `true`；`false` 时不会被判断模型选中 |
| `description` | 否 | 一句话说明，判断模型会用它做分类 |
| `knowledge_base_path` | 是 | 本地知识库目录，字符串或数组 |
| `style` | 是 | 风格描述：字符串，或 `persona/tone/audience/title_style/structure/dos/donts` 对象 |
| `word_limit` | 是 | `800-1300`、`1500`，或 `{ min, max, target }` |
| `pass_score` | 否 | 及格分，默认取 `defaults.review.pass_score` |
| `scoring_criteria` | 是 | 评分维度数组，每项 `{ id, name, weight, description?, criteria? }` |
| `image_count` | 否 | `1-5`、`3`，或 `{ min, max, default, cover }` |
| `image_position_format` | 否 | 配图标记模板，`{index}` 会替换成序号，默认 `[[img:{index}]]` |
| `topic` | 否 | `keywords` / `exclude_keywords` / `lookback_days` / `candidates` |
| `model` | 否 | 写作模型 id（如 `llm.local`、`llm.large`），默认 `defaults.model` |
| `review` | 否 | 覆盖 `model` / `max_rounds` / `pass_score` / `correct_cn` |
| `steps` | 否 | 按节点覆盖 `model` / `timeout` / `retry_limit` / `prompt` / `schema`；`prompt` 和 `schema` 写注册表 id |
| `prompts` | 否 | 旧字段：`outline_extra` / `draft_extra` / `revise_extra`，会追加到对应节点的 `prompt.extra` |
| `publish` | 否 | 一般不用配；终稿归档目录统一在 `config/defaults.yaml` 的 `defaults.publish.archive.knowledge_dir` |

## 例子

```yaml
id: ai-news
type: AI 资讯快评
knowledge_base_path: D:/knowledge/obsidian/ai
style:
  persona: 科技媒体主编，能在信息噪音里快速指出真正重要的变化。
  tone: 干脆、直接、信息密度高。
  audience: 每天用碎片时间跟踪 AI 动态的从业者。
word_limit: 800-1300
pass_score: 78
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

`config/steps/` 定义每个节点的默认处理方法、模型，以及提示词/数据结构的 id。类型只需要写有差异的部分，优先级高于阶段文件：

```yaml
steps:
  select_topic:
    prompt: ai-news.select_topic   # 对应 config/prompts/ai-news.yaml 的 select_topic
    schema: ai-news.select_topic   # 对应 config/schemas/ai-news.yaml 的 select_topic
  draft_writing:
    model: llm.large
    timeout: 900000
    retry_limit: 1
  scoring:
    timeout: 900000
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

- `step_name` 必须与 `config/steps/` 里的节点一致。
- 只写要覆盖的字段；`model` 只写 `config/models.yaml` 里的 id。
- 提示词/数据结构只写 id，不在这里展开内容。
- 查看合并后的结果：`wechat-article.mjs steps --type <id>`。

## 配图标记

`image_position_format` 是写进正文的占位符模板，`{index}` 是 1..N 的序号。
可选载荷（图片说明 / 英文 prompt）用 `|` 接在序号后面：

```text
[[img:1|一张示意图|abstract data flow, minimal editorial illustration]]
```

自定义模板时请保留 `{index}`；解析器只把它当作占位符，不会识别其它变量。

## 终稿归档

类型文件不需要配置归档目录。发布成功后，终稿会按 `config/defaults.yaml` 里的
`defaults.publish.archive.knowledge_dir`（环境变量 `KNOWLEDGE_PIPELINE_DIR`）
复制到本地知识库的 `pipeline/` 待入库目录，后续由入库脚本统一处理。
