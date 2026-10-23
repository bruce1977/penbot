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

`input` 对应节点的 `input_format`，只做文档。模型输出节点的 `output` 是**可执行紧凑 DSL**（见 `scripts/lib/template.mjs`），只被 `models.jsonValidated` / `validateTemplateSchema` 消费，用于校验模型输出；DSL 尾项的字符串是字段备注，**给人看的，校验忽略，不作为提示词来源**。给模型看的输出 JSON 结构说明内联在 `config/prompts/*.yaml` 对应提示词块里——改输出形状时，prompts（模型看到的）与 schemas（脚本校验的）两处都要改。非模型节点（本地代码产物）的 `output` 仍是文档。

`draft.yaml` 里的 `draft_input` 是 `02-step/draft-input.json` 的紧凑校验规则（key 直接是字段名，不包一层 `input` / `output`），完整 id 是 `draft.draft_input`。

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
