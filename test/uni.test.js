'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');
const sfc = require('@vue/compiler-sfc');
const { convertFormUni, layoutTree, camel, datasetToken } = require('../src/gen-uni');
const { runConversion } = require('../src/job-runner');

const UNI = path.join(__dirname, 'fixtures', 'uni');
const NEXA = path.join(__dirname, 'fixtures', 'nexa');

function convert(dir, rel) {
  const result = convertFormUni(fs.readFileSync(path.join(dir, rel), 'utf8'), { relPath: rel });
  const byName = (suffix) => result.files.find((f) => f.path.endsWith(suffix)).content;
  return { result, view: byName('View.vue'), service: byName('Service.js'), constant: byName('Constant.js') };
}

function compileVue(content) {
  const { descriptor, errors } = sfc.parse(content);
  assert.deepEqual(errors, []);
  return sfc.compileScript(descriptor, { id: 'test', inlineTemplate: true });
}

function parseModule(code) {
  return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
}

test('roles: a sub-screen lands in its host folder sharing Service/Constant, a popup becomes {ID+1}_POP opened with popup.open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-roles-'));
  try {
    const input = path.join(root, 'in');
    const dir = path.join(input, 'ua', 'usr');
    fs.mkdirSync(dir, { recursive: true });
    const hostSrc = fs.readFileSync(path.join(UNI, 'ua/usr/BAU0101010.xfdl'), 'utf8')
      .replace('<Layout height="720" width="1280">', '<Layout height="720" width="1280">\n<Div id="div_schl" left="10" top="650" right="10" height="60" url="ua::usr/BAU0102010.xfdl"/>')
      .replace('<![CDATA[', '<![CDATA[\nthis.fn_pop = function() { this.gfn_openPopup("pop", "ua::usr/BAU0102010_P.xfdl", {}, "fn_cb"); };\n');
    fs.writeFileSync(path.join(dir, 'BAU0101010.xfdl'), hostSrc);
    fs.copyFileSync(path.join(UNI, 'ua/usr/BAU0102010.xfdl'), path.join(dir, 'BAU0102010.xfdl'));
    fs.writeFileSync(path.join(dir, 'BAU0102010_P.xfdl'), fs.readFileSync(path.join(UNI, 'ua/usr/BAU0102010.xfdl'), 'utf8').replace('titletext="장학금 관리"', 'titletext="장학금 찾기"'));

    const out = path.join(root, 'out');
    const report = await runConversion(input, out, { profile: 'uni', uniBackend: { root: 'x', basePackage: 'kr.co.averedu' } });
    assert.deepEqual(
      Object.fromEntries(Object.entries(report.roles).map(([rel, r]) => [rel, [r.role, r.parent]])),
      { 'ua/usr/BAU0101010.xfdl': ['screen', null], 'ua/usr/BAU0102010.xfdl': ['sub', 'ua/usr/BAU0101010.xfdl'], 'ua/usr/BAU0102010_P.xfdl': ['popup', 'ua/usr/BAU0101010.xfdl'] },
    );
    const read = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');
    const hostDir = 'src/views/ua/usr/BAU0101010';
    // no screen folder of its own for the sub-screen
    assert.equal(fs.existsSync(path.join(out, 'src/views/ua/usr/BAU0102010')), false);

    const hostView = read(`${hostDir}/BAU0101010View.vue`);
    compileVue(hostView);
    assert.match(hostView, /<BAU0101010Schl \/>/);
    assert.match(hostView, /import BAU0101010Schl from '\.\/BAU0101010Schl\.vue'/);
    assert.match(hostView, /import BAU0101011_POP from '\.\.\/BAU0101011_POP\/BAU0101011_POPView\.vue'/);
    assert.match(hostView, /popup\.open\(BAU0101011_POP, \{ row: \{\} \}\)/);

    const sub = read(`${hostDir}/BAU0101010Schl.vue`);
    compileVue(sub);
    assert.match(sub, /import \{ BAU0101010Service as service \} from '\.\/BAU0101010Service'/);
    assert.match(sub, /defineOptions\(\{ name: 'BAU0101010Schl' \}\)/);
    assert.match(sub, /constants\.schlSearchItems/);
    const constant = read(`${hostDir}/BAU0101010Constant.js`);
    const service = read(`${hostDir}/BAU0101010Service.js`);
    parseModule(constant);
    parseModule(service);
    assert.match(constant, /---- 하위 화면 BAU0101010Schl/);
    assert.match(constant, /schlSearchItems:/);
    assert.match(service, /findSchl100List: \(params\) => request\(api\.get\(`\$\{basicUrl\}\/findSchl100List`/);
    // the host's backend serves the sub-screen's APIs
    const controller = read('backend/src/main/java/kr/co/averedu/ua/usr/controller/BAU0101010Controller.java');
    assert.match(controller, /findSchl100List/);

    const popDir = 'src/views/ua/usr/BAU0101011_POP';
    const pop = read(`${popDir}/BAU0101011_POPView.vue`);
    compileVue(pop);
    assert.match(pop, /<Popup :model-value="modelValue" width="1280px">/);
    assert.match(pop, /emit\('callback', \{ data: row \}\)/);
    assert.doesNotMatch(pop, /defineOptions/);
    parseModule(read(`${popDir}/BAU0101011_POPService.js`));

    const subLine = report.files.find((f) => f.input === 'ua/usr/BAU0102010.xfdl');
    assert.equal(subLine.mergedInto, 'ua/usr/BAU0101010.xfdl');
    assert.deepEqual(subLine.outputs, [`${hostDir}/BAU0101010Schl.vue`]);
    assert.equal(report.summary.total, 3);

    // confirmed on the page: the "popup" is a plain screen after all
    const out2 = path.join(root, 'out2');
    const again = await runConversion(input, out2, { profile: 'uni', roles: { 'ua/usr/BAU0102010_P.xfdl': { role: 'screen' } } });
    assert.equal(again.roles['ua/usr/BAU0102010_P.xfdl'].role, 'screen');
    assert.ok(fs.existsSync(path.join(out2, 'src/views/ua/usr/BAU0102010_P/BAU0102010_PView.vue')));
    assert.doesNotMatch(fs.readFileSync(path.join(out2, `${hostDir}/BAU0101010View.vue`), 'utf8'), /popup\.open/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('line breaks and "*/" in Nexacro text stay inside the generated comments', () => {
  const source = fs.readFileSync(path.join(UNI, 'ua/usr/BAU0101010.xfdl'), 'utf8')
    .replace('titletext="학적변동 관리"', 'titletext="학적변동 */ 관리&#10;두번째"')
    .replace('<Cell expr="currow+1"/>', '<Cell expr="currow&#10;+ 1 */ x"/>')
    .replace('text="엑셀" left="520"', 'text="상세&#10;보기" left="520"');
  const result = convertFormUni(source, { relPath: 'ua/usr/BAU0101010.xfdl' });
  const byName = (suffix) => result.files.find((f) => f.path.endsWith(suffix)).content;
  parseModule(byName('Service.js'));
  parseModule(byName('Constant.js'));
  compileVue(byName('View.vue'));
  // script code only: a line break in template text is just a space
  for (const f of result.files.filter((x) => /\.(js|vue)$/.test(x.path))) {
    const code = f.path.endsWith('.vue') ? f.content.slice(f.content.indexOf('<script')) : f.content;
    assert.doesNotMatch(code, /^\s*(두번째|\+ 1|보기)/m, f.path);
  }
});

test('a second input Div between two grids stays a separate region in its place (relative "grdMain:20" anchors)', () => {
  const source = `<?xml version="1.0" encoding="utf-8"?>
<FDL version="2.1">
  <Form id="ul06_034_t" width="1280" height="720" titletext="수강신청관리">
    <Layouts>
      <Layout height="720" width="1280">
        <Div id="divSearch" left="20" top="0" right="20" height="40">
          <Layouts><Layout>
            <Static id="staDaehak" text="대학" left="20" top="8" width="40" height="24"/>
            <Combo id="cboDAEHAK" left="63" top="8" width="120" height="24"/>
          </Layout></Layouts>
        </Div>
        <Button id="btnSearch" text="조회" right="20" top="8" width="65" height="24" onclick="fnSearch"/>
        <Static id="staNtc" text="※ 야간강좌를 수강신청하려면 승인을 받아야 합니다." left="300" top="50" width="400" height="30"/>
        <Static id="staSchList" text="개설과목" left="20" top="60" width="160" height="16"/>
        <Grid id="grdMain" left="20" top="84" right="20" height="200" binddataset="dsMain"/>
        <Div id="divSearch02" left="20" top="grdMain:20" right="20" height="42">
          <Layouts><Layout>
            <Static id="staHakbeon" text="학번" left="20" top="8" width="40" height="24"/>
            <Edit id="edtHAKBEON" left="63" top="8" width="120" height="24"/>
            <Static id="staGwamok" text="직접입력" left="200" top="8" width="50" height="24"/>
            <Edit id="edtGWAMOKCD" left="255" top="8" width="80" height="24"/>
            <Static id="sta00" text="-" left="335" top="8" width="20" height="24"/>
            <Edit id="edtBUNBAN" left="355" top="8" width="40" height="24"/>
          </Layout></Layouts>
        </Div>
        <Static id="staSchList2" text="수강신청내역" left="20" top="divSearch02:20" width="90" height="16"/>
        <Static id="staGrdSubCount" text="총 0건" left="120" top="divSearch02:20" width="80" height="16"/>
        <Grid id="grdSub" left="20" top="staSchList2:10" right="20" bottom="10" binddataset="dsSub"/>
      </Layout>
    </Layouts>
    <Objects>
      <Dataset id="dsSch"><ColumnInfo><Column id="DAEHAK_CD" type="STRING" size="10"/><Column id="HAKBEON" type="STRING" size="10"/><Column id="GWAMOK_CD" type="STRING" size="10"/><Column id="BUNBAN" type="STRING" size="10"/></ColumnInfo></Dataset>
      <Dataset id="dsMain"><ColumnInfo><Column id="GWAMOK_NM" type="STRING" size="50"/></ColumnInfo></Dataset>
      <Dataset id="dsSub"><ColumnInfo><Column id="GWAMOK_NM" type="STRING" size="50"/></ColumnInfo></Dataset>
    </Objects>
    <Bind>
      <BindItem id="b1" compid="divSearch.form.cboDAEHAK" propid="value" datasetid="dsSch" columnid="DAEHAK_CD"/>
      <BindItem id="b2" compid="divSearch02.form.edtHAKBEON" propid="value" datasetid="dsSch" columnid="HAKBEON"/>
      <BindItem id="b3" compid="divSearch02.form.edtGWAMOKCD" propid="value" datasetid="dsSch" columnid="GWAMOK_CD"/>
      <BindItem id="b4" compid="divSearch02.form.edtBUNBAN" propid="value" datasetid="dsSch" columnid="BUNBAN"/>
    </Bind>
  </Form>
</FDL>`;
  const result = convertFormUni(source, { relPath: 'ul/ul06/ul06_034_t.xfdl' });
  const view = result.files.find((f) => f.path.endsWith('View.vue')).content;
  compileVue(view);
  const order = [...view.matchAll(/<(SearchSection|DataGrid|Form)\b[^>]*?(?:title="([^"]*)")?/g)].map((m) => m[1]);
  assert.deepEqual(order, ['SearchSection', 'DataGrid', 'Form', 'DataGrid']);
  const titles = [...view.matchAll(/<Section title="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(titles[0], '개설과목');
  assert.equal(titles[titles.length - 1], '수강신청내역');
  const constants = loadConstant(result.files.find((f) => f.path.endsWith('Constant.js')).content);
  assert.deepEqual(constants.searchItems.flat().map((i) => i.key), ['daehakCd']);
  const formItems = Object.entries(constants).find(([k]) => k.endsWith('FormItems'))[1].flat();
  assert.deepEqual(formItems.map((i) => [i.key, i.label]), [['hakbeon', '학번'], ['gwamokCd', '직접입력'], ['bunban', 'bunban']]);
});

// Evaluate the generated Constant module without the uni project's imports.
function loadConstant(code) {
  const body = code.replace(/^export const (\w+) =/m, 'module.exports =');
  const mod = { exports: null };
  new Function('module', body)(mod);
  return mod.exports;
}

test('naming helpers follow the uni naming rules', () => {
  assert.equal(camel('STD_NO'), 'stdNo');
  assert.equal(camel('NAME'), 'name');
  assert.equal(camel('userId'), 'userId');
  assert.equal(datasetToken('ds_bamn010'), 'Bamn010');
  assert.equal(datasetToken('ds_list'), '');
});

test('layoutTree stacks regions vertically and places overlapping ones side by side', () => {
  const r = (x, y, w, h) => ({ box: { x, y, w, h } });
  const top = r(0, 0, 1000, 100);
  const left = r(0, 120, 400, 500);
  const right = r(410, 120, 590, 500);
  const tree = layoutTree([right, top, left]);
  assert.equal(tree.dir, 'vertical');
  assert.equal(tree.children[0], top);
  assert.equal(tree.children[1].dir, 'horizontal');
  assert.deepEqual(tree.children[1].children, [left, right]);
});

test('master/detail screen becomes SearchSection + horizontal SectionGroup of two DataGrids', () => {
  const { result, view, service, constant } = convert(UNI, 'ua/usr/BAU0101010.xfdl');
  assert.deepEqual(result.files.map((f) => f.path), [
    'src/views/ua/usr/BAU0101010/BAU0101010View.vue',
    'src/views/ua/usr/BAU0101010/BAU0101010Service.js',
    'src/views/ua/usr/BAU0101010/BAU0101010Constant.js',
  ]);
  compileVue(view);
  parseModule(service);
  parseModule(constant);

  assert.match(view, /<SearchSection v-model="params" :items="searchItems" :on-search="findAll" \/>/);
  assert.match(view, /<SectionGroup direction="horizontal">/);
  assert.match(view, /<Section title="학생 목록" size="rest">/);
  assert.match(view, /<Section title="학적변동 내역" size="rest">/);
  // master: read-only with row numbers and excel; detail: editable with selection
  assert.match(view, /:rows="bamn010Rows"[^>]*row-number :checkbox="false"/);
  assert.match(view, /@download-excel="downloadBamn010Excel"/);
  assert.match(view, /@add-item="addBamn011" @delete-item="deleteBamn011" @save-data="saveBamn011List"/);
  assert.match(view, /:rows="bamn011Rows"[^>]*status v-model:checked="checkedBamn011Rows"/);
  // non-standard button goes to the etc slot with a stub handler
  assert.match(view, /<Button color="secondary" @click="btn_print_onclick">출력<\/Button>/);
  assert.match(view, /function btn_print_onclick\(\)/);
  // the search button is replaced by SearchSection's own
  assert.doesNotMatch(view, /<Button[^>]*>조회</);

  const c = loadConstant(constant);
  assert.deepEqual(c.searchItems.map((row) => row.map((i) => i.key)), [['syy', 'shtm', 'deptCd'], ['chgDtFrom']]);
  assert.equal(c.searchItems[0][0].label, '학년도');
  assert.equal(c.searchItems[0][0].required, true);
  assert.equal(c.searchItems[0][1].label, '학기');
  assert.deepEqual(c.searchItems[0][1].options, [{ label: '1학기', value: '1' }, { label: '2학기', value: '2' }]);
  assert.equal(c.searchItems[1][0].type, 'date');
  assert.deepEqual(c.bamn011Columns.map((col) => col.name), ['chgSeCd', 'chgDt', 'crdt', 'chgRsn']);
  assert.equal(c.bamn011Columns[0].editor.type, 'select');
  assert.equal(c.bamn011Columns[2].editor.type, 'number');
  assert.equal(c.bamn011Columns[3].editor.maxlength, 200);
  assert.deepEqual(c.bamn011FeatureAuth, { add: true, delete: true, save: true, download: false });

  assert.match(service, /const basicUrl = '\/ua\/usr\/BAU0101010'/);
  assert.match(service, /findBamn010List: \(params\) => request\(api\.get\(`\$\{basicUrl\}\/findBamn010List`, \{ params \}\), 'findBamn010List', 'BAU0101010Service'\)/);
  assert.match(service, /saveBamn011List: \(params\) => request\(api\.post\(/);
  assert.match(service, /selectMaster → svc::ua\/usr\/selectBamn010List\.do/);
  assert.deepEqual(result.todos.map((t) => t.message), ['cbo_dept: 선택지(innerdataset="ds_dept")를 commonOptions나 고정 옵션으로 연결하세요']);
});

test('grid with a form bound to the same dataset follows base screen A3', () => {
  const { view, constant } = convert(UNI, 'ua/usr/BAU0102010.xfdl');
  compileVue(view);
  assert.match(view, /:on-search="findSchl100List"/);
  assert.match(view, /<Form :model="schl100DetailModel" :items="schl100FormItems" :columnCount="2" :disabled="isSchl100FormDisabled" @update:model="onSchl100FormUpdate" \/>/);
  assert.match(view, /@row-click="onSchl100RowClick"/);
  assert.match(view, /Object\.assign\(selectedSchl100\.value, nextModel\)/);

  const c = loadConstant(constant);
  // the TextArea under "금액" is its own row
  assert.deepEqual(c.schl100FormItems.map((row) => row.map((i) => i.key)), [['schlCd', 'schlNm'], ['amt'], ['rmk']]);
  assert.equal(c.schl100FormItems[0][1].required, true);
  assert.equal(c.schl100FormItems[1][0].type, 'number');
  assert.equal(c.schl100FormItems[2][0].type, 'textarea');
  assert.deepEqual(c.searchItems, [[{ key: 'schlNm', label: '장학금명', type: 'text' }]]);
});

test('non table-code datasets use the Tbl001 placeholder token and tabs are flagged', () => {
  const list = convert(NEXA, 'screens/member/MemberList.xfdl');
  compileVue(list.view);
  assert.match(list.view, /findTbl001List/);
  assert.doesNotMatch(list.view, /ListList/);

  const detail = convert(NEXA, 'screens/member/MemberDetail.xfdl');
  compileVue(detail.view);
  assert.match(detail.view, /TODO\(nexa2vue\): 원본 탭 tab_main/);
  // no search area: no lookup function that nothing calls
  assert.doesNotMatch(detail.view, /function find/);
  const messages = detail.result.todos.map((t) => t.message).join('\n');
  assert.match(messages, /WebBrowser/);
  assert.match(messages, /KeepAliveTabs/);
});

test('runConversion with the uni profile writes screen folders and no runtime helpers', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-uni-'));
  try {
    const plain = await runConversion(UNI, path.join(out, 'plain'), { profile: 'uni' });
    assert.equal(plain.viewer, undefined);
    assert.ok(!fs.existsSync(path.join(out, 'plain', 'package.json')));

    const report = await runConversion(UNI, path.join(out, 'vue'), { profile: 'uni', viewer: true, uniFrontend: 'D:\\work\\uni\\frontend' });
    assert.equal(report.profile, 'uni');
    assert.equal(report.summary.error, 0);
    const root = path.join(out, 'vue');
    assert.ok(fs.existsSync(path.join(root, 'src/views/ua/usr/BAU0101010/BAU0101010View.vue')));
    assert.ok(fs.existsSync(path.join(root, 'src/views/ua/usr/BAU0102010/BAU0102010Constant.js')));
    assert.ok(!fs.existsSync(path.join(root, 'src/utils/nexa-compat.js')));
    // uni style preview: borrows the uni frontend, so no dependencies to install
    assert.equal(report.viewer.kind, 'uni');
    assert.deepEqual(report.viewer.kept, []);
    for (const f of ['vite.config.js', 'index.html', 'preview/main.js', 'preview/App.vue', 'preview/mock-api.js', 'preview/start.mjs', 'view-screens.cmd']) {
      assert.ok(fs.existsSync(path.join(root, f)), f);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'uni-preview.config.json'), 'utf8')), { uniFrontend: 'D:\\work\\uni\\frontend' });
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.scripts.dev, 'node preview/start.mjs');
    assert.match(fs.readFileSync(path.join(root, 'view-screens.cmd'), 'utf8'), /\r\nnode preview\\start\.mjs\r\n/);
    await assert.rejects(runConversion(UNI, path.join(out, 'vue2'), { profile: 'nope' }), /알 수 없는 출력 형식/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a button handler never takes a name the View declares itself', () => {
  const src = fs.readFileSync(path.join(UNI, 'ua/usr/BAU0101010.xfdl'), 'utf8').replace('onclick="btn_print_onclick"', 'onclick="findAll"');
  const result = convertFormUni(src, { relPath: 'ua/usr/BAU0101010.xfdl' });
  const view = result.files.find((f) => f.path.endsWith('View.vue')).content;
  assert.match(view, /<Button color="secondary" @click="findAll2">출력<\/Button>/);
  assert.equal(view.match(/function findAll\(/g).length, 1);
  compileVue(view);
});
