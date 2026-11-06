'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { convertSources } = require('../src/convert-core');
const { buildPrompt, loadSkill, loadSkills, uniSkills, conversionSkills, withoutLegacyRules, RULES_SKILL_DIR, listSkills, runClaude, removeWorkDir, UNI_SKILL_NAME, OUTPUT_SCHEMA } = require('../src/ai-convert');

const UNI = path.join(__dirname, 'fixtures', 'uni');
const sources = ['ua/usr/BAU0101010.xfdl', 'ua/usr/BAU0102010.xfdl'].map((rel) => ({
  rel,
  kind: 'form',
  read: () => ({ text: fs.readFileSync(path.join(UNI, rel), 'utf8'), encoding: 'utf-8' }),
}));

function run(aiConvert, { env = {}, ...opts } = {}) {
  const written = new Map();
  const stages = [];
  return convertSources(sources, {
    input: 'in', output: 'out', write: (rel, content) => written.set(rel, content), aiConvert, ...env,
  }, { profile: 'uni', onFileStart: (rel, stage) => stages.push(`${stage}:${rel}`), ...opts })
    .then((report) => ({ report, written, stages }));
}

test('AI pass replaces the draft files and turns its notes into TODOs', async () => {
  const calls = [];
  const { report, written, stages } = await run(async ({ rel, text, draftFiles }) => {
    calls.push({ rel, hasScript: /<Script/.test(text), draft: draftFiles.map((f) => f.path) });
    return {
      files: draftFiles.map((f) => ({ path: f.path, content: `// AI ${path.posix.basename(f.path)}\n` })),
      notes: rel.endsWith('BAU0101010.xfdl') ? ['gfn_setCommCode는 정의를 몰라 TODO로 남김'] : [],
      costUsd: 0.1,
      durationMs: 1000,
    };
  }, { ai: true });

  assert.equal(report.ai, true);
  assert.deepEqual(calls.map((c) => c.rel), ['ua/usr/BAU0101010.xfdl', 'ua/usr/BAU0102010.xfdl']);
  assert.ok(calls[0].hasScript);
  assert.deepEqual(calls[0].draft, [
    'src/views/ua/usr/BAU0101010/BAU0101010View.vue',
    'src/views/ua/usr/BAU0101010/BAU0101010Service.js',
    'src/views/ua/usr/BAU0101010/BAU0101010Constant.js',
  ]);
  assert.equal(written.get('src/views/ua/usr/BAU0101010/BAU0101010View.vue'), '// AI BAU0101010View.vue\n');
  const [first, second] = report.files;
  assert.deepEqual(first.todos, [{ message: '[AI] gfn_setCommCode는 정의를 몰라 TODO로 남김' }]);
  assert.equal(first.status, 'partial');
  assert.equal(second.status, 'ok');
  assert.deepEqual(first.ai, { ok: true, durationMs: 1000, costUsd: 0.1 });
  assert.deepEqual(stages.sort(), ['ai:ua/usr/BAU0101010.xfdl', 'ai:ua/usr/BAU0102010.xfdl', 'rules:ua/usr/BAU0101010.xfdl', 'rules:ua/usr/BAU0102010.xfdl']);
});

test('AI sessions run several screens at once, up to aiParallel', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ ...sources[i % 2], rel: `ua/usr/S${i}.xfdl` }));
  async function measure(aiParallel) {
    let running = 0;
    let peak = 0;
    const progress = [];
    const report = await convertSources(many, { input: 'in', output: 'out', write: () => {}, aiConvert: async ({ draftFiles }) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { files: draftFiles, notes: [], costUsd: 0, durationMs: 20 };
    } }, { profile: 'uni', ai: true, aiParallel, onProgress: (r, done, total) => progress.push(`${done}/${total}`) });
    return { peak, report, progress };
  }
  const three = await measure(undefined);
  assert.equal(three.peak, 3);
  assert.equal(three.report.aiParallel, 3);
  // report keeps the source order even when screens finish out of order
  assert.deepEqual(three.report.files.map((f) => f.input), many.map((f) => f.rel));
  assert.deepEqual(three.progress, ['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7']);
  assert.equal((await measure(1)).peak, 1);
  // capped at 8; with 7 screens all 7 run together
  const capped = await measure(20);
  assert.equal(capped.report.aiParallel, 8);
  assert.equal(capped.peak, 7);
});

test('a failed AI pass keeps the rule-based draft and says why', async () => {
  const { report, written } = await run(async () => {
    throw new Error('Claude Code(claude 명령)를 찾을 수 없습니다');
  }, { ai: true });
  const file = report.files[0];
  assert.equal(file.ai.ok, false);
  assert.match(file.todos[0].message, /^\[AI\] 변환 실패 — 규칙 기반 초안을 저장했습니다: Claude Code/);
  assert.match(written.get('src/views/ua/usr/BAU0101010/BAU0101010View.vue'), /<SearchSection/);
});

