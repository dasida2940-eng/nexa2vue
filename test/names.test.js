'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveNames } = require('../src/names');
const { runConversion, preview } = require('../src/job-runner');

const UNI = path.join(__dirname, 'fixtures', 'uni');
const NEXA = path.join(__dirname, 'fixtures', 'nexa');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-names-'));
}

test('resolveNames defaults to the file name and validates changed names', () => {
  const forms = ['ua/usr/A.xfdl', 'ua/usr/B.xfdl', 'co/C-1.xfdl'];
  const ok = resolveNames(forms, { 'ua/usr/A.xfdl': 'BAU0101010', 'ua/usr/B.xfdl': ' ' });
  assert.deepEqual([...ok.names], [['ua/usr/A.xfdl', 'BAU0101010'], ['ua/usr/B.xfdl', 'B'], ['co/C-1.xfdl', 'C-1']]);
  assert.deepEqual([...ok.renamed], ['ua/usr/A.xfdl']);
  assert.deepEqual(ok.errors, []);

  const bad = resolveNames(forms, { 'ua/usr/A.xfdl': '1abc', 'co/C-1.xfdl': 'a/b' });
  assert.equal(bad.errors.length, 2);
  // same folder, same name (case-insensitive like Windows)
  const clash = resolveNames(forms, { 'ua/usr/A.xfdl': 'b' });
  assert.deepEqual(clash.errors.map((e) => e.rel), ['ua/usr/B.xfdl']);
  // same name in different folders is fine
  assert.deepEqual(resolveNames(['a/X.xfdl', 'b/Y.xfdl'], { 'b/Y.xfdl': 'X' }).errors, []);
});

