'use strict';

// Just enough Markdown → HTML for the conversion documents: headings,
// paragraphs, (nested) lists, tables, fenced code, `code`, **bold** and links.
// Everything is escaped first, so text the AI wrote can never become markup or
// script. No dependencies, so the browser build can use it too.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Relative links and http(s) only (no javascript: and the like).
const safeHref = (href) => /^https?:\/\//i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);

function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => (safeHref(href) ? `<a href="${href}">${label}</a>` : label));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;

// "| a | b \| c |" → ['a', 'b | c']
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function list(items) {
  let html = '';
  const stack = []; // { indent, tag } of the open lists
  for (const line of items) {
    const [, space, marker, text] = LIST_ITEM.exec(line);
    const indent = space.length;
    const tag = /\d/.test(marker) ? 'ol' : 'ul';
    if (!stack.length || indent > stack[stack.length - 1].indent) {
      html += `<${tag}>`;
      stack.push({ indent, tag });
    } else {
      html += '</li>';
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) html += `</${stack.pop().tag}></li>`;
    }
    html += `<li>${inline(text)}`;
  }
  html += '</li>';
  while (stack.length) {
    html += `</${stack.pop().tag}>`;
    if (stack.length) html += '</li>';
  }
  return html;
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const startsBlock = (l) => HEADING.test(l) || FENCE.test(l) || LIST_ITEM.test(l) || TABLE_ROW.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${inline(heading[2])}</h${n}>`);
      i++;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] || '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) items.push(lines[i++]);
      out.push(list(items));
      continue;
    }
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

const CSS = `
:root { --bg: #ffffff; --text: #1f2328; --muted: #59636e; --border: #d1d9e0; --head: #f6f8fa; --code: #eff1f3; --link: #0969da; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0d1117; --text: #e6edf3; --muted: #9198a1; --border: #3d444d; --head: #151b23; --code: #262c36; --link: #4493f8; }
}
:root[data-theme="dark"] { --bg: #0d1117; --text: #e6edf3; --muted: #9198a1; --border: #3d444d; --head: #151b23; --code: #262c36; --link: #4493f8; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6em; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
h2 { font-size: 1.3em; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.1em; margin: 24px 0 8px; }
h4, h5, h6 { font-size: 1em; margin: 16px 0 8px; }
p, ul, ol { margin: 0 0 12px; }
ul, ol { padding-left: 24px; }
a { color: var(--link); }
code { font-family: Consolas, "D2Coding", ui-monospace, monospace; font-size: .9em; background: var(--code); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
pre { background: var(--code); padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; word-break: normal; }
.table-wrap { overflow-x: auto; margin: 0 0 16px; }
table { border-collapse: collapse; min-width: 100%; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--head); white-space: nowrap; }
`;

/** A whole HTML page (UTF-8, light and dark) for a Markdown document. */
function markdownPage(title, md) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${renderMarkdown(md)}
</main>
</body>
</html>
`;
}

module.exports = { renderMarkdown, markdownPage };
