'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildMarkers, fallbackDesc, renderShotSection, applyShotSection, screensOf } = require('../src/shot-docs');

const CAPTURE = {
  width: 1000,
  height: 500,
  regions: [
    { type: 'search', box: { x: 0, y: 0, w: 1000, h: 50 }, labels: ['년도 *', '학기'], buttons: [{ text: '조회', box: { x: 900, y: 10, w: 60, h: 30 } }] },
    { type: 'section', kinds: ['grid'], title: '신청 내역', box: { x: 0, y: 60, w: 1000, h: 400 }, labels: [], columns: ['년도', '학기'], tabs: [], buttons: [{ text: '저장', box: { x: 920, y: 62, w: 60, h: 30 } }] },
  ],
};

const DOC = `<!doctype html>
<html lang="ko">
<head>
<style>
body { margin: 0; }
</style>
</head>
<body>
<main>
<h1>A</h1>
<h2>만든 파일</h2>
<p>files</p>
</main>
</body>
</html>`;

test('buildMarkers numbers each region and then its buttons', () => {
  const m = buildMarkers(CAPTURE);
  assert.deepEqual(m.map((x) => [x.n, x.kind, x.title, x.in]), [
    [1, '조회조건', '', undefined],
    [2, '버튼', '조회', 1],
    [3, '그리드', '신청 내역', undefined],
    [4, '버튼', '저장', 3],
  ]);
  assert.deepEqual(m[0].labels, ['년도 *', '학기']);
  assert.deepEqual(m[2].columns, ['년도', '학기']);
});

test('fallbackDesc describes every marker from the capture and says why', () => {
  const d = fallbackDesc(buildMarkers(CAPTURE), 'timeout');
  assert.equal(d.markers.length, 4);
  assert.match(d.markers[0].text, /항목: 년도 \*, 학기/);
  assert.match(d.markers[2].text, /컬럼: 년도, 학기/);
  assert.match(d.searchNote, /timeout/);
});

test('renderShotSection + applyShotSection put an annotated section before "만든 파일", once', () => {
  const markers = buildMarkers(CAPTURE);
  const shot = {
    id: 'X001',
    popup: false,
    base: { image: 'images/X001.png', size: { w: 1000, h: 500 }, markers },
    search: { image: 'images/X001_search.png', size: { w: 1000, h: 500 }, markers },
  };
  const desc = {
    summary: '신청 내역을 <조회>한다',
    markers: markers.map((m) => ({ n: m.n, text: `설명 ${m.n}` })),
    steps: [{ title: '조회', text: '년도를 넣고 조회한다', image: 'search', markers: [1, 2] }],
    searchNote: '샘플 데이터',
  };
  const section = renderShotSection(shot, desc);
  assert.match(section, /<h2>화면 설명<\/h2>/);
  assert.match(section, /신청 내역을 &lt;조회&gt;한다/);
  assert.match(section, /left:90\.000%;top:2\.000%;width:6\.000%;height:6\.000%/);
  assert.match(section, /<tr data-mk="4">.*저장 버튼.*3번 영역.*설명 4/);
  assert.match(section, /images\/X001_search\.png/);

  const once = applyShotSection(DOC, section);
  const twice = applyShotSection(once, section);
  assert.equal(twice, once, 'running again replaces the earlier section');
  assert.ok(once.indexOf('<h2>화면 설명</h2>') < once.indexOf('<h2>만든 파일</h2>'));
  assert.equal(once.match(/<h2>화면 설명<\/h2>/g).length, 1);
  assert.equal(once.match(/data-shot-script/g).length, 1);
  assert.equal(once.match(/\/\* shot:start \*\//g).length, 1);
});

test('screensOf picks screens with a document and a View, popups by role or _POP name', () => {
  const out = path.join('C:', 'out');
  const report = {
    files: [
      { input: 'a/A.xfdl', status: 'partial', doc: { path: 'docs/a/A001.html', id: 'A001' }, outputs: ['src/views/a/A001/A001View.vue', 'src/views/a/A001/A001Service.js'] },
      { input: 'a/P.xfdl', status: 'ok', role: 'popup', doc: { path: 'docs/a/A002_POP.html', id: 'A002_POP' }, outputs: ['src/views/a/A002_POP/A002_POPView.vue'] },
      { input: 'a/E.xfdl', status: 'error', doc: { path: 'docs/a/E.html', id: 'E' }, outputs: ['src/views/a/E/EView.vue'] },
      { input: 'a/S.xfdl', status: 'ok', role: 'sub', outputs: [] },
    ],
  };
  const s = screensOf(report, out);
  assert.deepEqual(s.map((x) => [x.id, x.hashId, x.popup]), [['A001', 'a/A001', false], ['A002_POP', 'a/A002_POP', true]]);
  assert.equal(s[0].imageDir, path.join(out, 'docs', 'a', 'images'));
  assert.equal(s[0].docFile, path.join(out, 'docs', 'a', 'A001.html'));
});
