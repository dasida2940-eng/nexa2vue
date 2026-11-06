'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createZip, crc32 } = require('../browser/zip');
const posix = require('../src/posix-path');
const { build } = require('../scripts/build-html');

test('posix-path helpers match path.posix', () => {
  for (const [from, to] of [['src/views/a/B.vue', 'src/utils/nexa-compat.js'], ['src/api/x.js', 'src/api/y.js'], ['a', 'a/b/c']]) {
    assert.equal(posix.relative(posix.dirname(from), to), path.posix.relative(path.posix.dirname(from), to));
  }
  assert.equal(posix.basename('ua/usr/BAU0101010.xfdl'), 'BAU0101010.xfdl');
  assert.equal(posix.dirname('Form.xfdl'), '.');
});

test('createZip writes a valid stored ZIP with UTF-8 names', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const blob = createZip([
    { path: 'out_vue/src/views/학생.vue', content: '<template>학생</template>\n' },
    { path: 'out_vue/_nexa2vue-report.json', content: '{}' },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-zip-'));
  try {
    const file = path.join(dir, 'out.zip');
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    // bsdtar reads ZIP files (Windows 10+ ships it; Git Bash's GNU tar does not).
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows','System32', 'tar.exe') : 'bsdtar';
    execFileSync(tar, ['-xf', file, '-C', dir]);
    assert.equal(fs.readFileSync(path.join(dir, 'out_vue/src/views/학생.vue'), 'utf8'), '<template>학생</template>\n');
    assert.equal(fs.readFileSync(path.join(dir, 'out_vue/_nexa2vue-report.json'), 'utf8'), '{}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build-html produces one self-contained page', async () => {
  const { path: out } = await build();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'"/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/gi) || []).length, 1);
  // outside the inline bundle (which embeds the viewer template as text) nothing is loaded from elsewhere
  const page = html.replace(/<script>[\s\S]*<\/script>/, '<script></script>');
  assert.doesNotMatch(page, /<script src=|<link [^>]*href=|https?:\/\//);
  assert.doesNotMatch(html, /\/\*__(CSS|APP)__\*\//);
  // runtime helper and viewer scaffold are embedded for the Element profile
  assert.match(html, /nexa-compat/);
  assert.match(html, /view-screens\.cmd/);
});
