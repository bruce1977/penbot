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
| `{profile}` | string | 是 | 配置名称，用于匹配 KB（`KB.name == profile`） |
| `{kb_id}` | string | 否 | 显式指定知识库 ID，优先于 profile 匹配 |

## 执行步骤

```
node skills/knowledge-sync-weknora/scripts/sync_to_weknora.js {marked} {weknora} {profile} [{kb_id}]
```

1. **定位知识库**：调用 `GET /knowledge-bases`，优先用 `{kb_id}`；否则按 `name == {profile}` 匹配，未找到则报错并列出可用 KB
2. **逐篇导入**：遍历 `{marked}/*.md`，每篇：
   - 解析 frontmatter：`title`、`tags`、正文 body
   - 创建/复用标签：`GET /knowledge-bases/{kb}/tags` 查找，缺失则 `POST` 创建
   - 导入文章：`POST /knowledge-bases/{kb}/knowledge/manual`，body 携带 `{ title, content, tag_ids: [...] }`
   - 成功后 `Move` 到 `{weknora}/`
3. **结果汇总**：输出同步成功/失败数量；失败篇保留在 `{marked}` 待重试

## 产出

| 文件 | 说明 |
|------|------|
| `{weknora}/{file_name}` | 已成功导入 WeKnora 的文章 |

文件在 `{marked}` = 未同步（可重试），`{weknora}` = 已同步。

## 错误处理

| 场景 | 处理 |
|------|------|
| KB 未匹配 | 报错退出，提示配置 `settings.weknora_kb_id` |
| 单篇导入失败 | 记录 FAIL，保留在 `{marked}`，继续处理其他篇 |
| API 频率限制 / 网络错误 | 单篇失败重试由调用方控制（可重新运行脚本） |

> 标签关联已验证：`POST /knowledge-bases/{kb}/knowledge/manual` 的 body 传 `tag_ids` 数组即可完成多标签关联（响应 `tags` 字段含完整标签对象，标签 `knowledge_count` 同步 +1）。

Base directory for this skill: D:\source\github\penbot\skills\knowledge-sync-weknora
