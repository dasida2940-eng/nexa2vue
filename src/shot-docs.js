'use strict';

// 화면 설명 문서 (uni 프로필, 변환 뒤 선택 단계, Node 전용).
// 변환이 끝난 출력 폴더의 uni 스타일 미리보기를 띄워 화면마다 캡처하고
// (처음 화면 · 조회 버튼을 누른 뒤 · 팝업은 popup.open으로 연 모습), 캡처 위
// 영역(조회조건·섹션·그리드·버튼)에 번호를 붙인다. 번호별 설명과 사용 순서는
// Claude Code가 변환된 View/Constant와 변환 문서를 읽고 쓴다. 결과는
// docs/<화면ID>/01_개요.html의 "만든 파일" 앞에 "화면 설명" 섹션으로 들어간다.
// 캡처에는 uni frontend에 설치된 Playwright와 이 PC의 Chrome(없으면 Edge)을 쓴다.
// Note: 설명을 쓰려고 변환된 화면 코드와 캡처를 Anthropic으로 보낸다(선택했을 때만).

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { runClaude, removeWorkDir } = require('./ai-convert');
const { DEFAULT_UNI_FRONTEND } = require('./uni-preview-files');
const { SCREEN_DOC_FILES } = require('./conversion-doc');

const START_MARK = '<!-- shot:start -->';
const END_MARK = '<!-- shot:end -->';
const CSS_START = '/* shot:start */';
const CSS_END = '/* shot:end */';
const DEFAULT_DESC_TIMEOUT_MS = 10 * 60 * 1000;
// 팝업 캡처 때 넘기는 샘플 row (부모 화면이 넘기는 값 대신)
const SAMPLE_ROW = { year: '2026', hakgi: '1', hakgiNm: '1학기', hakbeon: '20260001', gwamokCd: 'G001', bunban: '01', gwamokNm: '과목 1', deungrokNo: '1001', jeopsuDt: '2026-03-02', sangho: '실습기관 1', damdangEopmu: '담당업무 1' };

const DESC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '이 화면에서 사용자가 하는 일 1~2문장' },
    markers: {
      type: 'array',
      description: '마커 번호마다 설명 하나 (빠짐없이)',
      items: { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' } }, required: ['n', 'text'] },
    },
    steps: {
      type: 'array',
      description: '사용 순서 3~6단계',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          text: { type: 'string' },
          image: { type: 'string', enum: ['base', 'search', 'none'] },
          markers: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'text', 'image', 'markers'],
      },
    },
    searchNote: { type: 'string', description: '조회 후 캡처(또는 조회가 막힌 이유) 1~2문장' },
  },
  required: ['summary', 'markers', 'steps', 'searchNote'],
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v, total) => `${((v / total) * 100).toFixed(3)}%`;

// ---------------------------------------------------------------------------
// 마커·설명·HTML (순수 함수)

/**
 * 캡처에서 읽은 영역 → 번호 마커. 영역 다음에 그 영역의 버튼이 이어서 번호를 받는다.
 * capture: { width, height, regions: [{ type: 'search'|'section'|'footer', kinds, title, box, labels, columns, tabs, buttons: [{ text, box }] }] }
 */
function buildMarkers(capture) {
  const markers = [];
  let n = 0;
  for (const g of (capture && capture.regions) || []) {
    const kinds = g.kinds || [];
    if (g.type === 'loose') {
      for (const b of g.buttons || []) markers.push({ n: ++n, kind: '버튼', title: b.text, box: b.box });
      continue;
    }
    const kind = g.type === 'search' ? '조회조건' : g.type === 'footer' ? '팝업 하단 버튼'
      : kinds.includes('grid') ? '그리드' : kinds.includes('form') ? '입력폼' : kinds.includes('tabs') ? '탭' : '섹션';
    const m = { n: ++n, kind, title: g.title || '', box: g.box };
    for (const k of ['labels', 'columns', 'tabs']) if (g[k] && g[k].length) m[k] = g[k];
    markers.push(m);
    for (const b of g.buttons || []) markers.push({ n: ++n, kind: '버튼', title: b.text, box: b.box, in: m.n });
  }
  return markers;
}

