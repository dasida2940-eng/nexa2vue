'use strict';

// All file names and contents come from local sources and are rendered with
// textContent only, never innerHTML.
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { ok: '완료', partial: '확인 필요', error: '실패' };

let jobId = null;
let pollTimer = null;
let pollFailures = 0;
const POLL_MAX_FAILURES = 20; // 3 s apart: about a minute
let detailOutputs = [];
// Output name per screen edited in the preview list (rel -> name); sent with the job.
const screenNames = new Map();
// Role per screen changed in the review list (rel -> { role, parent }); sent
// with the job over what the server guessed (screen-roles.js).
const screenRoles = new Map();
let rolesFor = null; // input folder the role edits belong to
let nameTable = null;

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

// "화면 검토" needs both folders filled in (the output is never guessed);
// "변환 실행" needs a 화면 검토 for exactly those folders, confirmed with its checkbox.
let running = false;
let namedFor = null;
const foldersKey = () => `${$('input-dir').value.trim()}|${$('output-dir').value.trim()}`;
function updateReady() {
  const ready = !!$('input-dir').value.trim() && !!$('output-dir').value.trim();
  const named = ready && namedFor === foldersKey();
  // Popups and sub-screens change the files made, so the review is confirmed first.
  const reviewed = named && !!$('roles-ok') && $('roles-ok').checked;
  $('btn-preview').disabled = !ready;
  $('btn-run').disabled = !reviewed || running;
  // A retry reuses the previous run's roles and names: no review needed.
  $('btn-retry').disabled = !ready || running;
  $('folders-hint').hidden = ready;
  $('name-hint').hidden = !ready || reviewed;
}

// "선택" for the input folder: the native dialog; the server checks it holds .xfdl screens.
async function pickInput() {
  const button = $('btn-pick-input');
  button.disabled = true;
  setMessage('폴더 선택 창에서 입력 폴더를 고르세요… (창이 안 보이면 작업 표시줄을 확인하세요)');
  try {
    const data = await api('POST', '/api/input/pick', { initial: $('input-dir').value.trim() });
    if (data.cancelled) {
      setMessage('선택이 취소되었습니다.');
      return;
    }
    $('input-dir').value = data.path;
    $('preview').replaceChildren();
    setMessage(`입력 폴더: ${data.path}`);
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    button.disabled = false;
    updateReady();
  }
}

// "선택" for the output folder: any location on this PC, chosen in the native dialog.
async function pickOutput() {
  const button = $('btn-pick-output');
  button.disabled = true;
  setMessage('폴더 선택 창에서 출력 폴더를 고르세요… (창이 안 보이면 작업 표시줄을 확인하세요)');
  try {
    const data = await api('POST', '/api/output/pick', { initial: $('output-dir').value.trim() });
    if (data.cancelled) {
      setMessage('선택이 취소되었습니다.');
      return;
    }
    $('output-dir').value = data.path;
    setMessage(`출력 폴더: ${data.path}`);
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    button.disabled = false;
    updateReady();
  }
}

