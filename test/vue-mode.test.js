'use strict';

// uni profile into a frontend that is not uni: no uni draft, the AI pass
// writes the screen the vue-convert skill's way (convert-core.js vueMode).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { convertSources } = require('../src/convert-core');
const { buildPromptVue, cleanOutputPath, UNI_SKILL_NAME } = require('../src/ai-convert');
const { frontendKind } = require('../src/uni-structure');

const UNI = path.join(__dirname, 'fixtures', 'uni');
const sources = ['ua/usr/BAU0101010.xfdl'].map((rel) => ({
  rel,
  kind: 'form',
  read: () => ({ text: fs.readFileSync(path.join(UNI, rel), 'utf8'), encoding: 'utf-8' }),
}));

function run(aiConvertVue, opts = {}) {
  const written = new Map();
  const aiConvert = () => { throw new Error('uni AI pass must not run in vue mode'); };
  return convertSources(sources, {
    input: 'in', output: 'out', frontendKind: 'vue', write: (rel, content) => written.set(rel, content), aiConvert, aiConvertVue,
  }, { profile: 'uni', ai: true, ...opts }).then((report) => ({ report, written }));
}

test('vue mode: the AI files are written as given and no uni draft is', async () => {
  let call;
  const { report, written } = await run(async (args) => {
    call = args;
    return {
      files: [{ path: 'src/views/ua/usr/Bau0101010View.vue', content: '<template />\n' }, { path: 'src/api/bau0101010.js', content: 'export {}\n' }],
      notes: ['라우터에 등록 필요'],
      doc: '### 화면 개요\n- 테스트',
      costUsd: 0.2,
      durationMs: 1000,
    };
  });
  assert.equal(report.frontendKind, 'vue');
  assert.equal(call.screen.id, 'BAU0101010');
  assert.match(call.text, /<Script/);
  const files = [...written.keys()];
  assert.ok(files.includes('src/views/ua/usr/Bau0101010View.vue'));
  assert.ok(files.includes('src/api/bau0101010.js'));
  assert.ok(!files.some((f) => /Service\.js$|Constant\.js$/.test(f)), files.join(', '));
  const line = report.files[0];
  assert.deepEqual(line.todos.map((t) => t.message), ['[AI] 라우터에 등록 필요']);
  assert.match(written.get(line.doc.path), /vue-convert 스킬/);
});

test('vue mode: an AI failure writes nothing for the screen and marks it for retry', async () => {
  const { report, written } = await run(async () => { throw new Error('사용 한도'); });
  const line = report.files[0];
  assert.equal(line.status, 'error');
  assert.equal(line.ai.ok, false);
  assert.match(line.error, /초안을 저장하지 않음\): 사용 한도/);
  assert.ok(![...written.keys()].some((f) => f.startsWith('src/')));
});

test('vue mode: needs the AI pass; the preview gets the project preview files and a screen list', async () => {
  await assert.rejects(run(async () => ({}), { ai: false }), /AI 변환으로만/);
  const written = new Map();
  const report = await convertSources(sources, {
    input: 'in', output: 'out', frontendKind: 'vue', write: (rel, content) => written.set(rel, content),
    vuePreviewFiles: [{ path: 'preview/main.js', content: '// vue' }],
    uniPreviewFiles: [{ path: 'preview/uni.js', content: '// uni' }],
    aiConvertVue: async () => ({ files: [{ path: 'src/components/Part.vue', content: 'x' }, { path: 'src/views/ua/A.vue', content: 'x' }], notes: [], doc: '' }),
  }, { profile: 'uni', ai: true, viewer: true });
  assert.equal(report.viewer.kind, 'vue');
  assert.ok(written.has('preview/main.js') && !written.has('preview/uni.js'));
  assert.equal(report.files[0].view, 'src/views/ua/A.vue');
  const list = written.get('preview/screens.js');
  assert.match(list, /id: "BAU0101010"/);
  assert.match(list, /load: \(\) => import\("\/src\/views\/ua\/A\.vue"\)/);
});