test('retry converts again only the screens whose AI pass failed (usage limit) and keeps the others', async () => {
  // First run: the second screen hits the usage limit.
  const first = await run(async ({ rel, draftFiles }) => {
    if (rel.endsWith('BAU0102010.xfdl')) throw new Error("You've hit your 5-hour limit");
    return { files: draftFiles.map((f) => ({ path: f.path, content: '// AI first\n' })), notes: [], costUsd: 0.5, durationMs: 1 };
  }, { ai: true, renames: { 'ua/usr/BAU0102010.xfdl': 'BAU0102090' } });
  assert.equal(first.report.files[1].ai.ok, false);
  const prev = JSON.parse(first.written.get('_nexa2vue-report.json'));

  // Retry: no renames passed — the previous run's names are used, and only the failed screen goes to the AI.
  const calls = [];
  const again = await run(async ({ rel, draftFiles }) => {
    calls.push(rel);
    return { files: draftFiles.map((f) => ({ path: f.path, content: '// AI retry\n' })), notes: [], costUsd: 0.4, durationMs: 1 };
  }, { ai: true, retryFrom: prev });
  assert.deepEqual(calls, ['ua/usr/BAU0102010.xfdl']);
  assert.deepEqual(again.report.retry.units, ['ua/usr/BAU0102010.xfdl']);
  // Files of the screen that was fine are not written again.
  assert.ok(![...again.written.keys()].some((p) => p.includes('BAU0101010/')));
  assert.equal(again.written.get('src/views/ua/usr/BAU0102090/BAU0102090View.vue'), '// AI retry\n');
  // The report covers every screen: the kept line plus the redone one, in screen order.
  assert.deepEqual(again.report.files.map((f) => [f.input, f.ai.ok]), [['ua/usr/BAU0101010.xfdl', true], ['ua/usr/BAU0102010.xfdl', true]]);
  assert.equal(again.report.files[0].ai.costUsd, 0.5);
  assert.equal(again.report.summary.total, 2);
  assert.equal(again.report.summary.processed, 2);

  // Nothing left to retry.
  const done = JSON.parse(again.written.get('_nexa2vue-report.json'));
  await assert.rejects(run(async () => ({ files: [], notes: [] }), { ai: true, retryFrom: done }), /다시 변환할 화면이 없습니다/);
});

test('AI output that uses common components against their props is kept but counts as failed, and the retry is told why', async () => {
  const check = { file: 'src/views/ua/usr/BAU0101010/BAU0101010View.vue', line: 12, component: 'Field', message: '<Field> 필수 prop item·model 없음' };
  const first = await run(async ({ rel, draftFiles }) => ({
    files: draftFiles.map((f) => ({ path: f.path, content: '// AI first\n' })),
    checks: rel.endsWith('BAU0101010.xfdl') ? [check] : [],
    notes: [],
    durationMs: 1,
  }), { ai: true });
  const [bad, good] = first.report.files;
  assert.equal(bad.ai.ok, false);
  assert.deepEqual(bad.ai.checks, [check]);
  assert.match(bad.ai.error, /컴포넌트를 잘못 쓴 곳 1건/);
  assert.equal(bad.todos[0].message, `[검사] ${check.file}:12 <Field> 필수 prop item·model 없음`);
  // the AI files are written, not the rule draft
  assert.equal(first.written.get(check.file), '// AI first\n');
  assert.equal(good.ai.ok, true);
  assert.equal(good.ai.checks, undefined);

  // retry: only that screen, with what was wrong
  const prev = JSON.parse(first.written.get('_nexa2vue-report.json'));
  const calls = [];
  const again = await run(async ({ rel, draftFiles, previousChecks }) => {
    calls.push([rel, previousChecks]);
    return { files: draftFiles.map((f) => ({ path: f.path, content: '// AI fixed\n' })), checks: [], notes: [] };
  }, { ai: true, retryFrom: prev });
  assert.deepEqual(calls, [['ua/usr/BAU0101010.xfdl', [check]]]);
  assert.equal(again.report.files[0].ai.ok, true);
});

