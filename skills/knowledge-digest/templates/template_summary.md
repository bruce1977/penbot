# AI 行业资讯汇总

> 生成时间：{{{timestamp}}} | 覆盖 {{{category_count}}} 个主题分类 | 共 {{{account_count}}} 个公众号 | {{{article_count}}} 篇文章

## 执行概况

| 指标 | 数值 |
|------|------|
| 覆盖公众号数 | {{{account_count}}} |
| 主题分类数 | {{{category_count}}} |
| 文章总数 | {{{article_count}}} |
| 最早文章 | {{{earliest_date}}} |
| 最晚文章 | {{{latest_date}}} |

---

## 今日遴选主题

{{#topics}}
- **{{{title}}}**（公众号数：{{{account_count}}}，文章数：{{{article_count}}}，热度：{{{heat}}}）  
  {{{overview}}}

{{/topics}}
{{^topics}}
（暂无遴选主题）
{{/topics}}

---

## 公众号汇总

| 公众号 | 主题分类 | 文章数 | 最高评分 |
|--------|----------|--------|----------|
{{#account_summary}}| {{{name}}} | {{{category}}} | {{{article_count}}} | {{{best_score}}} |
{{/account_summary}}
{{^account_summary}}（暂无公众号数据）{{/account_summary}}

---

## 文章总览

| # | 日期 | 公众号 | 分类 | 标题 | 评分 | 标签 |
|---|------|--------|------|------|------|------|
{{#article_list}}| {{{index}}} | {{{date}}} | {{{account}}} | {{{category}}} | [{{{title}}}]({{{url}}}) | {{{score}}} | {{{tags}}} |
{{/article_list}}
{{^article_list}}（暂无文章数据）{{/article_list}}

---

## 标签汇总

| 标签 | 出现次数 | 覆盖公众号 |
|------|----------|-----------|
{{#tags_summary}}| {{{tag}}} | {{{count}}} | {{{accounts}}} |
{{/tags_summary}}
{{^tags_summary}}（暂无标签数据）{{/tags_summary}}

---

## 重点文章推荐

{{#highlights}}
- **【{{{source}}}】[{{{title}}}]({{{url}}})** — {{{reason}}} {{#tags}}（标签：{{{tags}}}）{{/tags}}
{{/highlights}}
{{^highlights}}
（暂无推荐，待质量评分后更新）
{{/highlights}}

---

*本报告由 AI 自动生成于 {{{timestamp}}}，内容仅供参考。*
