'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { runConversion, preview, validateDirs } = require('../src/job-runner');
const { safeJoin } = require('../src/paths');
const { startServer } = require('../src/server');

const FIX = path.join(__dirname, 'fixtures', 'nexa');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-'));
  fs.cpSync(FIX, path.join(root, 'src-nexa'), { recursive: true });
  return root;
}

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* html */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('validateDirs requires both folders and refuses overlapping input/output', () => {
  const root = tmpRoot();
  const input = path.join(root, 'src-nexa');
  assert.throws(() => validateDirs(input, input), /입력 폴더와 같거나/);
  assert.throws(() => validateDirs(input, path.join(input, 'out')), /입력 폴더와 같거나/);
  assert.throws(() => validateDirs(input, root), /입력 폴더와 같거나/);
  assert.throws(() => validateDirs(input, ''), /모두 지정하세요/);
  assert.throws(() => validateDirs('', path.join(root, 'out')), /모두 지정하세요/);
  assert.throws(() => validateDirs(input, 'relative-out', root), /절대 경로/);
  assert.throws(() => validateDirs(input, path.parse(root).root, root), /드라이브 최상위/);
  // Output may be anywhere the user chooses, as long as it does not overlap the input.
  assert.doesNotThrow(() => validateDirs(input, path.join(root, 'out'), root));
  assert.doesNotThrow(() => validateDirs(input, path.join(os.tmpdir(), 'elsewhere'), root));
  assert.doesNotThrow(() => validateDirs(root, `${root}_vue`, root));
  assert.throws(() => validateDirs(root, path.join(root, 'out'), root), /입력 폴더와 같거나/);
});

test('preview and runConversion refuse an input folder without .xfdl screens', async () => {
  const root = tmpRoot();
  const libOnly = path.join(root, 'src-nexa', 'lib');
  assert.throws(() => preview(libOnly, path.join(root, 'out'), { root }), /넥사크로 화면\(\.xfdl\)이 없습니다/);
  await assert.rejects(runConversion(libOnly, path.join(root, 'out')), /넥사크로 화면\(\.xfdl\)이 없습니다/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});

test('safeJoin refuses paths that escape the output folder', () => {
  assert.throws(() => safeJoin('/tmp/out', '../evil.js'), /outside output folder/);
  assert.ok(safeJoin(path.resolve('out'), 'src/a.vue').endsWith(path.join('src', 'a.vue')));
});

test('runConversion writes views, api, utils and a report without touching the input', async () => {
  const root = tmpRoot();
  const input = path.join(root, 'src-nexa');
  const before = fs.readFileSync(path.join(input, 'screens/member/MemberList.xfdl'), 'utf8');
  const out = path.join(root, 'out');
  const report = await runConversion(input, out, { root });

  assert.deepEqual(report.summary, { total: 4, processed: 4, ok: 1, partial: 3, error: 0, todos: 4 });
  assert.deepEqual(report.files.map((f) => f.input), ['lib/common.xjs', 'screens/Broken.xfdl', 'screens/member/MemberDetail.xfdl', 'screens/member/MemberList.xfdl']);
  assert.deepEqual(report.missingGfn, ['gfn_initForm']);
  for (const rel of [
    'src/views/screens/member/MemberList.vue',
    'src/api/screens/member/MemberList.js',
    'src/utils/nexa-compat.js',
    'src/utils/nexa-gfn.js',
    'src/utils/nexa-lib/lib/common.js',
    '_nexa2vue-report.json',
  ]) {
    assert.ok(fs.existsSync(path.join(out, rel)), rel);
  }
  assert.equal(fs.readFileSync(path.join(input, 'screens/member/MemberList.xfdl'), 'utf8'), before);
});

test('runConversion dry run writes nothing and can be cancelled', async () => {
  const root = tmpRoot();
  const out = path.join(root, 'out');
  const dry = await runConversion(path.join(root, 'src-nexa'), out, { dryRun: true });
  assert.equal(dry.summary.processed, 4);
  assert.equal(fs.existsSync(out), false);

  let calls = 0;
  const cancelled = await runConversion(path.join(root, 'src-nexa'), out, { dryRun: true, isCancelled: () => calls++ >= 1 });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.summary.processed, 1);
});

