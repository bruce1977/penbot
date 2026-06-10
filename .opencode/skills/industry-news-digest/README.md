# 行业新闻通讯稿生成 (industry-news-digest)

## 功能简介

从指定的N个行业网站中抓取最新文章，整理汇总成一篇结构化的新闻通讯稿。

## 文件结构

```
industry-news-digest/
├── SKILL.md        # 技能定义和工作流
├── config.json     # 目标网站和配置参数
├── fetch_web.py    # 网页抓取工具（自动编码检测/文章提取）
└── README.md       # 本文件
```

## 使用方法

### 1. 配置目标网站

编辑 `config.json`，添加你的目标行业网站：

```json
{
  "websites": [
    {
      "name": "36氪",
      "url": "https://36kr.com",
      "rss": "https://36kr.com/feed",
      "category": "科技"
    },
    {
      "name": "虎嗅",
      "url": "https://www.huxiu.com",
      "category": "商业"
    }
  ],
  "settings": {
    "dateRange": 7,
    "language": "zh-CN",
    "maxArticlesPerSite": 10,
    "outputFormat": "markdown"
  }
}
```

### 2. 触发技能

在opencode中输入类似以下指令：

- "帮我生成行业通讯稿"
- "抓取最新科技新闻做汇总"
- "从配置的网站抓取文章整理成日报"

### 3. 调整输出

通讯稿生成后，可以要求：

- 调整语气（正式/随意）
- 调整篇幅（精简/详细）
- 聚焦特定主题
- 导出为 `.md` 文件

## 配置参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `websites` | 目标网站列表 | 必填 |
| `websites[].name` | 网站名称 | 必填 |
| `websites[].url` | 网站URL | 必填 |
| `websites[].rss` | RSS订阅地址（可选，推荐） | 无 |
| `websites[].api` | 数据API接口（跳过页面渲染，直接获取JSON） | 无 |
| `websites[].note` | 站点访问特性说明 | 无 |
| `settings.dateRange` | 抓取最近几天的文章 | 7 |
| `settings.language` | 输出语言 | zh-CN |
| `settings.maxArticlesPerSite` | 每个网站最多抓取文章数 | 10 |
| `settings.outputFormat` | 输出格式 | markdown |

## 网页抓取工具 (fetch_web.py)

内置的Python脚本用于抓取网页内容，自动处理编码和反爬问题。

```bash
# 抓取并清理网页正文
python .opencode/skills/industry-news-digest/fetch_web.py --url "https://example.com"

# 自动检测编码（国内政务网站自动使用GBK）
python .opencode/skills/industry-news-digest/fetch_web.py --url "http://fta.mofcom.gov.cn/"

# 提取文章列表（标题+日期+链接）
python .opencode/skills/industry-news-digest/fetch_web.py --url "https://example.com/news" --mode articles

# 强制指定编码（出现乱码时）
python .opencode/skills/industry-news-digest/fetch_web.py --url "http://example.com" --encoding gbk

# 批量抓取
python .opencode/skills/industry-news-digest/fetch_web.py --file urls.txt
```

支持以下模式：
- `clean`：提取正文段落（默认）
- `articles`：提取文章标题/日期/链接
- `raw`：返回原始HTML
- `json`：返回完整JSON结构

## 注意事项

- **优先使用RSS**：RSS订阅提供更清晰、结构化的数据，抓取效果更好
- **网站数量建议**：5-10个来源通常能提供良好的覆盖
- **抓取限制**：部分网站可能有反爬措施，如遇问题建议使用RSS或减少抓取频率
