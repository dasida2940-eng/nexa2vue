'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, markdownPage } = require('../src/md-html');

test('headings, paragraphs, code, bold and links', () => {
  assert.equal(renderMarkdown('## 제목\n\n첫 줄 `a < b`\n둘째 **굵게** [문서](ua/A.html)'),
    '<h2>제목</h2>\n<p>첫 줄 <code>a &lt; b</code><br>둘째 <strong>굵게</strong> <a href="ua/A.html">문서</a></p>');
  // only relative and http(s) links become links
  assert.equal(renderMarkdown('[x](javascript:alert(1)) [y](https://a.example/b)'), '<p>x) <a href="https://a.example/b">y</a></p>');
});

test('tables keep escaped pipes inside cells', () => {
  assert.equal(renderMarkdown('| 키 | 값 |\n| --- | --- |\n| `a\\|b` | 1 |'),
    '<div class="table-wrap"><table><thead><tr><th>키</th><th>값</th></tr></thead><tbody><tr><td><code>a|b</code></td><td>1</td></tr></tbody></table></div>');
});

test('nested and numbered lists', () => {
  assert.equal(renderMarkdown('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. 하나\n2. 둘'), '<ol><li>하나</li><li>둘</li></ol>');
  assert.equal(renderMarkdown('- a\n  - a1'), '<ul><li>a<ul><li>a1</li></ul></li></ul>');
});

test('fenced code and raw HTML are shown as text', () => {
  assert.equal(renderMarkdown('```js\nif (a < b) x()\n```'), '<pre><code>if (a &lt; b) x()</code></pre>');
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('a page has a title, UTF-8 and light/dark styles', () => {
  const page = markdownPage('A & B', '# 제목');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<meta charset="utf-8">/);
  assert.match(page, /<title>A &amp; B<\/title>/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /<main>\n<h1>제목<\/h1>\n<\/main>/);
});
