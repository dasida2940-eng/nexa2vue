'use strict';

// Browser build of the nexa2vue web UI: no server. Sources are read with the
// File System Access API (or a folder <input> as fallback), converted in
// memory with the same code as the Node runner, then written to a folder the
// user picks or downloaded as a ZIP. File names and contents are rendered with
// textContent only, never innerHTML.

const { convertSources } = require('../src/convert-core');
const { decodeSource } = require('../src/decode');
const { SKIP_DIRS, SOURCE_EXT } = require('../src/scanner-rules');
const { createZip } = require('./zip');
const { uniPreviewFiles } = require('../src/uni-preview-files');
const { resolveNames } = require('../src/names');
const nexaNameTable = require('../public/name-table');
const assets = require('nexa2vue-assets');

const MAX_FILES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const STATUS_LABEL = { ok: '완료', partial: '확인 필요', error: '실패' };
const canPickFolder = typeof window.showDirectoryPicker === 'function';

const $ = (id) => document.getElementById(id);

const state = {
  inputName: '',
  inputHandle: null, // FileSystemDirectoryHandle when picked with showDirectoryPicker
  sources: [], // [{ rel, kind, size, getBytes() }]
  skipped: [],
  config: {},
  texts: new Map(), // rel -> decoded source text, for the compare view
  outputs: new Map(), // output path -> { content, keepIfExists }
  report: null,
  screenNames: new Map(), // rel -> output name edited in the preview list
  nameTable: null,
  running: false,
  cancelled: false,
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setMessage(text, isError = false, id = 'message') {
  $(id).textContent = text;
  $(id).className = isError ? 'message error' : 'message';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

// ---------------------------------------------------------------- input

async function scanHandle(root) {
  const sources = [];
  const skipped = [];
  let configFile = null;
  const walk = async (dir, prefix) => {
    const entries = [];
    for await (const [name, handle] of dir.entries()) entries.push([name, handle]);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, handle] of entries) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) await walk(handle, rel);
        continue;
      }
      if (!prefix && name === 'nexa2vue.config.json') configFile = handle;
      const kind = SOURCE_EXT[extOf(name)];
      if (!kind) continue;
      const file = await handle.getFile();
      addSource(sources, skipped, { rel, kind, size: file.size, getBytes: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
    }
  };
  await walk(root, '');
  return { sources, skipped, config: configFile ? await readConfig(await configFile.getFile()) : {} };
}

// Fallback (<input webkitdirectory>): paths start with the picked folder name.
async function scanFileList(fileList) {
  const sources = [];
  const skipped = [];
  let rootName = '';
  let configFile = null;
  const files = [...fileList].sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    rootName = rootName || parts[0];
    const relParts = parts.slice(1);
    if (relParts.slice(0, -1).some((d) => SKIP_DIRS.has(d) || d.startsWith('.'))) continue;
    const rel = relParts.join('/');
    if (rel === 'nexa2vue.config.json') configFile = file;
    const kind = SOURCE_EXT[extOf(file.name)];
    if (!kind) continue;
    addSource(sources, skipped, { rel, kind, size: file.size, getBytes: async () => new Uint8Array(await file.arrayBuffer()) });
  }
  return { rootName, sources, skipped, config: configFile ? await readConfig(configFile) : {} };
}

function addSource(sources, skipped, source) {
  if (source.size > MAX_BYTES) skipped.push({ rel: source.rel, reason: `larger than ${MAX_BYTES} bytes` });
  else if (sources.length >= MAX_FILES) skipped.push({ rel: source.rel, reason: `file limit ${MAX_FILES} reached` });
  else sources.push(source);
}

async function readConfig(file) {
  try {
    return JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`nexa2vue.config.json 형식 오류: ${err.message}`);
  }
}

async function pickInput() {
  if (!canPickFolder) {
    $('input-files').click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'nexa2vue-input', mode: 'read' });
  } catch (err) {
    // AbortError is also what Chrome reports when it refuses a system folder (C:\, the user folder, ...).
    const hint = '"다른 방식으로 선택" 버튼으로 다시 고르세요. 드라이브 최상위나 사용자 폴더 자체는 브라우저가 막으니 그 아래 폴더를 고르세요.';
    if (err.name === 'AbortError') setMessage(`폴더를 고르지 않았습니다. 선택 창에서 막혔다면 ${hint}`, false, 'input-message');
    else setMessage(`폴더 선택 창을 열 수 없습니다(${err.name}: ${err.message}). ${hint}`, true, 'input-message');
    return;
  }
  await loadInput(handle.name, handle, () => scanHandle(handle));
}

