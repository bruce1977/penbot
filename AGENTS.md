# MP 自动化管线

## 全局约束

- **产出文件位置**：过程中创建的任何文件（包括临时文件、中间产物、最终产出），只能放在 `.temp/` 和 `output/` 这两个目录下，不得在项目根目录或其他位置生成文件。持久性元数据（如经验池 `agents/experience/`）除外。
- **Node.js 脚本规范**：所有 `scripts/` 及技能下的 `.js` 脚本须遵循 [docs/rules/node-script.rule.md](docs/rules/node-script.rule.md) 定义的编码规范。
- **LLM 调用超时**：调用大模型及外部 API（含 subagent 委托、MCP 工具）须设置超时时间（默认 60 秒）。单次超时允许重试；**连续 3 次超时则立即停止当前流程**，记录失败原因并向用户报告，不继续后续步骤。

## 模式定义

管线按入口命令分为多种模式，每种模式映射不同的步骤组合（命令以 `opencode.json` 注册表为准）：

| 模式 | 触发命令 | 映射步骤 | 产出终点 |
|------|---------|---------|---------|
| **完整管线** | `cmd-mp-auto-pipeline` | 步骤 1 → 子流程 A(A1→A2可选→A3→A4) → 子流程 B(B1→B2→B3) → 子流程 C(C1可选→C2可选) | 终稿邮件 + 公众号草稿 |
| **采集简报** | `cmd-mp-digest` | 步骤 1 → 2 | 汇总报告邮件——发送即结束，**不做**步骤 3-8 |
| **草稿发布** | `cmd-wechat-mp-publish-drafts` | 草稿箱 → 已发表 | 公众号已发表文章 |
| **知识库管线** | `cmd-knowledge`（总索引）`cmd-knowledge-collect\|analyze\|import\|archive`（独立子流程） | 子流程 2.1 → 2.2 → 2.3 → 2.4（各子流程可独立运行） | `{KB}/articles/{profile}/[inbox\|marked\|weknora\|archived]`——采集→分析→导入→归档 |

**执行原则**：各模式的边界由命令的 `description` 和此表共同约束。`cmd-mp-digest` 包含步骤 2 的邮件发送，**不得**将步骤 2 排除在外。知识库管线四子流程相互独立，均可由 `cmd-knowledge-collect|analyze|import|archive <profile>` 单独触发，各自以 `{profile}` 为唯一入口。

## 工作流程

| 触发命令 | 提示词模板 | 对应工作流 |
|---------|-----------|-----------|
| `/cmd-mp-auto-pipeline` | 根据$1执行MP自动化管线 | [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md) |
| `/cmd-mp-digest` | 根据$1执行MP采集简报管线 | [workflows/workflow_mp-digest.md](workflows/workflow_mp-digest.md) |
| `/cmd-wechat-mp-publish-drafts` | 将微信公众号草稿箱内的草稿发布为已发表文章（需微信认证开通权限） | [skills/wechat-mp-wenyan/SKILL.md](skills/wechat-mp-wenyan/SKILL.md) |
| `/cmd-knowledge` | 根据$1执行MP知识库管线（四子流程总索引） | [workflows/workflow-knowledge.md](workflows/workflow-knowledge.md) |
| `/cmd-knowledge-collect` | 根据$1执行知识库子流程2.1 采集入库 | [workflows/workflow-knowledge-collect.md](workflows/workflow-knowledge-collect.md) |
| `/cmd-knowledge-analyze` | 根据$1执行知识库子流程2.2 文档分析 | [workflows/workflow-knowledge-analyze.md](workflows/workflow-knowledge-analyze.md) |
| `/cmd-knowledge-import` | 根据$1执行知识库子流程2.3 导入知识库 | [workflows/workflow-knowledge-import.md](workflows/workflow-knowledge-import.md) |
| `/cmd-knowledge-archive` | 根据$1执行知识库子流程2.4 归档 | [workflows/workflow-knowledge-archive.md](workflows/workflow-knowledge-archive.md) |

> 示例：`/cmd-mp-digest configs/ai-config.json` 触发采集简报管线，发送汇总报告邮件后结束。
>
> **知识库管线**：`/cmd-knowledge ai` 触发，知识库路径为 `{PB_KNOWLEDGE_BASE_PATH}/articles/{profile}/`。文件按阶段在 `inbox/`（原始）→ `marked/`（已分析）→ `weknora/`（已导入）→ `archived/`（已归档）四目录间单向流转。执行者根据参数或目录状态决定运行哪个子流程，四个子流程可分别用 `/cmd-knowledge-collect|analyze|import|archive <profile>` 独立触发，详见 [workflow-knowledge.md](workflows/workflow-knowledge.md)。

## Agents 一览

### 主流程

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `coordinator` | 司南 | `all` | 总调度支持两种入口：**full**（采集→评价→撰写→配图→发送→发布）或 **write-only**（直接输入主题+风格+知识库→写稿→配图→发布）。分别对应 `workflow_mp-auto-pipeline.md` 和 `workflow_mp-write.md` |
| `gatherer` | 拾遗 | `all` | 采集公众号文章（`wechat-mp-gather`），产出 `{inbox}/*.md` + `download_list.json` |
| `tagger` | 书签 | `subagent` | 知识库子流程 2.2 打标签：提取 title/date/auther/source/tags/summary/keywords → `.meta.json` |
| `writer` | 墨言 | `all` | 专注撰写，执行 `wechat-mp-writer` 技能完成素材阅读→大纲→初稿→3 轮审稿→输出，通过 `agents/experience/writer.md` 经验池持续自我改进 |

### 评论员（主题评价）

| Agent | 代号 | 模式 | 视角 |
|-------|------|------|------|
| `commentator-value` | 金算盘 | `subagent` | 商业与市场 |
| `commentator-tech` | 解码器 | `subagent` | 技术与工程 |
| `commentator-public` | 风向标 | `subagent` | 公众传播 |
| `commentator-academic` | 溯源者 | `subagent` | 学术研究 |
| `commentator-ethics` | 权衡者 | `subagent` | 伦理合规 |

### 支撑角色

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `proofreader` | — | `subagent` | writer 的子流程，作为 `wechat-mp-writer` 技能第 3 轮审稿调用，检查敏感词、错别字、语法/逻辑，与 writer 直接闭环 |
| `illustrator` | 画眉 | `all` | 公众号配图生成，执行 `article-illustrator` 技能完成双管线配图生成、优选、下载 |

### 工具角色

| Agent | 模式 | 用途 |
|-------|------|------|
| `silent` | `subagent` | 静默执行模式，仅供 command 内部使用 |
