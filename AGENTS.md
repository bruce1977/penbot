# MP 自动化管线

## 全局约束

- **产出文件位置**：过程中创建的任何文件（包括临时文件、中间产物、最终产出），只能放在 `.temp/` 和 `output/` 这两个目录下，不得在项目根目录或其他位置生成文件。持久性元数据（如经验池 `agents/experience/`）除外。

## 模式定义

管线按入口命令分为四种模式，每种模式映射不同的步骤组合：

| 模式 | 触发命令 | 映射步骤 | 产出终点 |
|------|---------|---------|---------|
| **写稿发布** | `cmd-write-publish` | 步骤 0 → 1 → 2A+2B(并行) → 3 → 4(可选) → 5(可选) | 终稿 + 可选邮件 + 可选公众号草稿 |
| **写稿配图** | `cmd-mp-write` | 步骤 0 → 1 → 2A+2B(并行) → 3 | 终稿 |
| **发布** | `cmd-mp-publish` | 步骤 A1(可选) → A2(可选) | 可选邮件 + 可选公众号草稿 |
| **完整管线** | `cmd-mp-auto-pipeline` | 步骤 1 → 子流程 A(A1→A2可选→A3→A4) → 子流程 B(B1→B2→B3) → 子流程 C(C1可选→C2可选) | 终稿邮件 + 公众号草稿 |
| **采集简报** | `cmd-mp-digest` | 步骤 1 → 2 | 汇总报告邮件——发送即结束，**不做**步骤 3-8 |
| **仅采集** | `cmd-wechat-mp-gather` | 抓取工作流（拉取+下载） | `*.md` + `download_list.json`——不生成报告，不发送邮件 |

**执行原则**：各模式的边界由命令的 `description` 和此表共同约束。`cmd-mp-digest` 包含步骤 2 的邮件发送，**不得**将步骤 2 排除在外；`cmd-wechat-mp-gather` 仅做抓取下载（不含选题分析和邮件）；`cmd-wechat-mp-analyze` 仅做选题报告（需先执行 gather）。`cmd-write-publish` 与采集管线完全解耦，直接以主题+风格+本地知识库为输入，不含任何抓取步骤。

## 工作流程

| 触发命令 | 提示词模板 | 对应工作流 |
|---------|-----------|-----------|
| `/cmd-write-publish` | 根据$1执行写稿-配图-发布流程 | [workflows/workflow_mp-write.md](workflows/workflow_mp-write.md) |
| `/cmd-mp-write` | 根据$1执行写稿配图（不含发布） | [workflows/workflow_mp-write.md](workflows/workflow_mp-write.md) |
| `/cmd-mp-publish` | 根据$1执行发布流程（邮件/公众号草稿箱） | [workflows/workflow_mp-publish.md](workflows/workflow_mp-publish.md) |
| `/cmd-mp-auto-pipeline` | 根据$1执行MP自动化管线 | [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md) |
| `/cmd-mp-digest` | 根据$1执行MP采集简报管线 | [workflows/workflow_mp-digest.md](workflows/workflow_mp-digest.md) |
| `/cmd-wechat-mp-gather` | 根据$1执行微信公众号文章**抓取**工作流（拉取+下载） | [skills/wechat-mp-gather/SKILL.md](skills/wechat-mp-gather/SKILL.md) |
| `/cmd-wechat-mp-analyze` | 根据$1执行微信公众号文章**选题**工作流（AI 评分/标签/主题遴选 → 报告） | [skills/wechat-mp-analyze/SKILL.md](skills/wechat-mp-analyze/SKILL.md) |
| `/cmd-wechat-mp-publish-drafts` | 将微信公众号草稿箱内的草稿发布为已发表文章（需微信认证开通权限） | [skills/wechat-mp-wenyan/SKILL.md](skills/wechat-mp-wenyan/SKILL.md) |

> 示例：`/cmd-mp-digest configs/ai-config.json` 触发采集简报管线，发送汇总报告邮件后结束。

## Agents 一览

### 主流程

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `coordinator` | 司南 | `all` | 总调度支持两种入口：**full**（采集→评价→撰写→配图→发送→发布）或 **write-only**（直接输入主题+风格+知识库→写稿→配图→发布）。分别对应 `workflow_mp-auto-pipeline.md` 和 `workflow_mp-write.md` |
| `gatherer` | 拾遗 | `all` | 采集公众号文章（`wechat-mp-gather`）与选题报告生成（`wechat-mp-analyze`） |
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
