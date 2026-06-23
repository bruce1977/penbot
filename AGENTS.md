# MP 自动化管线

## 模式定义

管线按入口命令分为三种模式，每种模式映射不同的步骤组合：

| 模式 | 触发命令 | 映射步骤 | 产出终点 |
|------|---------|---------|---------|
| **完整管线** | `cmd-mp-auto-pipeline` | 步骤 1 → 2 → 3 → 4 → 5 → 6 → 7 | 终稿邮件 |
| **采集简报** | `cmd-mp-digest` | 步骤 1 → 2 | 汇总报告邮件——发送即结束，**不做**步骤 3-7 |
| **仅采集** | `cmd-wechat-mp-articles` | 步骤 1（不含步骤 2 邮件发送） | `summary_report.md` + `topic_*.md`——不发送邮件 |

**执行原则**：各模式的边界由命令的 `description` 和此表共同约束。`cmd-mp-digest` 包含步骤 2 的邮件发送，**不得**将步骤 2 排除在外；同理 `cmd-wechat-mp-articles` 也以采集命名，但**不包含**邮件发送，调用者须注意区分。

## 工作流程

| 触发命令 | 提示词模板 | 对应工作流 |
|---------|-----------|-----------|
| `/cmd-mp-auto-pipeline` | 根据$1执行MP自动化管线 | [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md) |
| `/cmd-mp-digest` | 根据$1执行MP采集简报管线 | [workflows/workflow_mp-digest.md](workflows/workflow_mp-digest.md) |
| `/cmd-wechat-mp-articles` | 根据$1抓取微信公众号文章 | [skills/wechat-mp-articles/SKILL.md](skills/wechat-mp-articles/SKILL.md) |

> 示例：`/cmd-mp-digest configs/ai-config.json` 触发采集简报管线，发送汇总报告邮件后结束。

## Agents 一览

### 主流程

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `gatherer` | 拾遗 | `all` | 采集公众号文章，运行 wechat-mp-articles 技能产出报告与主题 |
| `writer` | 墨言 | `all` | 主理人，编排全流程并撰写文章 |

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
| `proofreader` | — | `subagent` | 敏感词检查、错字修正、语法/逻辑复核 |
| `illustrator` | 画眉 | `all` | 公众号配图生成。微信公众号配图尺寸规范：封面大图 900×383(2.35:1)、封面小图 500×500(1:1)、文中插图宽1080px 高度不限 PNG-24、GIF宽640px 帧率12-20 |

### 工具角色

| Agent | 模式 | 用途 |
|-------|------|------|
| `silent` | `subagent` | 静默执行模式，仅供 command 内部使用 |
