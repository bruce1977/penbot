# 05 发布 / 归档步（stage `publish`）

一句话：把 04 的 `composed.md` 落成 `05-step/final.md`，按渠道开关投递**邮件**与**公众号草稿**，
只有**至少一个渠道真实投递成功**才归档（入库 → 打包 → 删 `draft/<slug>/`）。

## 命令

```bash
npm run wechat-article -- publish --article <slug> --to me@example.com      # 手工确认门槛后投递
npm run wechat-article -- publish --article <slug> --dry-run                # 演练：不发不投
npm run wechat-article -- publish --article <slug> --email --wechat         # 显式触发两个渠道
npm run wechat-article -- auto                                              # 管线入口，一路跑到归档
```

无人值守时不带 flag：开关单源在 `config/wechat-article/steps/50-publish.yaml` 的
`publish.handler_options`（`auto_publish` / `email` / `wechat`，仓库默认三个都是 `true`，
`auto` 模式一路发到底）。要停投递或只发一个渠道就改这一处，不用带 flag。

## 执行序列

```
04-step/composed.md
        │  publish.enabled=false ──► 整环节跳过（不落 05 产物，composed.md 保持最终稿）
        ▼
   ① 终稿落盘  05-step/final.md（图片引用换基准 ──► ../04-step/images/…）
        ▼
   ② 渠道投递（各自独立，都留痕）
        ├─ email  ：markdown → HTML → CID 内联本地配图 → Resend API
        └─ wechat ：spawn wenyan CLI 投草稿（参数与回显里的密钥一律打码）
        ▼
   ③ 归档  仅 status=published 且 archive.enabled=true
        入库（knowledge_dir 留空=跳过）→ 先写 05-result.json → 打包 published/<date>-<slug>.zip → 删 draft/<slug>/
```

## 状态口径（`derivePublishStatus`）

| `status` | 条件 | 归档 |
| --- | --- | --- |
| `published` | 启用的渠道全部 `success: true` | 是 |
| `partial` | 部分渠道成功 | 否 |
| `failed` | 全部失败 | 否 |
| `dry_run` | `--dry-run`、`--mock`（mock 的承诺是不发真实请求），或渠道级 `dry_run: true` | 否 |
| `skipped` | `publish.enabled=false` / 两个渠道都关 / `handler_options.auto_publish=false` 且没显式触发 | 否 |

**几个开关是不同层次，别混**（投递开关单源都在 `steps/50-publish.yaml` 的 `publish` 节点）：

| 开关 | 关掉的效果 |
| --- | --- |
| steps 节点 `publish.enabled: false` | 整个环节不执行：不落 `05-step/final.md`、不落 `05-result.json`、不投递 |
| `publish.handler_options.auto_publish: false` | 落终稿但**不投递**（`status: skipped`，`reason: auto_publish disabled`）；`--auto-publish` 或 `publish` 命令可临时跳过这道门槛 |
| `publish.handler_options.email` / `wechat: false` | 只关这一个渠道；两个都关 = `skipped`（`reason: email/wechat disabled`）；`--email` / `--wechat` 临时覆盖 |
| steps 节点 `archive.enabled: false` | 不入库、不打包、不删 `draft/` |
| `defaults.publish.archive.knowledge_dir` 留空 | 只跳过复制到知识库，照常打包与清理（`archive.knowledge` 记 `{ok:true,skipped:true}`） |

## 投递细节

**邮件**（`comm/wechat-publish.mjs#sendEmail`）
- 正文走 `markdown-it` 渲染，外层套 `emailShell` 模板；主题模板 `publish.email.subject`（`{title}` / `{date}` / `{type}`）。
- 本地配图按 **CID 内联**：`inlineLocalImages` 用 HTML 里实际出现的引用串去匹配附件，因此终稿挪进 `05-step/` 后引用基准必须同步换（`relocateLocalImages`），否则邮件静默丢图。
- 收件人：`--to`（可多次或逗号分隔）> `publish.email.to`。
- 端点参数单源 `defaults.publish.email` 的 `base_url` / `timeout_ms` / `retries`，缺失在消费点抛错点名配置路径。

