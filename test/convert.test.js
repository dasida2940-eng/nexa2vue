'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sfc = require('@vue/compiler-sfc');
const { parseXfdl } = require('../src/xfdl-parser');
const { convertScript } = require('../src/convert-script');
const { convertForm, convertLibrary, genGfnModule } = require('../src/convert-form');
const { decodeSource } = require('../src/scanner');

const FIX = path.join(__dirname, 'fixtures', 'nexa');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');

function compileVue(content) {
  const { descriptor, errors } = sfc.parse(content);
  assert.deepEqual(errors, []);
  return sfc.compileScript(descriptor, { id: 'test', inlineTemplate: true });
}

test('parseXfdl extracts nested components, grid, datasets and binds', () => {
  const ir = parseXfdl(read('screens/member/MemberList.xfdl'));
  assert.equal(ir.id, 'MemberList');
  assert.deepEqual(ir.components.map((c) => c.id), ['sta_title', 'div_search', 'grd_list', 'btn_add', 'btn_save']);
  assert.deepEqual(ir.components[1].children.map((c) => c.id), ['sta_name', 'edt_name', 'cbo_grade', 'btn_search']);
  assert.deepEqual(ir.components[2].grid.columns.map((c) => [c.label, c.prop]), [['이름', 'NAME'], ['나이', 'AGE'], ['이메일', 'EMAIL']]);
  assert.deepEqual(ir.datasets.find((d) => d.id === 'ds_grade').rows, [{ CODE: 'A', NAME: '정회원' }, { CODE: 'B', NAME: '준회원' }]);
  assert.equal(ir.binds[0].compPath, 'div_search.form.edt_name');
  assert.match(ir.script, /this\.transaction/);
});

test('parseXfdl supports Nexacro 14 layout (components directly under Form)', () => {
  const ir = parseXfdl('<FDL><Form id="Old"><Button id="btn_a" text="A" left="0" top="0" width="10" height="10"/><Div id="div_a"><Edit id="edt_a"/></Div></Form></FDL>');
  assert.deepEqual(ir.components.map((c) => c.id), ['btn_a', 'div_a']);
  assert.deepEqual(ir.components[1].children.map((c) => c.id), ['edt_a']);
});

test('convertScript rewrites dataset, component and form APIs', () => {
  const datasets = new Map([['ds_list', {}], ['ds_in', {}]]);
  const comps = new Map([['btn_a', 'btn_a'], ['div_s.edt_n', 'edt_n']]);
  const binds = new Map([['edt_n', { datasetid: 'ds_in', columnid: 'NAME', propid: 'value' }]]);
  const src = `include "lib::common.xjs";
this.fn_a = function(obj:nexacro.Button, e:nexacro.ClickEventInfo) {
  var n = this.ds_list.addRow();
  this.ds_list.setColumn(n, "A", this.div_s.form.edt_n.value);
  this.btn_a.set_enable(false);
  if (this.ds_list.rowcount > 0) this.alert("x");
  this.gfn_x(this.ds_list);
  this.fn_b();
};
this.fn_b = function() {};`;
  const r = convertScript(src, { datasets, comps, binds });
  assert.equal(r.error, null);
  assert.deepEqual(r.includes, ['lib::common.xjs']);
  assert.match(r.code, /function fn_a\(obj, e\)/);
  assert.match(r.code, /var n = nexa\.ds\.addRow\(ds_list\)/);
  assert.match(r.code, /nexa\.ds\.setColumn\(ds_list, n, "A", ds_in\.value\[0\]\["NAME"\]\)/);
  assert.match(r.code, /comp\.btn_a\.enable = false/);
  assert.match(r.code, /nexa\.ds\.getRowCount\(ds_list\) > 0/);
  assert.match(r.code, /window\.alert\("x"\)/);
  assert.match(r.code, /gfn\.gfn_x\(ds_list\)/);
  assert.match(r.code, /\n  fn_b\(\);/);
  assert.deepEqual([...r.gfnUsed], ['gfn_x']);
  assert.equal(r.todos.length, 0);
});

