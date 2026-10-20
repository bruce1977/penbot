# 文章类型配置（`config/types/*.yaml`）

总配置在 `config/article-types.yaml`，这里只放**单个类型**的写作要求。
文件名建议与 `id` 一致（`ai-news.yaml` → `id: ai-news`），加载顺序由总配置的 `types:` 决定。

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
| `model` | 否 | 写作模型 profile，默认 `defaults.model` |
| `review` | 否 | 覆盖 `model` / `max_rounds` / `pass_score` / `correct_cn` |
| `prompts` | 否 | `outline_extra` / `draft_extra` / `revise_extra` 追加要求 |
| `publish` | 否 | 一般不用配；终稿归档目录统一在总配置 `defaults.publish.archive.knowledge_dir` |

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
```

## 配图标记

`image_position_format` 是写进正文的占位符模板，`{index}` 是 1..N 的序号。
可选载荷（图片说明 / 英文 prompt）用 `|` 接在序号后面：

```text
[[img:1|一张示意图|abstract data flow, minimal editorial illustration]]
```

自定义模板时请保留 `{index}`；解析器只把它当作占位符，不会识别其它变量。

## 终稿归档

类型文件不需要配置归档目录。发布成功后，终稿会按总配置
`defaults.publish.archive.knowledge_dir`（环境变量 `KNOWLEDGE_PIPELINE_DIR`）
复制到本地知识库的 `pipeline/` 待入库目录，后续由入库脚本统一处理。
