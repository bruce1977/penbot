# 数据结构（`config/schemas/*.yaml`）

输入/输出结构用 **id** 关联，id 的格式是 `<文件名>.<配置项名>`：

```yaml
# config/schemas/topic.yaml
schemas:
  select_topic:
    input:
      type: ArticleType
      candidates: "Array<Candidate>"
    output:
      topic: string
      thesis: string
```

上面的 `select_topic` 完整 id 是 `topic.select_topic`。步骤文件只写 id：

```yaml
# config/steps/10-topic.yaml
steps:
  select_topic:
    schema: topic.select_topic
```

`input` 对应节点的 `input_format`，`output` 对应 `output_format`；字段值是紧凑 DSL 字符串，用于文档和校验。

## 命名与扩展

- 文件名是命名空间，建议按阶段或类型命名：`topic.yaml`、`review.yaml`、`ai-news.yaml`。
- 不要在文件名上加序号；序号只用于 `config/steps/`。
- 类型专用结构放 `config/schemas/<类型 id>.yaml`，例如 `ai-news.yaml` 的 `select_topic` → `ai-news.select_topic`。
- 在类型文件里用 id 覆盖：

```yaml
# config/types/ai-news.yaml
steps:
  select_topic:
    schema: ai-news.select_topic
```

- 覆盖按 `input` / `output` 字段合并：只写 `input` 时保留基础结构的 `output`。