test('convertScript converts transaction() into an API call and records the endpoint', () => {
  const datasets = new Map([['ds_in', {}], ['ds_out', {}]]);
  const r = convertScript(
    'this.fn_s = function() { this.transaction("svc1", "svc::a/b.do", "input=ds_in:U", "ds_out=output", "k=v", "fn_cb"); };\nthis.fn_cb = function(id, code, msg) {};',
    { datasets },
  );
  assert.match(r.code, /nexa\.transaction\("svc1", api\.svc1, \{\s*"input": ds_in\s*\}, \{\s*"output": ds_out\s*\}, "k=v", fn_cb\)/);
  assert.equal(r.apiFns.get('svc1'), 'svc::a/b.do');
  assert.equal(r.todos.length, 0);
});

test('convertScript marks unsupported APIs with TODO comments and line numbers', () => {
  const r = convertScript('this.fn = function() {\n  this.ds_a.filter("X");\n  this.transaction(sId, "u", "", "");\n};', { datasets: new Map([['ds_a', {}]]) });
  assert.equal(r.todos.length, 2);
  assert.equal(r.todos[0].line, 2);
  assert.match(r.code, /\/\/ TODO\(nexa2vue\): Dataset method ds_a\.filter\(\) is not supported/);
  assert.match(r.code, /nexa\.transactionTodo/);
});

test('convertScript reports parse errors instead of throwing', () => {
  const r = convertScript('this.fn = function( {');
  assert.match(r.error, /Script parse error/);
});

