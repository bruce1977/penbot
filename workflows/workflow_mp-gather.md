---
name: mp-gather
description: "微信公众号文章采集（已并入知识库管线，作为子流程 2.1）"
---

> ⚠️ **已废弃**：本工作流已被 [workflow-knowledge.md](workflow-knowledge.md)（知识库管线四子流程）取代。

**采集入库** 现为知识库管线的 **子流程 2.1**，执行者为 `gatherer`（`wechat-mp-gather` 技能功能 1），下载目标为 `{KB}/articles/{profile}/inbox/`。

如需单独执行采集，请运行：

```
/cmd-collect <profile>    # 采集入库，详见 workflow-knowledge.md
```

详见 [workflow-knowledge.md](workflow-knowledge.md) 子流程 2.1。