async function loadInput(name, handle, scan) {
  setMessage('폴더를 읽는 중…', false, 'input-message');
  try {
    const result = await scan();
    if (!result.sources.some((s) => s.kind === 'form')) {
      throw new Error(`선택한 폴더(${name}) 아래에 넥사크로 화면(.xfdl)이 없습니다`);
    }
    state.screenNames = new Map();
    Object.assign(state, {
      inputName: name, inputHandle: handle, sources: result.sources, skipped: result.skipped, config: result.config,
    });
    $('input-name').textContent = name;
    renderPreview();
    setMessage(`입력 폴더: ${name}`, false, 'input-message');
    $('settings').hidden = false;
    resetResult();
  } catch (err) {
    setMessage(err.message, true, 'input-message');
  }
}

function renderPreview() {
  const box = $('preview');
  box.replaceChildren();
  const forms = state.sources.filter((s) => s.kind === 'form');
  const libs = state.sources.filter((s) => s.kind === 'lib');
  const libNote = $('ui-only').checked || $('profile').value === 'uni' ? ' (UI만 변환: 변환하지 않음)' : '';
  box.append(el('p', `화면(.xfdl) ${forms.length}개, 공통 스크립트(.xjs) ${libs.length}개${libNote}, 제외 ${state.skipped.length}개`));
  // Output name per screen: nexa2vue.config.json "names" or the file name.
  const rels = forms.map((f) => f.rel);
  const defaults = Object.fromEntries(resolveNames(rels, state.config.names).names);
  state.nameTable = nexaNameTable.create(rels, defaults, state.screenNames, () => $('profile').value);
  box.append(state.nameTable.table);
  if (libs.length || state.skipped.length) {
    const list = el('div', undefined, 'preview-list');
    for (const f of libs) list.append(el('div', f.rel));
    for (const s of state.skipped) list.append(el('div', `제외: ${s.rel} (${s.reason})`));
    box.append(list);
  }
}

// ---------------------------------------------------------------- convert

function outputName() {
  return `${state.inputName}_vue`;
}

// package.json "name" follows the output folder like the Node version.
function viewerFilesFor(name) {
  const pkgName = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'nexa2vue-screens';
  return assets.viewerFiles.map((f) => {
    if (f.path !== 'package.json') return f;
    const pkg = JSON.parse(f.content);
    pkg.name = pkgName;
    return { path: f.path, content: `${JSON.stringify(pkg, null, 2)}\n` };
  });
}

function resetResult() {
  state.outputs = new Map();
  state.report = null;
  $('progress-card').hidden = true;
  $('detail-card').hidden = true;
  $('btn-save-folder').disabled = true;
  $('btn-save-zip').disabled = true;
  setMessage('', false, 'save-message');
}

async function run() {
  if (state.running || !state.sources.length) return;
  if (state.nameTable && state.nameTable.hasErrors()) {
    setMessage('출력 이름에 오류가 있습니다. 입력 폴더 목록의 빨간 칸을 고치세요.', true);
    return;
  }
  resetResult();
  state.running = true;
  state.cancelled = false;
  state.texts = new Map();
  $('btn-run').disabled = true;
  $('btn-cancel').disabled = false;
  $('progress-card').hidden = false;
  setMessage('변환 중…');
  const files = [];
  try {
    const sources = state.sources.map((s) => ({
      rel: s.rel,
      kind: s.kind,
      read: async () => {
        const decoded = decodeSource(await s.getBytes());
        state.texts.set(s.rel, decoded.text);
        return decoded;
      },
    }));
    const report = await convertSources(sources, {
      input: state.inputName,
      output: outputName(),
      skipped: state.skipped,
      config: state.config,
      compatSource: assets.compatSource,
      viewerFiles: viewerFilesFor(outputName()),
      uniPreviewFiles: uniPreviewFiles($('uni-frontend').value.trim(), assets.uniPreviewTemplates),
      write: (rel, content, meta) => {
        state.outputs.set(rel, { content, keepIfExists: !!meta.keepIfExists });
      },
    }, {
      profile: $('profile').value,
      uiOnly: $('ui-only').checked,
      viewer: $('viewer').checked,
      renames: Object.fromEntries(state.screenNames),
      isCancelled: () => state.cancelled,
      onProgress: (result, done, total) => {
        files.push(result);
        renderProgress(files, done, total, null);
      },
    });
    state.report = report;
    renderProgress(report.files, report.files.length, report.summary.total, report);
    setMessage(report.cancelled ? '취소되었습니다. 처리한 파일까지만 저장할 수 있습니다.' : '변환이 끝났습니다. 아래에서 저장하세요.');
    // Without the input folder handle the overlap check cannot run, so only ZIP is offered.
    $('btn-save-folder').disabled = !canPickFolder || !state.inputHandle;
    if (canPickFolder && !state.inputHandle) setMessage('다른 방식으로 고른 폴더는 원본 보호 검사를 할 수 없어 ZIP으로만 저장합니다.', false, 'save-message');
    $('btn-save-zip').disabled = false;
  } catch (err) {
    setMessage(`오류: ${err.message}`, true);
  } finally {
    state.running = false;
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = true;
  }
}

