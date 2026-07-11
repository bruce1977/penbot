---
name: article-illustrator
description: 双管线配图生成技能，使用 modelscope + pollinations 两条管线并行生成图片，自动优选后下载到指定本地路径
---

# 文章配图生成 Skill

## 执行方式

本技能提供两种执行方式：

### 方式 A：Node.js 脚本（优先）

`scripts/generate_image.js` 直接调用双管线 API 并自动优选下载，不依赖 MCP 工具。

```bash
node scripts/generate_image.js "<prompt>" <scene> <position> <outputDir>
# 示例：
node scripts/generate_image.js "赛博朋克风格，神经网络星云" wechat-cover cover output/ai/20260711
```

脚本行为：
- 从环境变量 `PB_MODEL_API_KEY` 读取 API Key，自动调用 ModelScope 管线
- 每张图片有超时控制：`PB_IMAGE_TIMEOUT_MS`（默认 `60000`，即 60 秒），ModelScope 超时时自动降级到 Pollinations 管线
- 双管线并行执行，自动优选（ModelScope 优先）
- 结果保存为 `{outputDir}/{position}.png`，输出 JSON 记录

### 方式 B：MCP 工具（备选）

当脚本方式不可用时，通过 MCP 工具调用生成。

| 工具 | 用途 |
|------|------|
| `image-generation-modelscope_text_to_image` | 管线 A：文生图，支持尺寸/seed/负提示词控制 |
| `image-generation-modelscope_text_image_to_image` | 管线 A 备选：图生图，有参考图时使用（如文章截图、Logo） |
| `image-generation-pollinations_text_to_image` | 管线 B：纯文生图，免费无需认证 |

## 场景尺寸预定义

输入时通过 `scene` 字段指定使用场景，技能自动映射为对应尺寸：

| 场景标识 | 适用场景 | 尺寸（宽×高） | 比例 | 说明 |
|---------|---------|:------------:|:----:|------|
| `wechat-cover` | 微信公众号文章封面 | 900×383 | 2.35:1 | 头条封面大图 |
| `wechat-cover-thumb` | 公众号次条封面 | 500×500 | 1:1 | 次条封面小图 |
| `article-inline` | 文章正文配图（通用） | 1080×? | 自由 | 宽度固定 1080px，高度由宽高比决定 |
| `news-cover` | 新闻/资讯封面 | 1200×630 | 1.91:1 | 符合 Open Graph 社交分享标准 |
| `news-inline` | 新闻正文配图 | 1200×800 | 3:2 | 新闻场景常用插图尺寸 |
| `novel-cover` | 小说/故事封面 | 1200×1800 | 2:3 | 类书籍封面竖版比例（ModelScope 限制高≤2048） |
| `novel-inline` | 小说正文配图 | 1080×1440 | 3:4 | 竖版插图，适合移动端阅读 |

> 封面 `wechat-cover` 的 2.35:1 非标准比例，modelscope 模型可能对非 1:1 比例支持有限；若生成效果不佳可退守 `wechat-cover-thumb`（1:1）后裁剪。

### 各管线参数格式对照

| 管线 | 参数方式 | 示例 |
|------|---------|------|
| modelscope `text_to_image` / `text_image_to_image` | `size` 字符串 | `"900x383"` |
| pollinations `text_to_image` | `width` + `height` 数值 | `width=900, height=383` |

## 默认负提示词（modelscope 专用）

```
photorealistic, 3d render, oil painting, western fantasy, anime style,
manga, chibi, too many details, cluttered composition, bright neon colors,
over-saturated, soft focus, blurry, deformed hands, extra limbs,
signature, watermark, text, words, logo
```

## 执行步骤

1. **读取经验**：配图前先读取 `agents/experience/illustrator.md`，查阅历史经验（哪些 Prompt 效果好、哪些尺寸/管线组合出图快、常见失败原因），避免重复踩坑
2. **解析输入**：接收图片生成任务列表，每项包含：
   - `prompt` — 结构化图片提示词
   - `scene` — 使用场景标识（见上方预定义表），技能据此自动确定尺寸
   - `position` — 图片位置标识（`cover` / `inline_1` / `inline_2`）
   - `reference_image_url`（可选）— 参考图 URL，有值时优先使用 modelscope 图生图
   - `output_dir` — 下载根目录（由提示词指定，如 `output/{profile}/{date}/`），技能自动拼接为 `{output_dir}/{topic}_{position}.png`

2. **双管线并行生成**：
   - **脚本方式（优先）**：运行 `node scripts/generate_image.js "<prompt>" <scene> <position> <outputDir>`，脚本自动调用 ModelScope API（从 `PB_MODEL_API_KEY` 读取 Key）和 Pollinations API，双管线并行互不等待
   - **MCP 方式**：通过 `image-generation-modelscope_text_to_image` + `image-generation-pollinations_text_to_image` 生成图片 URL，再下载到本地

3. **自动优选**：对每个位置的图片，按以下规则选择：
   - 两条管线均成功 → 优先选用 ModelScope 版本（质量更可控）
   - 仅一条管线成功 → 选用成功的那张
   - 两条均失败 → 输出失败标记，不阻塞后续步骤

4. **下载到本地**：将选中的图片保存到 `{outputDir}/{position}.png`
   - 脚本方式已内置下载；MCP 方式用 `Invoke-WebRequest` 下载
   - 下载失败时记录错误，不阻塞后续步骤

5. **返回结果**：返回每张图片的生成记录（`scene`、`position`、`local_path`、`selected_pipeline`、`success`）

6. **记录经验**：任务完成后将本次配图的经验教训追加到 `agents/experience/illustrator.md`，内容包括：
   - 场景标识与图片说明
   - 成功的 Prompt 设计方法（可复用）
   - 管线表现（哪个更快、哪个质量好）
   - 失败原因与处理方式
