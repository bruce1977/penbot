# 数据结构（`config/wechat-article/schemas/*.yaml`）

输入/输出结构用 **id** 关联，id 的格式是 `<文件名>.<配置项名>`：

```yaml
# config/wechat-article/schemas/topic.yaml
schemas:
  select_topic:
    input:
      type: "ArticleType"
      candidates: "Array<{title: string, days_ago: number, fresh: boolean}>"
    output:
      topics: ["array", 1]
      "topics[].topic": ["string", 1, 64, "一句话主题"]
      "topics[].score": ["number", 0, 100]
```

上面的 `select_topic` 完整 id 是 `topic.select_topic`。步骤文件只写 id：

```yaml
# config/wechat-article/steps/10-topic.yaml
steps:
  select_topic:
    models:
      select:
        schema: topic.select_topic
```

**注册表里只放脚本真会跑的校验契约。** `output` 是可执行紧凑 DSL（见 `scripts/lib/template.mjs`），消费方只有四个：`models.jsonValidated`（校验模型输出，不合格带原因重试）、`validateDraftInput`（校验 02-step/draft-input.json）、`validateProduced`（校验脚本自己落盘的中间产物，如 04-step/images.json），以及校验**每步 `NN-result.json` 本体**的同一支 `validateProduced`——它由节点的 `result_schema` 指过来（见下节）。`input` 对应节点的 `input_format`，只做文档。DSL 尾项的字符串是字段备注，**给人看的，校验忽略，不作为提示词来源**；给模型看的输出 JSON 结构说明内联在 `config/wechat-article/prompts/*.yaml` 对应提示词块里——改输出形状时，prompts（模型看到的）与 schemas（脚本校验的）两处都要改。

## `schema` 与 `result_schema`：两个互不替代的口

- 节点级 `schema` = 本节点**模型输出或中间产物**的契约（`04-step/images.json` 用的就是 `image_generation.schema`）。
- 节点级 `result_schema` = 本节点**落盘的那份 `NN-result.json` 本体**的契约（`topic.result` / `draft.result` / `review.result` / `compose.result` / `publish.publish`；`archive` 校验 `05-result.json#archive` 用 `publish.archive`）。01–04 的 `schema` 口已被模型调用占用，同一节点要校验两份产物就必须各挂一个键。
- `result_schema` 只能挂在 `artifacts.writes` 里真的写了 `NN-result.json` 的节点上（`validateSteps` 检查），且引用的条目必须有 `output` DSL——两者任一不成立都是加载期硬错误。运行期在落盘前跑，不合格只警告不阻塞，结果如实记进该 result 的 `#validation`（`{checked, ok, errors, warnings}`；`checked: false` = 没挂契约，不等于通过）。
- `result_schema` **只在节点级**，type 层没有覆盖口：一份 result 的形状不随文章类型变。

没有可校验 JSON 形状的节点**不写 `schema`**，否则这个指针会伪装成「本节点有输出契约」：

| 节点 | 为什么没有校验契约 | 形状写在哪儿 |
| --- | --- | --- |
| `classify_type` / `select_topic.best` / `scoring.check` | 判断模型（systemone）的回答由 `classify.mjs` 自己解析：答案必须是候选项、置信度是数字 | 节点内联 `input_format` / `output_format` |
| `gather_materials` | 无模型调用，素材条目由 `landSources` 代码保证 | 同上 |
| `draft_writing` / `revision` / `de_ai` | 输出是自由格式 Markdown 正文；字数区间、原稿数字保全、frontmatter/小节标题/配图标记由代码闸门校验 | 同上 |

内联的 `input_format` / `output_format` 只是形状备注：`wechat-article.mjs steps --step <name>` 会标出「形状备注，脚本不校验」，引用了注册表 id 的才标「校验契约 <id>」，挂了 `result_schema` 的节点另外单独打印一行「result 本体校验契约」。

每个阶段产物文件的名字约定：`<文件>.result`（`topic.yaml` 的 `result` → `topic.result`，余同）就是该步 `NN-result.json` 的契约——内容是「信封五项 + 本步载荷」，改 result 形状时改这里，不改模型输出的那个条目。

`draft.yaml` 里的 `draft_input` 是 `02-step/draft-input.json` 的紧凑校验规则（key 直接是字段名，不包一层 `input` / `output`），完整 id 是 `draft.draft_input`。

## 命名与扩展

- 文件名是命名空间，建议按阶段或类型命名：`topic.yaml`、`review.yaml`、`ai-news.yaml`。
- 不要在文件名上加序号；序号只用于 `config/wechat-article/steps/`。
- 类型专用结构放 `config/wechat-article/schemas/<类型 id>.yaml`，例如 `ai-news.yaml` 的 `select_topic` → `ai-news.select_topic`。
- 在类型文件里用 id 覆盖：

```yaml
# config/wechat-article/types/ai-news.yaml
steps:
  select_topic:
    schema: ai-news.select_topic
```

- 覆盖按 `input` / `output` 字段合并：只写 `input` 时保留基础结构的 `output`。