test('web server: guards, folder browsing, preview, job and file detail', async (t) => {
  const root = tmpRoot();
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const { port } = server.address();

  // DNS rebinding and cross-origin requests are rejected.
  assert.equal((await request(port, 'GET', '/api/config', { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request(port, 'POST', '/api/preview', { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
  // Simple-form CSRF (non-JSON) is rejected.
  const form = await request(port, 'POST', '/api/jobs', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);

  const page = await request(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /nexa2vue/);

  // The work path and the in-page folder browser are gone.
  assert.equal((await request(port, 'GET', '/api/fs')).status, 404);
  assert.equal((await request(port, 'POST', '/api/root', { body: { path: root } })).status, 404);

  const input = path.join(root, 'src-nexa');
  const output = path.join(root, 'vue-out');
  const pv = await request(port, 'POST', '/api/preview', { body: { input, output } });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.forms.length, 3);
  assert.equal(pv.json.libs.length, 1);
  assert.equal((await request(port, 'POST', '/api/preview', { body: { input: os.tmpdir(), output } })).status, 400);
  // Both folders are required; the output is never filled in for the user.
  assert.equal((await request(port, 'POST', '/api/preview', { body: { input, output: '' } })).status, 400);
  assert.equal((await request(port, 'POST', '/api/jobs', { body: { input, output: '' } })).status, 400);
  assert.equal((await request(port, 'POST', '/api/jobs', { body: { input: '', output } })).status, 400);

  const started = await request(port, 'POST', '/api/jobs', { body: { input, output } });
  assert.equal(started.status, 202);
  let job;
  for (let i = 0; i < 50; i++) {
    job = (await request(port, 'GET', `/api/jobs/${started.json.id}`)).json;
    if (job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(job.state, 'done');
  assert.equal(job.summary.total, 4);

  const listIndex = job.files.findIndex((f) => f.input.endsWith('MemberList.xfdl'));
  const detail = await request(port, 'GET', `/api/jobs/${job.id}/files/${listIndex}`);
  assert.match(detail.json.source, /<Form id="MemberList"/);
  assert.match(detail.json.outputs[0].content, /<script setup>/);
  assert.equal((await request(port, 'GET', `/api/jobs/${job.id}/files/99`)).status, 404);
});

test('web server: --input presets the input folder and must hold .xfdl screens', async (t) => {
  const root = tmpRoot();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-empty-'));
  fs.writeFileSync(path.join(empty, 'readme.txt'), 'no nexacro here');
  await assert.rejects(startServer({ input: empty, port: 0 }), /넥사크로 화면\(\.xfdl\)이 없습니다/);

  const blank = await startServer({ port: 0 });
  t.after(() => blank.close());
  assert.deepEqual((await request(blank.address().port, 'GET', '/api/config')).json, { app: 'nexa2vue', input: null });

  const server = await startServer({ input: path.join(root, 'src-nexa'), port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await request(port, 'GET', '/api/config')).json.input, fs.realpathSync(path.join(root, 'src-nexa')));
});

test('web server: /api/ai/skills lists the skills of a folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['screen-convert', 'screen-summary']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 설명\n---\n본문\n`);
  }
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  const listed = await request(port, 'POST', '/api/ai/skills', { body: { folder: root } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.single, false);
  assert.deepEqual(listed.json.skills.map((s) => s.name), ['screen-convert', 'screen-summary']);
  assert.equal((await request(port, 'POST', '/api/ai/skills', { body: { folder: path.join(root, 'nope') } })).status, 400);
  assert.equal((await request(port, 'POST', '/api/ai/skills', { body: { folder: root }, headers: { Origin: 'http://evil.example' } })).status, 403);
});

test('web server: /api/shutdown is off unless the launcher enables it', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await request(port, 'POST', '/api/shutdown', { body: {} })).status, 404);
  assert.equal((await request(port, 'POST', '/api/shutdown', { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
});

test('web server: output "선택" picks any folder and conversion writes there', async (t) => {
  const root = tmpRoot();
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-out-')), 'vue');
  const calls = [];
  const picks = [null, elsewhere];
  const server = await startServer({
    root,
    port: 0,
    pickFolder: async (initial, purpose) => {
      calls.push([initial, purpose]);
      return picks.shift();
    },
  });
  t.after(() => server.close());
  const { port } = server.address();
  const pick = (initial) => request(port, 'POST', '/api/output/pick', { body: { initial } });

  assert.deepEqual((await pick('')).json, { cancelled: true, path: null });
  assert.deepEqual((await pick('D:\\x')).json, { cancelled: false, path: elsewhere });
  assert.deepEqual(calls, [[null, 'output'], ['D:\\x', 'output']]);

  const input = path.join(root, 'src-nexa');
  const job = await request(port, 'POST', '/api/jobs', { body: { input, output: elsewhere, uiOnly: true } });
  assert.equal(job.status, 202);
  for (let i = 0; i < 50; i++) {
    if ((await request(port, 'GET', `/api/jobs/${job.json.id}`)).json.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(fs.existsSync(path.join(elsewhere, 'src', 'views', 'screens', 'member', 'MemberList.vue')), true);
});

test('web server: frontend / backend / skill "선택" pick any folder', async (t) => {
  const calls = [];
  const picks = ['C:\\fe', null, 'C:\\skills'];
  const server = await startServer({
    port: 0,
    pickFolder: async (initial, purpose) => {
      calls.push([initial, purpose]);
      return picks.shift();
    },
  });
  t.after(() => server.close());
  const { port } = server.address();
  const pick = (purpose, initial) => request(port, 'POST', '/api/folder/pick', { body: { purpose, initial } });

  assert.deepEqual((await pick('frontend', '')).json, { cancelled: false, path: 'C:\\fe' });
  assert.deepEqual((await pick('backend', 'C:\\be')).json, { cancelled: true, path: null });
  assert.deepEqual((await pick('skill', '')).json, { cancelled: false, path: 'C:\\skills' });
  assert.equal((await pick('output', '')).status, 400);
  assert.deepEqual(calls, [[null, 'frontend'], ['C:\\be', 'backend'], [null, 'skill']]);
});

test('web server: input "선택" accepts any folder with .xfdl screens', async (t) => {
  const root = tmpRoot();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-empty-'));
  const calls = [];
  const picks = [null, empty, path.join(root, 'src-nexa')];
  const server = await startServer({
    port: 0,
    pickFolder: async (initial, purpose) => {
      calls.push([initial, purpose]);
      return picks.shift();
    },
  });
  t.after(() => server.close());
  const { port } = server.address();
  const pick = (initial) => request(port, 'POST', '/api/input/pick', { body: { initial } });

  assert.deepEqual((await pick('')).json, { cancelled: true, path: null });
  const invalid = await pick('');
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /넥사크로 화면\(\.xfdl\)이 없습니다/);
  assert.deepEqual((await pick('D:\\x')).json, { cancelled: false, path: fs.realpathSync(path.join(root, 'src-nexa')) });
  assert.deepEqual(calls, [[null, 'input'], [null, 'input'], ['D:\\x', 'input']]);

  // Cross-site pages cannot pop up the dialog.
  assert.equal((await request(port, 'POST', '/api/input/pick', { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
});

test('runConversion uiOnly converts screens only and writes no runtime helpers', async () => {
  const root = tmpRoot();
  const out = path.join(root, 'out-ui');
  const report = await runConversion(path.join(root, 'src-nexa'), out, { uiOnly: true });
  assert.equal(report.uiOnly, true);
  assert.ok(report.files.every((f) => f.kind === 'form'));
  assert.equal(report.files.some((f) => f.todos.some((t) => t.message.startsWith('[script]'))), false);
  assert.equal(fs.existsSync(path.join(out, 'src', 'utils', 'nexa-compat.js')), false);
  assert.equal(fs.existsSync(path.join(out, 'src', 'views', 'screens', 'member', 'MemberList.vue')), true);
});

test('runConversion viewer writes a runnable Vite project without overwriting existing files', async () => {
  const root = tmpRoot();
  const out = path.join(root, 'out-viewer');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'vite.config.js'), '// mine\n');
  const report = await runConversion(path.join(root, 'src-nexa'), out, { uiOnly: true, viewer: true });
  assert.deepEqual(report.viewer.kept, ['vite.config.js']);
  assert.ok(report.viewer.written.includes('src/App.vue'));
  assert.equal(fs.readFileSync(path.join(out, 'vite.config.js'), 'utf8'), '// mine\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'vite');
  assert.ok(pkg.dependencies.vue && pkg.dependencies['element-plus'] && pkg.devDependencies.vite);
  assert.match(fs.readFileSync(path.join(out, 'view-screens.cmd'), 'utf8'), /\r\nnpm|call npm run dev\r\n/);
  const app = fs.readFileSync(path.join(out, 'src', 'App.vue'), 'utf8');
  const { descriptor, errors } = require('@vue/compiler-sfc').parse(app);
  assert.deepEqual(errors, []);
  require('@vue/compiler-sfc').compileScript(descriptor, { id: 'viewer', inlineTemplate: true });
});

test('web server: "AI 실패한 화면만 다시 변환" needs uni + AI and a previous run with failures', async (t) => {
  const root = tmpRoot();
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  const input = path.join(root, 'src-nexa');
  const output = path.join(root, 'out');
  const body = { input, output, profile: 'uni', ai: true, retryFailed: true };

  assert.equal((await request(port, 'POST', '/api/jobs', { body: { ...body, ai: false } })).status, 400);
  // No previous run in the output folder.
  const none = await request(port, 'POST', '/api/jobs', { body });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /이전 변환 결과/);
  // A previous run whose screens all went through the AI.
  const forms = (await request(port, 'POST', '/api/preview', { body: { input, output } })).json.forms;
  fs.mkdirSync(output, { recursive: true });
  const files = forms.map((rel) => ({ input: rel, kind: 'form', name: null, status: 'ok', ai: { ok: true }, todos: [], outputs: [] }));
  fs.writeFileSync(path.join(output, '_nexa2vue-report.json'), JSON.stringify({ profile: 'uni', input: validateDirs(input, output).input, files }));
  const nothing = await request(port, 'POST', '/api/jobs', { body });
  assert.equal(nothing.status, 409);
  assert.match(nothing.json.error, /다시 변환할 화면이 없습니다/);
});

test('web server: 화면 설명 문서(shotDocs)는 uni 스타일 미리보기 생성이 켜져 있어야 한다', async (t) => {
  const root = tmpRoot();
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  const body = { input: path.join(root, 'src-nexa'), output: path.join(root, 'out'), profile: 'uni', ai: true, shotDocs: true, viewer: false };
  const res = await request(port, 'POST', '/api/jobs', { body });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /미리보기 함께 생성/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});
