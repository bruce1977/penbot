# Agents 一览

> 工作流程详见 [workflows/workflow_mp-auto-pipeline.md](workflows/workflow_mp-auto-pipeline.md)
>
> 触发指令：根据 `{config-path}` 执行 MP 自动化管线
>
> 示例：根据 `configs/ai-config.json` 执行 MP 自动化管线

## 主流程

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `gatherer` | 拾遗 | `all` | 采集公众号文章，运行 wechat-mp-articles 技能产出报告与主题 |
| `writer` | 墨言 | `all` | 主理人，编排全流程并撰写文章 |

## 评论员（步骤 2）

| Agent | 代号 | 模式 | 视角 |
|-------|------|------|------|
| `commentator-value` | 金算盘 | `subagent` | 商业与市场 |
| `commentator-tech` | 解码器 | `subagent` | 技术与工程 |
| `commentator-public` | 风向标 | `subagent` | 公众传播 |
| `commentator-academic` | 溯源者 | `subagent` | 学术研究 |
| `commentator-ethics` | 权衡者 | `subagent` | 伦理合规 |

## 支撑角色

| Agent | 代号 | 模式 | 职责 |
|-------|------|------|------|
| `proofreader` | — | `subagent` | 敏感词检查、错字修正、语法/逻辑复核 |
| `illustrator` | 画眉 | `all` | 公众号配图生成。微信公众号配图尺寸规范：封面大图 900×383(2.35:1)、封面小图 500×500(1:1)、文中插图宽1080px 高度不限 PNG-24、GIF宽640px 帧率12-20 |

## 工具角色

| Agent | 模式 | 用途 |
|-------|------|------|
| `silent` | `subagent` | 静默执行模式，仅供 command 内部使用 |