/** Claude 설명이 없을 때: 캡처에서 읽은 라벨·컬럼·버튼으로 만든 기본 설명. */
function fallbackDesc(markers, reason) {
  const list = (a) => a.slice(0, 12).join(', ') + (a.length > 12 ? ' 등' : '');
  const text = (m) => {
    if (m.kind === '버튼') return `${m.title} 버튼이다. 동작은 View.vue의 클릭 처리 함수를 확인한다.`;
    const parts = [];
    if (m.labels) parts.push(`항목: ${list(m.labels)}`);
    if (m.columns) parts.push(`컬럼: ${list(m.columns)}`);
    if (m.tabs) parts.push(`탭: ${list(m.tabs)}`);
    return `${m.title || m.kind}${parts.length ? ` — ${parts.join(' / ')}` : ''}`;
  };
  return {
    summary: '',
    markers: markers.map((m) => ({ n: m.n, text: text(m) })),
    steps: [],
    searchNote: reason ? `AI 설명을 만들지 못해 캡처에서 읽은 항목만 적었다: ${reason}` : '',
  };
}

const SHOT_CSS = `${CSS_START}
:root { --mk: #e5484d; --mk-on: #0969da; --mk-bg: rgba(9,105,218,.12); --mk-row: rgba(9,105,218,.10); }
.shot-lead { font-size: 1.02em; }
.annot { position: relative; margin: 12px 0 8px 28px; background: #fff; }
.annot img { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 6px; }
.annot .mk { position: absolute; border: 2px dashed var(--mk); border-radius: 4px; pointer-events: none; transition: background .15s, border-color .15s; }
.annot .mk.btn { border-style: solid; }
.annot .mk.on { background: var(--mk-bg); border-color: var(--mk-on); border-style: solid; }
.annot .badge { position: absolute; left: 0; top: 0; transform: translate(-45%, -45%); pointer-events: auto; cursor: default; }
.annot .mk:not(.btn) > .badge { transform: translate(calc(-100% - 6px), -2px); }
.badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px; background: var(--mk); color: #fff; font: 700 12px/1 system-ui, sans-serif; box-shadow: 0 0 0 2px #fff; }
.mk.on .badge, tr.on .badge { background: var(--mk-on); }
.shot-cap { font-size: .9em; color: var(--muted); margin: 0 0 16px; }
.legend td:first-child { width: 1%; white-space: nowrap; text-align: center; }
.legend td:nth-child(2) { width: 1%; white-space: nowrap; }
.legend tr.on td { background: var(--mk-row); }
.legend .sub { color: var(--muted); font-size: .9em; }
ol.steps { padding-left: 0; list-style: none; counter-reset: st; }
ol.steps > li { counter-increment: st; position: relative; padding: 0 0 12px 36px; }
ol.steps > li::before { content: counter(st); position: absolute; left: 0; top: 1px; width: 24px; height: 24px; border-radius: 50%; background: var(--head); border: 1px solid var(--border); text-align: center; font: 700 13px/22px system-ui, sans-serif; }
ol.steps .see { color: var(--muted); font-size: .9em; }
ol.steps .see .badge { min-width: 18px; height: 18px; font-size: 11px; box-shadow: none; margin: 0 1px; }
.note { border-left: 3px solid var(--mk); background: var(--head); padding: 8px 12px; border-radius: 0 6px 6px 0; }
${CSS_END}
`;

// 설명표 행·번호 배지에 마우스를 올리면 캡처의 같은 번호 영역을 강조한다
const SHOT_SCRIPT = `<script data-shot-script>
document.querySelectorAll('[data-mk]').forEach(function (el) {
  var n = el.getAttribute('data-mk'), scope = el.closest('[data-shot]');
  if (!scope) return;
  function set(on) { scope.querySelectorAll('[data-mk="' + n + '"]').forEach(function (x) { x.classList.toggle('on', on) }) }
  el.addEventListener('mouseenter', function () { set(true) }); el.addEventListener('mouseleave', function () { set(false) });
});
</script>`;

function overlay(src, size, markers, alt) {
  const boxes = markers.map((m) => {
    const b = m.box;
    return `<div class="mk${m.kind === '버튼' ? ' btn' : ''}" data-mk="${m.n}" style="left:${pct(b.x, size.w)};top:${pct(b.y, size.h)};width:${pct(b.w, size.w)};height:${pct(b.h, size.h)}"><span class="badge" data-mk="${m.n}" title="${esc(m.title || m.kind)}">${m.n}</span></div>`;
  }).join('');
  return `<div class="annot"><a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></a>${boxes}</div>`;
}

/**
 * "화면 설명" 섹션 HTML.
 * shot: { id, popup, base: { image, size, markers }, search: { image, size, markers } | null }
 * desc: { summary, markers: [{ n, text }], steps, searchNote }
 */
