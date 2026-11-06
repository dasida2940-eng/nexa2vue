'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ruleApiSpec, cleanAiApis, checkApisAgainstCode, apiListMarkdown, apiDetailMarkdown } = require('../src/api-spec');
const { screenDocs, screenDocPath } = require('../src/conversion-doc');
const { OUTPUT_SCHEMA, OUTPUT_SCHEMA_VUE } = require('../src/ai-convert');

const model = {
  id: 'BAU0101010',
  dir: 'ua/usr',
  screenName: '학적변동',
  search: [
    { key: 'syy', label: '학년도', type: 'text', required: true },
    { key: 'deptCd', label: '학과', type: 'select', required: false },
  ],
  apis: [
    { name: 'findBamn011List', kind: 'findList', token: 'Bamn011', dsId: 'ds_bamn011', title: '학적변동 내역', pk: ['stdNo'],
      columns: [{ col: 'STD_NO', field: 'stdNo', label: '학번' }, { col: 'SYY', field: 'syy', label: '학년도' }, { col: 'CHG_DT', field: 'chgDt', label: '변동일자', date: true }, { col: 'STATUS', field: 'status', label: '' }] },
    { name: 'saveBamn011List', kind: 'saveList', token: 'Bamn011', dsId: 'ds_bamn011', title: '학적변동 내역', pk: ['stdNo'],
      columns: [{ col: 'STD_NO', field: 'stdNo', label: '학번' }, { col: 'CHG_DT', field: 'chgDt', label: '변동일자', date: true }] },
    { name: 'findBamn010Info', kind: 'findInfo', token: 'Bamn010', dsId: 'ds_info', title: '학생 정보', pk: ['stdNo'],
      columns: [{ col: 'STD_NO', field: 'stdNo', label: '학번' }, { col: 'STD_NM', field: 'stdNm', label: '성명' }] },
  ],
};

test('api spec (rules): address, what is sent and what comes back per API', () => {
  const [find, save, info] = ruleApiSpec(model, { backend: true });
  assert.equal(find.method, 'GET');
  assert.equal(find.url, '/api/ua/usr/BAU0101010/findBamn011List');
  assert.equal(find.desc, '학적변동 목록 조회');
  assert.equal(find.requestShape, 'query');
  assert.deepEqual(find.request.map((f) => [f.name, f.required]), [['syy', true], ['deptCd', false]]);
  assert.match(find.request[0].desc, /부분 일치/);
  assert.match(find.request[1].desc, /SQL 조건 미작성/);
  assert.equal(find.responseShape, 'list');
  // audit/status columns are not the screen's
  assert.deepEqual(find.response.map((f) => f.name), ['stdNo', 'syy', 'chgDt']);
  assert.equal(find.response[2].type, 'string (YYYY-MM-DD)');
  assert.equal(save.method, 'POST');
  assert.equal(save.requestShape, 'list');
  assert.deepEqual(save.request.map((f) => [f.name, f.required]), [['status', true], ['stdNo', true], ['chgDt', false]]);
  assert.equal(save.responseShape, 'none');
  assert.deepEqual(info.request.map((f) => f.name), ['stdNo']);
  assert.equal(info.responseShape, 'object');
  assert.equal(info.backend, 'BAU0101010Controller.findBamn010Info');
});

test('api spec (rules): without a backend the address is still the real request one and SQL notes are left out', () => {
  const [find] = ruleApiSpec(model);
  // axios baseURL /api + basicUrl, the same with or without the backend
  assert.equal(find.url, '/api/ua/usr/BAU0101010/findBamn011List');
  assert.equal(find.backend, '');
  assert.ok(find.request.every((f) => !/SQL|부분 일치/.test(f.desc)));
});

test('api spec (AI): an API the written code does not have is flagged', () => {
  const files = [
    { path: 'src/views/a/AService.js', content: "const basicUrl = '/a'\nexport const AService = {\n  findAList: (params) => request(api.get(`${basicUrl}/findAList`, { params })),\n}\n" },
    { path: 'src/views/a/AView.vue', content: '<script setup>\nservice.findAList(search.value)\n</script>\n' },
    { path: 'docs/x.html', content: 'findGhost saveGhost' },
  ];
  const apis = cleanAiApis([
    { name: 'findAList', method: 'GET', url: '/api/a/findAList', service: 'AService.findAList', requestShape: 'none', responseShape: 'none' },
    { name: 'findAListX', method: 'GET', url: '/api/a/${id}/findAList?x=1', service: 'AService.findAList', requestShape: 'none', responseShape: 'none' },
    { name: 'saveGhost', method: 'POST', url: '/api/a/saveGhost', service: 'AService.saveGhost', requestShape: 'none', responseShape: 'none' },
  ]);
  const [ok, alsoOk, ghost] = checkApisAgainstCode(apis, files);
  assert.equal(ok.missing, undefined);
  // the call function is there and template parts of the address are skipped
  assert.equal(alsoOk.missing, undefined);
  // the docs file does not count as code
  assert.deepEqual(ghost.missing, ['함수 saveGhost', '주소 /api/a/saveGhost']);
  assert.match(apiDetailMarkdown(ghost), /⚠ 확인 필요/);
  assert.match(apiListMarkdown([ok, ghost]), /⚠ 코드에서 찾지 못함/);
});

