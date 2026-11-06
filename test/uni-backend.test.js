'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { convertFormUni } = require('../src/gen-uni');
const { analyzeUni } = require('../src/uni-structure');
const { startServer } = require('../src/server');

const UNI = path.join(__dirname, 'fixtures', 'uni');
const read = (rel) => fs.readFileSync(path.join(UNI, rel), 'utf8');

/** A minimal uni frontend + backend pair, enough for "구조 파악". */
function fakeUni() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-uni-'));
  const fe = path.join(root, 'frontend');
  const be = path.join(root, 'backend');
  fs.mkdirSync(path.join(fe, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(fe, 'src', 'utils', 'infra'), { recursive: true });
  fs.mkdirSync(path.join(fe, 'src', 'views', 'co', 'csm', 'CCU0297010'), { recursive: true });
  fs.writeFileSync(path.join(fe, 'src', 'utils', 'infra', 'api.js'), "const api = axios.create({\n  baseURL: '/api',\n})\n");
  const pkg = path.join(be, 'src', 'main', 'java', 'kr', 'co', 'averedu');
  fs.mkdirSync(path.join(pkg, 'common', 'dto'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'co', 'csm', 'controller'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'AvereduBackendApplication.java'), 'package kr.co.averedu;\n\n@SpringBootApplication\npublic class AvereduBackendApplication {}\n');
  fs.writeFileSync(path.join(pkg, 'common', 'dto', 'CommonDto.java'), 'package kr.co.averedu.common.dto;\n');
  fs.writeFileSync(path.join(pkg, 'co', 'csm', 'controller', 'CCU0297010Controller.java'), '');
  fs.writeFileSync(path.join(be, 'SCREEN_CONVENTION.md'), '#');
  return { root, fe, be };
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || 'null') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('backend: one Controller/Service/Mapper/Dto/Mapper.xml per screen, named like the frontend Service', () => {
  const out = convertFormUni(read('ua/usr/BAU0101010.xfdl'), { relPath: 'ua/usr/BAU0101010.xfdl', backend: { basePackage: 'kr.co.averedu' } });
  const byName = Object.fromEntries(out.backendFiles.map((f) => [path.posix.basename(f.path), f]));
  assert.deepEqual(out.backendFiles.map((f) => f.path), [
    'src/main/java/kr/co/averedu/ua/usr/controller/BAU0101010Controller.java',
    'src/main/java/kr/co/averedu/ua/usr/service/BAU0101010Service.java',
    'src/main/java/kr/co/averedu/ua/usr/mapper/BAU0101010Mapper.java',
    'src/main/java/kr/co/averedu/ua/usr/dto/BAU0101010Dto.java',
    'src/main/resources/mapper/ua/usr/BAU0101010Mapper.xml',
  ]);

  // Every API the frontend Service calls has a controller method of the same name.
  const frontendService = out.files.find((f) => f.path.endsWith('Service.js')).content;
  const apis = [...frontendService.matchAll(/^ {2}(\w+): \(params\)/gm)].map((m) => m[1]);
  assert.ok(apis.length >= 2);
  const controller = byName['BAU0101010Controller.java'].content;
  assert.match(controller, /@RequestMapping\("\/api\/ua\/usr\/BAU0101010"\)/);
  for (const api of apis) assert.match(controller, new RegExp(`Mapping\\("/${api}"\\)`), api);

  const service = byName['BAU0101010Service.java'].content;
  assert.match(service, /case "D":\n\s+mapper\.deleteBamn011Q01\(row\);/);

  const dto = byName['BAU0101010Dto.java'].content;
  assert.match(dto, /extends CommonDto/);
  assert.match(dto, /private String chgDt; +\/\/ 변동일자\(YYYY-MM-DD\)/);
  assert.doesNotMatch(dto, /private String chk;/); // grid checkbox column is not data

  const xml = byName['BAU0101010Mapper.xml'].content;
  assert.match(xml, /<mapper namespace="kr\.co\.averedu\.ua\.usr\.mapper\.BAU0101010Mapper">/);
  assert.match(xml, /TO_CHAR\(A\.CHG_DT, 'YYYY-MM-DD'\) AS CHG_DT/);
  assert.match(xml, /<insert id="insertBamn011Q01"[\s\S]*FRST_INPT_INDV_NO[\s\S]*#\{session\.indvNo\}/);
  assert.match(xml, /<!-- TODO: 테이블 UNI\.BAMN011과 컬럼은 넥사크로 Dataset\(ds_bamn011\)으로 추정한 것이라 테이블 설계 뒤에 맞춘다 -->/);
  assert.doesNotMatch(xml, /\$\{/); // values only through #{}
});

test('backend: screen text is escaped for Mapper.xml and Java, and no key means no whole-table UPDATE/DELETE', () => {
  const { generateBackend } = require('../src/gen-uni-backend');
  const files = generateBackend({
    id: 'BAU0109010',
    dir: 'ua/new/2024',
    screenName: '연구 */ 화면\n두번째 줄',
    search: [{ key: 'nm', label: '이름--조건', type: 'text', required: false }],
    apis: [
      { name: 'findCsys281List', kind: 'findList', token: 'Csys281', dsId: 'ds--list', title: 'R&D <목록>', columns: [], pk: [] },
      { name: 'saveCsys281List', kind: 'saveList', token: 'Csys281', dsId: 'ds--list', title: 'R&D <목록>', columns: [], pk: [] },
    ],
  });
  const xml = files.find((f) => f.path.endsWith('Mapper.xml')).content;
  assert.match(xml, /R&amp;D &lt;목록&gt;/);
  assert.doesNotMatch(xml, /R&D|<목록>/);
  // "--" only where XML comments open and close
  assert.doesNotMatch(xml.replace(/<!--|-->/g, ''), /--/);
  for (const stmt of ['UPDATE', 'DELETE FROM']) {
    const block = xml.slice(xml.indexOf(`    ${stmt} UNI.CSYS281`));
    assert.match(block.split('\n').slice(0, 15).join('\n'), /WHERE 1 = 0/, stmt);
  }
  const java = files.filter((f) => f.path.endsWith('.java'));
  assert.ok(java.length);
  for (const f of java) {
    assert.doesNotMatch(f.content, /연구 \*\/ 화면|\n두번째 줄/, f.path);
    // folder names that are Java keywords or start with a digit get a "_"
    assert.match(f.content, /^package kr\.co\.averedu\.ua\._new\._2024[.;]/m, f.path);
  }
});

test('backend: not generated unless asked for', () => {
  const out = convertFormUni(read('ua/usr/BAU0101010.xfdl'), { relPath: 'ua/usr/BAU0101010.xfdl' });
  assert.deepEqual(out.backendFiles, []);
  assert.ok(out.backendModel.apis.length);
});

test('구조 파악 reads base package, docs and base screens; bad folders are refused', () => {
  const { fe, be } = fakeUni();
  const s = analyzeUni({ uniFrontend: fe, uniBackend: be });
  assert.equal(s.frontend.apiBase, '/api');
  assert.deepEqual(s.frontend.referenceScreens, ['CCU0297010']);
  assert.equal(s.backend.basePackage, 'kr.co.averedu');
  assert.deepEqual(s.backend.referenceScreens, ['CCU0297010']);
  assert.deepEqual(s.backend.docs, ['SCREEN_CONVENTION.md']);
  assert.equal(analyzeUni({ uniFrontend: fe, uniBackend: '' }).backend, null);
  assert.throws(() => analyzeUni({ uniFrontend: be, uniBackend: '' }), /frontend를 찾을 수 없습니다/);
  assert.throws(() => analyzeUni({ uniFrontend: fe, uniBackend: fe }), /backend를 찾을 수 없습니다/);
});

test('web server: uni conversion needs a fresh 구조 파악 and then writes the backend too', async (t) => {
  const { root, fe, be } = fakeUni();
  const structureFile = path.join(root, 'structure.json');
  const server = await startServer({ port: 0, structureFile });
  t.after(() => server.close());
  const { port } = server.address();
  const output = path.join(root, 'out');
  const job = { input: UNI, output, profile: 'uni', uniFrontend: fe, uniBackend: be };

  assert.equal((await request(port, 'GET', '/api/uni/structure')).json.structure, null);
  assert.equal((await request(port, 'POST', '/api/jobs', job)).status, 409);

  const analyzed = await request(port, 'POST', '/api/uni/analyze', { uniFrontend: fe, uniBackend: be });
  assert.equal(analyzed.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(structureFile, 'utf8')).backend.basePackage, 'kr.co.averedu');
  assert.equal((await request(port, 'GET', '/api/uni/structure')).json.structure.backend.root, path.resolve(be));
  assert.equal((await request(port, 'POST', '/api/uni/analyze', { uniFrontend: be })).status, 400);

  // Folders changed since the analysis: refused until analyzed again.
  assert.equal((await request(port, 'POST', '/api/jobs', { ...job, uniBackend: '' })).status, 409);

  const started = await request(port, 'POST', '/api/jobs', job);
  assert.equal(started.status, 202);
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await request(port, 'GET', `/api/jobs/${started.json.id}`)).json;
    if (state.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(state.state, 'done');
  assert.ok(fs.existsSync(path.join(output, 'src', 'views', 'ua', 'usr', 'BAU0101010', 'BAU0101010View.vue')));
  assert.ok(fs.existsSync(path.join(output, 'backend', 'src', 'main', 'java', 'kr', 'co', 'averedu', 'ua', 'usr', 'controller', 'BAU0101010Controller.java')));
  assert.ok(fs.existsSync(path.join(output, 'backend', 'src', 'main', 'resources', 'mapper', 'ua', 'usr', 'BAU0102010Mapper.xml')));

  // CLI-like progress log; logFrom returns only the lines not shown yet.
  const full = (await request(port, 'GET', `/api/jobs/${started.json.id}`)).json;
  const text = full.log.join('\n');
  assert.match(text, /변환 시작 — 화면 2개, 백엔드 함께 생성/);
  assert.match(text, /\[ua\/usr\/BAU0101010\.xfdl\] 규칙 변환 시작/);
  assert.match(text, /쓰기 backend\/src\/main\/java\/kr\/co\/averedu\/ua\/usr\/controller\/BAU0101010Controller\.java/);
  assert.match(full.log[full.log.length - 1], /끝 — 전체 2/);
  const tail = (await request(port, 'GET', `/api/jobs/${started.json.id}?logFrom=${full.logTotal - 1}`)).json;
  assert.equal(tail.log.length, 1);
  assert.equal(tail.logFrom, full.logTotal - 1);
});

test('usage line shows used and remaining percent', () => {
  const { usageLine } = require('../src/ai-convert');
  assert.equal(
    usageLine({ fiveHour: { utilization: 0.3 }, sevenDay: { utilization: 0.104 } }),
    '5시간 30% 사용(70% 남음) · 7일 10% 사용(90% 남음)',
  );
});