test('the retry prompt lists what the component check found last time', () => {
  const names = { view: 'AView.vue', service: 'AService.js', constant: 'AConstant.js' };
  const prompt = buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni', previousChecks: [{ file: 'src/views/A/AView.vue', line: 7, message: '<Field> 필수 prop item·model 없음' }] });
  assert.match(prompt, /## 지난 변환에서 틀린 곳 \(이번에는 고친다\)\n[^\n]+\n- src\/views\/A\/AView\.vue:7 <Field> 필수 prop item·model 없음\n/);
  assert.ok(prompt.indexOf('## 지난 변환에서 틀린 곳') < prompt.indexOf('## 할 일 (기본 규칙)'));
  assert.doesNotMatch(buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni' }), /지난 변환에서 틀린 곳/);
});

test('retry also picks up screens the previous run never reached, and refuses a dry run or another input', async () => {
  const prev = { profile: 'uni', input: 'in', startedAt: 't', files: [{ input: 'ua/usr/BAU0101010.xfdl', kind: 'form', name: 'BAU0101010', status: 'ok', ai: { ok: true } }] };
  const calls = [];
  const { report } = await run(async ({ rel, draftFiles }) => {
    calls.push(rel);
    return { files: draftFiles, notes: [] };
  }, { ai: true, retryFrom: prev });
  assert.deepEqual(calls, ['ua/usr/BAU0102010.xfdl']);
  assert.equal(report.files.length, 2);

  const ai = async () => ({ files: [], notes: [] });
  await assert.rejects(run(ai, { ai: true, retryFrom: { ...prev, dryRun: true } }), /드라이런/);
  await assert.rejects(run(ai, { ai: true, retryFrom: { ...prev, input: 'C:\\other' } }), /입력 폴더/);
  await assert.rejects(run(ai, { retryFrom: prev }), /AI 변환을 켜야/);
});

test('no AI unless asked, and never for the Element profile', async () => {
  let called = 0;
  const ai = async () => {
    called++;
    throw new Error('should not run');
  };
  await run(ai);
  await convertSources(sources, { input: 'in', output: 'out', write: () => {}, compatSource: '', aiConvert: ai }, { ai: true });
  assert.equal(called, 0);
});

test('a conversion-rules skill is loaded from its folder and put first in the prompt', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-skill-'));
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '\uFEFF---\nname: nexa-to-uni\ndescription: 넥사크로 → uni 변환 규칙\n---\n\n# 규칙\n- transaction은 service로\n');
    const skill = loadSkill(dir);
    assert.deepEqual(skill, { name: 'nexa-to-uni', description: '넥사크로 → uni 변환 규칙', dir, body: '# 규칙\n- transaction은 service로' });
    assert.deepEqual(loadSkill(path.join(dir, 'SKILL.md')), skill);
    const prompt = buildPrompt({ relPath: 'a.xfdl', draftNames: { view: 'V', service: 'S', constant: 'C' }, uniFrontend: 'C:\\uni', skills: [skill] });
    assert.doesNotMatch(prompt, /앞에 있는 스킬을 따른다/);
    assert.ok(prompt.indexOf('<skill name="nexa-to-uni">') < prompt.indexOf('## 할 일 (기본 규칙)'));
    assert.match(prompt, /스킬이 아래 기본 규칙과 다르면 스킬을 따르고/);
    assert.match(prompt, /- transaction은 service로\n<\/skill>/);
    assert.doesNotMatch(buildPrompt({ relPath: 'a.xfdl', draftNames: { view: 'V', service: 'S', constant: 'C' }, uniFrontend: 'C:\\uni' }), /<skill/);
    assert.throws(() => loadSkill(path.join(dir, 'nope')), /변환 규칙 스킬을 찾을 수 없습니다/);
    fs.rmSync(path.join(dir, 'SKILL.md'));
    assert.throws(() => loadSkill(dir), /SKILL\.md가 없습니다/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out AI run reports the timeout, after the whole process tree has ended', async () => {
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-ai-test-'));
  try {
    // stands in for claude.exe: never answers, and starts a child that sits in the work folder
    const hang = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)";
    const started = Date.now();
    await assert.rejects(
      runClaude(['-e', hang], '', { cwd: work, timeoutMs: 1500, claudeBin: process.execPath }),
      /AI 변환 시간 초과/,
    );
    assert.ok(Date.now() - started < 1500 + 6000);
    removeWorkDir(work);
    assert.equal(fs.existsSync(work), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('removing the work folder never throws', () => {
  assert.doesNotThrow(() => removeWorkDir(path.join(require('os').tmpdir(), 'nexa2vue-no-such-folder')));
});

test('Claude Code exiting before it reads a large prompt fails that run, not the whole process', async () => {
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-ai-test-'));
  try {
    // stands in for claude.exe: exits at once without reading stdin
    await assert.rejects(
      runClaude(['-e', 'process.exit(3)'], 'x'.repeat(8 * 1024 * 1024), { cwd: work, timeoutMs: 30000, claudeBin: process.execPath }),
      /exit 3/,
    );
  } finally {
    removeWorkDir(work);
  }
});

test('an npm claude.cmd shim runs its cli.js directly, with the JSON arguments intact', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-cmd-'));
  try {
    const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    // stands in for Claude Code: answers with the arguments it got
    fs.writeFileSync(cli, "console.log(JSON.stringify({ type: 'result', args: process.argv.slice(2) }))\n");
    // the shape npm writes for a global install
    fs.writeFileSync(path.join(dir, 'claude.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    ].join('\r\n'));
    const schema = JSON.stringify({ type: 'object', properties: { a: { type: 'string', description: '"따옴표" & 공백' } } });
    const res = await runClaude(['-p', '--json-schema', schema], '', { cwd: dir, timeoutMs: 30000, claudeBin: path.join(dir, 'claude.cmd') });
    assert.deepEqual(res.args, ['-p', '--json-schema', schema]);
  } finally {
    removeWorkDir(dir);
  }
});

// A .claude\skills style folder: one folder per skill.
function skillsFolder() {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-skills-'));
  const add = (name, description, body) => {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  };
  add('screen-summary', '결과를 정리한다', '고른 기본 화면과 이유를 정리해줘.');
  add('screen-convert', 'xfdl 화면을 전환한다', '화면 표준에 맞춰 전환해줘.');
  fs.mkdirSync(path.join(root, 'not-a-skill'));
  return root;
}

test('a folder of skills is listed, and each skill is picked by its own folder', () => {
  const root = skillsFolder();
  try {
    const listed = listSkills(root);
    assert.equal(listed.single, false);
    assert.deepEqual(listed.skills, [
      { name: 'screen-convert', description: 'xfdl 화면을 전환한다', dir: path.join(root, 'screen-convert') },
      { name: 'screen-summary', description: '결과를 정리한다', dir: path.join(root, 'screen-summary') },
    ]);
    // a single skill folder lists just itself
    const one = listSkills(path.join(root, 'screen-convert'));
    assert.equal(one.single, true);
    assert.deepEqual(one.skills.map((s) => s.name), ['screen-convert']);
    assert.throws(() => listSkills(path.join(root, 'not-a-skill')), /SKILL\.md가 없습니다/);
    // the folder of skills itself is not a skill: it says which ones are there
    assert.throws(() => loadSkill(root), /스킬이 여러 개 있습니다\(screen-convert, screen-summary\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('several skills go into the prompt in the given order, each once', () => {
  const root = skillsFolder();
  try {
    const summary = path.join(root, 'screen-summary');
    const convert = path.join(root, 'screen-convert');
    // config.aiSkill may be one folder or a list; blanks are ignored
    assert.deepEqual(loadSkills(convert).map((s) => s.name), ['screen-convert']);
    assert.deepEqual(loadSkills(undefined), []);
    const skills = loadSkills([summary, '', convert, summary]);
    assert.deepEqual(skills.map((s) => s.name), ['screen-summary', 'screen-convert']);
    const prompt = buildPrompt({ relPath: 'a.xfdl', draftNames: { view: 'V', service: 'S', constant: 'C' }, uniFrontend: 'C:\\uni', skills });
    assert.match(prompt, /## 변환 규칙 \(스킬: screen-summary, screen-convert\)/);
    assert.match(prompt, /스킬끼리 다르면 앞에 있는 스킬을 따른다/);
    assert.ok(prompt.indexOf('<skill name="screen-summary">') < prompt.indexOf('<skill name="screen-convert">'));
    assert.ok(prompt.indexOf('<skill name="screen-convert">') < prompt.indexOf('## 할 일 (기본 규칙)'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with the vue-convert summary skill the inputs go into the prompt and no uni files are to be read', () => {
  const names = { view: 'AView.vue', service: 'AService.js', constant: 'AConstant.js' };
  const uniSkill = { name: UNI_SKILL_NAME, description: '', dir: 'C:\\home\\.nexa2vue\\skills\\uni-convert', body: '## 파일 구성\n- View.vue' };
  const inputs = { 'source.xfdl': '<Form id="A"/>\n', 'draft/AView.vue': '<template/>', 'draft/backend/AController.java': 'class A {}' };
  const prompt = buildPrompt({ relPath: 'ua/A.xfdl', draftNames: names, uniFrontend: 'C:\\uni\\frontend', skills: [uniSkill], inputs, backend: { uniBackend: 'C:\\uni\\backend', names: ['AController.java'] } });
  assert.doesNotMatch(prompt, /반드시 먼저 읽을/);
  assert.doesNotMatch(prompt, /NAMING_CONVENTION\.md|SCREEN_CONVENTION\.md|CCU0297010/);
  assert.doesNotMatch(prompt, /C:\\uni\\/);
  assert.doesNotMatch(prompt, /참고 파일도 읽어도 된다/);
  assert.match(prompt, /## uni 규칙\n- 위 vue-convert 스킬이/);
  assert.match(prompt, /백엔드 규칙도 위 스킬의 백엔드 절을 따른다/);  assert.match(prompt, /<file path="source\.xfdl">\n<Form id="A"\/>\n<\/file>/);
  assert.match(prompt, /<file path="draft\/backend\/AController\.java">\nclass A \{\}\n<\/file>$/);

  // another skill next to it keeps its folder readable; without the summary skill nothing changes
  const other = { name: 'team-rules', description: '', dir: 'C:\\skills\\team-rules', body: '- 규칙' };
  assert.match(buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni', skills: [uniSkill, other] }), /스킬 폴더\(C:\\skills\\team-rules\)의 참고 파일도/);
  const plain = buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni', skills: [other] });
  assert.match(plain, /반드시 먼저 읽을 uni 규칙/);
  assert.doesNotMatch(plain, /<file path=/);
});

test('every conversion gets the nexa2vue rules skill, with or without a summary skill', () => {
  const rules = loadSkill(RULES_SKILL_DIR);
  assert.equal(rules.name, 'nexa2vue-rules');
  assert.match(rules.body, /원본 Div 하나는 영역 하나로 둔다/);
  // the rules name no project component: how a project keeps them comes from its summary skill
  assert.doesNotMatch(rules.body, /SearchSection|ButtonGroup|Field|selector-box|CCU0|q-btn|Constant/);
  // no uni rules skill is shipped any more
  assert.ok(!fs.existsSync(path.join(path.dirname(RULES_SKILL_DIR), 'nexa2vue-rules-uni')));
  // no skill picked: still the rules, and the prompt carries them; uni and other projects alike
  assert.deepEqual(uniSkills([]).map((s) => s.name), ['nexa2vue-rules']);
  assert.deepEqual(conversionSkills([], { uni: false }).map((s) => s.name), ['nexa2vue-rules']);
  const names = { view: 'AView.vue', service: 'AService.js', constant: 'AConstant.js' };
  const plain = buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni', skills: uniSkills([]) });
  assert.match(plain, /<skill name="nexa2vue-rules">/);
  assert.match(plain, /반드시 먼저 읽을 uni 규칙/);
  // the rules skill is all in the prompt: no folder to read
  assert.doesNotMatch(plain, /참고 파일도 읽어도 된다/);

  // added skills win over the rules, the rules over the summary skill; picking the rules skill adds no second copy
  const root = skillsFolder();
  try {
    const summaryDir = path.join(root, UNI_SKILL_NAME);
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(path.join(summaryDir, 'SKILL.md'), `---\nname: ${UNI_SKILL_NAME}\n---\n요약\n`);
    // an old copy of nexa2vue-rules-uni left in a skill folder is dropped like the rules skill
    const oldUni = path.join(root, 'nexa2vue-rules-uni');
    fs.mkdirSync(oldUni, { recursive: true });
    fs.writeFileSync(path.join(oldUni, 'SKILL.md'), '---\nname: nexa2vue-rules-uni\n---\n옛 uni 규칙\n');
    const skills = uniSkills([summaryDir, path.join(root, 'screen-convert'), RULES_SKILL_DIR, oldUni]);
    assert.deepEqual(skills.map((s) => s.name), ['screen-convert', 'nexa2vue-rules', UNI_SKILL_NAME]);
    assert.match(buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni', skills }), /스킬끼리 다르면 앞에 있는 스킬을 따른다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a summary skill made before the rules skill loses its old copy of the rules', () => {
  const old = '## 파일 구성\n- View.vue\n\n## 넥사크로 변환 규칙 (nexa2vue, 위 요약과 다르면 이 절을 따른다)\n- 옛 규칙\n\n## 공통 유틸 함수 목록\n- data.add(list, item)';
  assert.equal(withoutLegacyRules(old), '## 파일 구성\n- View.vue\n\n## 공통 유틸 함수 목록\n- data.add(list, item)');
  assert.equal(withoutLegacyRules('## 파일 구성\n\n## 넥사크로 변환 규칙 (nexa2vue)\n- 옛 규칙'), '## 파일 구성');
  assert.equal(withoutLegacyRules('## 파일 구성'), '## 파일 구성');

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-summary-'));
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${UNI_SKILL_NAME}\ndescription: 요약\n---\n\n${old}\n`);
    const [first, summary] = uniSkills([dir]);
    assert.equal(first.name, 'nexa2vue-rules');
    assert.equal(summary.name, UNI_SKILL_NAME);
    assert.doesNotMatch(summary.body, /옛 규칙/);
    // with the summary skill the run stays one-shot: the rules skill adds no folder to read
    const prompt = buildPrompt({ relPath: 'a', draftNames: { view: 'V', service: 'S', constant: 'C' }, uniFrontend: 'C:\\uni', skills: [first, summary], inputs: { 'source.xfdl': '<Form/>' } });
    assert.match(prompt, /## uni 규칙\n- 위 vue-convert 스킬이/);
    assert.doesNotMatch(prompt, /참고 파일도 읽어도 된다/);
    assert.ok(prompt.indexOf('<skill name="nexa2vue-rules">') < prompt.indexOf(`<skill name="${UNI_SKILL_NAME}">`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt tells Claude a screen is a popup, which sub-screens come along and which popups it opens', () => {
  const names = { view: 'AView.vue', service: 'AService.js', constant: 'AConstant.js' };
  const popup = buildPrompt({ relPath: 'a/P.xfdl', draftNames: names, uniFrontend: 'C:\\uni', relations: { role: 'popup', parent: { rel: 'a/A.xfdl', name: 'BAU0101010' }, subs: [], popups: [] } });
  assert.match(popup, /## 다른 화면과의 관계/);
  assert.match(popup, /이 화면은 팝업이다: BAU0101010\(원본 a\/A\.xfdl\)에서 popup\.open으로 연다/);
  const host = buildPrompt({
    relPath: 'a/A.xfdl', draftNames: names, uniFrontend: 'C:\\uni',
    relations: {
      role: 'screen', parent: null,
      subs: [{ rel: 'a/S.xfdl', name: 'BAU0101010Detail', parent: 'BAU0101010' }],
      popups: [{ rel: 'a/P.xfdl', name: 'BAU0101011_POP', importPath: '../BAU0101011_POP/BAU0101011_POPView.vue', from: 'BAU0101010' }],
    },
  });
  assert.match(host, /하위 화면 BAU0101010Detail\(원본 a\/S\.xfdl\): source-BAU0101010Detail\.xfdl, 초안 draft\/BAU0101010Detail\.vue/);
  assert.match(host, /subs\.BAU0101010Detail에 전체 내용/);
  assert.match(host, /import BAU0101011_POP from '\.\.\/BAU0101011_POP\/BAU0101011_POPView\.vue' 후 popup\.open/);
  assert.doesNotMatch(buildPrompt({ relPath: 'a', draftNames: names, uniFrontend: 'C:\\uni' }), /다른 화면과의 관계/);
});

test('the prompt points Claude at the uni rules and asks for full files only', () => {
  const prompt = buildPrompt({ relPath: 'ua/usr/A.xfdl', draftNames: { view: 'AView.vue', service: 'AService.js', constant: 'AConstant.js' }, uniFrontend: 'C:\\uni\\frontend' });
  assert.match(prompt, /NAMING_CONVENTION\.md/);
  assert.match(prompt, /CCU0297010~CCU0297060/);
  assert.match(prompt, /draft\/AView\.vue/);
  assert.match(prompt, /파일을 만들거나 고치지 말고/);
  assert.deepEqual(OUTPUT_SCHEMA.required, ['view', 'service', 'constant', 'notes', 'doc', 'apis']);
  assert.match(prompt, /## 변환 내용 문서 \(doc\)/);
  assert.match(prompt, /### 스크립트 변환/);
});

test('each uni screen gets a conversion document, with the AI write-up as its body', async () => {
  const reading = (five, seven) => ({ at: new Date().toISOString(), fiveHour: { utilization: five, resetsAt: 100 }, sevenDay: { utilization: seven, resetsAt: 200 } });
  const { report, written } = await run(async ({ rel, draftFiles, onUsage }) => {
    onUsage(reading(0.25, 0.06));
    onUsage(reading(0.28, 0.07));
    return {
      files: draftFiles,
      notes: rel.endsWith('BAU0101010.xfdl') ? ['gfn_setCommCode는 정의를 몰라 TODO로 남김'] : [],
      doc: rel.endsWith('BAU0101010.xfdl') ? '### 화면 개요\n- 학적변동을 조회·저장한다.\n' : '',
      costUsd: 0.42,
      durationMs: 182000,
    };
  }, { ai: true, aiParallel: 1 });
  const [first, second] = report.files;
  // one folder per screen: 개요, 변환내용, API목록, API/<이름>.html
  const { apis: docApis, ...docInfo } = first.doc;
  assert.deepEqual(docInfo, { path: 'docs/ua/usr/BAU0101010/01_개요.html', id: 'BAU0101010', screenName: '학적변동 관리' });
  // one line per API in the report, for docs/전체_API목록.html
  assert.ok(docApis.length > 0);
  assert.ok(docApis.every((a) => a.url.startsWith('/api/ua/usr/BAU0101010/') && a.page.startsWith('docs/ua/usr/BAU0101010/API/')));
  const docFiles = first.outputs.filter((p) => p.startsWith('docs/'));
  assert.deepEqual(docFiles.slice(0, 3), ['docs/ua/usr/BAU0101010/01_개요.html', 'docs/ua/usr/BAU0101010/02_변환내용.html', 'docs/ua/usr/BAU0101010/03_API목록.html']);
  assert.ok(docFiles.slice(3).length && docFiles.slice(3).every((p) => /^docs\/ua\/usr\/BAU0101010\/API\/[A-Za-z0-9_]+\.html$/.test(p)));
  const doc = written.get('docs/ua/usr/BAU0101010/01_개요.html');
  assert.match(doc, /^<!doctype html>\n<html lang="ko">/);
  assert.match(doc, /<title>BAU0101010 학적변동 관리 개요<\/title>/);
  assert.match(doc, /<a href="02_%EB%B3%80%ED%99%98%EB%82%B4%EC%9A%A9\.html">변환 내용<\/a>/);
  assert.doesNotMatch(doc, /<td><code>docs\//);
  assert.match(doc, /<h1>BAU0101010 학적변동 관리<\/h1>/);
  assert.match(doc, /<tr><td>변환 방식<\/td><td>AI\(Claude Code\) · 182초 · 사용량 5시간 \+3%\(25→28%\) · 7일 \+1%\(6→7%\)<\/td><\/tr>/);
  assert.doesNotMatch(doc, /\$0\.42/);
  assert.deepEqual(first.ai.usage, { fiveHour: { from: 25, to: 28 }, sevenDay: { from: 6, to: 7 } });
  assert.match(doc, /<td><code>src\/views\/ua\/usr\/BAU0101010\/BAU0101010View\.vue<\/code><\/td><td>화면\(배치·이벤트 처리\)<\/td>/);
  assert.match(written.get('docs/ua/usr/BAU0101010/02_변환내용.html'), /<p>AI가 변환하면서 쓴 내용입니다\.<\/p>\n<h3>화면 개요<\/h3>\n<ul><li>학적변동을 조회·저장한다\.<\/li><\/ul>/);
  assert.match(doc, /<h2>확인할 것 \(1건\)<\/h2>\n<ul><li>\[AI\] gfn_setCommCode는 정의를 몰라 TODO로 남김<\/li><\/ul>/);
  // no AI write-up: the rule-based model fills the body
  const plain = written.get(second.doc.path);
  assert.match(written.get(second.doc.path.replace('01_개요', '02_변환내용')), /<p>규칙 기반으로 변환했습니다\.<\/p>/);
  assert.match(written.get(second.doc.path.replace('01_개요', '03_API목록')), /<th>API<\/th><th>메서드<\/th><th>주소<\/th><th>보내는 값<\/th><th>받는 값<\/th>/);
  assert.match(plain, /<h2>확인할 것 \(0건\)<\/h2>\n<ul><li>없음<\/li><\/ul>/);

  assert.equal(report.docs, 'docs/index.html');
  const index = written.get('docs/index.html');
  assert.match(index, /<tr><td><a href="ua\/usr\/BAU0101010\/01_%EA%B0%9C%EC%9A%94\.html">BAU0101010<\/a><\/td><td>학적변동 관리<\/td><td><code>ua\/usr\/BAU0101010\.xfdl<\/code><\/td><td>AI\(Claude Code\) · 182초 · 사용량 5시간 \+3%\(25→28%\) · 7일 \+1%\(6→7%\)<\/td><td>확인 필요<\/td><td>\d+<\/td><td>1<\/td><\/tr>/);
  // every screen's APIs in one page, linked from the index
  assert.match(index, /<a href="%EC%A0%84%EC%B2%B4_API%EB%AA%A9%EB%A1%9D\.html">전체 API 목록<\/a>/);
  const all = written.get('docs/전체_API목록.html');
  assert.match(all, /<th>화면ID<\/th><th>화면명<\/th><th>API<\/th><th>메서드<\/th><th>주소<\/th>/);
  assert.match(all, /<a href="ua\/usr\/BAU0101010\/API\/[A-Za-z0-9_]+\.html">/);
  assert.match(all, /BAU0102010/);
  assert.match(index, /<tr><td>Claude 사용량<\/td><td>5시간 \+3%\(25→28%\) · 7일 \+1%\(6→7%\) — 이번 변환 전체<\/td><\/tr>/);
  assert.match(index, /전체 2 · 완료 1 · 확인 필요 1 · 실패 0/);
});

test('the "after" usage reading comes from a probe once the work is done (Claude Code reports only at session start)', async () => {
  const reading = (five) => ({ at: new Date().toISOString(), fiveHour: { utilization: five, resetsAt: 100 }, sevenDay: null });
  // one at a time: each screen sees only its session-start reading, the probe after it gives the real end
  let now = 0.34;
  const one = await run(async ({ draftFiles, onUsage }) => {
    onUsage(reading(now));
    now += 0.03; // what this screen really used, visible only to the next reading
    return { files: draftFiles, notes: [], costUsd: 0.5, durationMs: 1000 };
  }, { ai: true, aiParallel: 1, env: { usageProbe: async () => reading(now) } });
  const [a, b] = one.report.files;
  assert.deepEqual(a.ai.usage, { fiveHour: { from: 34, to: 37 } });
  assert.deepEqual(b.ai.usage, { fiveHour: { from: 37, to: 40 } });
  assert.deepEqual(one.report.usage, { fiveHour: { from: 34, to: 40 } });

  // several at once: one probe at the end, then split by cost
  let probes = 0;
  const many = await run(async ({ rel, draftFiles, onUsage }) => {
    onUsage(reading(0.34));
    return { files: draftFiles, notes: [], costUsd: rel.endsWith('BAU0101010.xfdl') ? 3 : 1, durationMs: 1000 };
  }, { ai: true, aiParallel: 2, env: { usageProbe: async () => (probes++, reading(0.38)) } });
  assert.equal(probes, 1);
  assert.deepEqual(many.report.usage, { fiveHour: { from: 34, to: 38 } });
  assert.deepEqual(many.report.files.map((f) => f.ai.usage.fiveHour.share), [3, 1]);

  // several at once but only one screen used AI: its usage is the measured run figure, not an estimate
  const single = await run(async ({ rel, draftFiles, onUsage }) => {
    if (!rel.endsWith('BAU0101010.xfdl')) throw new Error('usage limit');
    onUsage(reading(0.43));
    return { files: draftFiles, notes: [], costUsd: 2.5, durationMs: 1000 };
  }, { ai: true, aiParallel: 3, env: { usageProbe: async () => reading(0.72) } });
  assert.deepEqual(single.report.files[0].ai.usage, { fiveHour: { from: 43, to: 72 } });
  assert.match(single.written.get('docs/ua/usr/BAU0101010/01_개요.html'), /사용량 5시간 \+29%\(43→72%\)<\/td>/);

  // a failed probe keeps what was seen
  const failed = await run(async ({ draftFiles, onUsage }) => {
    onUsage(reading(0.34));
    return { files: draftFiles, notes: [], costUsd: 0.5, durationMs: 1000 };
  }, { ai: true, aiParallel: 1, env: { usageProbe: async () => null } });
  assert.deepEqual(failed.report.usage, { fiveHour: { from: 34, to: 34 } });
});

test('screens converted at the same time get the run usage split by their token cost', async () => {
  const reading = (five) => ({ at: new Date().toISOString(), fiveHour: { utilization: five, resetsAt: 100 }, sevenDay: null });
  let calls = 0;
  const { report, written } = await run(async ({ rel, draftFiles, onUsage }) => {
    onUsage(reading(calls++ === 0 ? 0.2 : 0.3));
    return { files: draftFiles, notes: [], costUsd: rel.endsWith('BAU0101010.xfdl') ? 0.6 : 0.4, durationMs: 1000 };
  }, { ai: true, aiParallel: 2 });
  const [first, second] = report.files;
  assert.deepEqual(report.usage, { fiveHour: { from: 20, to: 30 } });
  assert.deepEqual(first.ai.usage, { estimated: true, fiveHour: { share: 6 } });
  assert.deepEqual(second.ai.usage, { estimated: true, fiveHour: { share: 4 } });
  // The screen document was written again with the estimate
  assert.match(written.get('docs/ua/usr/BAU0101010/01_개요.html'), /사용량 5시간 약 \+6% \(추정: 동시 변환이라 전체 사용량을 화면별 토큰 비용 비율로 나눔\)/);
  assert.match(written.get('docs/ua/usr/BAU0102010/01_개요.html'), /사용량 5시간 약 \+4% \(추정/);
});

test('what the AI wrote cannot become markup in the HTML document', async () => {
  const { written } = await run(async ({ draftFiles }) => ({
    files: draftFiles,
    notes: ['<img src=x onerror=alert(1)> 확인'],
    doc: '### 개요\n<script>alert(1)</script>\n- [링크](javascript:alert(1))\n',
    costUsd: 0,
    durationMs: 0,
  }), { ai: true });
  const doc = written.get('docs/ua/usr/BAU0101010/01_개요.html');
  const body = written.get('docs/ua/usr/BAU0101010/02_변환내용.html');
  for (const page of [doc, body]) assert.doesNotMatch(page, /<script|<img|href="javascript/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(doc, /<li>\[AI\] &lt;img src=x onerror=alert\(1\)&gt; 확인<\/li>/);
});

test('an API in the AI spec that the written code does not call goes into 확인할 것', async () => {
  const { cleanAiApis } = require('../src/api-spec');
  const { report, written } = await run(async ({ draftFiles }) => ({
    files: draftFiles,
    notes: [],
    doc: '',
    apis: cleanAiApis([
      { name: 'findBamn010List', desc: '학생 목록 조회', method: 'GET', url: '/api/ua/usr/BAU0101010/findBamn010List', service: 'BAU0101010Service.findBamn010List', requestShape: 'none', responseShape: 'list', response: [{ name: 'stdNo', type: 'string', desc: '학번' }] },
      { name: 'findGhostList', desc: '없는 조회', method: 'GET', url: '/api/ua/usr/BAU0101010/findGhostList', service: 'BAU0101010Service.findGhostList', requestShape: 'none', responseShape: 'none' },
    ]),
    costUsd: 0,
    durationMs: 0,
  }), { ai: true });
  const first = report.files[0];
  assert.deepEqual(first.todos.filter((t) => /API 명세/.test(t.message)).map((t) => t.message),
    ['[검사] API 명세 findGhostList: 변환된 코드에서 찾지 못함(함수 findGhostList, 주소 /api/ua/usr/BAU0101010/findGhostList)']);
  assert.match(written.get('docs/ua/usr/BAU0101010/API/findGhostList.html'), /⚠ 확인 필요/);
  assert.doesNotMatch(written.get('docs/ua/usr/BAU0101010/API/findBamn010List.html'), /⚠ 확인 필요/);
});

test('a failed AI pass still documents the screen, rule-based', async () => {
  const { report, written } = await run(async () => {
    throw new Error('시간 초과');
  }, { ai: true });
  const doc = written.get(report.files[0].doc.path);
  assert.match(doc, /<td>변환 방식<\/td><td>규칙 기반 \(AI 실패: 시간 초과\)<\/td>/);
  assert.match(written.get(report.files[0].doc.path.replace('01_개요', '02_변환내용')), /규칙 기반으로 변환했습니다/);
  assert.match(doc, /<li>\[AI\] 변환 실패 — 규칙 기반 초안을 저장했습니다: 시간 초과/);
});

test('skill frontmatter is read with or without a space after the colon', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nexa2vue-skillname-'));
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname:sample\ndescription:  short\n---\nbody\n');
    const skill = loadSkill(dir);
    assert.equal(skill.name, 'sample');
    assert.equal(skill.description, 'short');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a saved rule-based draft is checked too; AI output that passed is not checked again', async () => {
  const checked = [];
  const checkDraft = (files) => {
    checked.push(files.map((f) => f.path));
    return [{ file: files[0].path, line: 3, component: 'Field', message: '<Field> 필수 prop item 없음' }];
  };
  const go = (aiConvert, opts) => convertSources(sources.slice(0, 1), {
    input: 'in', output: 'out', write: () => {}, compatSource: '', aiConvert, checkFiles: checkDraft,
  }, { profile: 'uni', ...opts });

  const failed = await go(async () => { throw new Error('사용 한도'); }, { ai: true });
  assert.equal(checked.length, 1);
  assert.match(failed.files[0].todos[0].message, /^\[검사\] 초안 src\/views\/.+:3 <Field> 필수 prop item 없음$/);
  assert.equal(failed.files[0].ai.ok, false);
  assert.equal(failed.files[0].ai.checks, undefined);

  await go(undefined, {});
  assert.equal(checked.length, 2);

  // AI output is checked once, as AI output (not again as a draft)
  const aiOut = await go(async ({ draftFiles }) => ({ files: draftFiles, notes: [] }), { ai: true });
  assert.equal(checked.length, 3);
  assert.deepEqual(aiOut.files[0].todos.map((t) => t.message.split(' ').slice(0, 2).join(' ')), ['[검사] src/views/ua/usr/BAU0101010/BAU0101010View.vue:3']);
});

// A fake project check: a file is wrong while it still has `v-model` on <Field>.
const fieldCheck = (files) => files.filter((f) => /<Field v-model/.test(f.content))
  .map((f) => ({ file: f.path, line: 2, component: 'Field', message: '<Field> 필수 prop item·model 없음' }));

test('fix round: caught spots go back to the AI once; fixed screens pass, and only the given files change', async () => {
  const fixCalls = [];
  const go = (aiFix, opts = {}) => {
    const written = new Map();
    return convertSources(sources.slice(0, 1), {
      input: 'in', output: 'out', write: (rel, content) => written.set(rel, content), compatSource: '',
      aiConvert: async ({ draftFiles }) => ({
        files: draftFiles.map((f) => ({ path: f.path, content: f.path.endsWith('View.vue') ? '<template>\n<Field v-model="x" />\n</template>\n' : '// AI\n' })),
        notes: [], costUsd: 0.5, durationMs: 1,
      }),
      checkFiles: fieldCheck,
      aiFix,
    }, { profile: 'uni', ai: true, ...opts }).then((report) => ({ line: report.files[0], written }));
  };

  const fixed = await go(async ({ rel, files, checks }) => {
    fixCalls.push({ rel, files: files.length, checks });
    const view = files.find((f) => f.path.endsWith('View.vue'));
    return { files: [{ path: view.path, content: '<template>\n<Field :item="i" :model="m" />\n</template>\n' }], notes: ['item 정의를 Constant에 추가함'], costUsd: 0.1, durationMs: 5 };
  });
  assert.equal(fixCalls.length, 1);
  assert.equal(fixCalls[0].checks.length, 1);
  assert.equal(fixed.line.ai.ok, true);
  assert.deepEqual(fixed.line.ai.fix, { before: 1, after: 0, files: 1, durationMs: 5, costUsd: 0.1 });
  assert.equal(fixed.line.ai.costUsd, 0.6);
  assert.deepEqual(fixed.line.todos.map((t) => t.message), ['[AI 수정] item 정의를 Constant에 추가함']);
  const viewPath = [...fixed.written.keys()].find((p) => p.endsWith('View.vue'));
  assert.match(fixed.written.get(viewPath), /:item="i"/);
  assert.equal(fixed.written.get(viewPath.replace('View.vue', 'Service.js')), '// AI\n');

  // still wrong after the fix: files kept, screen failed for the retry
  const still = await go(async () => ({ files: [], notes: [], durationMs: 1 }));
  assert.equal(still.line.ai.ok, false);
  assert.equal(still.line.ai.checks.length, 1);
  assert.deepEqual({ before: still.line.ai.fix.before, after: still.line.ai.fix.after }, { before: 1, after: 1 });

  // the fix call itself fails: same as not fixed, the reason kept
  const broke = await go(async () => { throw new Error('사용 한도'); });
  assert.equal(broke.line.ai.ok, false);
  assert.equal(broke.line.ai.fix.error, '사용 한도');

  // switched off: no fix round
  fixCalls.length = 0;
  const off = await go(async () => { fixCalls.push(1); return { files: [], notes: [] }; }, { aiFix: false });
  assert.equal(fixCalls.length, 0);
  assert.equal(off.line.ai.ok, false);
});

test('the fix prompt carries the issues, the real declarations and what really exists', () => {
  const { buildFixPrompt } = require('../src/ai-convert');
  const prompt = buildFixPrompt({
    relPath: 'ua/A.xfdl',
    checks: [{ file: 'src/pages/A.vue', line: 2, message: '<AppInput> 필수 prop label 없음' }],
    files: [{ path: 'src/pages/A.vue', content: '<template><AppInput /></template>' }],
    context: {
      components: [{ component: 'AppInput', file: 'src/shared/ui/AppInput.vue', source: '<script setup>defineProps({ label: { type: String, required: true } })</script>' }],
      exports: [{ source: '~/shared/ui', names: ['AppInput', 'AppDialog'] }],
      folders: [{ source: '~/components/SearchBox.vue', files: ['src/components/Legacy.vue'] }],
    },
  });
  assert.match(prompt, /- src\/pages\/A\.vue:2 <AppInput> 필수 prop label 없음/);
  assert.match(prompt, /<file path="src\/shared\/ui\/AppInput\.vue">\n<script setup>defineProps/);
  assert.match(prompt, /'~\/shared\/ui'의 export: AppInput, AppDialog/);
  assert.match(prompt, /'~\/components\/SearchBox\.vue'가 가리키는 폴더의 파일: src\/components\/Legacy\.vue/);
  assert.ok(prompt.indexOf('## 고칠 파일') > prompt.indexOf('## 컴포넌트 선언'));
});

test('index doc links are URL-encoded so odd folder names still open', () => {
  const { indexDoc } = require('../src/conversion-doc');
  const html = indexDoc({
    summary: { total: 1, ok: 1, partial: 0, error: 0, todos: 0 }, startedAt: 'a', finishedAt: 'b', input: 'in', output: 'out',
    files: [{ input: 'x.xfdl', status: 'ok', todos: [], doc: { id: 'A1', screenName: '화면', path: 'docs/my dir (1)/A1.html' } }],
  });
  assert.match(html, /href="my%20dir%20%281%29\/A1\.html"/);
});