test('vue preview: setup.js keeps plugins and CSS from main.js, not App, the router or mount', () => {
  const { setupFromMain } = require('../src/vue-preview-scaffold');
  const chained = setupFromMain("import { createApp } from 'vue'\nimport { createPinia } from 'pinia'\nimport App from './App.vue'\nimport router from './router'\nimport './assets/main.css'\n\ncreateApp(App).use(createPinia()).use(router).mount('#app')\n");
  assert.deepEqual(chained.imports, ["import { createPinia } from 'pinia'", 'import "@/assets/main.css"']);
  assert.deepEqual(chained.body, ['app.use(createPinia())']);
  const named = setupFromMain("import { createApp } from 'vue'\nimport App from './App.vue'\nimport router from './router/index.js'\nimport ElementPlus from 'element-plus'\nconst vm = createApp(App)\nvm.use(ElementPlus)\nvm.use(router)\nrouter.beforeEach(() => true)\nvm.config.globalProperties.$x = 1\nvm.mount('#app')\n");
  assert.deepEqual(named.imports, ["import ElementPlus from 'element-plus'"]);
  assert.deepEqual(named.body, ['app.use(ElementPlus)', 'app.config.globalProperties.$x = 1']);
  assert.ok(named.skipped.some((s) => /beforeEach/.test(s)));
});

test('vue preview: the files point at the project and carry a router only when it has vue-router', () => {
  const { vuePreviewFiles } = require('../src/vue-preview-scaffold');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2v-vp-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.js'), "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '3' } }));
  const files = vuePreviewFiles(root);
  const get = (p) => files.find((f) => f.path === p).content;
  assert.equal(JSON.parse(get('vue-preview.config.json')).frontend, root);
  assert.doesNotMatch(get('preview/main.js'), /vue-router/);
  assert.ok(files.some((f) => f.path === 'vite.config.js') && files.some((f) => f.path === 'preview/start.mjs'));
});

test('shot docs: in vue mode the screen is the report line\'s view, opened by its id', () => {
  const { screensOf, buildMarkers } = require('../src/shot-docs');
  const report = { frontendKind: 'vue', files: [{ input: 'a.xfdl', status: 'partial', view: 'src/views/x/AView.vue', outputs: ['src/views/x/AView.vue'], doc: { id: 'A1', path: 'docs/a/A1.html' } }] };
  const [s] = screensOf(report, 'C:\\out');
  assert.equal(s.kind, 'vue');
  assert.equal(s.hashId, 'A1');
  assert.equal(s.viewFile, 'src/views/x/AView.vue');
  // buttons outside every region are numbered on their own
  const m = buildMarkers({ regions: [{ type: 'section', kinds: ['grid'], title: '목록', box: {}, buttons: [] }, { type: 'loose', buttons: [{ text: '저장', box: {} }] }] });
  assert.deepEqual(m.map((x) => [x.n, x.kind, x.title, x.in]), [[1, '그리드', '목록', undefined], [2, '버튼', '저장', undefined]]);
});

test('vue mode: AI file paths stay inside the project and out of nexa2vue places', () => {
  assert.equal(cleanOutputPath('src\\views\\A.vue'), 'src/views/A.vue');
  assert.equal(cleanOutputPath('./src/A.vue'), 'src/A.vue');
  for (const bad of ['../x.vue', '/abs.vue', 'C:/x.vue', 'src//a.vue', 'docs/a.html', '_nexa2vue-report.json', '']) {
    assert.throws(() => cleanOutputPath(bad), /경로/, bad);
  }
});