function renderProgress(files, done, total, report) {
  $('progress').max = Math.max(total, 1);
  $('progress').value = done;
  const s = report && report.summary;
  $('summary').textContent = s
    ? `전체 ${s.total} · 완료 ${s.ok} · 확인 필요 ${s.partial} · 실패 ${s.error} · TODO ${s.todos}건 · 출력 파일 ${state.outputs.size}개`
    : `${done} / ${total} 처리 중…`;

  const gfn = $('missing-gfn');
  gfn.replaceChildren();
  if (report && report.missingGfn.length) {
    gfn.append(el('p', `구현이 필요한 공통 함수 (src/utils/nexa-gfn.js 스텁): ${report.missingGfn.join(', ')}`));
  }

  const rows = $('file-rows');
  rows.replaceChildren();
  files.forEach((f) => {
    const tr = el('tr');
    const status = el('td');
    status.append(el('span', STATUS_LABEL[f.status] || f.status, `badge ${f.status}`));
    const name = el('td');
    const open = el('button', f.input, 'link');
    open.type = 'button';
    open.addEventListener('click', () => {
      rows.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      showDetail(f);
    });
    name.append(open);
    tr.append(status, name, el('td', String(f.todos.length)));
    rows.append(tr);
  });
}

let detailOutputs = [];