test('convertForm output compiles as a Vue SFC and escapes source text', () => {
  const r = convertForm(read('screens/member/MemberList.xfdl'), { relPath: 'member/MemberList.xfdl' });
  const [vue, apiFile] = r.files;
  assert.equal(vue.path, 'src/views/member/MemberList.vue');
  assert.equal(apiFile.path, 'src/api/member/MemberList.js');
  compileVue(vue.content);
  // Static text with markup / mustache lives in script state, not the template.
  assert.match(vue.content, /"text":"회원 <목록> \{\{x\}\}"/);
  assert.doesNotMatch(vue.content.split('<script setup>')[0], /회원 <목록>/);
  assert.match(vue.content, /v-model="ds_search\[0\]\.NAME"/);
  assert.match(vue.content, /<el-option v-for="o in ds_grade" :key="o\.CODE" :label="o\.NAME" :value="o\.CODE" \/>/);
  assert.match(vue.content, /:data="ds_list"/);
  assert.match(vue.content, /onMounted\(\(\) => \{\n  form_onload\(comp, \{\}\);/);
  assert.match(vue.content, /import \* as api from '\.\.\/\.\.\/api\/member\/MemberList\.js';/);
  assert.match(apiFile.content, /export function selectMember\(params\) \{\n  return http\("svc::member\/selectList\.do", params\);/);
  assert.deepEqual([...r.gfnUsed], ['gfn_initForm']);
});

test('convertForm handles tabs, option components and unsupported components', () => {
  const r = convertForm(read('screens/member/MemberDetail.xfdl'), { relPath: 'MemberDetail.xfdl' });
  compileVue(r.files[0].content);
  assert.match(r.files[0].content, /<el-tab-pane name="1" label="기타">/);
  assert.match(r.files[0].content, /<el-radio v-for="o in ds_gender"/);
  assert.match(r.files[0].content, /true-value="Y" false-value="N"/);
  assert.deepEqual(r.todos.map((t) => t.message), ['[template] web_help: unsupported component type WebBrowser']);
});

test('convertForm keeps the original script as a comment when it cannot be parsed', () => {
  const r = convertForm(read('screens/Broken.xfdl'), { relPath: 'Broken.xfdl' });
  compileVue(r.files[0].content);
  assert.match(r.error, /parse error/);
  assert.match(r.files[0].content, /original script \(parse failed\)/);
});

test('convertForm cannot be broken out of <script> or comments by source content', () => {
  const xfdl = `<FDL><Form id="X" titletext="a --> b"><Layouts><Layout>
    <Static id="sta" text="&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;" left="0" top="0" width="1" height="1"/>
    <WebBrowser id="w--x"/>
  </Layout></Layouts><Script><![CDATA[this.fn = function() { var s = "</script>"; };]]></Script></Form></FDL>`;
  const r = convertForm(xfdl, { relPath: 'X--.xfdl' });
  const content = r.files[0].content;
  compileVue(content);
  assert.equal((content.match(/<\/script>/g) || []).length, 1);
});

test('convertForm leaves out datasets whose id clashes with generated names, so the .vue still compiles', () => {
  const xfdl = `<FDL><Form id="X"><Layouts><Layout>
    <Static id="sta" text="a" left="0" top="0" width="1" height="1"/>
  </Layout></Layouts><Objects>
    <Dataset id="ref"><ColumnInfo><Column id="A" type="STRING" size="10"/></ColumnInfo></Dataset>
    <Dataset id="comp"><ColumnInfo><Column id="A" type="STRING" size="10"/></ColumnInfo></Dataset>
    <Dataset id="class"><ColumnInfo><Column id="A" type="STRING" size="10"/></ColumnInfo></Dataset>
    <Dataset id="ds_ok"><ColumnInfo><Column id="A" type="STRING" size="10"/></ColumnInfo></Dataset>
  </Objects></Form></FDL>`;
  const r = convertForm(xfdl, { relPath: 'X.xfdl' });
  const content = r.files[0].content;
  compileVue(content);
  assert.match(content, /const ds_ok = ref\(/);
  assert.equal(r.todos.filter((t) => /clashes with a name/.test(t.message)).length, 3);
});

test('convertLibrary exports functions and genGfnModule stubs only missing ones', () => {
  const lib = convertLibrary(read('lib/common.xjs'), { relPath: 'lib/common.xjs' });
  assert.equal(lib.libPath, 'src/utils/nexa-lib/lib/common.js');
  assert.match(lib.files[0].content, /export function gfn_trim\(val\) \{\n  if \(gfn_isNull\(val\)\)/);
  const gfn = genGfnModule(new Map([[lib.libPath, lib.exported]]), new Set(['gfn_trim', 'gfn_initForm']));
  assert.deepEqual(gfn.missing, ['gfn_initForm']);
  assert.match(gfn.content, /export \{ gfn_isNull, gfn_trim \} from '\.\/nexa-lib\/lib\/common\.js';/);
  assert.match(gfn.content, /export function gfn_initForm\(\.\.\.args\)/);
});

test('decodeSource handles UTF-8 BOM, declared EUC-KR and undeclared EUC-KR', () => {
  const eucKr = Buffer.from([0xb0, 0xa1]); // "가"
  const declared = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="euc-kr"?><a>'), eucKr, Buffer.from('</a>')]);
  assert.deepEqual(decodeSource(declared), { text: '<?xml version="1.0" encoding="euc-kr"?><a>가</a>', encoding: 'euc-kr' });
  const undeclared = Buffer.concat([Buffer.from('<a>'), eucKr, Buffer.from('</a>')]);
  assert.equal(decodeSource(undeclared).text, '<a>가</a>');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a>가</a>')]);
  assert.deepEqual(decodeSource(bom), { text: '<a>가</a>', encoding: 'utf-8' });
});

test('convertForm uiOnly keeps the UI, stubs handlers and skips script TODOs', () => {
  const full = convertForm(read('screens/member/MemberList.xfdl'), { relPath: 'member/MemberList.xfdl' });
  const ui = convertForm(read('screens/member/MemberList.xfdl'), { relPath: 'member/MemberList.xfdl', uiOnly: true });
  assert.ok(full.todos.some((t) => t.message.startsWith('[script]')) || full.files.length > 1);
  assert.equal(ui.todos.filter((t) => t.message.startsWith('[script]')).length, 0);
  assert.deepEqual(ui.files.map((f) => f.path), ['src/views/member/MemberList.vue']);
  const vue = ui.files[0].content;
  assert.match(vue, /<el-table/);
  assert.match(vue, /UI만 변환: 원본 스크립트의/);
  assert.match(vue, /\/\* 원본 스크립트 \(UI만 변환/);
  assert.doesNotMatch(vue, /nexa-compat|onMounted|api\./);
  compileVue(vue);
});

test('decodeSource reads UTF-16 files saved with a BOM', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a>가</a>', 'utf16le')]);
  assert.deepEqual(decodeSource(le), { text: '<a>가</a>', encoding: 'utf-16le' });
  const be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<a>가</a>', 'utf16le').swap16()]));
  assert.deepEqual(decodeSource(be), { text: '<a>가</a>', encoding: 'utf-16be' });
});