test('vue mode: the prompt follows the skill and has no uni rules', () => {
  const skills = [{ name: UNI_SKILL_NAME, description: '', dir: 'C:\\s', body: '## 프로젝트 구성\n- views/users' }];
  const prompt = buildPromptVue({ relPath: 'ua/A.xfdl', skills, inputs: { 'source.xfdl': '<x/>' }, relations: null, screen: { id: 'A', dir: 'ua', screenName: '이름' } });
  assert.match(prompt, /views\/users/);
  assert.match(prompt, /화면ID A\(이름\)/);
  assert.match(prompt, /이 프로젝트의 어떤 컴포넌트·요소가 되었는지/);
  assert.doesNotMatch(prompt, /SearchSection|commonOptions|task\.run/);
});

test('frontendKind: uni base screens → uni, another Vue project → vue, missing folder → uni', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2v-kind-'));
  assert.equal(frontendKind(path.join(root, 'nope')), 'uni');
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  assert.equal(frontendKind(root), 'vue');
  fs.mkdirSync(path.join(root, 'src', 'views', 'co', 'csm', 'CCU0297010'), { recursive: true });
  assert.equal(frontendKind(root), 'uni');
});

test('vue mode: the project check and fix round run too, and a retry is told what was wrong', async () => {
  const written = new Map();
  const calls = [];
  const go = (aiConvertVue, opts = {}) => convertSources(sources, {
    input: 'in', output: 'out', frontendKind: 'vue', write: (rel, content) => written.set(rel, content),
    aiConvert: () => { throw new Error('uni AI pass must not run in vue mode'); },
    aiConvertVue,
    checkFiles: (files) => files.filter((f) => /<AppInput \/>/.test(f.content)).map((f) => ({ file: f.path, line: 1, component: 'AppInput', message: '<AppInput> 필수 prop label 없음' })),
    aiFix: async ({ files }) => { calls.push('fix'); return { files: [], notes: [] }; },
  }, { profile: 'uni', ai: true, ...opts });
  const first = await go(async ({ previousChecks }) => {
    calls.push(['convert', previousChecks]);
    return { files: [{ path: 'src/pages/A.vue', content: '<template><AppInput /></template>\n' }], notes: [], doc: '' };
  });
  const line = first.files[0];
  assert.equal(line.ai.ok, false);
  assert.equal(line.ai.checks.length, 1);
  assert.equal(written.get('src/pages/A.vue'), '<template><AppInput /></template>\n');
  assert.deepEqual(calls, [['convert', undefined], 'fix']);

  const prev = JSON.parse(written.get('_nexa2vue-report.json'));
  calls.length = 0;
  await go(async ({ previousChecks }) => {
    calls.push(['convert', previousChecks.map((c) => c.message)]);
    return { files: [{ path: 'src/pages/A.vue', content: '<template><AppInput label="x" /></template>\n' }], notes: [], doc: '' };
  }, { retryFrom: prev });
  assert.deepEqual(calls, [['convert', ['<AppInput> 필수 prop label 없음']]]);
});

test('vue mode prompt: last time\'s check results go in before the task list', () => {
  const prompt = buildPromptVue({ relPath: 'a', skills: [], inputs: {}, screen: { id: 'A1' }, previousChecks: [{ file: 'src/pages/A.vue', line: 3, message: '<AppInput> 필수 prop label 없음' }] });
  assert.match(prompt, /## 지난 변환에서 틀린 곳[\s\S]+- src\/pages\/A\.vue:3 <AppInput> 필수 prop label 없음[\s\S]+## 할 일/);
});

test('vue mode prompt: the common nexa2vue rules go in, the uni ones do not', () => {
  const { conversionSkills } = require('../src/ai-convert');
  const skills = conversionSkills([], { uni: false });
  const prompt = buildPromptVue({ relPath: 'a', skills, inputs: {}, screen: { id: 'A1' } });
  assert.match(prompt, /<skill name="nexa2vue-rules">/);
  assert.doesNotMatch(prompt, /nexa2vue-rules-uni|SearchSection|selector-box/);
});