function renderShotSection(shot, desc) {
  const textOf = new Map((desc.markers || []).map((m) => [Number(m.n), m.text]));
  const legend = shot.base.markers.map((m) => {
    const name = m.kind === '버튼' ? `${esc(m.title)} 버튼` : esc(m.title || m.kind);
    const sub = m.kind === '버튼' ? `${m.in}번 영역` : esc(m.kind);
    return `<tr data-mk="${m.n}"><td><span class="badge">${m.n}</span></td><td>${name}<br><span class="sub">${sub}</span></td><td>${esc(textOf.get(m.n) || '')}</td></tr>`;
  }).join('');

  let searchFig = '';
  if (shot.search) {
    searchFig = `<div data-shot>${overlay(shot.search.image, shot.search.size, shot.search.markers, `${shot.id} 조회 후 화면`)}</div>
<p class="shot-cap">조회 후 화면 — 비어 있는 조회조건에 샘플 값(년도 2026·학번 20260001·첫 번째 코드 등)을 넣고 조회 버튼을 누른 모습이다. 그리드·폼 값은 미리보기용 샘플 데이터다.</p>\n`;
  }
  const see = (ns) => (ns && ns.length ? ` <span class="see">· 볼 곳 ${ns.map((n) => `<span class="badge">${Number(n)}</span>`).join('')}</span>` : '');
  let steps = '';
  let searchShown = false;
  for (const st of desc.steps || []) {
    steps += `<li><strong>${esc(st.title)}</strong> — ${esc(st.text)}${see(st.markers)}`;
    if (st.image === 'search' && searchFig && !searchShown) {
      steps += `\n${searchFig}`;
      searchShown = true;
    }
    steps += '</li>\n';
  }
  const cap = shot.popup
    ? '팝업을 샘플 값(년도 2026·학기 1·학번 20260001 등)으로 열어 찍은 화면이다.'
    : '화면을 처음 연 상태다.';
  return `${START_MARK}
<h2>화면 설명</h2>
${desc.summary ? `<p class="shot-lead">${esc(desc.summary)}</p>\n` : ''}<div data-shot>
${overlay(shot.base.image, shot.base.size, shot.base.markers, `${shot.id} 변환 화면 캡처`)}
<p class="shot-cap">${cap} 번호나 아래 설명표의 행에 마우스를 올리면 같은 번호 영역이 강조된다. 이미지를 클릭하면 원본 크기로 본다. nexa2vue 미리보기(${shot.kind === 'vue' ? '구조 파악한 프로젝트의 컴포넌트·스타일, 서버 응답은 빈 샘플' : 'uni 공통 컴포넌트·스타일, 샘플 데이터'})로 띄운 화면이다.</p>
<div class="table-wrap"><table class="legend"><thead><tr><th>번호</th><th>영역</th><th>설명</th></tr></thead><tbody>${legend}</tbody></table></div>
</div>
${steps ? `<h3>사용 순서</h3>\n<ol class="steps">\n${steps}</ol>\n` : ''}${searchFig && !searchShown ? searchFig : ''}${desc.searchNote ? `<p class="note">${esc(desc.searchNote)}</p>\n` : ''}${END_MARK}
`;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** 변환 문서 HTML에 섹션을 넣는다(다시 돌리면 이전 섹션을 바꾼다). */
function applyShotSection(html, section) {
  let s = html;
  s = s.replace(new RegExp(`${reEsc(START_MARK)}[\\s\\S]*?${reEsc(END_MARK)}\\n?`), '');
  s = s.replace(new RegExp(`${reEsc(CSS_START)}[\\s\\S]*?${reEsc(CSS_END)}\\n?`), '');
  s = s.replace(/<script data-shot-script>[\s\S]*?<\/script>\n?/, '');
  s = s.replace('</style>', `${SHOT_CSS}</style>`);
  const anchor = s.indexOf('<h2>만든 파일</h2>');
  s = anchor >= 0 ? `${s.slice(0, anchor)}${section}${s.slice(anchor)}` : s.replace('</main>', `${section}</main>`);
  return s.replace('</body>', `${SHOT_SCRIPT}\n</body>`);
}

// ---------------------------------------------------------------------------
// 설명 쓰기 (Claude Code)

function descPrompt(shot) {
  const vue = shot.kind === 'vue';
  return `넥사크로→Vue${vue ? '' : '(uni)'} 변환 화면의 "캡처 이미지 기반 화면 설명"을 쓴다. 화면: ${shot.id}${shot.popup ? ' (팝업)' : ''}

작업 폴더의 파일
- markers.json: 캡처 위에 번호 배지로 표시한 영역 목록(n, kind=조회조건/입력폼/그리드/탭/섹션/버튼/팝업 하단 버튼, title, labels, columns, tabs, in=버튼이 속한 영역 번호). search는 조회 시도 결과(조회 후 캡처가 있는지, 뜬 alert 메시지).
- base.png: 처음 화면 캡처${shot.search ? ' / search.png: 조회 버튼을 누른 뒤 캡처' : ''} (Read로 직접 본다)
- view/: ${vue ? '이 화면에서 만든 파일(.vue·.js)' : '변환된 View.vue·Constant.js·Service.js(와 하위 화면 .vue)'}
- doc.html: 이 화면의 문서(개요·확인할 것, 그 뒤에 변환 내용: 원본 함수→변환 위치, 원본과 달라진 점)

출력(JSON 스키마 그대로)
- summary: 이 화면에서 사용자가 무엇을 하는지 1~2문장.
- markers: markers.json의 모든 n에 대해 빠짐없이 { n, text }. 그 영역/버튼이 무엇이고 입력하거나 누르면 실제로 무슨 일이 일어나는지를 ${vue ? '화면 코드' : 'View.vue'} 기준으로 쓴다(호출 API, 검증 메시지 원문, 여는 팝업, 선택 행 처리). 조회조건·입력폼은 주요 항목과 필수·비활성 여부, 그리드는 주요 컬럼과 행 클릭 동작, 버튼은 클릭 동작과 사전 검사. 2~4문장(버튼이 많으면 1~2문장).
- steps: 이 화면을 쓰는 실제 순서 3~6단계 { title, text(1~3문장), image, markers }. image는 그 단계를 보여 주는 캡처: "search"는 search.png가 있을 때만, 아니면 "base" 또는 "none". markers는 그 단계에서 볼 번호.
- searchNote: 조회 후 캡처가 있으면 샘플 데이터로 조회한 결과라는 점과 무엇이 채워졌는지. 없고 alert가 있으면 그 메시지가 왜 떴는지(소스의 검증 조건). 조회조건이 없는 화면(팝업 등)은 열 때 무엇을 조회하는지.

규칙
- 아직 연결 안 된 기능(TODO, "준비 중" 알림, 미연결 팝업)은 그렇다고 분명히 쓴다. 돋보기(아이콘만 있는) 버튼은 마커가 없으니 해당 조회조건/입력폼 설명 안에서 다룬다.
- 탭 화면은 캡처에 첫 탭만 보인다. 탭 설명에서 탭별로 무엇을 하는지 소스 기준으로 정리한다.
- 팝업은 캡처하려고 샘플 row(year 2026, hakgi 1, hakbeon 20260001 등)로 열었다. 어느 화면에서 어떤 값을 받아 열리는지 소스·문서 기준으로 쓴다.
- ${vue ? '미리보기는 서버 호출에 빈 응답을 준다. 목록이 비어 있는 것은 그 때문이다' : '캡처의 값("성명 1", "코드 1" 등)은 미리보기용 가짜 데이터다'}. 실제 데이터처럼 설명하지 않는다. 캡처를 어떻게 만들었는지(도구·스크립트)는 쓰지 않는다.
- 근거 없는 추측 금지. doc.html의 "원본과 달라진 점/확인할 것"과 어긋나지 않게.
- 한국어 평서체("~한다", "~를 띄운다"), 짧고 구체적으로.`;
}

async function describeShot(shot, { output, outputs, docFile, claudeBin, model, timeoutMs, isCancelled, onStep, onUsage }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-shot-'));
  try {
    const markersJson = {
      id: shot.id,
      kind: shot.kind || 'uni',
      popup: shot.popup,
      markers: shot.base.markers.map(({ box, ...m }) => m),
      search: shot.popup ? null : { tried: shot.searchTried, afterImage: !!shot.search, alerts: shot.searchAlerts },
      alertsOnOpen: shot.openAlerts,
    };
    fs.writeFileSync(path.join(work, 'markers.json'), JSON.stringify(markersJson, null, 1), 'utf8');
    fs.copyFileSync(shot.base.file, path.join(work, 'base.png'));
    if (shot.search) fs.copyFileSync(shot.search.file, path.join(work, 'search.png'));
    fs.mkdirSync(path.join(work, 'view'));
    for (const rel of outputs.filter((p) => /\.(vue|js)$/.test(p) && p.startsWith('src/'))) {
      const src = path.join(output, ...rel.split('/'));
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(work, 'view', path.posix.basename(rel)));
    }
    // The screen's documents are split (conversion-doc.js): 개요 has the
    // 확인할 것, 변환내용 the original → converted mapping. Claude gets both.
    const docParts = [docFile, path.join(path.dirname(docFile), SCREEN_DOC_FILES.conversion)].filter((p) => fs.existsSync(p));
    if (docParts.length) fs.writeFileSync(path.join(work, 'doc.html'), docParts.map((p) => fs.readFileSync(p, 'utf8')).join('\n'), 'utf8');
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(DESC_SCHEMA),
      // 작업 폴더만 읽는다
      '--tools', 'Read,Glob,Grep',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources', 'project',
    ];
    if (model) args.push('--model', model);
    const res = await runClaude(args, descPrompt(shot), { cwd: work, timeoutMs, claudeBin, isCancelled, onStep, onUsage });
    if (res.is_error || !res.structured_output) throw new Error(`설명 생성 실패: ${String(res.result || res.subtype || 'no result').slice(0, 200)}`);
    const out = res.structured_output;
    if (!Array.isArray(out.markers)) throw new Error('설명 응답에 markers가 없습니다');
    return { desc: out, costUsd: res.total_cost_usd };
  } finally {
    removeWorkDir(work);
  }
}