test('api spec (AI): malformed entries are dropped, never thrown', () => {
  assert.deepEqual(cleanAiApis(undefined), []);
  const apis = cleanAiApis([
    null,
    { name: 'x' },
    { name: 'findA', method: 'get', url: ' /a/findA ', requestShape: 'query', request: [{ name: 'k', type: '', required: 'yes' }, { type: 'string' }], responseShape: 'weird', response: [{ name: 'v' }] },
  ]);
  assert.equal(apis.length, 1);
  assert.equal(apis[0].method, 'GET');
  assert.equal(apis[0].url, '/a/findA');
  assert.deepEqual(apis[0].request, [{ name: 'k', type: 'string', required: false, desc: '' }]);
  assert.equal(apis[0].responseShape, 'none');
  assert.deepEqual(apis[0].response, []);
});

test('converting again drops the screen\'s old pages (and the old single-file doc), keeps its images', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { runConversion } = require('../src/job-runner');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-docs-'));
  try {
    const dir = path.join(out, 'docs', 'ua', 'usr', 'BAU0101010');
    fs.mkdirSync(path.join(dir, 'API'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'API', 'findGone.html'), 'old');
    // a Korean name: Node 24's fs.rmSync skipped (or crashed on) these on Windows
    fs.writeFileSync(path.join(dir, '09_예전.html'), 'old');
    fs.writeFileSync(path.join(dir, 'images', 'base.png'), 'png');
    fs.writeFileSync(path.join(out, 'docs', 'ua', 'usr', 'BAU0101010.html'), 'old single file');
    await runConversion(path.join(__dirname, 'fixtures', 'uni'), out, { profile: 'uni' });
    // and once more over its own Korean-named pages
    await runConversion(path.join(__dirname, 'fixtures', 'uni'), out, { profile: 'uni' });
    assert.ok(!fs.existsSync(path.join(dir, 'API', 'findGone.html')));
    assert.ok(!fs.existsSync(path.join(dir, '09_예전.html')));
    assert.ok(!fs.existsSync(path.join(out, 'docs', 'ua', 'usr', 'BAU0101010.html')));
    assert.ok(fs.existsSync(path.join(dir, 'images', 'base.png')));
    assert.ok(fs.existsSync(path.join(dir, '01_개요.html')));
    assert.ok(fs.readdirSync(path.join(dir, 'API')).length > 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('all-API page: every screen in one table, shared addresses and screens of an older report noted', () => {
  const { allApisDoc } = require('../src/conversion-doc');
  const api = (name, url, extra = {}) => ({ name, method: 'GET', url, desc: `${name} 조회`, page: `docs/a/A1/API/${name}.html`, ...extra });
  const html = allApisDoc({
    files: [
      { input: 'a/A.xfdl', doc: { id: 'A1', screenName: '가', path: 'docs/a/A1/01_개요.html', apis: [api('findCode', '/api/co/findCode'), api('findA', '/api/a/A1/findA', { missing: ['함수 findA'] })] } },
      { input: 'a/B.xfdl', doc: { id: 'B1', screenName: '나', path: 'docs/a/B1/01_개요.html', apis: [api('findCode', '/api/co/findCode')] } },
      { input: 'a/S.xfdl', mergedInto: 'a/A.xfdl', doc: { id: 'A1', path: 'docs/a/A1/01_개요.html', apis: [api('findX', '/x')] } },
      { input: 'a/Old.xfdl', doc: { id: 'OLD1', screenName: '예전', path: 'docs/a/OLD1.html' } },
    ],
  });
  assert.match(html, /화면 3개 · API 3개/);
  assert.match(html, /같은 주소: A1, B1/);
  assert.match(html, /⚠ 코드에서 찾지 못함\(함수 findA\)/);
  assert.match(html, /href="a\/A1\/API\/findA\.html"/);
  assert.doesNotMatch(html, /findX/);
  assert.match(html, /API 정보가 없는 화면\(이전 버전으로 변환한 결과, 다시 변환하면 들어감\): OLD1/);
});

test('summary skill: made skills carry the generator version, older ones read as 1', () => {
  const { skillFile, skillGeneratorVersion, SKILL_GENERATOR_VERSION } = require('../src/uni-skill');
  const made = skillFile({ body: '## 1. 프로젝트 구성', structure: { frontend: { root: 'C:/fe' } }, utils: '' });
  assert.equal(skillGeneratorVersion(made), SKILL_GENERATOR_VERSION);
  assert.ok(SKILL_GENERATOR_VERSION >= 3);
  assert.equal(skillGeneratorVersion('---\nname: vue-convert\ngenerated-at: x\n---\n'), 1);
  // 3: the summary skill writes how this project keeps each base rule (no uni rules skill shipped)
  const { buildSkillPrompt } = require('../src/uni-skill');
  const prompt = buildSkillPrompt({ frontend: { root: 'C:/fe', screens: ['src/views/a/AView.vue'] } });
  assert.match(prompt, /6\. 변환 규칙 적용법/);
  assert.match(prompt, /## nexa2vue 기본 규칙/);
  assert.match(prompt, /원본 Div 하나는 영역 하나로 둔다/);
  assert.match(prompt, /7\. 하지 말 것/);
  assert.match(buildSkillPrompt({ frontend: { root: 'C:/fe', screens: [] }, backend: { root: 'C:/be', referenceScreens: [], basePackage: 'p' } }), /7\. 백엔드[\s\S]*8\. 하지 말 것/);
});

test('api spec: both AI schemas require apis', () => {
  assert.ok(OUTPUT_SCHEMA.required.includes('apis'));
  assert.ok(OUTPUT_SCHEMA_VUE.required.includes('apis'));
  assert.equal(OUTPUT_SCHEMA.properties.apis.items.properties.request.items.required.includes('required'), true);
  // another Vue project: no uni names or Spring backend in what the AI is told
  assert.doesNotMatch(JSON.stringify(OUTPUT_SCHEMA_VUE.properties.apis), /uni|Controller|@RequestMapping|XxxService|I\/U\/D/);
  assert.match(JSON.stringify(OUTPUT_SCHEMA.properties.apis), /@RequestMapping/);
  // the real request address there too: the project's own base address, or a note that it is unknown
  const vueUrl = OUTPUT_SCHEMA_VUE.properties.apis.items.properties.url.description;
  assert.match(vueUrl, /기본 주소/);
  assert.match(vueUrl, /기본 주소 미확인/);
  assert.doesNotMatch(vueUrl, /\/api/);
});

test('screen docs: one folder per screen, the API list and one page per API', () => {
  const result = { input: 'ua/usr/BAU0101010.xfdl', outputs: ['src/views/ua/usr/BAU0101010/BAU0101010View.vue', 'docs/ua/usr/BAU0101010/01_개요.html'], todos: [], status: 'ok' };
  const pages = screenDocs({ result, model, aiDoc: '', convertedAt: 'now' });
  const dir = 'docs/ua/usr/BAU0101010';
  assert.equal(screenDocPath(model), `${dir}/01_개요.html`);
  assert.deepEqual(pages.map((p) => p.path), [
    `${dir}/01_개요.html`, `${dir}/02_변환내용.html`, `${dir}/03_API목록.html`,
    `${dir}/API/findBamn011List.html`, `${dir}/API/saveBamn011List.html`, `${dir}/API/findBamn010Info.html`,
  ]);
  const get = (name) => pages.find((p) => p.path.endsWith(name)).content;
  // the overview links every page and lists only the code files
  assert.match(get('01_개요.html'), /href="API\/saveBamn011List\.html"/);
  assert.doesNotMatch(get('01_개요.html'), /<code>docs\//);
  assert.match(get('03_API목록.html'), /규칙 기반 초안 기준/);
  const save = get('API/saveBamn011List.html');
  assert.match(save, /href="\.\.\/01_%EA%B0%9C%EC%9A%94\.html"/);
  assert.match(save, /POST <code>\/api\/ua\/usr\/BAU0101010\/saveBamn011List<\/code>/);
  assert.match(save, /<h2>보내는 값 \(요청\)<\/h2>/);
  assert.match(save, /<h2>받는 값 \(응답\)<\/h2>/);
  // the AI's spec replaces the rule-based one; odd names become file-safe
  const aiApis = cleanAiApis([{ name: 'find Z', desc: 'Z 조회', method: 'GET', url: '/z/findZ', requestShape: 'none', request: [], responseShape: 'list', response: [{ name: 'zz', type: 'number', desc: '제트' }] }]);
  const ai = screenDocs({ result, model, aiDoc: '### 화면 개요\n- x', aiApis, convertedAt: 'now' });
  assert.deepEqual(ai.slice(3).map((p) => p.path), [`${dir}/API/find_Z.html`]);
  assert.match(ai[2].content, /AI가 변환한 코드 기준/);
  // vue mode without AI apis: nothing guessed from the uni model
  assert.equal(screenDocs({ result, model, aiDoc: '', convertedAt: 'now', kind: 'vue' }).length, 2);
  assert.equal(apiListMarkdown([]), '');
});
