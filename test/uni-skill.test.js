'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { exportedFunctions, utilsReference, buildSkillPrompt, skillFile } = require('../src/uni-skill');
const { startServer } = require('../src/server');
const { listScreens } = require('../src/uni-structure');

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function fakeFrontend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-skill-test-'));
  const fe = path.join(root, 'frontend');
  fs.mkdirSync(path.join(fe, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(fe, 'src', 'utils', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(fe, 'src', 'utils', 'domain', 'data.js'), [
    'const hidden = () => 1',
    'export const data = {',
    '  add(list, item) { list.push(item) },',
    '  remove: (list, checked = []) => list,',
    '  STATUS: { I: "I" },',
    '}',
    'export function tempId() { return hidden() }',
  ].join('\n'));
  fs.writeFileSync(path.join(fe, 'README.md'), '# fe');
  return { root, fe };
}

test('uni skill: the utils function list comes from the source, not from the AI', () => {
  assert.deepEqual(exportedFunctions('export const a = { f(x, y = 1) {}, g: async (z) => z, n: 3 }\nexport const h = (p) => p'), ['a.f(x, y = 1)', 'a.g(z)', 'a.n', 'h(p)']);
  assert.deepEqual(exportedFunctions('this is not js {'), []);
  const { fe } = fakeFrontend();
  assert.equal(utilsReference(fe), '### domain/data.js\n- data.add(list, item)\n- data.remove(list, checked = [])\n- data.STATUS\n- tempId()');
});

test('uni skill: the prompt lists the project screens (not the docs) and skips the backend when there is none', () => {
  const prompt = buildSkillPrompt({ frontend: { root: 'C:\\fe', docs: ['README.md'], referenceScreens: [], screens: ['src/views/users/UserListView.vue'] }, backend: null });
  assert.match(prompt, /UserListView\.vue/);
  assert.doesNotMatch(prompt, /- C:\\fe\\README\.md/);
  assert.match(prompt, /문서는 기준으로 삼지 않는다/);
  assert.match(prompt, /backend는 만들지 않는다/);
});

test('uni structure: screens are the base screens when present, otherwise every .vue under src/views', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2v-screens-'));
  fs.mkdirSync(path.join(root, 'src', 'views', 'users'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'views', 'users', 'UserListView.vue'), '<template/>');
  fs.writeFileSync(path.join(root, 'src', 'views', 'Home.vue'), '<template/>');
  assert.deepEqual(listScreens(root), ['src/views/Home.vue', 'src/views/users/UserListView.vue']);
  const csm = path.join(root, 'src', 'views', 'co', 'csm', 'CCU0297010');
  fs.mkdirSync(csm, { recursive: true });
  fs.writeFileSync(path.join(csm, 'CCU0297010View.vue'), '<template/>');
  assert.deepEqual(listScreens(root), ['src/views/co/csm/CCU0297010/CCU0297010View.vue']);
});

test('web server: 구조 파악 with skill: true makes the skill in the background', async (t) => {
  const { root, fe } = fakeFrontend();
  const skillDir = path.join(root, 'skill');
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const server = await startServer({
    port: 0,
    structureFile: path.join(root, 'structure.json'),
    skillDir,
    skillClaudeStatus: async () => ({ available: true, loggedIn: true }),
    makeSkill: async ({ structure, dir, onStep }) => {
      calls.push(structure.frontend.root);
      onStep('읽기 README.md');
      await gate;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, '---\nname: vue-convert\ngenerated-at: 2026-10-30T00:00:00.000Z\n---\n\nbody\n');
      return { dir, file, chars: 60, notes: ['확인'] };
    },
  });
  t.after(() => server.close());
  const { port } = server.address();

  // Without skill: true nothing is made (and no Claude is needed).
  assert.equal((await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe })).json.skill.state, 'idle');
  assert.equal(calls.length, 0);

  const analyzed = await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe, skill: true });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.json.skill.state, 'running');
  assert.deepEqual(calls, [path.resolve(fe)]);
  // While it runs: no second one, no new 구조 파악.
  assert.equal((await request(port, 'POST', '/api/uni/skill', {})).status, 409);
  assert.equal((await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe, skill: true })).status, 409);

  release();
  let s;
  for (let i = 0; i < 50; i++) {
    s = (await request(port, 'GET', '/api/uni/skill')).json;
    if (s.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.state, 'done');
  assert.equal(s.saved.file, path.join(skillDir, 'SKILL.md'));
  assert.equal(s.saved.generatedAt, '2026-10-30T00:00:00.000Z');
  assert.ok(s.log.some((l) => l.includes('읽기 README.md')));
  assert.ok(s.log.some((l) => l.includes('확인할 것: 확인')));
  // logFrom: only lines not shown yet
  assert.equal((await request(port, 'GET', `/api/uni/skill?logFrom=${s.logTotal}`)).json.log.length, 0);
});