// ---------------------------------------------------------------------------
// 미리보기 서버 · 캡처

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  else child.kill();
}

/** 출력 폴더의 미리보기(preview/start.mjs)를 빈 포트에 띄운다. */
async function startPreview(output, onLog) {
  if (!fs.existsSync(path.join(output, 'preview', 'start.mjs'))) {
    throw new Error('출력 폴더에 미리보기가 없습니다. "미리보기 함께 생성"을 켜고 변환하세요');
  }
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, [path.join(output, 'preview', 'start.mjs'), '--port', String(port), '--strictPort'], {
    cwd: output,
    windowsHide: true,
    // 브라우저 창을 열지 않는다
    env: { ...process.env, BROWSER: 'none' },
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  const until = Date.now() + 90 * 1000;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new Error(`미리보기를 띄우지 못했습니다: ${log.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 300)}`);
    if (await httpOk(url)) {
      if (onLog) onLog(`미리보기 서버 ${url}`);
      return { url, stop: () => killTree(child) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  throw new Error('미리보기 서버가 90초 안에 뜨지 않았습니다');
}

/** uni frontend에 설치된 Playwright로 이 PC의 Chrome(없으면 Edge, 그다음 Playwright 브라우저)을 연다. */
async function launchBrowser(uniFrontend) {
  const dirs = [uniFrontend, DEFAULT_UNI_FRONTEND].map((d) => path.join(d, 'node_modules', 'playwright'));
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!dir) {
    throw new Error(`캡처에 쓸 Playwright가 없습니다: ${dirs.join(', ')} (frontend 폴더에서 npm install playwright)`);
  }
  const { chromium } = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
  const errors = [];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch (err) {
      errors.push(`${channel || 'playwright'}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(`캡처용 브라우저를 열 수 없습니다 — ${errors.join(' / ')}`);
}

// 브라우저 안에서 실행: 캡처 대상 요소 안의 영역(좌표는 대상 요소 기준 px)
function extractRegions(root) {
  const R = root.getBoundingClientRect();
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left - R.left), y: Math.round(r.top - R.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelsIn = (el) => [...el.querySelectorAll('label.common-label')].filter(visible).map(txt).filter(Boolean);
  const btn = (b) => ({ text: txt(b), box: box(b) });
  const buttonsIn = (el) => [...el.querySelectorAll('button.custom-button:not(.icon-only)')].filter(visible).map(btn);
  const regions = [];
  const ss = root.querySelector('.search-section');
  if (ss && visible(ss)) regions.push({ type: 'search', box: box(ss), labels: labelsIn(ss), buttons: buttonsIn(ss) });
  for (const s of root.querySelectorAll('section.section')) {
    if (!visible(s)) continue;
    const tb = s.querySelector(':scope > .title-box');
    const body = s.querySelector(':scope > .section-body') || s;
    const kinds = [];
    if (body.querySelector('.dg-wrap, .q-table__container')) kinds.push('grid');
    if (body.querySelector('form.form-box')) kinds.push('form');
    if (body.querySelector('.q-tabs')) kinds.push('tabs');
    regions.push({
      type: 'section',
      kinds,
      title: txt(tb && tb.querySelector('.title')),
      box: box(s),
      labels: labelsIn(body),
      columns: [...body.querySelectorAll('thead th')].filter(visible).map(txt).filter(Boolean),
      tabs: [...body.querySelectorAll('.q-tab')].map(txt).filter(Boolean),
      buttons: tb ? buttonsIn(tb) : [],
    });
  }
  const pf = root.querySelector('.popup-footer');
  if (pf) regions.push({ type: 'footer', box: box(pf), buttons: buttonsIn(pf) });
  if (!regions.length) {
    // Not the uni layout: the outermost forms, tables, fieldsets and sections,
    // in page order; buttons outside them are numbered on their own.
    const SEL = 'form, table, fieldset, section, [role="tablist"], [class*="search"], [class*="filter"], [class*="toolbar"]';
    const picked = [...root.querySelectorAll(SEL)].filter((el) => visible(el) && el !== root);
    const outer = picked.filter((el) => !picked.some((p) => p !== el && p.contains(el)));
    const heading = (el) => {
      const own = el.querySelector('legend, caption, h1, h2, h3, h4');
      if (own) return txt(own);
      let p = el.previousElementSibling;
      for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) if (/^H[1-4]$/.test(p.tagName)) return txt(p);
      return el.getAttribute('aria-label') || '';
    };
    const anyBtn = (el) => [...el.querySelectorAll('button, input[type="button"], input[type="submit"]')].filter(visible)
      .map((b) => ({ text: txt(b) || b.value || b.title || b.getAttribute('aria-label') || '', box: box(b) })).filter((b) => b.text);
    for (const el of outer) {
      const isTable = el.tagName === 'TABLE' || !!el.querySelector('table');
      const isForm = !isTable && !!el.querySelector('input, select, textarea');
      const isSearch = /search|filter/i.test(el.className || '') || (isForm && anyBtn(el).some((b) => /조회|검색/.test(b.text)));
      const kinds = isTable ? ['grid'] : isForm ? ['form'] : el.getAttribute('role') === 'tablist' ? ['tabs'] : [];
      regions.push({
        type: isSearch ? 'search' : 'section',
        kinds,
        title: heading(el),
        box: box(el),
        labels: [...el.querySelectorAll('label, th[scope="row"]')].filter(visible).map(txt).filter(Boolean),
        columns: [...el.querySelectorAll('thead th')].filter(visible).map(txt).filter(Boolean),
        tabs: el.getAttribute('role') === 'tablist' ? [...el.querySelectorAll('[role="tab"]')].map(txt).filter(Boolean) : [],
        buttons: anyBtn(el),
      });
    }
    const loose = [...root.querySelectorAll('button, input[type="button"], input[type="submit"]')]
      .filter((b) => visible(b) && !outer.some((el) => el.contains(b)))
      .map((b) => ({ text: txt(b) || b.value || b.title || '', box: box(b) })).filter((b) => b.text);
    if (loose.length) regions.push({ type: 'loose', buttons: loose });
    regions.sort((a, b) => (a.box ? a.box.y : 1e9) - (b.box ? b.box.y : 1e9) || (a.box ? a.box.x : 0) - (b.box ? b.box.x : 0));
  }
  return { width: Math.round(R.width), height: Math.round(R.height), regions };
}

async function shoot(page, selector, file) {
  const el = page.locator(selector).first();
  const h = await el.evaluate((e) => Math.max(e.scrollHeight, e.getBoundingClientRect().height));
  await page.setViewportSize({ width: 1600, height: Math.max(1000, Math.min(Math.ceil(h) + 80, 4000)) });
  await page.waitForTimeout(600);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await el.screenshot({ path: file });
  const capture = await el.evaluate(extractRegions);
  await page.setViewportSize({ width: 1600, height: 1000 });
  return capture;
}

/**
 * 한 화면 캡처. screen: { id, hashId, viewFile, popup, imageDir }
 * 팝업은 미리보기 목록에서 닫힌 채 뜨므로 uni popup.open으로 직접 연다.
 */
async function captureScreen(browser, baseUrl, uniFrontend, screen) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.accept().catch(() => {});
  });
  try {
    const shot = { id: screen.id, popup: screen.popup, search: null, searchTried: false, searchAlerts: [], openAlerts: [] };
    const baseFile = path.join(screen.imageDir, `${screen.id}.png`);
    if (screen.popup && screen.kind !== 'vue') {
      await page.goto(`${baseUrl}#/__none`, { waitUntil: 'networkidle' });
      const utilsUrl = `/@fs/${uniFrontend.replace(/\\/g, '/')}/src/utils/index.js`;
      await page.evaluate(async ({ utilsUrl, viewUrl, row }) => {
        const utils = await import(utilsUrl);
        const mod = await import(viewUrl);
        utils.popup.open(mod.default, { row });
      }, { utilsUrl, viewUrl: `/${screen.viewFile}`, row: SAMPLE_ROW });
      await page.waitForSelector('.popup-card', { timeout: 15000 });
      await page.waitForTimeout(2000);
      // 카드 안 스크롤을 풀어 팝업 전체가 한 장에 나오게 한다
      await page.addStyleTag({ content: '.popup-dialog{position:absolute!important;inset:0 auto auto 0!important;height:auto!important;overflow:visible!important}.popup-card,.popup-body{max-height:none!important;height:auto!important;overflow:visible!important}' });
      await page.waitForTimeout(500);
      shot.base = { file: baseFile, capture: await shoot(page, '.popup-card', baseFile) };
      shot.openAlerts = dialogs.slice();
      return shot;
    }
    await page.goto(`${baseUrl}#/${screen.hashId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    if (screen.kind === 'vue') {
      shot.base = { file: baseFile, capture: await shoot(page, '#np-screen', baseFile) };
      shot.openAlerts = dialogs.slice();
      const btn = page.locator('#np-screen').getByRole('button', { name: /조회|검색/ }).first();
      if (await btn.count()) {
        shot.searchTried = true;
        const before = await page.locator('#np-screen tbody tr').count();
        for (const inp of await page.locator('#np-screen input[type="text"]:enabled, #np-screen input:not([type]):enabled').all()) {
          if (await inp.inputValue().catch(() => 'x')) continue;
          const hint = `${(await inp.getAttribute('placeholder').catch(() => '')) || ''} ${(await inp.getAttribute('name').catch(() => '')) || ''}`;
          const v = /년도|연도|year/i.test(hint) ? '2026' : /학번/.test(hint) ? '20260001' : /성명|이름|name/i.test(hint) ? '홍길동' : '';
          if (v) await inp.fill(v).catch(() => {});
        }
        const n = dialogs.length;
        await btn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        shot.searchAlerts = dialogs.slice(n);
        const after = await page.locator('#np-screen tbody tr').count();
        if (after > 0 && after !== before) {
          const file = path.join(screen.imageDir, `${screen.id}_search.png`);
          shot.search = { file, capture: await shoot(page, '#np-screen', file) };
        }
      }
      return shot;
    }
    shot.base = { file: baseFile, capture: await shoot(page, '.np-main .content-body', baseFile) };
    shot.openAlerts = dialogs.slice();
    const ss = page.locator('.search-section');
    if (await ss.count()) {
      // 비어 있는 조회조건에 샘플 값을 넣고 조회 버튼을 누른다
      shot.searchTried = true;
      const before = await page.locator('.q-table tbody tr').count();
      const items = ss.locator('.item');
      for (let i = 0; i < (await items.count()); i++) {
        const it = items.nth(i);
        const label = (await it.locator('label').first().textContent().catch(() => '')) || '';
        for (const inp of await it.locator('input.common-input:enabled').all()) {
          if (await inp.inputValue().catch(() => 'x')) continue;
          const v = /년도|연도/.test(label) ? '2026' : /학번/.test(label) ? '20260001' : /교번/.test(label) ? 'P0001' : /성명|이름/.test(label) ? '홍길동' : '';
          if (v) await inp.fill(v).catch(() => {});
        }
        for (const sel of await it.locator('select:enabled').all()) {
          if (await sel.inputValue().catch(() => 'x')) continue;
          const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
          if (opts.length) await sel.selectOption(opts[0]).catch(() => {});
        }
      }
      const n = dialogs.length;
      await ss.locator('button.custom-button.primary').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      shot.searchAlerts = dialogs.slice(n);
      const after = await page.locator('.q-table tbody tr').count();
      if (after > 0 && after !== before) {
        const file = path.join(screen.imageDir, `${screen.id}_search.png`);
        shot.search = { file, capture: await shoot(page, '.np-main .content-body', file) };
      }
    }
    return shot;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 전체 흐름

/** 변환 결과(report.files)에서 설명 문서를 만들 화면: 문서와 View.vue가 있는 것. */
function screensOf(report, output) {
  const out = [];
  const vue = report.frontendKind === 'vue';
  for (const f of report.files || []) {
    if (!f.doc || f.status === 'error') continue;
    const viewFile = vue ? f.view
      : (f.outputs || []).find((p) => /^src\/views\/.+View\.vue$/.test(p) && path.posix.basename(p) === `${f.doc.id}View.vue`);
    if (!viewFile) continue;
    const docDir = path.posix.dirname(f.doc.path);
    out.push({
      input: f.input,
      id: f.doc.id,
      kind: vue ? 'vue' : 'uni',
      viewFile,
      // vue preview: #/<id> (preview/screens.js); uni preview: #/<views path>
      hashId: vue ? f.doc.id : viewFile.replace(/^src\/views\//, '').replace(/\/[^/]+View\.vue$/, ''),
      popup: f.role === 'popup' || /_POP$/.test(f.doc.id),
      outputs: f.outputs || [],
      docFile: path.join(output, ...f.doc.path.split('/')),
      imageDir: path.join(output, ...docDir.split('/'), 'images'),
    });
  }
  return out;
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * 변환이 끝난 출력 폴더의 화면 문서마다 "화면 설명" 섹션을 만든다.
 * opts: { output, uniFrontend, report, claudeBin, model, parallel, timeoutMs, isCancelled, onLog, onUsage }
 * 반환: { done: [id], failed: [{ id, error }], costUsd }
 */
async function makeShotDocs({ output, uniFrontend, report, claudeBin, model, parallel = 3, timeoutMs = DEFAULT_DESC_TIMEOUT_MS, isCancelled, onLog, onUsage }) {
  const log = onLog || (() => {});
  const cancelled = () => !!(isCancelled && isCancelled());
  const screens = screensOf(report, output);
  const result = { done: [], failed: [], costUsd: 0 };
  if (!screens.length) {
    log('화면 설명: 문서를 만들 화면이 없습니다');
    return result;
  }
  log(`화면 설명 문서 생성 시작 — 화면 ${screens.length}개 (캡처 → Claude 설명 → docs 반영)`);
  const preview = await startPreview(output, log);
  const shots = new Map();
  try {
    const browser = await launchBrowser(uniFrontend);
    try {
      for (const s of screens) {
        if (cancelled()) throw new Error('취소되었습니다');
        try {
          const shot = await captureScreen(browser, preview.url, uniFrontend, s);
          shots.set(s.id, shot);
          log(`[${s.input}] 캡처 ${shot.search ? '처음 화면 + 조회 후' : '처음 화면'}${shot.searchAlerts.length ? ` (조회 때 알림: ${shot.searchAlerts.join(' / ')})` : ''}`);
        } catch (err) {
          result.failed.push({ id: s.id, error: `캡처 실패: ${err.message}` });
          log(`[${s.input}] 캡처 실패: ${String(err.message).split('\n')[0]}`);
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    preview.stop();
  }

  await pool(screens.filter((s) => shots.has(s.id)), parallel, async (s) => {
    if (cancelled()) return;
    const raw = shots.get(s.id);
    const rel = (file) => path.relative(path.dirname(s.docFile), file).split(path.sep).join('/');
    const shot = {
      id: s.id,
      kind: s.kind,
      popup: s.popup && s.kind !== 'vue',
      searchTried: raw.searchTried,
      searchAlerts: raw.searchAlerts,
      openAlerts: raw.openAlerts,
      base: { file: raw.base.file, image: rel(raw.base.file), size: { w: raw.base.capture.width, h: raw.base.capture.height }, markers: buildMarkers(raw.base.capture) },
      search: null,
    };
    if (raw.search) {
      // 레이아웃이 같으면(마커 수 동일) 같은 번호를 조회 후 캡처에도 표시
      const sm = buildMarkers(raw.search.capture);
      shot.search = { file: raw.search.file, image: rel(raw.search.file), size: { w: raw.search.capture.width, h: raw.search.capture.height }, markers: sm.length === shot.base.markers.length ? sm : [] };
    }
    let desc;
    try {
      log(`[${s.input}] 설명 작성 시작 (Claude Code, 번호 ${shot.base.markers.length}개)`);
      const out = await describeShot(shot, { output, outputs: s.outputs, docFile: s.docFile, claudeBin, model, timeoutMs, isCancelled, onUsage });
      desc = out.desc;
      if (out.costUsd != null) result.costUsd += out.costUsd;
    } catch (err) {
      if (cancelled()) return;
      desc = fallbackDesc(shot.base.markers, err.message);
      result.failed.push({ id: s.id, error: err.message });
      log(`[${s.input}] 설명 작성 실패 — 캡처와 항목 목록만 넣습니다: ${err.message}`);
    }
    const html = fs.readFileSync(s.docFile, 'utf8');
    fs.writeFileSync(s.docFile, applyShotSection(html, renderShotSection(shot, desc)), 'utf8');
    result.done.push(s.id);
    log(`[${s.input}] 화면 설명 반영 ${path.relative(output, s.docFile).split(path.sep).join('/')}`);
  });
  if (cancelled()) throw new Error('취소되었습니다');
  log(`화면 설명 문서 끝 — 반영 ${result.done.length}개${result.failed.length ? `, 문제 ${result.failed.length}개(${result.failed.map((f) => f.id).join(', ')})` : ''}`);
  return result;
}

module.exports = { makeShotDocs, buildMarkers, fallbackDesc, renderShotSection, applyShotSection, screensOf, DESC_SCHEMA };
