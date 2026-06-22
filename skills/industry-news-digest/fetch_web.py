#!/usr/bin/env python3
"""
网页抓取工具 - 用于行业新闻通讯稿技能
支持参数：URL、编码、输出格式

用法:
  python fetch_web.py --url http://example.com
  python fetch_web.py --url http://example.com --encoding gbk
  python fetch_web.py --url http://example.com --format text
  python fetch_web.py --file urls.txt
"""

import requests
import re
import sys
import json
import argparse
from urllib.parse import urlparse


def auto_detect_encoding(url, response):
    """自动检测编码，优先从Content-Type或HTML meta中获取"""
    # 从Content-Type检测
    ct = response.headers.get('Content-Type', '')
    if 'charset=' in ct:
        return ct.split('charset=')[-1].split(';')[0].strip().lower()

    # 从HTML meta检测（仅读取前2KB，效率高）
    try:
        html_sample = response.content[:2048].decode('utf-8', errors='ignore')
        meta_charset = re.search(r'<meta[^>]+charset=["\']?([^"\'>\s]+)', html_sample, re.I)
        if meta_charset:
            # 修复常见别名
            enc = meta_charset.group(1).strip().lower()
            return 'gbk' if enc in ('gb2312', 'gbk') else enc
    except Exception:
        pass

    # 通过Content-Type头部中未包含charset时，检查content二进制
    try:
        import chardet
        detected = chardet.detect(response.content[:4096])
        if detected['confidence'] > 0.8:
            return detected['encoding']
    except ImportError:
        pass

    # 兜底：域名映射（仅用于已知GBK站点）
    gbk_domains = ['fta.mofcom.gov.cn', 'customs.gov.cn', 'mofcom.gov.cn']
    for domain in gbk_domains:
        if domain in urlparse(url).netloc:
            return 'gbk'

    return 'utf-8'


def fetch_page(url, encoding=None, timeout=20, retry_http=False):
    """抓取网页内容"""
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    })

    # 尝试HTTPS
    if url.startswith('http://'):
        urls_to_try = [url]
    else:
        urls_to_try = [url]

    for attempt_url in urls_to_try:
        try:
            r = session.get(attempt_url, timeout=timeout, verify=False)
            r.raise_for_status()

            if encoding:
                r.encoding = encoding
            else:
                r.encoding = auto_detect_encoding(attempt_url, r)

            return {
                'url': attempt_url,
                'encoding': r.encoding,
                'status': r.status_code,
                'content': r.text,
                'raw_length': len(r.content),
            }
        except requests.exceptions.RequestException as e:
            return {'url': url, 'error': str(e)}

    return {'url': url, 'error': 'All attempts failed'}


def extract_articles(html, site_name='', base_url=''):
    """从HTML中提取文章标题、链接、日期"""
    articles = []
    seen_urls = set()

    # 策略1：找所有<a>标签，匹配内容型链接（含art/content/news等路径）
    link_pattern = re.compile(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL)
    date_pattern = re.compile(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2})')

    for m in link_pattern.finditer(html):
        href = m.group(1).strip()
        title = re.sub(r'<[^>]+>', '', m.group(2)).strip()

        if not href or not title or len(title) < 6:
            continue
        if href.startswith('#') or href.startswith('javascript'):
            continue
        if href in seen_urls:
            continue

        # 判断是否为文章链接
        is_article = False
        for keyword in ['art_', 'content', 'news', 'article', 'xwdt', 'xwfb',
                        'zwxx', 'ggtz', 'gzdt', 'tzgg', 'detail', 'info']:
            if keyword in href.lower():
                is_article = True
                break

        if not is_article:
            continue

        seen_urls.add(href)

        # 构造完整URL
        if href.startswith('/') and base_url:
            full_url = base_url.rstrip('/') + href
        elif href.startswith('http'):
            full_url = href
        else:
            full_url = href

        # 查找附近的日期
        # 在链接前后各200字符范围内搜索日期
        link_pos = html.find(href)
        if link_pos > 0:
            nearby = html[max(0, link_pos - 80):link_pos + len(href) + 80]
            date_match = date_pattern.search(nearby)
            date = date_match.group(1) if date_match else ''
        else:
            date = ''

        articles.append({
            'title': title,
            'url': full_url,
            'date': date,
        })

    return articles


