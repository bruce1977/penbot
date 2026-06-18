const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const highlightjs = require('markdown-it-highlightjs');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});
md.use(highlightjs);

// Main
const [,, inputPath, outputPath] = process.argv;

if (!inputPath) {
  console.error('Usage: node convert.js <input.md> [output.html]');
  process.exit(1);
}

const src = fs.readFileSync(inputPath, 'utf-8');
const bodyHtml = md.render(src);
const out = outputPath || inputPath.replace(/\.md$/i, '') + '.html';

const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; color: #333; max-width: 680px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 22px; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-top: 0; }
    h2 { font-size: 18px; margin-top: 28px; color: #1a1a1a; }
    h3 { font-size: 16px; margin-top: 22px; }
    p { margin: 14px 0; }
    img { max-width: 100%; height: auto; border-radius: 6px; margin: 16px 0; }
    a { color: #1a73e8; }
    blockquote { border-left: 4px solid #1a73e8; margin: 16px 0; padding: 8px 16px; color: #555; background: #f0f6ff; border-radius: 0 6px 6px 0; }
    pre { background: #2d2d2d; padding: 14px; border-radius: 6px; overflow-x: auto; }
    code { padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre code { background: none; padding: 0; }
    .hljs { display: block; overflow-x: auto; color: #ccc; background: none; }
    .hljs-keyword { color: #c792ea; }
    .hljs-string { color: #c3e88d; }
    .hljs-number { color: #f78c6c; }
    .hljs-comment { color: #676e95; font-style: italic; }
    .hljs-built_in { color: #82aaff; }
    .hljs-attr { color: #f07178; }
    .hljs-literal { color: #ff5370; }
    .hljs-title { color: #82aaff; }
    .hljs-params { color: #f07178; }
    .hljs-selector-tag { color: #c792ea; }
    .hljs-meta { color: #89ddff; }
    .hljs-section { color: #82aaff; }
    .hljs-link { color: #c3e88d; }
    .hljs-symbol { color: #f78c6c; }
    .hljs-deletion { color: #ff5370; }
    .hljs-addition { color: #c3e88d; }
    hr { border: none; border-top: 1px solid #e0e0e0; margin: 28px 0; }
    ul, ol { padding-left: 24px; margin: 14px 0; }
    li { margin: 6px 0; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
    th, td { border: 1px solid #e0e0e0; padding: 10px 12px; text-align: left; }
    th { background: #f5f7fa; font-weight: 600; color: #1a1a1a; }
    tr:nth-child(even) { background: #fafbfc; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

fs.writeFileSync(out, fullHtml, 'utf-8');
console.log('Converted: ' + path.basename(inputPath) + ' -> ' + path.basename(out));
