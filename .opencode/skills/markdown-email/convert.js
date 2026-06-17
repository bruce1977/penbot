const fs = require('fs');
const path = require('path');

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdToHtml(md) {
  let lines = md.split('\n');
  let html = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];
    let trimmed = line.trim();

    if (trimmed === '') {
      html.push('');
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(trimmed)) {
      html.push('<hr>');
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      let quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().replace(/^> /, ''));
        i++;
      }
      html.push('<blockquote><p>' + processInline(quoteLines.join('<br>')) + '</p></blockquote>');
      continue;
    }

    // Headers
    let hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      let level = hMatch[1].length;
      html.push(`<h${level}>${processInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      let tableRows = [];
      let headerRow = null;
      let separatorHandled = false;

      while (i < lines.length) {
        let l = lines[i].trim();
        if (!l.startsWith('|') || !l.endsWith('|')) break;

        let cells = l.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        cells = cells.map(c => c.trim());

        // Skip separator rows like |---|---| or |:---|---:|
        let isSep = cells.every(c => /^:?-+:?$/.test(c));
        if (isSep) {
          separatorHandled = true;
          i++;
          continue;
        }

        cells = cells.map(c => processInline(c));

        if (!separatorHandled && headerRow === null) {
          headerRow = cells;
        } else {
          tableRows.push(cells);
        }
        i++;
      }

      html.push('<table>');
      if (headerRow) {
        html.push('<thead><tr>' + headerRow.map(c => `<th>${c}</th>`).join('') + '</tr></thead>');
      }
      if (tableRows.length > 0) {
        html.push('<tbody>' + tableRows.map(row => '<tr>' + row.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>');
      }
      html.push('</table>');
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(trimmed)) {
      let items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i].trim())) {
        items.push('<li>' + processInline(lines[i].trim().replace(/^[-*+]\s/, '')) + '</li>');
        i++;
      }
      html.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(trimmed)) {
      let items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push('<li>' + processInline(lines[i].trim().replace(/^\d+\.\s/, '')) + '</li>');
        i++;
      }
      html.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    // Paragraph
    html.push('<p>' + processInline(trimmed) + '</p>');
    i++;
  }

  return html.join('\n');
}

function processInline(text) {
  // Images first - handle URLs with parentheses
  text = text.replace(/!\[([^\]]*)\]\(((?:[^()]+|\((?:[^()]+|\([^()]*\))*\))*)\)/g, (match, alt, url) => {
    return `<img src="${url}" alt="${alt}" style="max-width:100%;border-radius:6px;margin:16px 0;">`;
  });
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links - handle URLs with parentheses
  text = text.replace(/\[([^\]]+)\]\(((?:[^()]+|\((?:[^()]+|\([^()]*\))*\))*)\)/g, (match, linkText, url) => {
    return `<a href="${url}">${linkText}</a>`;
  });
  return text;
}

function wrapHtml(bodyHtml) {
  return `<!DOCTYPE html>
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
    pre { background: #f5f5f5; padding: 14px; border-radius: 6px; overflow-x: auto; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
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
}

// Main
const [,, inputPath, outputPath] = process.argv;

if (!inputPath) {
  console.error('Usage: node convert.js <input.md> [output.html]');
  process.exit(1);
}

const md = fs.readFileSync(inputPath, 'utf-8');
const bodyHtml = mdToHtml(md);
const fullHtml = wrapHtml(bodyHtml);

if (outputPath) {
  fs.writeFileSync(outputPath, fullHtml, 'utf-8');
  console.log('Converted: ' + path.basename(inputPath) + ' -> ' + path.basename(outputPath));
} else {
  console.log(fullHtml);
}
