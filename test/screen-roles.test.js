'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRoles, normalizeRoles, roleNames, hostOf, resolveRef } = require('../src/screen-roles');

const form = ({ title = '', layout = '', script = '' } = {}) =>
  `<FDL><Form id="F" titletext="${title}"><Layouts><Layout>${layout}</Layout></Layouts><Script type="xscript5.1"><![CDATA[${script}]]></Script></Form></FDL>`;

const SOURCES = [
  {
    rel: 'ua/usr/BAU0101010.xfdl',
    text: form({
      title: '학적변동 관리',
      layout: '<Div id="div_detail" left="0" top="0" width="100" height="100" url="ua::usr/BAU0101010_D.xfdl"/>',
      script: 'this.fn_pop = function() { this.gfn_openPopup("pop1", "ua::usr/BAU0101010_P1.xfdl", {}, "fn_cb"); };',
    }),
  },
  { rel: 'ua/usr/BAU0101010_D.xfdl', text: form({ script: 'this.fn_x = function() { this.parent.parent.fn_search(); };' }) },
  { rel: 'ua/usr/BAU0101010_P1.xfdl', text: form({ title: '학생 찾기', script: 'this.btn_ok_onclick = function() { this.close("ok"); };' }) },
  { rel: 'ua/usr/STU_POP.xfdl', text: form({ title: '학생 검색 팝업' }) },
  { rel: 'ua/usr/BAU0102010.xfdl', text: form({ title: '그냥 화면' }) },
];

test('roles: Div url makes a sub-screen, a form URL in the script a popup, with the reason', () => {
  const roles = detectRoles(SOURCES);
  assert.equal(roles['ua/usr/BAU0101010.xfdl'].role, 'screen');
  assert.deepEqual(
    { role: roles['ua/usr/BAU0101010_D.xfdl'].role, parent: roles['ua/usr/BAU0101010_D.xfdl'].parent, via: roles['ua/usr/BAU0101010_D.xfdl'].via },
    { role: 'sub', parent: 'ua/usr/BAU0101010.xfdl', via: { kind: 'embed', compId: 'div_detail' } },
  );
  assert.match(roles['ua/usr/BAU0101010_D.xfdl'].reasons.join(' / '), /div_detail에 들어감/);
  assert.equal(roles['ua/usr/BAU0101010_P1.xfdl'].role, 'popup');
  assert.equal(roles['ua/usr/BAU0101010_P1.xfdl'].parent, 'ua/usr/BAU0101010.xfdl');
  assert.match(roles['ua/usr/BAU0101010_P1.xfdl'].reasons.join(' / '), /스크립트에서 엶.*this\.close/);
  // nobody opens it, but name and title say popup: popup without a parent
  assert.deepEqual([roles['ua/usr/STU_POP.xfdl'].role, roles['ua/usr/STU_POP.xfdl'].parent], ['popup', null]);
  assert.match(roles['ua/usr/STU_POP.xfdl'].reasons.join(' / '), /부모를 고르세요/);
  assert.equal(roles['ua/usr/BAU0102010.xfdl'].role, 'screen');
});

test('roles: form URLs resolve by path tail, else by a unique file name', () => {
  const forms = ['ua/usr/A.xfdl', 'co/csm/A.xfdl', 'co/csm/B.xfdl'];
  assert.equal(resolveRef('ua::usr/A.xfdl', forms), 'ua/usr/A.xfdl');
  assert.equal(resolveRef('csm::B.xfdl', forms), 'co/csm/B.xfdl');
  assert.equal(resolveRef('x::A.xfdl', forms), null);
  assert.equal(resolveRef('x::A.xjs', forms), null);
});

test('roles: confirmed roles are made safe and default names follow them', () => {
  const forms = SOURCES.map((s) => s.rel);
  const roles = normalizeRoles(forms, {
    ...detectRoles(SOURCES),
    // a sub-screen without a parent is a screen
    'ua/usr/BAU0102010.xfdl': { role: 'sub', parent: 'nowhere.xfdl' },
  });
  assert.equal(roles['ua/usr/BAU0102010.xfdl'].role, 'screen');
  // a loop is broken at its first screen, which becomes 화면; the other stays its sub-screen
  const loop = normalizeRoles(['a.xfdl', 'b.xfdl'], { 'a.xfdl': { role: 'sub', parent: 'b.xfdl' }, 'b.xfdl': { role: 'sub', parent: 'a.xfdl' } });
  assert.deepEqual([loop['a.xfdl'].role, loop['b.xfdl'].role, loop['b.xfdl'].parent], ['screen', 'sub', 'a.xfdl']);

  const base = Object.fromEntries(forms.map((rel) => [rel, rel.slice(rel.lastIndexOf('/') + 1, -5)]));
  const names = roleNames(forms, base, roles);
  assert.equal(names['ua/usr/BAU0101010_P1.xfdl'], 'BAU0101011_POP');
  assert.equal(names['ua/usr/BAU0101010_D.xfdl'], 'BAU0101010Detail');
  assert.equal(names['ua/usr/STU_POP.xfdl'], 'STU_POP');
  assert.equal(names['ua/usr/BAU0101010.xfdl'], 'BAU0101010');
  assert.equal(hostOf('ua/usr/BAU0101010_D.xfdl', roles), 'ua/usr/BAU0101010.xfdl');
});
