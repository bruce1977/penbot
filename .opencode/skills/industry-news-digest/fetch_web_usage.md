# fetch_web.py — 网页抓取工具

`industry-news-digest` 技能内置的通用网页抓取脚本，自动处理编码检测、反爬规避和内容提取。

## 用法

```bash
python fetch_web.py --url <URL> [选项]
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--url`, `-u` | 目标网页URL | — |
| `--file`, `-f` | URL列表文件（每行一个，`#` 开头为注释） | — |
| `--mode`, `-m` | 输出模式：`clean` / `articles` / `raw` / `json` | `clean` |
| `--encoding`, `-e` | 编码：`auto` / `utf-8` / `gbk` | `auto` |
| `--timeout`, `-t` | 请求超时（秒） | 20 |

未指定 `--url` 或 `--file` 时，从 stdin 读取URL。

## 输出模式

### `clean`（默认）— 提取正文段落

适合抓取单篇文章全文，自动提取 `<p>` 段落，去除 script/style。

```bash
python fetch_web.py --url "https://example.com/article/123"
```

输出示例：
```
问：5月14日，中美两国元首举行会晤...
答：中美两国元首在北京举行会晤...
```

### `articles` — 提取文章列表

适合新闻列表页，识别含 `art_`/`content`/`news`/`xwdt` 等关键字的超链接，并从附近查找日期。

```bash
python fetch_web.py --url "https://www.mofcom.gov.cn/xwfb/index.html" --mode articles
```

输出示例：
```
1. [2026-05-17] 习近平同美国总统特朗普在中南海小范围会晤
   https://www.mofcom.gov.cn/xwfb/ldrhd/art/2026/art_xxx.html
2. [2026-05-16] 商务部新闻发言人就中美经贸磋商初步成果答记者问
   https://www.mofcom.gov.cn/xwfb/xwfyrth/art/2026/art_xxx.html
```

### `raw` — 原始HTML

返回未经处理的HTML源码，用于调试。

```bash
python fetch_web.py --url "https://example.com" --mode raw
```

### `json` — 结构化JSON

同时返回正文、文章列表、编码信息，适合程序化处理。

```bash
python fetch_web.py --url "https://example.com" --mode json
```

输出示例：
```json
{
  "url": "https://www.mofcom.gov.cn/xwfb/index.html",
  "encoding": "utf-8",
  "status": 200,
  "clean_text": "问：5月14日...",
  "articles": [
    {"title": "习近平同美国总统特朗普会谈", "url": "https://...", "date": "2026-05-14"}
  ]
}
```

## 编码处理策略

自动按以下优先级检测编码：

1. **HTTP响应头** `Content-Type: charset=...`
2. **HTML meta** `<meta charset="...">`
3. **chardet 库**（如已安装，置信度>80%时使用）
4. **域名兜底**：仅已知GBK站点（`fta.mofcom.gov.cn` 等）回退 `gbk`，其余默认 `utf-8`

遇到乱码时强制指定编码：

```bash
python fetch_web.py --url "http://fta.mofcom.gov.cn/" --encoding gbk
python fetch_web.py --url "http://customs.gov.cn/" --encoding gbk
```

## 批量抓取

创建 URL 文件 `urls.txt`：

```
# ===== 政务网站 =====
https://www.mofcom.gov.cn/xwfb/index.html
http://fta.mofcom.gov.cn/

# ===== 文章页面 =====
https://www.mofcom.gov.cn/xwfb/xwfyrth/art/2026/art_2ff1de0282be42ab87201b69a9fcb008.html
```

执行批量抓取：

```bash
python fetch_web.py --file urls.txt --mode articles
```

## 工作原理

```
URL → requests.get() → 自动检测编码 → 解码为文本
                                      ├─ clean: 正则提取 <p> 段落
                                      ├─ articles: 搜索 <a> 标签匹配文章关键字
                                      ├─ raw: 原样输出
                                      └─ json: 组合全部信息
```