test('web server: the skill counts as running from the first request, and blocks sign-out and shutdown', async (t) => {
  const { root, fe } = fakeFrontend();
  let release;
  const gate = new Promise((r) => (release = r));
  let made = 0;
  const server = await startServer({
    port: 0,
    shutdownable: true,
    structureFile: path.join(root, 'structure.json'),
    skillDir: path.join(root, 'skill'),
    // the status check is slow (it spawns claude): a second request lands meanwhile
    skillClaudeStatus: async () => {
      await gate;
      return { available: true, loggedIn: true };
    },
    makeSkill: async () => {
      made++;
      await new Promise(() => {});
    },
  });
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe })).status, 200);
  const first = request(port, 'POST', '/api/uni/skill', {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await request(port, 'POST', '/api/uni/skill', {})).status, 409);
  for (const url of ['/api/ai/logout', '/api/ai/account', '/api/shutdown']) {
    const res = await request(port, 'POST', url, {});
    assert.equal(res.status, 409, url);
    assert.match(res.json.error, /규칙 스킬 생성이 진행 중/, url);
  }
  release();
  assert.equal((await first).status, 200);
  assert.equal(made, 1);
});

test('web server: a skill made from other folders is flagged and not used for a conversion', async (t) => {
  const { root, fe } = fakeFrontend();
  const skillDir = path.join(root, 'skill');
  const input = path.join(root, 'input');
  fs.mkdirSync(path.join(input, 'ua', 'usr'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'uni', 'ua', 'usr', 'BAU0102010.xfdl'), path.join(input, 'ua', 'usr', 'BAU0102010.xfdl'));
  const writeSkill = (from) => {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: vue-convert\ngenerated-at: 2026-11-01T00:00:00.000Z\ngenerated-from: ${from}\n---\n\nbody\n`);
  };
  const server = await startServer({
    port: 0,
    structureFile: path.join(root, 'structure.json'),
    skillDir,
    skillClaudeStatus: async () => ({ available: true, loggedIn: true }),
    makeSkill: async () => assert.fail('must not run'),
  });
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe })).status, 200);

  writeSkill(fe);
  assert.equal((await request(port, 'GET', '/api/uni/skill')).json.saved.stale, false);
  writeSkill(path.join(root, 'other-frontend'));
  assert.equal((await request(port, 'GET', '/api/uni/skill')).json.saved.stale, true);
  const job = await request(port, 'POST', '/api/jobs', { input, output: path.join(root, 'out'), profile: 'uni', ai: true, aiSkills: [skillDir], uniFrontend: fe });
  assert.equal(job.status, 409);
  assert.match(job.json.error, /지금의 frontend·backend로 만든 것이 아닙니다/);
});

test('web server: no skill without Claude signed in', async (t) => {
  const { root, fe } = fakeFrontend();
  const server = await startServer({
    port: 0,
    structureFile: path.join(root, 'structure.json'),
    skillDir: path.join(root, 'skill'),
    skillClaudeStatus: async () => ({ available: true, loggedIn: false }),
    makeSkill: async () => assert.fail('must not run'),
  });
  t.after(() => server.close());
  const { port } = server.address();
  const analyzed = await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe, skill: true });
  assert.equal(analyzed.status, 200);
  assert.match(analyzed.json.skillError, /Claude가 연결되어 있지 않아/);
  assert.equal(analyzed.json.skill.saved, null);
});

test('the summary skill file is the summary and the utils list only: the conversion rules have their own skill', () => {
  const content = skillFile({ body: '## 요약\n- 그리드에 영향 주는 조건을 Form에 두지 않는다', structure: { frontend: { root: path.join(os.tmpdir(), 'n2v-no-such-frontend') } }, utils: '### domain/data.js\n- data.add(rows, row)' });
  assert.ok(content.indexOf('## 요약') < content.indexOf('## 공통 유틸 함수 목록'));
  assert.doesNotMatch(content, /## 넥사크로 변환 규칙/);
});