function showDetail(f) {
  $('detail-card').hidden = false;
  $('detail-name').textContent = f.input;
  $('detail-source').textContent = state.texts.get(f.input) || '';
  const todos = $('detail-todos');
  todos.replaceChildren();
  if (f.error) todos.append(el('li', f.error));
  for (const t of f.todos) todos.append(el('li', t.line ? `${t.message} (원본 스크립트 ${t.line}행)` : t.message));

  detailOutputs = f.outputs.map((p) => ({ path: p, content: (state.outputs.get(p) || {}).content || '' }));
  const select = $('detail-output');
  select.replaceChildren();
  detailOutputs.forEach((o, i) => {
    const opt = el('option', o.path);
    opt.value = String(i);
    select.append(opt);
  });
  $('detail-result').textContent = detailOutputs.length ? detailOutputs[0].content : '(출력 없음)';
  $('detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- save

async function isOverlapping(input, output) {
  if (!input) return false;
  if (await input.isSameEntry(output)) return true;
  // resolve() returns the path when the second handle is inside the first.
  return (await input.resolve(output)) !== null || (await output.resolve(input)) !== null;
}

async function fileExists(dir, parts) {
  try {
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    await d.getFileHandle(parts[parts.length - 1]);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(dir, parts, content) {
  let d = dir;
  for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
  const handle = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

function safeParts(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`잘못된 출력 경로: ${rel}`);
  return parts;
}

async function saveToFolder() {
  let output;
  try {
    output = await window.showDirectoryPicker({ id: 'nexa2vue-output', mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') setMessage(err.message, true, 'save-message');
    return;
  }
  const button = $('btn-save-folder');
  button.disabled = true;
  try {
    if (await isOverlapping(state.inputHandle, output)) {
      throw new Error('출력 폴더는 입력 폴더와 같거나, 그 안에 있거나, 그것을 포함하면 안 됩니다 (원본 보호)');
    }
    const written = [];
    const kept = [];
    let i = 0;
    for (const [rel, { content, keepIfExists }] of state.outputs) {
      const parts = safeParts(rel);
      setMessage(`저장 중… ${++i} / ${state.outputs.size}`, false, 'save-message');
      if (keepIfExists && (await fileExists(output, parts))) {
        kept.push(rel);
        continue;
      }
      await writeFile(output, parts, content);
      written.push(rel);
    }
    setMessage(`출력 폴더(${output.name})에 ${written.length}개 파일을 저장했습니다. 같은 이름의 파일은 덮어썼습니다.`, false, 'save-message');
    renderViewerGuide(output.name, kept);
  } catch (err) {
    setMessage(err.message, true, 'save-message');
  } finally {
    button.disabled = false;
  }
}

function saveZip() {
  const root = outputName();
  const entries = [...state.outputs].map(([rel, { content }]) => ({ path: `${root}/${rel}`, content }));
  const url = URL.createObjectURL(createZip(entries));
  const a = el('a');
  a.href = url;
  a.download = `${root}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setMessage(`${root}.zip을 내려받았습니다(${entries.length}개 파일). 압축을 풀어 쓰세요.`, false, 'save-message');
  renderViewerGuide(root, []);
}

// How to run the generated screen viewer, shown once the files are saved.
function renderViewerGuide(folderName, kept) {
  const box = $('viewer-guide');
  box.replaceChildren();
  box.hidden = !(state.report && state.report.viewer);
  if (box.hidden) return;
  const kind = state.report.viewer.kind;
  box.append(el('h3', '화면 보기 실행 방법'));
  if (kind === 'uni') {
    box.append(el('p', `저장한 폴더의 view-screens.cmd를 더블클릭하세요. uni frontend(${$('uni-frontend').value.trim() || '기본 경로'})에 설치된 패키지를 그대로 쓰므로 npm install은 하지 않습니다.`));
    box.append(el('pre', `cd /d "${folderName}"\nnode preview\\start.mjs`));
    box.append(el('p', '브라우저에서 http://127.0.0.1:5174 이 열리면 왼쪽 목록에서 화면을 고르세요. 조회하면 Constant 정의로 만든 샘플 데이터가 나옵니다. uni frontend 경로는 uni-preview.config.json에서 바꿀 수 있습니다.'));
  } else {
    box.append(el('p', '저장한 폴더의 view-screens.cmd를 더블클릭하거나, 명령 프롬프트에서 아래를 실행하세요. 처음 한 번은 npm install로 패키지를 내려받습니다.'));
    box.append(el('pre', `cd /d "${folderName}"\nnpm install\nnpm run dev`));
    box.append(el('p', '브라우저에서 http://127.0.0.1:5173 이 열리면 왼쪽 목록에서 화면을 고르세요.'));
  }
  if (kept.length) box.append(el('p', `이미 있던 파일은 덮어쓰지 않았습니다: ${kept.join(', ')}`, 'message error'));
}

// ---------------------------------------------------------------- wiring

// The uni profile is always UI-only and is viewed inside the uni project.
const VIEWER_LABEL = {
  element: '화면 보기용 Vite 프로젝트 함께 생성 (출력 폴더에서 바로 실행해 화면별로 확인)',
  uni: 'uni 스타일 미리보기 함께 생성 (uni frontend의 공통 컴포넌트·스타일로 변환 화면을 띄워 확인, 설치 불필요)',
};
function onOptionChange() {
  const uni = $('profile').value === 'uni';
  $('ui-only').disabled = uni;
  $('profile-note').hidden = !uni;
  $('viewer-label').textContent = VIEWER_LABEL[uni ? 'uni' : 'element'];
  $('uni-frontend-row').hidden = !uni;
  $('ai-note').hidden = !uni;
  if (state.sources.length) renderPreview();
}

if (!canPickFolder) {
  $('btn-pick-input-alt').hidden = true;
  $('support-note').hidden = false;
  $('support-note').textContent = '이 브라우저는 폴더에 직접 저장할 수 없어 결과를 ZIP으로 내려받습니다. 폴더에 바로 저장하려면 Chrome이나 Edge에서 여세요.';
}
$('btn-pick-input').addEventListener('click', pickInput);
// Fallback that works in every browser: the files are read, but the folder
// itself is unknown, so results can only be downloaded as a ZIP.
$('btn-pick-input-alt').addEventListener('click', () => $('input-files').click());
$('input-files').addEventListener('change', (e) => {
  const list = e.target.files;
  if (!list.length) return;
  const rootName = list[0].webkitRelativePath.split('/')[0];
  loadInput(rootName, null, () => scanFileList(list));
});
$('profile').addEventListener('change', onOptionChange);
$('ui-only').addEventListener('change', onOptionChange);
$('btn-run').addEventListener('click', run);
$('btn-cancel').addEventListener('click', () => {
  state.cancelled = true;
});
$('btn-save-folder').addEventListener('click', saveToFolder);
$('btn-save-zip').addEventListener('click', saveZip);
$('detail-output').addEventListener('change', (e) => {
  const o = detailOutputs[Number(e.target.value)];
  $('detail-result').textContent = o ? o.content : '';
});

// Hook for automated checks: convert in-memory files without the pickers.
window.nexa2vue = {
  loadFiles: (name, files) => loadInput(name, null, async () => {
    const sources = [];
    const skipped = [];
    for (const f of files) {
      const kind = SOURCE_EXT[extOf(f.rel)];
      if (kind) addSource(sources, skipped, { rel: f.rel, kind, size: f.bytes.length, getBytes: async () => f.bytes });
    }
    return { sources, skipped, config: {} };
  }),
  run,
  state,
};
