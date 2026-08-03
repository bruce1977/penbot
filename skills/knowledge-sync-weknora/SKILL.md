# Skill: knowledge-sync-weknora

# 同步 marked/ 到 WeKnora 远程知识库

独立子流程（对应 `workflow-knowledge.md` 子流程 2.3）。将 `{marked}` 目录中带 frontmatter 的终稿逐篇导入 WeKnora 知识库（文章 + 标签），导入成功后移动到 `{weknora}` 目录。

## 前置条件

| 环境变量 | 说明 |
|---------|------|
| `WEKNORA_BASE_URL` | WeKnora API 基础地址（如 `https://.../api/v1`） |
| `WEKNORA_API_KEY` | API 密钥（X-API-Key 头） |

## 输入

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `{marked}` | string | 是 | 带 frontmatter 的终稿目录 |
| `{weknora}` | string | 是 | 已同步文章存放目录（导入成功后 move 到此） |
| `{profile}` | string | 是 | 知识库 profile 名称 |
| `{kb_id}` | string | 否 | 显式指定知识库 ID，优先于 `weknora.json` |

## 配置：`{base}/weknora.json`

目标知识库 ID 与提交间隔由 profile 根目录下的 `weknora.json` 读取，**不依赖 config 文件**。若该文件不存在，脚本会自动创建默认配置：

```json
{
  "kb_id": "",
  "submit_interval_ms": 10000
}
```

| 字段 | 说明 |
|------|------|
| `kb_id` | 目标知识库 ID（留空时回退按 `KB.name == {profile}` 匹配，匹配成功会自动回填到本文件） |
| `submit_interval_ms` | 每篇提交后的等待间隔（毫秒），优先于环境变量 `SUBMIT_INTERVAL_MS`（默认 `10000`） |

> 首次运行（`kb_id` 为空）会尝试按知识库名匹配 `{profile}`：匹配成功自动写回 `kb_id`；匹配失败则报错并列出可用 KB 供你填写。

## 执行步骤

```
node skills/knowledge-sync-weknora/scripts/sync_to_weknora.js {marked} {weknora} {profile} [{kb_id}]
```

1. **定位知识库**：优先用第 4 参 `{kb_id}`；否则读取 `{base}/weknora.json` 的 `kb_id`；再回退按 `name == {profile}` 匹配，未找到则报错并列出可用 KB
2. **导入前查重（hash+title）**：调用 `GET /knowledge-bases/{kb}/knowledge` 分页拉取库内已有标题，建立标题集合
3. **逐篇导入**：遍历 `{marked}/*.md`，每篇：
   - 解析 frontmatter：`hash`、`title`、`tags`、正文 body
   - 提交标题 = `${hash}_${title}`（无 `hash` 字段的旧文件回退为 `title`）
   - 若提交标题已存在于知识库 → `SKIP`（不建标签、不提交，直接移动），避免重复导入
   - 创建/复用标签：`GET /knowledge-bases/{kb}/tags` 查找，缺失则 `POST` 创建
   - 导入文章：`POST /knowledge-bases/{kb}/knowledge/manual`，body 携带 `{ title: "${hash}_${title}", content, status: "publish", tag_ids: [...] }`（`status: "publish"` 立即入队解析，避免草稿不可检索）
   - 成功后 `Move` 到 `{weknora}/`
   - **提交间隔**：每篇提交后等待 `submit_interval_ms`（默认 10s）再提交下一篇
4. **结果汇总**：输出同步成功/失败数量；失败篇保留在 `{marked}` 待重试

> 查重键为 **hash + title**：hash 在子流程 2.2 由 `lib/content_hash.js` 自动计算（3 轮 sha256 取 12 位），写入 frontmatter `hash` 字段并作为文件名前缀。导入时把 hash 拼进标题，使 hash 随标题进入 WeKnora，库内标题集合即可精确去重（同标题不同内容的文章因 hash 不同不会误判）。无 `hash` 的旧文件回退为按 `title` 查重。
>
> **Why not 独立 hash 字段**：已实测 WeKnora manual 导入不持久化自定义 metadata（`file_hash` 为空、metadata 仅保留 content/format/status/version/updated_at），无法按 hash 字段查询，故采用 hash 嵌入标题的方案。

## 产出

| 文件 | 说明 |
|------|------|
| `{weknora}/{file_name}` | 已成功导入 WeKnora 的文章 |

文件在 `{marked}` = 未同步（可重试），`{weknora}` = 已同步。

## 错误处理

| 场景 | 处理 |
|------|------|
| KB 未匹配 | 报错退出，提示配置 `weknora.json` 的 `kb_id` |
| 单篇导入失败 | 记录 FAIL，保留在 `{marked}`，继续处理其他篇 |
| API 频率限制 / 网络错误 | 单篇失败重试由调用方控制（可重新运行脚本） |
| 内容重复（hash+title 命中知识库已有文章） | SKIP 并移动至 `{weknora}`，不重复提交 |

> 标签关联已验证：`POST /knowledge-bases/{kb}/knowledge/manual` 的 body 传 `tag_ids` 数组即可完成多标签关联（响应 `tags` 字段含完整标签对象，标签 `knowledge_count` 同步 +1）。

## 禁止事项

- **绝不自动删除知识库文档**：本技能只负责新增/跳过导入，不得调用 `DELETE /knowledge/:id` 或任何清理接口。历史重复记录由人工通过 WeKnora 后台处理，脚本不参与。
- 若发现知识库中已有重复文档，仅报告（SKIP/提示），不自行清理。

Base directory for this skill: D:\source\github\penbot\skills\knowledge-sync-weknora