**公众号草稿**（`publishToWechat`，spawn 外部 CLI）
- 命令单源 `defaults.publish.wechat.command`（默认 `npx --yes @wenyan-md/cli`，已在 `package.json` 依赖里，lockfile 锁版本、断网可跑）。
- 凭据：管线配 `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET`，spawn 时由 `wechatChildEnv` 补成 CLI 真正读取的 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`（CLI 没有 `--app-secret` 参数，secret 只能走环境变量或它自己的 `credential.json`）。
- 公众号后台有 **IP 白名单**：本机 IP 不在名单时取 `access_token` 直接失败（`errcode 40164`）。绕过方式是走 CLI 的远程发布服务端，配 `wechat.server` + `wechat.api_key`（代码已支持 `--server` / `--api-key`）。
- Windows 下命令串自己加引号（`args + shell:true` 会被 cmd 拆路径并触发 DEP0190）。

**留痕纪律**（`05-step/api/`）
| 调用 | 文件 | 记什么 |
| --- | --- | --- |
| 邮件 | `01_1-email.resend.json` | 收件人、主题、`html_chars`、附件的**文件名 / content-id / mime / 字节数** |
| 公众号 | `02_1-publish.wenyan-md.json` | 打码后的命令行 + CLI 回显末 2000 字符（同样打码） |

绝不含 Authorization / API key 原文；大 body 只记摘要。

## 节点表（`config/wechat-article/steps/50-publish.yaml`）

| 节点 | handler | 模型调用 | 校验契约 | 写 |
| --- | --- | --- | --- | --- |
| `publish` | `builtin:publish_article` | 无 | `publish.publish`（校验 `05-result.json` 本体，结果记 `#validation`） | `05-step/final.md`、`05-step/final.html?`、`05-result.json` |
| `archive` | `builtin:archive_article` | 无 | `publish.archive`（校验 `#archive`，结果记 `#archive.validation`） | `05-result.json`（并入 archive）、`published/<date>-<slug>.zip` |

`publish.handler_options` 是投递开关单源：`auto_publish` / `email` / `wechat`（仓库默认全 `true`，
即 `auto` 模式一路发布到归档；三个键必填，缺了运行期抛错点名 `publish.handler_options.<键>`）；
类型层 `steps.publish.handler_options` 可按类型关掉某个渠道。
渠道参数（收件人、发件人、命令串、超时重试）仍在 `defaults.yaml` 的 `defaults.publish.*`。

不合格只警告不阻塞；`checked: false` 表示节点没挂契约，不是「校验通过」。

## 产物地图与路径口径

```
draft/<slug>/
├── 05-result.json          status / channels / email / wechat / reason（+ 归档后 archive、archivedAt）
└── 05-step/
    ├── final.md            投递用终稿（图片引用相对 05-step/）
    ├── final.html          仅启用邮件时生成
    └── api/                01_1-email.resend、02_1-publish.wenyan-md
published/
└── <YYYYMMDD>-<slug>.zip   整个文章目录（含 05-result.json 清单）
```

| 路径 | 基准 |
| --- | --- |
| `files.final`、`files.html` | **文章目录**（`05-step/final.md`） |
| `archive.zip` | **项目根**（`output/wechat-article/published/…`） |
| `archive.knowledge.file` | **绝对路径**（知识库目录在项目外，相对化会得到 `../../…`，读取端无法还原） |

## 排障

| 现象 | 先看 |
| --- | --- |
| 只有 `final.md` 没投递 | `05-result.json#reason`（`auto_publish disabled` / `email/wechat disabled`） |
| 邮件里图全断 | `final.html` 里的引用串与 `collect` 出的附件路径是否一致（基准没换 = 永远不命中） |
| 公众号 `errcode 40164` | IP 白名单；加白后 5-10 分钟生效，动态 IP 建议改走远程发布 server |
| 归档没跑 | `status` 必须是 `published`；再看 `archive.enabled` 与 `archive.knowledge.skipped` |
| 报「缺少配置 …」 | 必填参数在**消费点**抛错并点名完整配置路径，照路径补 `.env` 或配置 |

IP 白名单加在哪、wenyan 凭据的三条解析路径见 [USAGE.md](USAGE.md) 的「发布」与「环境变量」节；
归档序列与发布成功判定的完整口径见 [artifacts.md](artifacts.md)。