// "선택" for the frontend / backend / skill folders: the native dialog, any folder.
const PICK_LABEL = { frontend: 'frontend 경로', backend: 'backend 경로', skill: '변환 규칙 스킬 폴더' };
async function pickPath(purpose, inputId, buttonId, onPicked) {
  const button = $(buttonId);
  const show = purpose === 'skill'
    ? (text, isError = false) => setMessage(text, isError, 'ai-skill-message')
    : (text) => { $('structure-status').textContent = text; };
  button.disabled = true;
  show(`폴더 선택 창에서 ${PICK_LABEL[purpose]}를 고르세요… (창이 안 보이면 작업 표시줄을 확인하세요)`);
  try {
    const data = await api('POST', '/api/folder/pick', { purpose, initial: $(inputId).value.trim() });
    if (data.cancelled) {
      show('선택이 취소되었습니다.');
      return;
    }
    $(inputId).value = data.path;
    onPicked();
  } catch (err) {
    show(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// "구조 파악": the server reads the uni frontend/backend only when this button
// is pressed and saves the result as the default. The button stays off while
// the folders on screen are the analyzed ones, and turns on when they change.
let structure = null;
const samePath = (a, b) => String(a || '').trim().replace(/[\\/]+$/, '').toLowerCase() === String(b || '').trim().replace(/[\\/]+$/, '').toLowerCase();

function structureFresh() {
  return !!structure && samePath(structure.frontend.root, $('uni-frontend').value)
    && samePath(structure.backend ? structure.backend.root : '', $('uni-backend').value);
}

function renderStructure() {
  const fresh = structureFresh();
  // Claude first: 구조 파악 opens once Claude is connected, and everything
  // below the setup card only after that and a fresh 구조 파악.
  $('structure-box').disabled = !aiReady;
  $('btn-analyze').disabled = fresh || !aiReady;
  $('workspace').disabled = !fresh || !aiReady;
  const list = $('structure-summary');
  list.replaceChildren();
  if (!structure) {
    $('structure-status').textContent = 'frontend·backend 경로를 확인하고 구조 파악을 누르세요.';
    return;
  }
  if (!fresh) {
    $('structure-status').textContent = '경로가 바뀌었습니다. 구조 파악을 다시 누르세요.';
    return;
  }
  const f = structure.frontend;
  const b = structure.backend;
  $('structure-status').textContent = `구조 파악 완료 (${new Date(structure.analyzedAt).toLocaleString()})`;
  list.append(el('li', `프론트: API ${f.apiBase || '(baseURL 없음)'} · 스킬을 만들 화면 ${(f.screens || []).length}개${f.referenceScreens.length ? ` (기준 화면 ${f.referenceScreens.join(', ')})` : ''}${f.kind === 'vue' ? ' · uni가 아닌 프로젝트: 규칙 스킬(vue-convert) 방식으로 AI가 변환, 미리보기는 이 프로젝트의 패키지로 띄움 (백엔드는 아직 안 만듦)' : ''}`));
  list.append(el('li', b
    ? `백엔드: 패키지 ${b.basePackage} · 규칙 문서 ${b.docs.length}개 · 기준 화면 ${b.referenceScreens.join(', ') || '없음'} → 화면마다 출력 폴더의 backend 아래에 생성`
    : '백엔드: 경로가 비어 있어 만들지 않음'));
}

async function analyzeStructure() {
  $('btn-analyze').disabled = true;
  $('structure-status').textContent = '구조 파악 중…';
  try {
    // skill: the server also starts making the conversion-rules skill
    const data = await api('POST', '/api/uni/analyze', { uniFrontend: $('uni-frontend').value.trim(), uniBackend: $('uni-backend').value.trim(), skill: true });
    structure = data.structure;
    // Saved as the default: the analyzed folders, as resolved by the server.
    $('uni-frontend').value = structure.frontend.root;
    $('uni-backend').value = structure.backend ? structure.backend.root : '';
    renderStructure();
    skillLogShown = 0;
    $('skill-log').value = '';
    renderSkill(data.skill, data.skillError);
  } catch (err) {
    renderStructure();
    $('structure-status').textContent = err.message;
  }
}

async function loadStructure() {
  try {
    const data = await api('GET', '/api/uni/structure');
    structure = data.structure;
  } catch {
    structure = null;
  }
  refreshSkill();
  // Defaults: the last analyzed folders, else the usual uni locations.
  $('uni-frontend').value = structure ? structure.frontend.root : 'C:\\uni_averedu\\frontend';
  $('uni-backend').value = structure ? (structure.backend ? structure.backend.root : '') : 'C:\\uni_averedu\\backend';
  renderStructure();
}

async function init() {
  loadStructure();
  refreshAi();
  try {
    const { input } = await api('GET', '/api/config');
    if (input) $('input-dir').value = input;
  } catch (err) {
    setMessage(err.message, true);
  }
  updateReady();
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function formBody() {
  return {
    input: $('input-dir').value.trim(),
    output: $('output-dir').value.trim(),
    dryRun: false,
    uiOnly: true,
    viewer: $('viewer').checked,
    shotDocs: $('viewer').checked && $('shot-docs').checked,
    // Always the uni structure analyzed above, always with the AI pass.
    profile: 'uni',
    uniFrontend: $('uni-frontend').value.trim(),
    uniBackend: $('uni-backend').value.trim(),
    renames: Object.fromEntries(screenNames),
    roles: Object.fromEntries(screenRoles),
    ai: true,
    aiSkills: selectedSkills(),
    aiParallel: Number($('ai-parallel').value) || 3,
    aiTimeout: Number($('ai-timeout').value) || 20,
    aiFix: $('ai-fix').checked,
  };
}

// Conversion-rules skills: one skill folder, or a folder of skills such as
// .claude\skills listed with checkboxes. Only the ticked ones go with the
// job, in list order (an earlier skill wins where two disagree).
let skillsFor = null; // folder the checkbox list was loaded for
// The default skill folder (~/.nexa2vue/skills): the made skill and the user's own.
let skillsRoot = null;
let staleSkillDir = null; // a made skill from other frontend/backend folders: listed, not checked
let savedSkillDir = null;
const normPathUi = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const samePathUi = (a, b) => !!a && !!b && normPathUi(a) === normPathUi(b);
// Conversion-rules skill made after 구조 파악: progress while Claude makes it,
// then the saved SKILL.md, which goes into the skill folder field below.
let skillLogShown = 0;
let skillPoll = null;

function renderSkill(s, error) {
  if (!s) return;
  $('skill-box').hidden = !structure;
  const running = s.state === 'running';
  $('btn-skill-make').hidden = running;
  $('btn-skill-make').textContent = s.saved ? '다시 만들기' : '만들기';
  $('btn-skill-cancel').hidden = !running;
  if (s.log && s.log.length) {
    const box = $('skill-log');
    box.hidden = false;
    box.value += `${s.log.join('\n')}\n`;
    box.scrollTop = box.scrollHeight;
    skillLogShown = s.logTotal;
  }
  const saved = s.saved
    ? `${s.saved.file} (${Math.round(s.saved.chars / 1000)}천 자${s.saved.generatedAt ? ` · ${new Date(s.saved.generatedAt).toLocaleString()}` : ''})${s.saved.stale ? ' — 지금의 frontend·backend와 다른 폴더로 만든 스킬이라 쓰지 않습니다. 다시 만들기를 누르세요' : s.saved.outdated ? ' — 이전 버전 nexa2vue로 만든 스킬입니다(API 주소·보내는 값·받는 값 정리 등이 빠져 있음). 지금도 쓰지만 다시 만들기를 권장합니다' : ''}`
    : '';
  if (running) $('skill-status').textContent = 'Claude가 만드는 중…';
  else if (error || s.state === 'failed') $('skill-status').textContent = `만들지 못했습니다: ${error || s.error}${saved ? ` · 이전 스킬 사용: ${saved}` : ''}`;
  else if (s.state === 'cancelled') $('skill-status').textContent = `중지했습니다${saved ? ` · 이전 스킬 사용: ${saved}` : ''}`;
  else $('skill-status').textContent = saved || '아직 없습니다. 만들기를 누르세요.';
  if (running) {
    if (!skillPoll) skillPoll = setInterval(refreshSkill, 2000);
  } else {
    if (skillPoll) clearInterval(skillPoll);
    skillPoll = null;
    skillsRoot = s.skillsRoot || null;
    staleSkillDir = s.saved && s.saved.stale ? s.saved.dir : null;
    savedSkillDir = s.saved ? s.saved.dir : null;
    if (s.skillsRootReady) useSavedSkill(s.skillsRoot);
  }
}

// Put the default skill folder in the field, unless another folder was chosen
// (the made skill's own folder, filled in by older versions, counts as not chosen).
function useSavedSkill(dir) {
  const field = $('ai-skill');
  if (field.value.trim() && field.value.trim() !== dir && !samePathUi(field.value.trim(), savedSkillDir)) return;
  if (field.value.trim() === dir && skillsFor === dir) return;
  field.value = dir;
  loadSkillList();
}

async function refreshSkill() {
  try {
    renderSkill(await api('GET', `/api/uni/skill?logFrom=${skillLogShown}`));
  } catch (err) {
    $('skill-status').textContent = err.message;
  }
}

async function makeSkill() {
  $('btn-skill-make').disabled = true;
  try {
    skillLogShown = 0;
    $('skill-log').value = '';
    renderSkill(await api('POST', '/api/uni/skill', {}));
  } catch (err) {
    $('skill-status').textContent = err.message;
  } finally {
    $('btn-skill-make').disabled = false;
  }
}

async function cancelSkill() {
  try {
    await api('POST', '/api/uni/skill/cancel', {});
  } catch (err) {
    $('skill-status').textContent = err.message;
  }
}

function selectedSkills() {
  return [...$('ai-skill-list').querySelectorAll('input:checked')].map((i) => i.value);
}

function clearSkillList() {
  skillsFor = null;
  $('ai-skill-list').replaceChildren();
  $('ai-skill-list').hidden = true;
  setMessage('', false, 'ai-skill-message');
}

async function loadSkillList() {
  const folder = $('ai-skill').value.trim();
  clearSkillList();
  if (!folder) return;
  try {
    const data = await api('POST', '/api/ai/skills', { folder });
    const box = $('ai-skill-list');
    for (const s of data.skills) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = s.dir;
      // a folder that is itself one skill: that skill; a folder of skills: the user picks
      // the default folder: every skill in it, except a made skill gone stale
      check.checked = data.single || (samePathUi(folder, skillsRoot) && !samePathUi(s.dir, staleSkillDir));
      const text = el('span');
      text.append(el('strong', s.name));
      if (s.description) text.append(el('div', s.description, 'skill-desc'));
      const label = el('label', undefined, 'inline');
      label.title = s.dir;
      label.append(check, text);
      box.append(label);
    }
    box.hidden = false;
    skillsFor = folder;
    setMessage(data.single
      ? '스킬 1개를 적용합니다.'
      : samePathUi(folder, skillsRoot)
        ? `기본 스킬 폴더입니다. 스킬 ${data.skills.length}개를 적용합니다(빼려면 체크 해제). 이 폴더에 스킬 폴더를 넣으면 다음부터 함께 적용되고, 직접 넣은 스킬이 구조 파악이 만든 요약 스킬보다 우선합니다.`
      : `스킬 ${data.skills.length}개를 찾았습니다. 적용할 스킬을 고르세요(여러 개면 위에 있는 스킬이 우선).`, false, 'ai-skill-message');
  } catch (err) {
    setMessage(err.message, true, 'ai-skill-message');
  }
}

async function doPreview() {
  if ($('btn-preview').disabled) return;
  setMessage('');
  $('preview').replaceChildren();
  namedFor = null;
  updateReady();
  const key = foldersKey();
  // Role edits are for one input folder's screens.
  if (rolesFor !== $('input-dir').value.trim()) {
    screenRoles.clear();
    rolesFor = $('input-dir').value.trim();
  }
  try {
    const data = await api('POST', '/api/preview', formBody());
    // Conversion opens up only for the folders this list was made for.
    namedFor = key;
    const box = $('preview');
    const libNote = ' (공통 스크립트는 변환하지 않음)';
    box.append(el('p', `화면(.xfdl) ${data.forms.length}개, 공통 스크립트(.xjs) ${data.libs.length}개${libNote}, 제외 ${data.skipped.length}개`));
    const count = (role) => Object.values(data.roles || {}).filter((r) => r.role === role).length;
    box.append(el('p', `화면 검토: 화면 ${count('screen')}개 · 하위 화면 ${count('sub')}개 · 팝업 ${count('popup')}개. 하위 화면은 부모 화면 폴더에 컴포넌트로 들어가 부모의 Service·Constant를 같이 쓰고, 팝업은 {부모ID+1}_POP 폴더로 만들어 부모에서 popup.open으로 엽니다. 종류·부모가 틀리면 고치세요.`, 'hint'));
    nameTable = nexaNameTable.create(data.forms, data.names, screenNames, () => 'uni', {
      roles: data.roles,
      // A changed role changes default names and paths: ask the server again.
      onRoleChange: (rel, r) => {
        // Back to 팝업/하위 화면 with no parent picked: the one found in the sources.
        const found = data.detected && data.detected[rel];
        const parent = r.role !== 'screen' && !r.parent && found ? found.parent : r.parent;
        screenRoles.set(rel, { ...r, parent, via: found && found.parent === parent ? found.via : null });
        doPreview();
      },
    });
    box.append(nameTable.table);
    const ok = el('label', undefined, 'inline');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = 'roles-ok';
    check.addEventListener('change', updateReady);
    ok.append(check, ' 화면 종류(화면·하위 화면·팝업)와 부모 화면을 확인했습니다');
    box.append(ok);
    updateReady();
    if (data.libs.length || data.skipped.length) {
      const list = el('div', undefined, 'preview-list');
      for (const f of data.libs) list.append(el('div', f));
      for (const s of data.skipped) list.append(el('div', `제외: ${s.rel} (${s.reason})`));
      box.append(list);
    }
  } catch (err) {
    setMessage(err.message, true);
  }
}

// retry: only the screens whose AI pass failed in the output folder's last run.
async function doRun(retry = false) {
  if ($(retry ? 'btn-retry' : 'btn-run').disabled) return;
  setMessage('');
  if (!structureFresh()) {
    setMessage('frontend·backend 구조를 먼저 파악하세요 (구조 파악 버튼).', true);
    return;
  }
  if (!retry && nameTable && nameTable.hasErrors()) {
    setMessage('출력 이름에 오류가 있습니다. 화면 검토 목록의 빨간 칸을 고치세요.', true);
    return;
  }
  if (!aiReady) {
    setMessage('Claude가 연결되어 있지 않습니다. 0. 준비에서 Claude 계정을 연결하세요.', true);
    return;
  }
  const skillFolder = $('ai-skill').value.trim();
  if (skillFolder && skillsFor !== skillFolder) {
    await loadSkillList();
    setMessage('스킬 목록을 불러왔습니다. 적용할 스킬을 확인한 뒤 변환 실행을 다시 누르세요.', true);
    return;
  }
  if (skillFolder && !selectedSkills().length) {
    setMessage('적용할 스킬을 하나 이상 고르세요. 기본 규칙만 쓰려면 스킬 폴더 칸을 비우세요.', true);
    return;
  }
  try {
    const job = await api('POST', '/api/jobs', retry ? { ...formBody(), retryFailed: true } : formBody());
    jobId = job.id;
    logShown = 0;
    $('log').value = '';
    running = true;
    $('progress-card').hidden = false;
    $('detail-card').hidden = true;
    $('btn-run').disabled = true;
    $('btn-retry').disabled = true;
    $('btn-cancel').disabled = false;
    renderJob(job);
    poll();
  } catch (err) {
    setMessage(err.message, true);
  }
}

async function doCancel() {
  if (!jobId) return;
  try {
    await api('POST', `/api/jobs/${jobId}/cancel`, {});
  } catch (err) {
    setMessage(err.message, true);
  }
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const job = await api('GET', `/api/jobs/${jobId}?logFrom=${logShown}`);
    renderJob(job);
    if (pollFailures) {
      pollFailures = 0;
      setMessage('');
    }
    if (job.state === 'running') {
      pollTimer = setTimeout(poll, 500);
      return;
    }
    running = false;
    updateReady();
    $('btn-cancel').disabled = true;
    const done = { done: '변환이 끝났습니다.', cancelled: '취소되었습니다.', error: `오류: ${job.error}` }[job.state];
    setMessage(job.dryRun && job.state === 'done' ? `${done} (드라이런: 파일을 쓰지 않음)` : done, job.state === 'error');
  } catch (err) {
    // A missed answer (PC busy, waking from sleep) is not the end of the job:
    // it keeps running on the server, so ask again. Give up only when the
    // server says the job is gone or stays unreachable for about a minute.
    pollFailures += 1;
    if (err.status !== 404 && pollFailures < POLL_MAX_FAILURES) {
      setMessage(`진행 상황을 받지 못해 다시 확인하는 중입니다(${pollFailures}회). 변환은 계속 돌고 있습니다.`, true);
      pollTimer = setTimeout(poll, 3000);
      return;
    }
    pollFailures = 0;
    setMessage(err.status === 404
      ? '서버에 이 작업이 없습니다(서버를 다시 시작했을 수 있음). 출력 폴더의 결과를 확인하세요.'
      : `서버와 연결이 끊겼습니다: ${err.message} · 서버가 켜져 있는지 확인하세요. 변환은 서버에서 계속 돌았을 수 있습니다.`, true);
    running = false;
    updateReady();
    $('btn-cancel').disabled = true;
  }
}

// CLI-like progress log: only lines not shown yet arrive; stay at the bottom
// unless the user scrolled up to read.
let logShown = 0;
function appendLog(job) {
  if (!job.log || job.logFrom !== logShown || !job.log.length) return;
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.value += `${box.value ? '\n' : ''}${job.log.join('\n')}`;
  logShown = job.logTotal;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderJob(job) {
  appendLog(job);
  renderUsage($('job-usage'), job.usage);
  $('progress').max = Math.max(job.total, 1);
  $('progress').value = job.done;
  const s = job.summary;
  const sd = job.shotDocsResult;
  const shotText = !sd ? '' : sd.error ? ` · 화면 설명 문서 실패: ${sd.error}`
    : ` · 화면 설명 문서 ${sd.done.length}개${sd.failed.length ? `(문제 ${sd.failed.length}개 — 로그 참고)` : ''}`;
  $('summary').textContent = s
    ? `전체 ${s.total} · 완료 ${s.ok} · 확인 필요 ${s.partial} · 실패 ${s.error} · TODO ${s.todos}건${shotText} — 출력: ${job.output}`
    : job.shotDocs && job.total && job.done >= job.total
      ? '변환 끝 — 화면 설명 문서 만드는 중(캡처 → Claude 설명, 화면당 1~3분)…'
      : `${job.done} / ${job.total} 처리 중…${activeText(job.active)}`;

  const gfn = $('missing-gfn');
  gfn.replaceChildren();
  if (job.missingGfn && job.missingGfn.length) {
    gfn.append(el('p', `구현이 필요한 공통 함수 (src/utils/nexa-gfn.js 스텁): ${job.missingGfn.join(', ')}`));
  }

  renderViewerGuide(job);

  const rows = $('file-rows');
  rows.replaceChildren();
  for (const f of job.files || []) {
    const tr = el('tr');
    const status = el('td');
    status.append(el('span', STATUS_LABEL[f.status] || f.status, `badge ${f.status}`));
    const name = el('td');
    const open = el('button', f.input, 'link');
    open.type = 'button';
    open.addEventListener('click', () => {
      rows.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      showDetail(f.index);
    });
    name.append(open);
    tr.append(status, name, el('td', `${f.todoCount}${f.ai ? (f.ai.ok ? (f.ai.fix ? ' · AI(검사 후 고침)' : ' · AI') : f.ai.checks && f.ai.checks.length ? ' · AI 검사 실패' : ' · AI 실패') : ''}`));
    rows.append(tr);
  }
}

// Screens in progress; with the AI pass several run at once.
function activeText(active) {
  if (!active || !active.length) return '';
  const ai = active.filter((a) => a.stage === 'ai').map((a) => a.rel);
  const rules = active.filter((a) => a.stage !== 'ai').map((a) => a.rel);
  return [ai.length ? ` AI 변환 중(${ai.length}개, 화면당 몇 분): ${ai.join(', ')}` : '', rules.length ? ` ${rules.join(', ')}` : ''].join('');
}

// How to run the generated screen viewer, shown once the conversion is done.
function renderViewerGuide(job) {
  const box = $('viewer-guide');
  box.replaceChildren();
  box.hidden = !(job.viewer && !job.dryRun && job.state === 'done');
  if (box.hidden) return;
  const kind = job.viewer.kind;
  box.append(el('h3', '화면 보기 실행 방법'));
  if (kind === 'uni') {
    box.append(el('p', `저장한 폴더의 view-screens.cmd를 더블클릭하세요. frontend(${job.uniFrontend || '기본 경로'})에 설치된 패키지를 그대로 쓰므로 npm install은 하지 않습니다.`));
    box.append(el('pre', `cd /d "${job.output}"\nnode preview\\start.mjs`));
    box.append(el('p', '브라우저에서 http://127.0.0.1:5174 이 열리면 왼쪽 목록에서 화면을 고르세요. 조회하면 Constant 정의로 만든 샘플 데이터가 나옵니다. frontend 경로는 uni-preview.config.json에서 바꿀 수 있습니다.'));
  } else {
    box.append(el('p', '저장한 폴더의 view-screens.cmd를 더블클릭하거나, 명령 프롬프트에서 아래를 실행하세요. 처음 한 번은 npm install로 패키지를 내려받습니다.'));
    box.append(el('pre', `cd /d "${job.output}"\nnpm install\nnpm run dev`));
    box.append(el('p', '브라우저에서 http://127.0.0.1:5173 이 열리면 왼쪽 목록에서 화면을 고르세요.'));
  }
  if (job.viewer.kept.length) {
    box.append(el('p', `이미 있던 파일은 덮어쓰지 않았습니다: ${job.viewer.kept.join(', ')}`, 'message error'));
  }
}

async function showDetail(index) {
  try {
    const d = await api('GET', `/api/jobs/${jobId}/files/${index}`);
    $('detail-card').hidden = false;
    $('detail-name').textContent = d.input;
    $('detail-source').textContent = d.source;
    const todos = $('detail-todos');
    todos.replaceChildren();
    if (d.error) todos.append(el('li', d.error));
    for (const t of d.todos) todos.append(el('li', t.line ? `${t.message} (원본 스크립트 ${t.line}행)` : t.message));

    detailOutputs = d.outputs;
    const select = $('detail-output');
    select.replaceChildren();
    d.outputs.forEach((o, i) => {
      const opt = el('option', o.path);
      opt.value = String(i);
      select.append(opt);
    });
    $('detail-result').textContent = d.outputs.length ? d.outputs[0].content : '(출력 없음)';
    $('detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setMessage(err.message, true);
  }
}

$('detail-output').addEventListener('change', (e) => {
  const o = detailOutputs[Number(e.target.value)];
  $('detail-result').textContent = o ? o.content : '';
});
// AI conversion needs Claude Code installed and signed in on this PC.
// Sign-in happens on the web: the server runs `claude auth login`, which opens the browser.
let aiReady = false;
const AUTH_LABEL = { 'claude.ai': 'Claude 구독', console_api_key: 'Anthropic Console', oauth_token: 'OAuth 토큰', api_key: 'API 키' };
let loginPoll = null;
async function refreshAi() {
  $('ai-status').textContent = 'Claude Code 확인 중…';
  try {
    const s = await api('GET', '/api/ai/status');
    aiReady = s.available && s.loggedIn;
    if (!s.available) $('ai-status').textContent = 'Claude Code(claude 명령)를 찾을 수 없습니다. 설치한 뒤 연결 확인을 누르세요.';
    else if (!s.loggedIn) $('ai-status').textContent = `Claude Code ${s.version} · 로그인되어 있지 않습니다. 연결 방식을 고르고 계정 연결을 누르세요.`;
    else $('ai-status').textContent = `연결됨: ${s.email || 'Claude 계정'} (${AUTH_LABEL[s.authMethod] || s.authMethod || '방식 모름'}${s.plan ? ` ${s.plan}` : ''}) · Claude Code ${s.version}${s.configDir ? ` · 설정 폴더 ${s.configDir}` : ''}`;
    renderAccounts(s);
    $('btn-ai-login').hidden = !s.available || s.loggedIn;
    $('btn-ai-switch').hidden = !s.available || !s.loggedIn;
    if (aiReady) stopLoginPoll();
    renderUsage($('ai-usage'), s.usage);
    renderStructure();
    return s;
  } catch (err) {
    aiReady = false;
    $('ai-status').textContent = err.message;
    renderAccounts(null);
    renderStructure();
    return null;
  }
}
// Already signed in to Claude Code on this PC (in any config folder such as
// ~/.claude-work) counts as connected; with several accounts, pick one here.
function renderAccounts(s) {
  const accounts = (s && s.accounts) || [];
  $('ai-account-row').hidden = accounts.length < 2;
  $('ai-account').replaceChildren(...accounts.map((a) => {
    const o = el('option', `${a.email || 'Claude 계정'} (${AUTH_LABEL[a.authMethod] || a.authMethod || '방식 모름'}${a.plan ? ` ${a.plan}` : ''}) · ${a.configDir}`);
    o.value = a.configDir;
    o.selected = a.configDir === s.configDir;
    return o;
  }));
}
async function aiSelectAccount() {
  $('ai-account').disabled = true;
  try {
    await api('POST', '/api/ai/account', { configDir: $('ai-account').value });
  } catch (err) {
    $('ai-login-hint').hidden = false;
    $('ai-login-hint').textContent = err.message;
  } finally {
    $('ai-account').disabled = false;
    await refreshAi();
  }
}
function stopLoginPoll() {
  if (loginPoll) clearInterval(loginPoll);
  loginPoll = null;
  if (aiReady) $('ai-login-hint').hidden = true;
}
async function aiLogin() {
  $('btn-ai-login').disabled = true;
  try {
    const r = await api('POST', '/api/ai/login', { method: $('ai-method').value });
    if (!r.started) throw new Error(r.error || '로그인을 시작하지 못했습니다');
    const hint = $('ai-login-hint');
    hint.hidden = false;
    hint.textContent = '브라우저에서 Claude 로그인을 마치면 자동으로 연결됩니다. ';
    if (r.url) {
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '브라우저가 열리지 않았으면 여기를 눌러 로그인';
      hint.append(a);
    }
    stopLoginPoll();
    const until = Date.now() + 10 * 60 * 1000;
    loginPoll = setInterval(async () => {
      const s = await refreshAi();
      if ((s && s.loggedIn) || Date.now() > until || (s && s.login && !s.login.running && !s.loggedIn)) stopLoginPoll();
    }, 3000);
  } catch (err) {
    $('ai-login-hint').hidden = false;
    $('ai-login-hint').textContent = err.message;
  } finally {
    $('btn-ai-login').disabled = false;
  }
}
// Change the connected account or method: sign out of Claude Code, then sign in on the web again.
async function aiSwitch() {
  if (!confirm('이 PC의 Claude Code 로그인을 해제하고 다시 연결합니다. 계속할까요?')) return;
  $('btn-ai-switch').disabled = true;
  try {
    await api('POST', '/api/ai/logout', {});
    await refreshAi();
    await aiLogin();
  } catch (err) {
    $('ai-login-hint').hidden = false;
    $('ai-login-hint').textContent = err.message;
  } finally {
    $('btn-ai-switch').disabled = false;
  }
}
// Claude usage limits as last reported during an AI call (5-hour and 7-day windows).
function renderUsage(box, usage) {
  box.replaceChildren();
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const [label, w] of [['5시간 한도', usage.fiveHour], ['7일 한도', usage.sevenDay]]) {
    if (!w) continue;
    const used = Math.round(w.utilization * 100);
    const row = el('div', undefined, 'usage-row');
    const bar = el('div', undefined, 'usage-bar');
    const fill = el('div', undefined, used >= 90 ? 'usage-fill high' : used >= 70 ? 'usage-fill mid' : 'usage-fill');
    fill.style.width = `${Math.min(100, used)}%`;
    bar.append(fill);
    const reset = w.resetsAt ? ` · ${new Date(w.resetsAt * 1000).toLocaleString()} 초기화` : '';
    row.append(el('span', label, 'usage-label'), bar, el('span', `${used}% 사용 · ${Math.max(0, 100 - used)}% 남음${reset}`));
    box.append(row);
  }
  box.append(el('div', `기준: 마지막 AI 호출 ${new Date(usage.at).toLocaleTimeString()}`, 'hint'));
}
$('btn-ai-login').addEventListener('click', aiLogin);
$('btn-ai-switch').addEventListener('click', aiSwitch);
$('btn-ai-check').addEventListener('click', refreshAi);
$('ai-account').addEventListener('change', aiSelectAccount);
$('btn-preview').addEventListener('click', doPreview);
// 화면 설명 문서는 미리보기로 캡처하므로 미리보기 생성을 끄면 함께 끈다
function syncShotDocs() {
  const box = $('shot-docs');
  box.disabled = !$('viewer').checked;
  if (box.disabled) box.checked = false;
}
$('viewer').addEventListener('change', syncShotDocs);
syncShotDocs();
// 화면 설명 문서는 미리보기로 캡처하므로 미리보기 생성을 끄면 함께 끈다
function syncShotDocs() {
  const box = $('shot-docs');
  box.disabled = !$('viewer').checked;
  if (box.disabled) box.checked = false;
}
$('viewer').addEventListener('change', syncShotDocs);
syncShotDocs();
$('btn-run').addEventListener('click', () => doRun(false));
$('btn-retry').addEventListener('click', () => doRun(true));
$('btn-cancel').addEventListener('click', doCancel);
$('input-dir').addEventListener('input', updateReady);
$('output-dir').addEventListener('input', updateReady);
$('btn-pick-input').addEventListener('click', pickInput);
$('btn-analyze').addEventListener('click', analyzeStructure);
$('btn-skill-make').addEventListener('click', makeSkill);
$('btn-skill-cancel').addEventListener('click', cancelSkill);
$('uni-frontend').addEventListener('input', renderStructure);
$('uni-backend').addEventListener('input', renderStructure);
$('btn-pick-output').addEventListener('click', pickOutput);
$('btn-pick-frontend').addEventListener('click', () => pickPath('frontend', 'uni-frontend', 'btn-pick-frontend', renderStructure));
$('btn-pick-backend').addEventListener('click', () => pickPath('backend', 'uni-backend', 'btn-pick-backend', renderStructure));
$('btn-clear-backend').addEventListener('click', () => {
  $('uni-backend').value = '';
  renderStructure();
});
$('btn-pick-skill').addEventListener('click', () => pickPath('skill', 'ai-skill', 'btn-pick-skill', loadSkillList));
$('btn-ai-skills').addEventListener('click', loadSkillList);
$('ai-skill').addEventListener('input', clearSkillList);
$('ai-skill').addEventListener('change', loadSkillList);

init();
