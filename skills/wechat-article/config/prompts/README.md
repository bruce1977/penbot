# 提示词（`config/prompts/*.yaml`）

提示词用 **id** 关联，id 的格式是 `<文件名>.<配置项名>`：

```yaml
# config/prompts/topic.yaml
prompts:
  select_topic:
    system: |
      你是「{{type_name}}」栏目的选题编辑。
    user: |
      {{mode_line}}
      {{candidates}}
```

上面的 `select_topic` 完整 id 是 `topic.select_topic`。步骤文件只写 id：

```yaml
# config/steps/10-topic.yaml
steps:
  select_topic:
    prompt: topic.select_topic
    schema: topic.select_topic
```

## 字段

| 字段 | 说明 |
| --- | --- |
| `system` | system prompt，支持 `{{变量}}` |
| `user` | user prompt，支持 `{{变量}}` |
| `retry` | 重试时使用的 prompt |
| `extra` | 追加到 user prompt 末尾的额外要求 |

## 命名与扩展

- 文件名是命名空间，建议按阶段或类型命名：`topic.yaml`、`outline.yaml`、`ai-news.yaml`。
- 不要在文件名上加 `10-`、`20-` 之类的序号；序号只用于 `config/steps/`。
- 类型专用提示词放 `config/prompts/<类型 id>.yaml`，例如 `ai-news.yaml` 的 `select_topic` → `ai-news.select_topic`。
- 在类型文件里用 id 覆盖：

```yaml
# config/types/ai-news.yaml
steps:
  select_topic:
    prompt: ai-news.select_topic
```

- 覆盖按字段合并：只写 `extra` 会保留基础提示词的 `system` / `user`。
- 初稿提示词在 `prompts/draft.yaml` 的 `draft_writing`；初稿输入的校验规则在 `schemas/draft.yaml` 的 `draft_input`，两者都按普通 id 注册。