def clean_text(html):
    """提取并清理网页正文"""
    # 尝试获取 <article> 或 <main> 内容
    for tag in ['article', 'main', '.content', '.article', '#content', '#article']:
        if tag.startswith(('.', '#')):
            continue
        m = re.search(r'<{tag}[^>]*>(.*?)</{tag}>'.format(tag=tag), html, re.DOTALL | re.I)
        if m:
            html = m.group(1)
            break

    # 去除script和style
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.I)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.I)

    # 提取段落文本
    paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', html, re.DOTALL)
    if not paragraphs:
        paragraphs = re.findall(r'<div[^>]*class=["\']?[^"\']*(?:content|text|article)[^"\']*["\']?>(.*?)</div>', html, re.DOTALL)

    texts = []
    for p in paragraphs:
        t = re.sub(r'<[^>]+>', '', p).strip()
        if len(t) > 10:
            texts.append(t)

    return '\n\n'.join(texts)


def main():
    # Fix Windows console encoding
    if hasattr(sys.stdout, 'buffer'):
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

    parser = argparse.ArgumentParser(description='网页抓取工具 for industry-news-digest')
    parser.add_argument('--url', '-u', help='目标网页URL')
    parser.add_argument('--file', '-f', help='URL列表文件（每行一个URL）')
    parser.add_argument('--encoding', '-e', default='auto', help='编码（auto/gbk/utf-8等）')
    parser.add_argument('--mode', '-m', choices=['raw', 'clean', 'articles', 'json'], default='clean',
                        help='输出模式: raw(原始文本), clean(清理正文), articles(文章列表), json(完整JSON)')
    parser.add_argument('--timeout', '-t', type=int, default=20, help='超时秒数')

    args = parser.parse_args()

    urls = []
    if args.url:
        urls.append(args.url)
    elif args.file:
        with open(args.file, 'r', encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    else:
        # 从stdin读取
        urls = [line.strip() for line in sys.stdin if line.strip()]

    if not urls:
        parser.print_help()
        sys.exit(1)

    encoding = args.encoding if args.encoding != 'auto' else None
    results = []

    for url in urls:
        result = fetch_page(url, encoding=encoding, timeout=args.timeout)

        if 'error' in result:
            print(f'[错误] {url} -> {result["error"]}', file=sys.stderr)
            continue

        html = result['content']

        if args.mode == 'raw':
            output = html
        elif args.mode == 'articles':
            base_url = f'{urlparse(url).scheme}://{urlparse(url).netloc}'
            articles = extract_articles(html, base_url=base_url)
            output = ''
            for i, a in enumerate(articles, 1):
                output += f'{i}. [{a.get("date", "?")}] {a.get("title", "?")}\n   {a.get("url", "?")}\n\n'
        elif args.mode == 'json':
            result['clean_text'] = clean_text(html)
            result['articles'] = extract_articles(html, base_url=f'{urlparse(url).scheme}://{urlparse(url).netloc}')
            results.append(result)
            continue
        else:
            output = clean_text(html)
            if not output:
                # 兜底：输出所有可见文本
                text = re.sub(r'<[^>]+>', '', html)
                text = re.sub(r'\s+', '\n', text).strip()
                output = text[:5000]

        results.append({
            'url': url,
            'encoding': result.get('encoding', '?'),
            'output': output[:10000] if len(output) > 10000 else output,
        })

    if args.mode == 'json':
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f'=== {r["url"]} (编码: {r["encoding"]}) ===')
            print(r['output'])
            print()


if __name__ == '__main__':
    main()