test('preview guesses roles for review and the default names follow them; page changes override', () => {
  const root = tmp();
  try {
    const dir = path.join(root, 'in', 'ua', 'usr');
    fs.mkdirSync(dir, { recursive: true });
    const host = fs.readFileSync(path.join(UNI, 'ua/usr/BAU0101010.xfdl'), 'utf8')
      .replace('<![CDATA[', '<![CDATA[\nthis.fn_pop = function() { this.gfn_openPopup("p", "ua::usr/BAU0102010.xfdl"); };\n');
    fs.writeFileSync(path.join(dir, 'BAU0101010.xfdl'), host);
    fs.copyFileSync(path.join(UNI, 'ua/usr/BAU0102010.xfdl'), path.join(dir, 'BAU0102010.xfdl'));
    const input = path.join(root, 'in');
    const out = path.join(root, 'out');
    const pv = preview(input, out);
    assert.equal(pv.roles['ua/usr/BAU0102010.xfdl'].role, 'popup');
    assert.equal(pv.names['ua/usr/BAU0102010.xfdl'], 'BAU0101011_POP');
    // changed on the page: it is a screen after all, so it keeps its own name
    const changed = preview(input, out, { roles: { 'ua/usr/BAU0102010.xfdl': { role: 'screen' } } });
    assert.equal(changed.roles['ua/usr/BAU0102010.xfdl'].role, 'screen');
    assert.equal(changed.names['ua/usr/BAU0102010.xfdl'], 'BAU0102010');
    assert.equal(changed.detected['ua/usr/BAU0102010.xfdl'].role, 'popup');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file names that become the same screen ID clash too (Korean names, - vs _)', () => {
  const korean = resolveNames(['ua/usr/화면.xfdl', 'ua/usr/목록.xfdl']);
  assert.deepEqual(korean.errors.map((e) => e.rel), ['ua/usr/목록.xfdl']);
  assert.match(korean.errors[0].message, /_로 바뀌어 __/);
  assert.deepEqual(resolveNames(['co/A-1.xfdl', 'co/A_1.xfdl']).errors.map((e) => e.rel), ['co/A_1.xfdl']);
  // renaming one of them clears it
  assert.deepEqual(resolveNames(['ua/usr/화면.xfdl', 'ua/usr/목록.xfdl'], { 'ua/usr/목록.xfdl': 'BAU0101020' }).errors, []);
});

test('uni profile: a new name renames the screen folder, files and identifiers', async () => {
  const out = tmp();
  try {
    const report = await runConversion(UNI, out, { profile: 'uni', renames: { 'ua/usr/BAU0101010.xfdl': 'BAU0105010' } });
    const file = report.files.find((f) => f.input === 'ua/usr/BAU0101010.xfdl');
    assert.equal(file.name, 'BAU0105010');
    assert.deepEqual(file.outputs.filter((p) => !p.startsWith('docs/')), [
      'src/views/ua/usr/BAU0105010/BAU0105010View.vue',
      'src/views/ua/usr/BAU0105010/BAU0105010Service.js',
      'src/views/ua/usr/BAU0105010/BAU0105010Constant.js',
    ]);
    // the screen's documents go in a folder named after the new name
    assert.equal(file.doc.path, 'docs/ua/usr/BAU0105010/01_개요.html');
    assert.ok(fs.existsSync(path.join(out, 'docs/ua/usr/BAU0105010/02_변환내용.html')));
    assert.ok(!fs.existsSync(path.join(out, 'src/views/ua/usr/BAU0101010')));
    const view = fs.readFileSync(path.join(out, file.outputs[0]), 'utf8');
    assert.match(view, /import \{ BAU0105010Service as service \} from '\.\/BAU0105010Service'/);
    assert.match(view, /defineOptions\(\{ name: 'BAU0105010View' \}\)/);
    assert.doesNotMatch(view, /BAU0101010(View|Service|Constant)/);
    const service = fs.readFileSync(path.join(out, file.outputs[1]), 'utf8');
    assert.match(service, /const basicUrl = '\/ua\/usr\/BAU0105010'/);
    assert.match(service, /export const BAU0105010Service = /);
    assert.match(fs.readFileSync(path.join(out, file.outputs[2]), 'utf8'), /export const BAU0105010Constant = /);
    // the other screen keeps its file name
    assert.ok(fs.existsSync(path.join(out, 'src/views/ua/usr/BAU0102010/BAU0102010View.vue')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('element profile: a new name renames the .vue and api files', async () => {
  const out = tmp();
  try {
    const report = await runConversion(NEXA, out, { renames: { 'screens/member/MemberList.xfdl': 'MemberMain' } });
    const file = report.files.find((f) => f.input === 'screens/member/MemberList.xfdl');
    assert.deepEqual(file.outputs, ['src/views/screens/member/MemberMain.vue', 'src/api/screens/member/MemberMain.js']);
    assert.match(fs.readFileSync(path.join(out, file.outputs[0]), 'utf8'), /from '\.\.\/\.\.\/\.\.\/api\/screens\/member\/MemberMain\.js'/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('bad or clashing names stop the run before anything is written', async () => {
  const out = tmp();
  try {
    await assert.rejects(
      runConversion(UNI, path.join(out, 'a'), { profile: 'uni', renames: { 'ua/usr/BAU0101010.xfdl': 'BAU0102010' } }),
      /출력 이름을 확인하세요: ua\/usr\/BAU0102010\.xfdl — 같은 폴더의 ua\/usr\/BAU0101010\.xfdl와/,
    );
    await assert.rejects(runConversion(UNI, path.join(out, 'b'), { profile: 'uni', renames: { 'ua/usr/BAU0101010.xfdl': '학생' } }), /쓸 수 없습니다/);
    assert.ok(!fs.existsSync(path.join(out, 'a')));
    assert.ok(!fs.existsSync(path.join(out, 'b')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('nexa2vue.config.json "names" sets defaults that the UI can still override', async () => {
  const work = tmp();
  try {
    const input = path.join(work, 'src');
    fs.cpSync(UNI, input, { recursive: true });
    fs.writeFileSync(path.join(input, 'nexa2vue.config.json'), JSON.stringify({ names: { 'ua/usr/BAU0102010.xfdl': 'BAU0102020' } }));
    const pv = preview(input, path.join(work, 'out'));
    assert.deepEqual(pv.names, { 'ua/usr/BAU0101010.xfdl': 'BAU0101010', 'ua/usr/BAU0102010.xfdl': 'BAU0102020' });

    const fromConfig = await runConversion(input, path.join(work, 'out1'), { profile: 'uni' });
    assert.equal(fromConfig.files.find((f) => f.input === 'ua/usr/BAU0102010.xfdl').name, 'BAU0102020');
    const overridden = await runConversion(input, path.join(work, 'out2'), { profile: 'uni', renames: { 'ua/usr/BAU0102010.xfdl': 'BAU0102030' } });
    assert.equal(overridden.files.find((f) => f.input === 'ua/usr/BAU0102010.xfdl').name, 'BAU0102030');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
