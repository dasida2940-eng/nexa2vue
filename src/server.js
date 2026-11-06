'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { runConversion, preview, loadPreviousReport, PROFILES } = require('./job-runner');
const { retryUnits, NOTHING_TO_RETRY_MESSAGE } = require('./convert-core');
const { analyzeUni, loadStructure, saveStructure, samePath, DEFAULT_FILE: STRUCTURE_FILE } = require('./uni-structure');
const { resolveNames } = require('./names');
const { generateUniSkill, DEFAULT_DIR: SKILL_DIR, SKILL_GENERATOR_VERSION, skillGeneratorVersion } = require('./uni-skill');
const { claudeStatus, selectClaudeAccount, startClaudeLogin, logoutClaude, loginState, loadSkills, listSkills, usageState, usageLine, isSummarySkill, DEFAULT_TIMEOUT_MIN } = require('./ai-convert');
const { realResolve } = require('./paths');
const { hasFormSource, readSource } = require('./scanner');
const { pickFolder: defaultPickFolder } = require('./folder-picker');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/name-table.js': ['name-table.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 64 * 1024;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINES = 20000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

/** Blocks DNS rebinding (Host) and cross-site requests (Origin). */
function isTrustedRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = [...LOOPBACK].map((h) => `${h}:${port}`);
  if (!allowedHosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !allowedHosts.map((h) => `http://${h}`).includes(String(origin).toLowerCase())) return false;
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(Object.assign(new Error('Content-Type은 application/json이어야 합니다'), { status: 415 }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('요청이 너무 큽니다'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('잘못된 JSON입니다'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readTextLimited(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_VIEW_BYTES) return `(file too large to display: ${stat.size} bytes)`;
  return readSource(file).text;
}

/**
 * Validate an input folder: absolute, an existing folder, and containing at
 * least one Nexacro screen (.xfdl) somewhere below it. Returns the real path.
 */
function validateInputDir(p) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (typeof p !== 'string' || !p.trim()) throw fail('입력 폴더를 입력하세요');
  if (!path.isAbsolute(p.trim())) throw fail('입력 폴더는 절대 경로여야 합니다 (예: C:\\넥사프로젝트\\src)');
  const resolved = path.resolve(p.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw fail(`폴더를 찾을 수 없습니다: ${resolved}`);
  const real = realResolve(resolved);
  if (!hasFormSource(real)) throw fail(`이 폴더 아래에 넥사크로 화면(.xfdl)이 없습니다: ${real}`);
  return real;
}

function createApp({ input, port, pickFolder = defaultPickFolder, onShutdown, structureFile = STRUCTURE_FILE, skillDir = SKILL_DIR, makeSkill = generateUniSkill, skillClaudeStatus = claudeStatus }) {
  // --input presets the input folder shown in the web UI; preview and
  // conversion still need both folders filled in there.
  const presetInput = input ? validateInputDir(input) : null;
  const jobs = new Map();
  let picking = false;

  // Input: any folder with Nexacro screens below it.
  async function pickInput(initial) {
    if (picking) throw Object.assign(new Error('폴더 선택 창이 이미 열려 있습니다'), { status: 409 });
    picking = true;
    try {
      const selected = await pickFolder(typeof initial === 'string' && initial.trim() ? initial.trim() : presetInput, 'input');
      if (!selected) return { cancelled: true, path: null };
      return { cancelled: false, path: validateInputDir(selected) };
    } finally {
      picking = false;
    }
  }

  // Output may be any folder the user picks; overlap with the input is checked
  // when the conversion is previewed or started.
  async function pickOutput(initial) {
    if (picking) throw Object.assign(new Error('폴더 선택 창이 이미 열려 있습니다'), { status: 409 });
    picking = true;
    try {
      const selected = await pickFolder(typeof initial === 'string' && initial.trim() ? initial.trim() : null, 'output');
      return selected ? { cancelled: false, path: selected } : { cancelled: true, path: null };
    } finally {
      picking = false;
    }
  }

  // frontend / backend / skill folders: any folder; "구조 파악" and the skill
  // list check what is inside.
  async function pickPlain(purpose, initial) {
    if (!['frontend', 'backend', 'skill'].includes(purpose)) throw Object.assign(new Error(`알 수 없는 폴더 종류: ${purpose}`), { status: 400 });
    if (picking) throw Object.assign(new Error('폴더 선택 창이 이미 열려 있습니다'), { status: 409 });
    picking = true;
    try {
      const selected = await pickFolder(typeof initial === 'string' && initial.trim() ? initial.trim() : null, purpose);
      return selected ? { cancelled: false, path: selected } : { cancelled: true, path: null };
    } finally {
      picking = false;
    }
  }

  function isRunning() {
    return [...jobs.values()].some((j) => j.state === 'running');
  }

  // Conversion-rules skill made after 구조 파악 (uni-skill.js): Claude reads
  // the uni docs once, in the background; the page polls for progress.
  const skill = { state: 'idle', log: [], error: null, result: null, cancelled: false };

  // Busy with Claude Code: a conversion or the skill being made.
  function claudeBusy() {
    if (isRunning()) return '변환이';
    if (skill.state === 'running') return '규칙 스킬 생성이';
    return null;
  }

  // The skill already on disk (from an earlier 구조 파악), if any. stale: it was
  // made from other frontend/backend folders than the saved structure.
  function savedSkill() {
    const file = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const at = /^generated-at:\s*(.+)$/m.exec(head);
    const from = /^generated-from:\s*(.+)$/m.exec(head);
    const generatedFrom = from ? from[1].trim() : null;
    // outdated: made by an older nexa2vue (uni-skill.js SKILL_GENERATOR_VERSION).
    // Still used; the page suggests making it again.
    const version = skillGeneratorVersion(head);
    return { dir: skillDir, file, chars: fs.statSync(file).size, generatedAt: at ? at[1].trim() : null, generatedFrom, stale: skillStale(generatedFrom, loadStructure(structureFile)), version, outdated: version < SKILL_GENERATOR_VERSION };
  }

  // generated-from (uni-skill.js) is "frontend root, backend root".
  function skillStale(generatedFrom, structure) {
    if (!generatedFrom || !structure || !structure.frontend) return true;
    const [fe, be] = generatedFrom.split(', ');
    return !samePath(fe, structure.frontend.root) || !samePath(be || null, structure.backend ? structure.backend.root : null);
  }

  // The default skill folder: the made summary skill lives in it, and skills the
  // user adds go next to it, so the skill folder field points here.
  const skillsRoot = path.dirname(skillDir);
  function skillsRootReady() {
    try {
      return listSkills(skillsRoot).skills.length > 0;
    } catch {
      return false;
    }
  }

  function skillView(logFrom = 0) {
    return { state: skill.state, error: skill.error, result: skill.result, saved: savedSkill(), skillsRoot, skillsRootReady: skillsRootReady(), log: skill.log.slice(logFrom), logTotal: skill.log.length };
  }

  async function startSkill(structure) {
    if (skill.state === 'running') throw Object.assign(new Error('규칙 스킬을 이미 만들고 있습니다'), { status: 409 });
    if (!structure) throw Object.assign(new Error('구조 파악을 먼저 하세요'), { status: 409 });
    // Taken before the status check (it spawns claude and waits), so a second
    // request or a conversion in that gap sees it running; given back on failure.
    const before = { ...skill };
    Object.assign(skill, { state: 'running', log: [], error: null, result: null, cancelled: false });
    let s;
    try {
      s = await skillClaudeStatus();
    } catch (err) {
      Object.assign(skill, before);
      throw err;
    }
    if (!s.available || !s.loggedIn) {
      Object.assign(skill, before);
      throw Object.assign(new Error('Claude가 연결되어 있지 않아 규칙 스킬을 만들 수 없습니다'), { status: 409 });
    }
    const log = (line) => skill.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    log('규칙 스킬 생성 시작 — Claude가 구조 파악 때 넣은 frontend의 화면을 읽고 요약합니다(문서·uni 표준과 비교 안 함, 몇 분 걸림)');
    makeSkill({
      structure,
      dir: skillDir,
      isCancelled: () => skill.cancelled,
      onStep: log,
      onUsage: (u) => log(`Claude 사용량: ${usageLine(u)}`),
    }).then((result) => {
      Object.assign(skill, { state: 'done', result });
      log(`완료: ${result.file} (${Math.round(result.chars / 1000)}천 자${result.durationMs ? `, ${Math.round(result.durationMs / 1000)}초` : ''})`);
      for (const note of result.notes || []) log(`확인할 것: ${note}`);
    }).catch((err) => {
      Object.assign(skill, { state: skill.cancelled ? 'cancelled' : 'failed', error: err.message });
      log(skill.cancelled ? '취소되었습니다' : `실패: ${err.message}`);
    });
  }

  // logFrom: the page asks only for log lines it has not shown yet.
  function jobView(job, { withFiles = true, logFrom = 0 } = {}) {
    const from = Math.max(0, Math.min(Number(logFrom) || 0, job.log.length));
    return {
      log: job.log.slice(from),
      logFrom: from,
      logTotal: job.log.length,
      usage: usageState(),
      id: job.id,
      state: job.state,
      input: job.input,
      output: job.output,
      dryRun: job.dryRun,
      uiOnly: job.uiOnly,
      profile: job.profile,
      ai: job.ai,
      retryFailed: !!job.retryFailed,
      active: job.state === 'running' ? [...job.active].map(([rel, stage]) => ({ rel, stage })) : [],
      done: job.files.length,
      total: job.total,
      error: job.error,
      summary: job.report ? job.report.summary : null,
      missingGfn: job.report ? job.report.missingGfn : [],
      viewer: job.report ? job.report.viewer || null : null,
      shotDocs: job.shotDocs,
      shotDocsResult: job.report ? job.report.shotDocs || null : null,
      skipped: job.report ? job.report.skipped : [],
      files: withFiles
        ? job.files.map((f, index) => ({ index, input: f.input, kind: f.kind, status: f.status, todoCount: f.todos.length, error: f.error, ai: f.ai || null }))
        : undefined,
    };
  }

  function startJob(body) {
    if (isRunning()) throw Object.assign(new Error('이미 변환이 진행 중입니다'), { status: 409 });
    if (skill.state === 'running') throw Object.assign(new Error('규칙 스킬을 만드는 중입니다. 끝난 뒤에 변환하세요'), { status: 409 });
    const profile = body.profile || 'element';
    if (!PROFILES.includes(profile)) throw Object.assign(new Error(`알 수 없는 출력 형식입니다: ${profile}`), { status: 400 });
    // 화면 설명 문서는 출력 폴더의 미리보기로 캡처하므로 미리보기가 필요하다
    const shotDocs = profile === 'uni' && !!body.shotDocs && !body.dryRun;
    if (shotDocs && !body.viewer) throw Object.assign(new Error('화면 설명 문서를 만들려면 "미리보기 함께 생성"도 켜야 합니다'), { status: 400 });
    // "AI 실패한 화면만 다시 변환": the previous run in the output folder decides
    // the roles, names and which screens go again (checked here so errors show at once).
    const retry = !!body.retryFailed;
    if (retry && (profile !== 'uni' || !body.ai)) throw Object.assign(new Error('AI 실패 화면 다시 변환은 uni 형식 + AI 변환에서만 됩니다'), { status: 400 });
    // Roles confirmed in the review list (screen / sub-screen / popup and parent).
    const roles = !retry && profile === 'uni' && body.roles && typeof body.roles === 'object' ? body.roles : undefined;
    const pv = preview(body.input, body.output, { roles });
    let retryList = null;
    if (retry) {
      let prev;
      try {
        prev = loadPreviousReport(pv.output);
      } catch (err) {
        throw Object.assign(err, { status: 409 });
      }
      const prevRoles = prev.roles || pv.roles;
      retryList = retryUnits(prev, pv.forms.filter((rel) => !prevRoles[rel] || prevRoles[rel].role !== 'sub'));
      if (!retryList.length) throw Object.assign(new Error(NOTHING_TO_RETRY_MESSAGE), { status: 409 });
    }
    const renames = !retry && body.renames && typeof body.renames === 'object' ? body.renames : {};
    // Reject bad or clashing output names before starting, so the error shows right away.
    const named = resolveNames(pv.forms, { ...pv.names, ...renames });
    if (named.errors.length) {
      throw Object.assign(new Error(`출력 이름을 확인하세요: ${named.errors.map((e) => `${e.rel} — ${e.message}`).join(' / ')}`), { status: 400 });
    }
    const uiOnly = profile === 'uni' || !!body.uiOnly;
    // Conversion-rules skills for the AI pass (the ones ticked on the page, in
    // order): checked up front so a wrong path fails right away.
    const aiSkills = (Array.isArray(body.aiSkills) ? body.aiSkills : [body.aiSkill])
      .filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
    let pickedSkills = [];
    if (profile === 'uni' && body.ai && aiSkills.length) {
      try {
        pickedSkills = loadSkills(aiSkills);
      } catch (err) {
        throw Object.assign(err, { status: 400 });
      }
    }
    // uni: the projects are not read here. The saved "구조 파악" result is used,
    // and it must be for the folders on the screen.
    let structure = null;
    if (profile === 'uni') {
      structure = loadStructure(structureFile);
      const fresh = structure && samePath(structure.frontend && structure.frontend.root, body.uniFrontend)
        && samePath(structure.backend && structure.backend.root, body.uniBackend);
      if (!fresh) throw Object.assign(new Error('frontend·backend 경로가 바뀌었거나 아직 구조를 파악하지 않았습니다. 구조 파악 버튼을 먼저 누르세요'), { status: 409 });
      // With the uni summary skill Claude reads no uni files, so a skill made
      // from other folders would convert to the wrong project's rules unnoticed.
      for (const s of pickedSkills.filter(isSummarySkill)) {
        const head = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8').slice(0, 2000);
        const from = /^generated-from:\s*(.+)$/m.exec(head);
        if (skillStale(from && from[1].trim(), structure)) {
          throw Object.assign(new Error(`규칙 스킬(${s.dir})이 지금의 frontend·backend로 만든 것이 아닙니다. 구조 파악에서 규칙 스킬을 다시 만드세요`), { status: 409 });
        }
      }
    }
    const job = {
      id: crypto.randomUUID(),
      state: 'running',
      input: pv.input,
      output: pv.output,
      dryRun: !!body.dryRun,
      uiOnly,
      profile,
      viewer: !!body.viewer,
      shotDocs,
      ai: profile === 'uni' && !!body.ai,
      aiSkills,
      aiParallel: Number(body.aiParallel) || undefined,
      aiTimeout: Number(body.aiTimeout) > 0 ? Number(body.aiTimeout) : undefined,
      aiFix: body.aiFix !== false,
      active: new Map(), // rel -> stage of the screens being converted
      log: [], // progress log lines, like a CLI
      renames,
      roles: roles ? pv.roles : undefined,
      uniFrontend: structure ? structure.frontend.root : '',
      uniBackend: structure && structure.backend ? { root: structure.backend.root, basePackage: structure.backend.basePackage } : null,
      total: retryList ? retryList.length : pv.forms.length + (uiOnly ? 0 : pv.libs.length),
      retryFailed: retry,
      files: [],
      cancelled: false,
      report: null,
      error: null,
    };
    jobs.set(job.id, job);
    const time = () => new Date().toTimeString().slice(0, 8);
    const log = (line) => {
      if (job.log.length < MAX_LOG_LINES) job.log.push(`${time()} ${line}`);
    };
    let lastUsage = '';
    log(`변환 시작 — 화면 ${pv.forms.length}개${job.ai ? `, AI(Claude Code) 동시 ${job.aiParallel || 3}개, 화면당 최대 ${job.aiTimeout || DEFAULT_TIMEOUT_MIN}분` : ''}${job.uniBackend ? ', 백엔드 함께 생성' : ''}${job.shotDocs ? ', 끝나면 화면 설명 문서 생성' : ''}${job.dryRun ? ', 드라이런' : ''}`);
    log(`입력 ${job.input}`);
    log(`출력 ${job.output}`);
    if (retryList) log(`AI 실패한 화면만 다시 변환 — ${retryList.length}개: ${retryList.join(', ')} (나머지 화면은 그대로 둠, 화면 종류·이름은 이전 변환 기준)`);
    else for (const [rel, r] of Object.entries(pv.roles || {})) {
      if (r.role !== 'screen') log(`관계 ${rel} — ${r.role === 'sub' ? '하위 화면' : '팝업'}${r.parent ? `, 부모 ${r.parent}` : ''}`);
    }
    runConversion(job.input, job.output, {
      dryRun: job.dryRun,
      uiOnly: job.uiOnly,
      profile: job.profile,
      viewer: job.viewer,
      shotDocs: job.shotDocs,
      uniFrontend: job.uniFrontend,
      uniBackend: job.uniBackend || undefined,
      renames: job.renames,
      roles: job.roles,
      ai: job.ai,
      aiSkills: job.aiSkills,
      aiParallel: job.aiParallel,
      aiTimeout: job.aiTimeout,
      aiFix: job.aiFix,
      retryFailed: job.retryFailed,
      onFileStart: (rel, stage) => {
        job.active.set(rel, stage);
      },
      isCancelled: () => job.cancelled,
      onLog: log,
      // Claude usage: logged when the percentages change
      onUsage: (u) => {
        const line = usageLine(u);
        if (line && line !== lastUsage) log(`사용량 ${line}`);
        lastUsage = line;
      },
      onProgress: (result, done, total) => {
        job.total = total;
        job.active.delete(result.input);
        job.files.push(result);
        log(`(${done}/${total}) ${result.input} ${{ ok: '완료', partial: '확인 필요', error: '실패' }[result.status] || result.status}${result.todos.length ? ` — TODO ${result.todos.length}건` : ''}`);
      },
    }).then((report) => {
      job.report = report;
      job.state = report.cancelled ? 'cancelled' : 'done';
      const sm = report.summary;
      log(report.cancelled ? '취소되었습니다' : `끝 — 전체 ${sm.total} · 완료 ${sm.ok} · 확인 필요 ${sm.partial} · 실패 ${sm.error} · TODO ${sm.todos}건`);
    }).catch((err) => {
      job.state = 'error';
      job.error = err.message;
      log(`오류: ${err.message}`);
    });
    return job;
  }

  function fileDetail(job, index) {
    const f = job.files[index];
    if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
    const source = path.join(job.input, ...f.input.split('/'));
    const detail = { ...f, source: readTextLimited(source), outputs: [] };
    for (const rel of f.outputs) {
      const out = path.join(job.output, ...rel.split('/'));
      detail.outputs.push({
        path: rel,
        content: job.dryRun ? '(드라이런: 파일을 쓰지 않았습니다. 드라이런을 끄고 실행하면 결과를 볼 수 있습니다.)' : (fs.existsSync(out) ? readTextLimited(out) : '(missing)'),
      });
    }
    return detail;
  }

  async function handle(req, res) {
    if (!isTrustedRequest(req, typeof port === 'function' ? port() : port)) return send(res, 403, { error: '허용되지 않은 접속입니다 (Host/Origin)' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const [file, type] = STATIC_FILES[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), type);
    }
    if (route === 'GET /api/config') return send(res, 200, { app: 'nexa2vue', input: presetInput });
    // A newer launcher takes over the port: it asks the running server to stop.
    if (route === 'POST /api/shutdown') {
      await readJson(req);
      if (claudeBusy()) throw Object.assign(new Error(`${claudeBusy()} 진행 중이라 서버를 끌 수 없습니다`), { status: 409 });
      if (!onShutdown) return send(res, 404, { error: 'Not found' });
      send(res, 200, { stopping: true });
      setImmediate(onShutdown);
      return undefined;
    }
    // AI conversion needs the Claude Code CLI installed and logged in on this PC
    if (route === 'GET /api/ai/status') {
      return send(res, 200, { ...(await claudeStatus()), login: loginState(), usage: usageState() });
    }
    // Sign in on the web: runs `claude auth login`, which opens the browser
    if (route === 'POST /api/ai/login') {
      const body = await readJson(req);
      return send(res, 200, await startClaudeLogin({ method: body.method === 'console' ? 'console' : 'claudeai' }));
    }
    // Several signed-in Claude Code accounts on this PC: use the one picked on the page
    if (route === 'POST /api/ai/account') {
      const body = await readJson(req);
      if (claudeBusy()) throw Object.assign(new Error(`${claudeBusy()} 진행 중에는 Claude 연결을 바꿀 수 없습니다`), { status: 409 });
      return send(res, 200, await selectClaudeAccount(body.configDir));
    }
    // Switching accounts: sign out first (not while a conversion uses Claude Code)
    if (route === 'POST /api/ai/logout') {
      await readJson(req);
      if (claudeBusy()) throw Object.assign(new Error(`${claudeBusy()} 진행 중에는 Claude 연결을 바꿀 수 없습니다`), { status: 409 });
      return send(res, 200, await logoutClaude());
    }
    // Skills a folder offers (the folder itself, or each skill under .claude\skills)
    if (route === 'POST /api/ai/skills') {
      const body = await readJson(req);
      try {
        return send(res, 200, listSkills(body.folder));
      } catch (err) {
        throw Object.assign(err, { status: 400 });
      }
    }
    // "구조 파악": read the uni frontend/backend once and keep it as the default.
    if (route === 'GET /api/uni/structure') return send(res, 200, { structure: loadStructure(structureFile) });
    if (route === 'POST /api/uni/analyze') {
      const body = await readJson(req);
      if (isRunning()) throw Object.assign(new Error('변환이 진행 중에는 구조를 다시 파악할 수 없습니다'), { status: 409 });
      if (skill.state === 'running') throw Object.assign(new Error('규칙 스킬을 만드는 중에는 구조를 다시 파악할 수 없습니다'), { status: 409 });
      const structure = analyzeUni({ uniFrontend: body.uniFrontend, uniBackend: body.uniBackend });
      saveStructure(structure, structureFile);
      // The page asks for the skill along with 구조 파악 (skill: true).
      let skillError = null;
      if (body.skill) {
        try {
          await startSkill(structure);
        } catch (err) {
          skillError = err.message;
        }
      }
      return send(res, 200, { structure, skill: skillView(), skillError });
    }
    // The conversion-rules skill: progress, make it again, or stop.
    if (route === 'GET /api/uni/skill') return send(res, 200, skillView(Number(url.searchParams.get('logFrom')) || 0));
    if (route === 'POST /api/uni/skill') {
      await readJson(req);
      if (isRunning()) throw Object.assign(new Error('변환이 진행 중에는 규칙 스킬을 만들 수 없습니다'), { status: 409 });
      await startSkill(loadStructure(structureFile));
      return send(res, 200, skillView());
    }
    if (route === 'POST /api/uni/skill/cancel') {
      await readJson(req);
      skill.cancelled = true;
      return send(res, 200, skillView());
    }
    if (route === 'POST /api/input/pick') {
      const body = await readJson(req);
      return send(res, 200, await pickInput(body.initial));
    }
    if (route === 'POST /api/output/pick') {
      const body = await readJson(req);
      return send(res, 200, await pickOutput(body.initial));
    }
    if (route === 'POST /api/folder/pick') {
      const body = await readJson(req);
      return send(res, 200, await pickPlain(body.purpose, body.initial));
    }
    if (route === 'POST /api/preview') {
      const body = await readJson(req);
      return send(res, 200, preview(body.input, body.output, { roles: body.roles && typeof body.roles === 'object' ? body.roles : undefined }));
    }
    if (route === 'POST /api/jobs') {
      const body = await readJson(req);
      // The AI pass needs Claude Code signed in; say so before starting.
      if (body.ai && body.profile === 'uni') {
        const s = await claudeStatus();
        if (!s.available || !s.loggedIn) throw Object.assign(new Error('Claude가 연결되어 있지 않습니다. 0. 준비에서 Claude 계정을 연결하세요'), { status: 409 });
      }
      return send(res, 202, jobView(startJob(body)));
    }
    const m = /^\/api\/jobs\/([\w-]+)(?:\/(cancel|files\/(\d+)))?$/.exec(url.pathname);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'Job not found' });
      if (req.method === 'GET' && !m[2]) return send(res, 200, jobView(job, { logFrom: url.searchParams.get('logFrom') }));
      if (req.method === 'POST' && m[2] === 'cancel') {
        await readJson(req);
        job.cancelled = true;
        return send(res, 200, jobView(job, { withFiles: false }));
      }
      if (req.method === 'GET' && m[3] !== undefined) return send(res, 200, fileDetail(job, Number(m[3])));
    }
    return send(res, 404, { error: 'Not found' });
  }

  return (req, res) => {
    handle(req, res).catch((err) => send(res, err.status || 400, { error: err.message }));
  };
}

async function startServer({ input, port = 3470, host = '127.0.0.1', pickFolder, shutdownable = false, structureFile, skillDir, makeSkill, skillClaudeStatus }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('nexa2vue only binds to loopback');
  let boundPort = port;
  let server = null;
  const onShutdown = () => {
    console.log('[nexa2vue] 새로 실행한 서버에 자리를 넘기고 종료합니다.');
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  server = http.createServer(createApp({ input, port: () => boundPort, pickFolder, structureFile, skillDir, makeSkill, skillClaudeStatus, onShutdown: shutdownable ? onShutdown : undefined }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      boundPort = server.address().port;
      resolve(server);
    });
  });
}

module.exports = { startServer, createApp, isTrustedRequest };
