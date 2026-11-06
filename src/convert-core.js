'use strict';

// Conversion run shared by the Node runner (job-runner.js) and the browser
// build (browser/app.js). It knows nothing about the file system: sources are
// read and outputs written through the callbacks passed in.

const { convertForm, convertLibrary, genGfnModule } = require('./convert-form');
const { convertFormUni } = require('./gen-uni');
const { resolveNames, namesWithRoles, outputId } = require('./names');
const { detectRoles, normalizeRoles, withEdits, hostOf } = require('./screen-roles');
const posix = require('./posix-path');
const { screenDocs, apiSummary, screenDocPath, screenDocDir, legacyDocPath, indexDoc, allApisDoc, INDEX_PATH, ALL_APIS_PATH } = require('./conversion-doc');
const { usageMeter, shareUsage, usageText } = require('./usage');
const { checkApisAgainstCode } = require('./api-spec');

const PROFILES = ['element', 'uni'];
const NO_FORMS_MESSAGE = '입력 폴더 아래에 넥사크로 화면(.xfdl)이 없습니다';
// Claude Code sessions run at the same time during the AI pass (config aiParallel).
const DEFAULT_AI_PARALLEL = 3;
const MAX_AI_PARALLEL = 8;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Convert every .xjs (first, to learn exported function names) and .xfdl.
 *
 * sources: [{ rel, kind: 'form' | 'lib', read: () => ({ text, encoding }) | Promise }]
 * env: {
 *   input, output, skipped, config,
 *   compatSource,                  runtime/nexa-compat.js content
 *   viewerFiles,                   [{ path, content }] for the screen viewer (Element profile)
 *   uniPreviewFiles,               [{ path, content }] for the uni style preview (uni profile)
 *   write(rel, content, meta),     meta.keepIfExists marks viewer files
 *   exists(rel),                   optional; when given, existing viewer files are kept
 *   backend: { basePackage },       optional (uni): also generate each screen's backend under backend/
 *   aiConvert({ rel, text, draftFiles, draftBackendFiles }),  optional (uni + opts.ai): returns { files, backendFiles?, notes, doc?, costUsd, durationMs }
 * uni screens also get docs/<원본 경로>/<화면ID>.html (what was converted; body from the AI's doc) and docs/index.html.
 * }
 * opts: { dryRun, uiOnly, viewer, profile, renames, ai, aiParallel, onFileStart(rel, stage), onProgress(fileResult, doneCount, total), onLog(line), isCancelled() }
 * onLog: one line per step, like a CLI log (screen started, AI steps, files written, result)
 * aiParallel: screens converted at once by the AI pass (default 3, max 8); results may finish out of order
 * renames: { 'ua/usr/A.xfdl': 'BAU0101010' } output name per screen, over config.names (default: file name)
 * roles (uni): { rel: { role: 'screen' | 'sub' | 'popup', parent, via } } as confirmed before
 *   conversion (screen-roles.js); screens not in it keep the guessed role. A popup becomes
 *   {화면ID}_POP opened with popup.open; a sub-screen a component in its host's folder that
 *   shares the host's Service/Constant/backend, so a host and its sub-screens convert as one.
 * retryFrom (uni + ai): the previous run's _nexa2vue-report.json in the same output folder.
 *   Only the units whose AI pass failed (usage limit, timeout…), that failed outright, or that
 *   the previous run never reached are converted again, with that run's roles and names; the
 *   other screens' files are left alone and their report lines are carried over.
 */
async function convertSources(sources, env, opts = {}) {
  const profile = opts.profile || 'element';
  if (!PROFILES.includes(profile)) throw new Error(`알 수 없는 출력 형식입니다: ${profile}`);
  if (!sources.some((f) => f.kind === 'form')) throw new Error(`${NO_FORMS_MESSAGE}: ${env.input}`);
  const uni = profile === 'uni';
  // uni profile into a frontend that is not uni (env.frontendKind 'vue'): no uni
  // draft is written; the AI pass writes the screen the vue-convert skill's way.
  const vueMode = uni && env.frontendKind === 'vue';
  if (vueMode && !opts.ai) throw new Error('uni가 아닌 frontend로는 AI 변환으로만 변환할 수 있습니다(규칙 기반 초안은 uni 화면 형식)');
  // UI-only mode converts screens only; .xjs libraries are script and skipped.
  // The uni profile never converts script, so it skips them too.
  const uiOnly = uni || !!opts.uiOnly;
  const config = env.config || {};
  const formSources = sources.filter((f) => f.kind === 'form');
  const forms = formSources.map((f) => f.rel);
  // uni: every screen is read first, to see which are popups and sub-screens.
  const texts = new Map();
  const prev = opts.retryFrom || null;
  if (prev) checkRetry(prev, { uni, ai: !!opts.ai, input: env.input });
  let roles = null;
  if (uni) {
    for (const f of formSources) texts.set(f.rel, await f.read());
    const guessed = detectRoles(formSources.map((f) => ({ rel: f.rel, text: texts.get(f.rel).text })));
    // A retry keeps the previous run's roles, so files land where they did.
    roles = prev ? normalizeRoles(forms, { ...guessed, ...(prev.roles || {}) }) : normalizeRoles(forms, withEdits(guessed, opts.roles));
  }
  const renames = { ...(config.names || {}), ...(prev ? previousNames(prev) : {}), ...(opts.renames || {}) };
  const { names, errors } = resolveNames(forms, namesWithRoles(forms, renames, roles));
  if (errors.length) throw new Error(`출력 이름을 확인하세요: ${errors.map((e) => `${e.rel} — ${e.message}`).join(' / ')}`);
  // Sub-screens convert with their host (one unit), not on their own.
  let ordered = [...(uiOnly ? [] : sources.filter((f) => f.kind === 'lib')), ...formSources.filter((f) => !roles || roles[f.rel].role !== 'sub')];
  const unitCount = ordered.length;
  if (prev) {
    const again = new Set(retryUnits(prev, ordered.map((f) => f.rel)));
    ordered = ordered.filter((f) => again.has(f.rel));
    if (!ordered.length) throw new Error(`${NOTHING_TO_RETRY_MESSAGE}: ${env.output}`);
  }

  // uni file layout of each screen, by role
  const idOf = (rel) => outputId(names.get(rel));
  const dirOf = (rel) => (posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
  const viewDirOf = (rel) => `src/views/${dirOf(rel) ? `${dirOf(rel)}/` : ''}${idOf(rel)}`;
  const hostRel = (rel) => hostOf(rel, roles);
  const fileOf = (rel) => (roles[rel].role === 'sub' ? `${viewDirOf(hostRel(rel))}/${idOf(rel)}.vue` : `${viewDirOf(rel)}/${idOf(rel)}View.vue`);
  const membersOf = (rel) => forms.filter((r) => roles[r].role === 'sub' && r !== rel && hostRel(r) === rel);
  // Sub-screens a screen's Divs hold. One chosen by hand (no Div known) gets
  // a key no Div has, so gen-uni puts it at the end with a TODO.
  const embedsOf = (rel) => forms.filter((r) => roles[r].role === 'sub' && roles[r].parent === rel)
    .map((r) => ({ compId: (roles[r].via && roles[r].via.kind === 'embed' && roles[r].via.compId) || `(${r})`, name: idOf(r) }));
  const popupsOf = (rel) => forms.filter((r) => roles[r].role === 'popup' && roles[r].parent === rel).map((r) => {
    const to = posix.relative(posix.dirname(fileOf(rel)), fileOf(r));
    return { name: idOf(r), rel: r, importPath: to.startsWith('.') ? to : `./${to}` };
  });

  const report = {
    startedAt: new Date().toISOString(),
    input: env.input,
    output: env.output,
    dryRun: !!opts.dryRun,
    uiOnly,
    profile,
    ai: uni && !!opts.ai,
    frontendKind: uni ? (vueMode ? 'vue' : 'uni') : undefined,
    roles: roles || undefined,
    retry: prev ? { from: prev.startedAt || null, units: ordered.map((f) => f.rel) } : undefined,
    cancelled: false,
    files: [],
    skipped: env.skipped || [],
    missingGfn: [],
    summary: null,
  };
  const log = (line) => {
    if (opts.onLog) opts.onLog(line);
  };
  const write = async (rel, content, meta = {}) => {
    if (!opts.dryRun) await env.write(rel, content, meta);
  };

  const libExports = new Map();
  const libFns = new Set();
  const gfnUsed = new Set();

  // One screen, start to finish. Each AI pass is its own Claude Code session.
  // uni: a host screen (or popup) with every sub-screen that lands in it.
  // Sub-screens go first: their constants and APIs go into the host's files.
  function convertUnitUni(rel, text) {
    const members = membersOf(rel);
    const reserved = new Set();
    const subParts = [];
    const subFiles = [];
    const subTodos = [];
    for (const m of members) {
      const c = convertFormUni(texts.get(m).text, {
        relPath: m, name: names.get(m), role: 'sub', host: { id: idOf(rel), viewDir: viewDirOf(rel) },
        reservedTokens: reserved, embeds: embedsOf(m), popups: popupsOf(m),
      });
      c.sub.tokens.forEach((t) => reserved.add(t));
      subParts.push(c.sub);
      subFiles.push(...c.files);
      subTodos.push(...c.todos.map((t) => ({ message: `[하위 화면 ${idOf(m)}] ${t.message}` })));
    }
    const r = roles[rel];
    const converted = convertFormUni(text, {
      relPath: rel, name: names.get(rel), role: r.role, parentName: r.parent ? idOf(r.parent) : null,
      embeds: embedsOf(rel), subParts, popups: popupsOf(rel), reservedTokens: reserved, backend: env.backend || null,
    });
    converted.files.push(...subFiles);
    converted.todos.push(...subTodos);
    // What the AI pass needs to know about this unit's place among the screens.
    converted.relations = {
      role: r.role,
      parent: r.parent ? { rel: r.parent, name: idOf(r.parent), file: fileOf(r.parent) } : null,
      subs: members.map((m) => ({ rel: m, name: idOf(m), text: texts.get(m).text, file: fileOf(m), parent: idOf(roles[m].parent) })),
      popups: [rel, ...members].flatMap((from) => popupsOf(from).map((p) => ({ ...p, from: idOf(from) }))),
    };
    return converted;
  }

  // After an AI pass (uni or any Vue project): check how the screen uses the
  // project's components. Caught spots get one AI fix round (env.aiFix); what is
  // still wrong keeps the files (mostly right) but makes the screen an AI failure,
  // so "AI 실패한 화면만 다시 변환" picks it up, told what was wrong.
  // Every reading goes to the screen's meter, the whole run's meter and the caller.
  const runMeter = usageMeter(env.usageNow ? env.usageNow() : null);
  function seeUsage(u, meter) {
    if (meter) meter.see(u);
    runMeter.see(u);
    if (opts.onUsage) opts.onUsage(u);
  }
  // One screen at a time: what the account figure moved is this screen's usage.
  // Several at once: the figures mix, so the share is worked out at the end (shareRunUsage).
  // Claude Code reports usage only at the start of each session, so the "after"
  // reading comes from one tiny call once the work is done (env.usageProbe).
  async function probeAfter(meter) {
    if (!env.usageProbe || (opts.isCancelled && opts.isCancelled())) return;
    const u = await env.usageProbe();
    if (u) seeUsage(u, meter);
  }
  async function noteUsage(rel, result, meter) {
    if (report.aiParallel > 1) return;
    await probeAfter(meter);
    const usage = meter.result();
    if (!usage) return;
    result.ai.usage = usage;
    log(`[${rel}] Claude ${usageText(usage)}`);
  }
  // Screen documents, kept so they can be written again with the estimated usage
  const docJobs = [];
  // After a run with several screens at once: split the run's usage by each
  // screen's token cost, then write those screens' documents again.
  async function shareRunUsage(lines, runUsage) {
    const screens = lines.filter((r) => r.ai && !r.mergedInto && (r.ai.costUsd > 0 || r.ai.durationMs > 0));
    const byCost = screens.every((r) => r.ai.costUsd > 0);
    // Only one screen used AI: nothing to split, the run's figure is its measured usage
    const shares = screens.length === 1
      ? [runUsage]
      : shareUsage(runUsage, screens.map((r) => (byCost ? r.ai.costUsd : r.ai.durationMs)));
    screens.forEach((r, i) => {
      if (!shares[i]) return;
      r.ai.usage = shares[i];
      log(`[${r.input}] Claude ${usageText(shares[i])}`);
    });
    for (const job of docJobs) {
      if (job.docArgs.result.ai && job.docArgs.result.ai.usage) {
        for (const p of screenDocs(job.docArgs)) await write(p.path, p.content);
      }
    }
  }

  async function checkAndFix(rel, converted, result, given, meter) {
    let checks = env.checkFiles ? env.checkFiles(converted.files) : Array.isArray(given) ? given : [];
    if (checks.length && env.checkFiles && env.aiFix && opts.aiFix !== false) {
      log(`[${rel}] 검사 — 컴포넌트를 잘못 쓴 곳 ${checks.length}건, AI가 그 부분만 고칩니다`);
      try {
        const fix = await env.aiFix({
          rel, files: converted.files, checks,
          onStep: (step) => log(`[${rel}] AI 수정 ${step}`),
          onUsage: (u) => seeUsage(u, meter),
        });
        const byPath = new Map(fix.files.map((f) => [f.path, f]));
        converted.files = converted.files.map((f) => byPath.get(f.path) || f);
        const after = env.checkFiles(converted.files);
        result.ai.fix = { before: checks.length, after: after.length, files: fix.files.length, durationMs: fix.durationMs, costUsd: fix.costUsd };
        if (fix.costUsd != null) result.ai.costUsd = (result.ai.costUsd || 0) + fix.costUsd;
        converted.todos = [...converted.todos, ...(fix.notes || []).map((message) => ({ message: `[AI 수정] ${message}` }))];
        log(`[${rel}] AI 수정 끝 — ${Math.round((fix.durationMs || 0) / 1000)}초, ${after.length ? `아직 ${after.length}건 남음` : '검사 통과'}`);
        checks = after;
      } catch (err) {
        if (opts.isCancelled && opts.isCancelled()) throw err;
        result.ai.fix = { before: checks.length, error: err.message };
        log(`[${rel}] AI 수정 실패 — ${err.message}`);
      }
    }
    if (!checks.length) return;
    result.ai = { ...result.ai, ok: false, error: `컴포넌트를 잘못 쓴 곳 ${checks.length}건(화면이 열리지 않음)`, checks };
    converted.todos = [...checks.map((c) => ({ message: `[검사] ${c.file}:${c.line} ${c.message}` })), ...converted.todos];
    log(`[${rel}] 검사 — 컴포넌트를 잘못 쓴 곳 ${checks.length}건 — 다시 변환 대상`);
  }

  async function convertOne(file) {
    const name = names.get(file.rel);
    const result = { input: file.rel, kind: file.kind, name: names.get(file.rel) || null, status: 'ok', outputs: [], todos: [], error: null, encoding: null };
    if (roles && roles[file.rel]) {
      result.role = roles[file.rel].role;
      if (roles[file.rel].parent) result.parent = roles[file.rel].parent;
    }
    const members = roles ? membersOf(file.rel) : [];
    if (members.length) result.members = members;
    try {
      if (opts.onFileStart) opts.onFileStart(file.rel, 'rules');
      log(`[${file.rel}] 규칙 변환 시작${members.length ? ` (하위 화면 ${members.length}개 포함: ${members.join(', ')})` : ''}`);
      const { text, encoding } = texts.get(file.rel) || (await file.read());
      result.encoding = encoding;
      const converted = file.kind === 'lib'
        ? convertLibrary(text, { relPath: file.rel, libFns })
        : uni
          ? convertUnitUni(file.rel, text)
          : convertForm(text, { relPath: file.rel, name, libFns, componentMap: config.componentMap, uiOnly });
      if (file.kind === 'lib') {
        libExports.set(converted.libPath, converted.exported);
        converted.exported.forEach((n) => libFns.add(n));
      }
      // AI pass: port the script into the uni conventions. On failure the
      // rule-based draft is kept and the reason becomes a TODO.
      let aiDoc = '';
      // API 명세 the AI wrote with its code (null: none, use the rule-based model)
      let aiApis = null;
      // Claude usage (% of the plan limits) seen while this unit's AI work runs
      const meter = usageMeter(env.usageNow ? env.usageNow() : null);
      if (vueMode) log(`[${file.rel}] 원본 분석 끝 — 화면ID ${converted.backendModel ? converted.backendModel.id : '?'} (uni 초안은 쓰지 않고 AI가 프로젝트 방식으로 작성)`);
      else log(`[${file.rel}] 규칙 변환 끝 — 프론트 ${converted.files.length}개${converted.backendFiles && converted.backendFiles.length ? `, 백엔드 ${converted.backendFiles.length}개` : ''} 초안, TODO ${converted.todos.length}건${converted.error ? `, 오류: ${converted.error}` : ''}`);
      if (vueMode && file.kind === 'form' && !converted.error) {
        if (opts.onFileStart) opts.onFileStart(file.rel, 'ai');
        log(`[${file.rel}] AI 변환 시작 (Claude Code, 프로젝트 스킬 방식)`);
        try {
          const out = await env.aiConvertVue({
            rel: file.rel, text, relations: converted.relations, screen: converted.backendModel,
            previousChecks: previousChecks(prev, file.rel),
            onStep: (step) => log(`[${file.rel}] AI ${step}`),
            onUsage: (u) => seeUsage(u, meter),
          });
          converted.files = out.files;
          converted.backendFiles = [];
          // The screen's own .vue (the preview list and the shot docs open it)
          const vues = out.files.map((f) => f.path).filter((p) => p.endsWith('.vue'));
          result.view = vues.find((p) => /^src\/views\/.+View\.vue$/.test(p)) || vues.find((p) => p.startsWith('src/views/')) || vues[0] || null;
          converted.todos = out.notes.map((message) => ({ message: `[AI] ${message}` }));
          aiDoc = out.doc || '';
          aiApis = out.apis && out.apis.length ? out.apis : null;
          result.ai = { ok: true, durationMs: out.durationMs, costUsd: out.costUsd };
          log(`[${file.rel}] AI 변환 끝 — ${Math.round((out.durationMs || 0) / 1000)}초, 파일 ${out.files.length}개, 확인할 것 ${out.notes.length}건`);
          await checkAndFix(file.rel, converted, result, out.checks, meter);
          await noteUsage(file.rel, result, meter);
        } catch (err) {
          if (opts.isCancelled && opts.isCancelled()) throw err;
          // No draft to fall back on: nothing is written for this screen.
          result.ai = { ok: false, error: err.message };
          throw new Error(`AI 변환 실패(uni가 아닌 frontend라 초안을 저장하지 않음): ${err.message}`);
        }
      } else if (ai && file.kind === 'form' && !converted.error) {
        if (opts.onFileStart) opts.onFileStart(file.rel, 'ai');
        log(`[${file.rel}] AI 변환 시작 (Claude Code)`);
        try {
          const out = await env.aiConvert({
            rel: file.rel, text, draftFiles: converted.files, draftBackendFiles: converted.backendFiles, relations: converted.relations,
            previousChecks: previousChecks(prev, file.rel),
            onStep: (step) => log(`[${file.rel}] AI ${step}`),
            onUsage: (u) => seeUsage(u, meter),
          });
          converted.files = out.files;
          if (out.backendFiles) converted.backendFiles = out.backendFiles;
          converted.todos = out.notes.map((message) => ({ message: `[AI] ${message}` }));
          aiDoc = out.doc || '';
          aiApis = out.apis && out.apis.length ? out.apis : null;
          result.ai = { ok: true, durationMs: out.durationMs, costUsd: out.costUsd };
          log(`[${file.rel}] AI 변환 끝 — ${Math.round((out.durationMs || 0) / 1000)}초, 확인할 것 ${out.notes.length}건`);
          await checkAndFix(file.rel, converted, result, out.checks, meter);
          await noteUsage(file.rel, result, meter);
        } catch (err) {
          if (opts.isCancelled && opts.isCancelled()) throw err;
          converted.todos = [{ message: `[AI] 변환 실패 — 규칙 기반 초안을 저장했습니다: ${err.message}` }, ...converted.todos];
          result.ai = { ok: false, error: err.message };
          log(`[${file.rel}] AI 변환 실패 — 규칙 기반 초안을 저장합니다: ${err.message}`);
        }
      }
      // The saved files are the rule-based draft (no AI pass, or it failed):
      // check them too, so a draft that breaks the render says where.
      if (uni && !vueMode && file.kind === 'form' && env.checkFiles && !(result.ai && result.ai.ok) && !(result.ai && result.ai.checks)) {
        const draftChecks = env.checkFiles(converted.files);
        if (draftChecks.length) {
          converted.todos = [...draftChecks.map((c) => ({ message: `[검사] 초안 ${c.file}:${c.line} ${c.message}` })), ...converted.todos];
          log(`[${file.rel}] 초안 검사 — 컴포넌트를 잘못 쓴 곳 ${draftChecks.length}건 (TODO에 남김)`);
        }
      }
      converted.gfnUsed.forEach((n) => gfnUsed.add(n));
      // Backend files (uni backend project layout) go under backend/.
      const all = [...converted.files, ...(converted.backendFiles || []).map((f) => ({ ...f, path: `backend/${f.path}` }))];
      for (const f of all) {
        await write(f.path, f.content);
        result.outputs.push(f.path);
        log(`[${file.rel}] ${opts.dryRun ? '(드라이런) ' : ''}쓰기 ${f.path}`);
      }
      // The AI's API 명세 checked against the code it wrote (after the fix round)
      if (aiApis) {
        aiApis = checkApisAgainstCode(aiApis, converted.files);
        const off = aiApis.filter((a) => a.missing);
        if (off.length) {
          converted.todos = [...converted.todos, ...off.map((a) => ({ message: `[검사] API 명세 ${a.name}: 변환된 코드에서 찾지 못함(${a.missing.join(', ')})` }))];
          log(`[${file.rel}] API 명세 검사 — 코드에서 찾지 못한 API ${off.length}개 (확인할 것에 남김)`);
        }
      }
      result.todos = converted.todos;
      if (converted.error) result.error = converted.error;
      result.status = converted.error || converted.todos.length ? 'partial' : 'ok';
      // uni: documents of what this screen's conversion did, in one folder
      // per screen (docs/…/<화면ID>/01_개요.html and the pages it links to)
      if (uni && converted.backendModel) {
        const model = converted.backendModel;
        const docPath = screenDocPath(model);
        const docArgs = { result, model, aiDoc, aiApis, backend: !vueMode && (converted.backendFiles || []).length > 0, convertedAt: new Date().toISOString(), kind: vueMode ? 'vue' : 'uni' };
        const pages = screenDocs(docArgs);
        // pages of an earlier run (an API renamed or gone) must not linger
        if (!opts.dryRun && env.removeDocs) await env.removeDocs(screenDocDir(model), legacyDocPath(model));
        for (const p of pages) await write(p.path, p.content);
        docJobs.push({ docArgs });
        // apis: one line per API for docs/전체_API목록.html (and retries, via the report)
        result.doc = { path: docPath, id: model.id, screenName: model.screenName, apis: apiSummary(docArgs) };
        result.outputs.push(...pages.map((p) => p.path));
        log(`[${file.rel}] ${opts.dryRun ? '(드라이런) ' : ''}쓰기 문서 ${screenDocDir(model)}/ (${pages.length}개)`);
      }
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      log(`[${file.rel}] 실패: ${err.message}`);
    }
    // Each sub-screen also gets its report line, pointing at its host.
    const subResults = members.map((m) => ({
      input: m, kind: 'form', name: names.get(m), role: 'sub', parent: roles[m].parent, mergedInto: file.rel,
      status: result.status, outputs: result.outputs.filter((p) => p === fileOf(m)), todos: [], error: null, encoding: null,
    }));
    return subResults.length ? [result, ...subResults] : result;
  }

  // Rule-based conversion is quick and stays in order (libraries first). With
  // the AI pass every screen is independent, so several sessions run at once.
  const ai = uni && !!opts.ai && !!env.aiConvert;
  const parallel = ai ? Math.min(MAX_AI_PARALLEL, Math.max(1, Number(opts.aiParallel || config.aiParallel) || DEFAULT_AI_PARALLEL)) : 1;
  report.aiParallel = ai ? parallel : undefined;
  const results = new Array(ordered.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < ordered.length) {
      if (opts.isCancelled && opts.isCancelled()) {
        report.cancelled = true;
        return;
      }
      const i = next++;
      // A host with sub-screens gives several report lines (host first).
      const out = await convertOne(ordered[i]);
      results[i] = Array.isArray(out) ? out : [out];
      done++;
      if (opts.onProgress) for (const r of results[i]) opts.onProgress(r, done, ordered.length);
      await tick();
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  report.files = results.filter(Boolean).flat();
  // Several at once: one "after" reading for the whole run (one at a time, the
  // last screen's reading already came after all the work).
  if (parallel > 1 && runMeter.result()) await probeAfter(null);
  const runUsage = runMeter.result();
  if (runUsage) report.usage = runUsage;
  if (runUsage && parallel > 1) await shareRunUsage(results.filter(Boolean).flat(), runUsage);
  // Retry: the screens not converted again keep their previous report lines
  // (so do units a cancelled retry did not reach), in screen order.
  if (prev) {
    const redone = new Set(report.files.map((f) => f.input));
    const kept = (prev.files || []).filter((f) => f && !redone.has(f.input) && forms.includes(f.input))
      .map((f) => ({ ...f, todos: Array.isArray(f.todos) ? f.todos : [], outputs: Array.isArray(f.outputs) ? f.outputs : [] }));
    const at = (f) => forms.indexOf(f.mergedInto || f.input);
    report.files = [...kept, ...report.files].sort((a, b) => at(a) - at(b) || (a.mergedInto ? 1 : 0) - (b.mergedInto ? 1 : 0));
  }

  // Screen viewer project: never overwrite files that already exist, so an
  // existing Vue project used as the output keeps its own setup. The uni
  // profile gets a preview that borrows the uni frontend's components and styles.
  if (opts.viewer) {
    report.viewer = { kind: vueMode ? 'vue' : uni ? 'uni' : 'element', written: [], kept: [] };
    for (const f of (vueMode ? env.vuePreviewFiles : uni ? env.uniPreviewFiles : env.viewerFiles) || []) {
      if (env.exists && (await env.exists(f.path))) {
        report.viewer.kept.push(f.path);
        continue;
      }
      await write(f.path, f.content, { keepIfExists: true });
      report.viewer.written.push(f.path);
    }
    // vue preview: its screen list, made again every run (a retry keeps the earlier screens).
    if (vueMode) {
      await write(VUE_SCREENS_PATH, vueScreensModule(report.files));
      report.viewer.written.push(VUE_SCREENS_PATH);
    }
  }

  if (!uiOnly) {
    const gfn = genGfnModule(libExports, gfnUsed);
    report.missingGfn = gfn.missing;
    await write('src/utils/nexa-gfn.js', gfn.content);
    await write('src/utils/nexa-compat.js', env.compatSource);
  }

  const count = (s) => report.files.filter((f) => f.status === s).length;
  report.summary = {
    // every screen, sub-screens (converted with their host) included
    total: unitCount + (roles ? forms.filter((r) => roles[r].role === 'sub').length : 0),
    processed: report.files.length,
    ok: count('ok'),
    partial: count('partial'),
    error: count('error'),
    todos: report.files.reduce((n, f) => n + f.todos.length, 0),
  };
  report.finishedAt = new Date().toISOString();
  if (report.files.some((f) => f.doc)) {
    await write(INDEX_PATH, indexDoc(report));
    await write(ALL_APIS_PATH, allApisDoc(report));
    report.docs = INDEX_PATH;
  }
  await write('_nexa2vue-report.json', JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------- vue preview

const VUE_SCREENS_PATH = 'preview/screens.js';

/** preview/screens.js: [{ id, name, file, load }] for every converted screen with a .vue. */
function vueScreensModule(files) {
  const rows = files.filter((f) => f.view && f.status !== 'error').map((f) => {
    const id = (f.doc && f.doc.id) || f.name || f.input;
    const name = (f.doc && f.doc.screenName) || '';
    const file = `/${f.view}`;
    return `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, file: ${JSON.stringify(file)}, load: () => import(${JSON.stringify(file)}) },`;
  });
  return `// nexa2vue가 변환할 때마다 다시 쓴다: 미리보기 화면 목록\nexport default [\n${rows.join('\n')}\n]\n`;
}

// ---------------------------------------------------------------- retry

const NOTHING_TO_RETRY_MESSAGE = '다시 변환할 화면이 없습니다(이전 변환에서 AI가 실패한 화면이 없음)';

// Is this unit's previous result one to convert again?
function needsRetry(line) {
  return !line || line.status === 'error' || !!(line.ai && line.ai.ok === false);
}

/**
 * Units (host screens and popups, not sub-screens) to convert again: the AI
 * pass failed, the conversion failed, or the previous run never got to them
 * (cancelled, or a screen added since).
 */
// What the component check found in a unit's previous AI output (retry only).
function previousChecks(prev, rel) {
  const line = prev && (prev.files || []).find((f) => f && f.input === rel && !f.mergedInto);
  return line && line.ai && Array.isArray(line.ai.checks) && line.ai.checks.length ? line.ai.checks : undefined;
}

function retryUnits(prev, units) {
  const byInput = new Map((prev.files || []).filter((f) => !f.mergedInto).map((f) => [f.input, f]));
  return units.filter((rel) => needsRetry(byInput.get(rel)));
}

// Output names the previous run used, so retried screens overwrite their own files.
function previousNames(prev) {
  return Object.fromEntries((prev.files || []).filter((f) => f.kind === 'form' && f.name).map((f) => [f.input, f.name]));
}

function samePath(a, b) {
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function checkRetry(prev, { uni, ai, input }) {
  if (!prev || typeof prev !== 'object' || !Array.isArray(prev.files)) throw new Error('이전 변환 결과(_nexa2vue-report.json)를 읽을 수 없습니다');
  if (!uni || prev.profile !== 'uni') throw new Error('AI 실패 화면 다시 변환은 uni 형식에서만 됩니다');
  if (!ai) throw new Error('AI 실패 화면 다시 변환은 AI 변환을 켜야 합니다');
  if (prev.dryRun) throw new Error('이전 변환이 드라이런이라 저장된 결과가 없습니다. 변환 실행으로 처음부터 변환하세요');
  if (prev.input && input && !samePath(prev.input, input)) {
    throw new Error(`이전 변환의 입력 폴더(${prev.input})와 지금 입력 폴더가 다릅니다`);
  }
}

module.exports = {
  convertSources, retryUnits, needsRetry, PROFILES, NO_FORMS_MESSAGE, NOTHING_TO_RETRY_MESSAGE, DEFAULT_AI_PARALLEL, MAX_AI_PARALLEL,
};
