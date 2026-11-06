'use strict';

// AI conversion (uni profile, Node only): the rule-based draft plus the
// original .xfdl go to the Claude Code CLI installed and logged in on this PC,
// which ports the script into the uni frontend conventions. Claude gets
// read-only tools (its work folder + the uni frontend for docs and examples);
// with the vue-convert summary skill it gets the inputs inline and no tools.
// Files are written by nexa2vue, never by Claude.
// Note: this sends the screen source to Anthropic, so it runs only when asked for.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fixContext } = require('./component-check');
const { cleanAiApis } = require('./api-spec');

// Per screen. Large screens took 7~10 minutes in practice, so 10 was too tight
// (config aiTimeout / --ai-timeout, in minutes).
const DEFAULT_TIMEOUT_MIN = 20;
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MIN * 60 * 1000;
// After a timeout or cancel, how long to wait for Claude Code to exit.
const STOP_GRACE_MS = 5000;

// API 명세 for the conversion document (api-spec.js renders it): one entry per
// server call the converted code makes, matching that code. Vue mode (another
// project) gets project-neutral wording: no uni names, no Spring backend.
const API_FIELD = (withRequired, uni) => ({
  type: 'object',
  properties: {
    name: { type: 'string', description: '파라미터·필드 이름(코드에서 쓰는 그대로)' },
    type: { type: 'string', description: '형식: string, number, boolean, string (YYYY-MM-DD) 등' },
    ...(withRequired ? { required: { type: 'boolean', description: '꼭 보내야 하면 true' } } : {}),
    desc: { type: 'string', description: uni ? '뜻(원본 라벨·컬럼 설명), 값 규칙(I/U/D, 코드 그룹 등)' : '뜻(원본 라벨·컬럼 설명), 값 규칙(행 상태값, 코드 그룹 등)' },
  },
  required: ['name', 'type', ...(withRequired ? ['required'] : []), 'desc'],
});
const apiSpecSchema = (uni) => ({
  type: 'array',
  description: '이 화면이 부르는 API 전부(서버 호출이 없으면 빈 배열). 변환한 코드와 똑같이',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: uni ? 'API(Service 함수) 이름' : 'API(호출 함수) 이름' },
      desc: { type: 'string', description: '하는 일 한 줄' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      url: { type: 'string', description: uni ? '브라우저가 실제로 요청하는 전체 주소: axios baseURL(/api) + Service basicUrl + 함수 경로(= Controller @RequestMapping + 메서드 경로), 예: /api/ua/usr/화면ID/findXxxList' : '브라우저가 실제로 요청하는 전체 주소: 프로젝트의 기본 주소(axios baseURL·프록시 등, 스킬에 있으면 그대로)를 앞에 붙인다. 기본 주소를 모르면 코드에 쓴 주소 그대로 쓰고 desc 끝에 \"(기본 주소 미확인)\"을 붙인다' },
      service: { type: 'string', description: uni ? '프론트 호출 함수, 예: XxxService.findXxxList' : '화면 코드의 호출 함수(파일·함수 이름 그대로)' },
      backend: { type: 'string', description: uni ? '백엔드 Controller 메서드(만들지 않았으면 빈 문자열)' : '백엔드 처리 위치(이번에 만들지 않았으면 빈 문자열)' },
      source: { type: 'string', description: '원본 transaction svcId·입력/출력 Dataset' },
      requestShape: { type: 'string', enum: ['query', 'object', 'list', 'none'], description: 'query=쿼리 파라미터, object=JSON 객체 본문, list=JSON 배열 본문(행마다 request 필드), none=보내는 값 없음' },
      request: { type: 'array', description: '보내는 값(필드마다 하나)', items: API_FIELD(true, uni) },
      responseShape: { type: 'string', enum: ['list', 'object', 'value', 'none'], description: 'list=배열(행마다 response 필드), object=객체 하나, value=값 하나, none=받는 값 없음' },
      response: { type: 'array', description: '받는 값(필드마다 하나, 화면이 쓰는 것 기준)', items: API_FIELD(false, uni) },
    },
    required: ['name', 'desc', 'method', 'url', 'service', 'backend', 'source', 'requestShape', 'request', 'responseShape', 'response'],
  },
});
const API_SPEC_SCHEMA = apiSpecSchema(true);

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    view: { type: 'string', description: 'View.vue 전체 내용' },
    service: { type: 'string', description: 'Service.js 전체 내용' },
    constant: { type: 'string', description: 'Constant.js 전체 내용' },
    // Tab pages (원본 Tab → KeepAliveTabs): one .vue per Tabpage next to the View.
    tabs: {
      type: 'array',
      description: '원본 Tab의 탭 페이지 컴포넌트(화면 폴더에 같이 둔다). 탭이 없으면 빈 배열',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '확장자 없는 파일·컴포넌트 이름: {화면ID}Tab{이름}' },
          content: { type: 'string', description: '.vue 전체 내용' },
        },
        required: ['name', 'content'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: '사람이 확인할 것(옮기지 못한 것, 추정한 것)' },
    doc: { type: 'string', description: '변환 내용 문서(마크다운, ### 제목부터)' },
    apis: API_SPEC_SCHEMA,
  },
  required: ['view', 'service', 'constant', 'notes', 'doc', 'apis'],
};

// AI tab pages → files beside the View. Names must be {screenId}Tab{Word} and
// must not clash with the screen's own files or sub-screens.
function tabFiles(tabs, viewPath, taken) {
  if (!Array.isArray(tabs) || !tabs.length) return [];
  const dir = path.posix.dirname(viewPath);
  const screenId = path.posix.basename(viewPath).replace(/View\.vue$/, '');
  const pattern = new RegExp(`^${screenId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}Tab[A-Za-z0-9_]+$`);
  const seen = new Set(taken);
  return tabs.map((t) => {
    const name = String((t && t.name) || '').replace(/\.vue$/, '');
    if (!pattern.test(name)) throw new Error(`AI 응답의 탭 파일 이름이 규칙(${screenId}Tab…)과 다릅니다: ${name || '(없음)'}`);
    const p = `${dir}/${name}.vue`;
    if (seen.has(p)) throw new Error(`AI 응답의 탭 파일 이름이 겹칩니다: ${name}`);
    if (typeof t.content !== 'string' || !t.content.trim()) throw new Error(`AI 응답에 탭 ${name} 내용이 없습니다`);
    seen.add(p);
    return { path: p, content: t.content.endsWith('\n') ? t.content : `${t.content}\n` };
  });
}

// With a uni backend: the five backend files of the screen as well.
const BACKEND_KEYS = [
  ['controller', 'Controller.java'],
  ['service', 'Service.java'],
  ['mapper', 'Mapper.java'],
  ['dto', 'Dto.java'],
  ['mapperXml', 'Mapper.xml'],
];
const OUTPUT_SCHEMA_BACKEND = {
  ...OUTPUT_SCHEMA,
  properties: {
    ...OUTPUT_SCHEMA.properties,
    backend: {
      type: 'object',
      properties: Object.fromEntries(BACKEND_KEYS.map(([k, suffix]) => [k, { type: 'string', description: `${suffix} 전체 내용` }])),
      required: BACKEND_KEYS.map(([k]) => k),
    },
  },
  required: [...OUTPUT_SCHEMA.required, 'backend'],
};

// With sub-screens: each one's whole .vue under subs.<name>.
function withSubs(schema, subs) {
  if (!subs.length) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      subs: {
        type: 'object',
        properties: Object.fromEntries(subs.map((s) => [s.name, { type: 'string', description: `${s.name}.vue 전체 내용` }])),
        required: subs.map((s) => s.name),
      },
    },
    required: [...schema.required, 'subs'],
  };
}

// Where this screen stands among the others, as confirmed before conversion
// (screen-roles.js): popup, sub-screens converted along, popups it opens.
function relationPrompt(relations) {
  if (!relations) return '';
  const lines = [];
  if (relations.role === 'popup') {
    lines.push(`- 이 화면은 팝업이다${relations.parent ? `: ${relations.parent.name}(원본 ${relations.parent.rel})에서 popup.open으로 연다` : '(여는 화면은 이번 변환에 없다)'}. 기본 화면 A5 팝업(CCU0297051_POP)과 같은 계약을 지킨다: props modelValue·row(여는 쪽이 넘긴 초기 조건), 결과는 emit('callback', { data: 결과 | null }) 뒤 emit('update:modelValue', false). 초안의 Popup 틀·confirm·close는 두고, 원본에서 this.close(값)·opener/arguments로 주고받던 것을 row와 close(값)으로 옮긴다.`);
  }
  for (const s of relations.subs || []) {
    lines.push(`- 하위 화면 ${s.name}(원본 ${s.rel}): source-${s.name}.xfdl, 초안 draft/${s.name}.vue. ${s.parent}의 원래 Div 자리에 <${s.name} />로 들어가 있고, Service·Constant는 이 화면 것을 같이 쓴다(초안에 이미 합쳐 두었고 이름이 겹치지 않게 해 두었다). 원본에서 this.parent…로 부모를 부르거나 부모가 하위 화면을 부르던 것은 props·emit(또는 defineExpose)로 옮긴다. 하위 화면도 같은 규칙으로 옮기고 subs.${s.name}에 전체 내용을 담는다.`);
  }
  for (const p of relations.popups || []) {
    lines.push(`- 여는 팝업 ${p.name}(원본 ${p.rel}): ${p.from}에서 import ${p.name} from '${p.importPath}' 후 popup.open(${p.name}, { row })로 연다(초안의 open${p.name.replace(/_POP$/, '')}Popup). 원본에서 그 팝업을 열던 곳(gfn_openPopup·showModal·ChildFrame 등)과 연결하고, 원본 콜백에서 하던 일을 await 뒤에 옮긴다. 팝업 파일은 따로 변환하므로 고치지 않는다.`);
  }
  return lines.length ? `## 다른 화면과의 관계 (변환 전에 사람이 확인함)\n${lines.join('\n')}\n\n` : '';
}

function readSkillFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const field = (key) => {
    const m = front && new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front[1]);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return {
    name: field('name') || path.basename(path.dirname(file)),
    description: field('description'),
    dir: path.dirname(file),
    body: (front ? text.slice(front[0].length) : text).trim(),
  };
}

// Skill folders right under a skills folder (like .claude\skills), by name.
function childSkillFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => path.join(dir, e.name, 'SKILL.md'))
    .sort();
}

/**
 * Conversion rules supplied as a Claude Code skill: a folder with SKILL.md
 * (or the SKILL.md file itself). Returns { name, description, dir, body }.
 */
function loadSkill(skillPath) {
  const target = path.resolve(skillPath);
  if (!fs.existsSync(target)) throw new Error(`변환 규칙 스킬을 찾을 수 없습니다: ${skillPath}`);
  const isDir = fs.statSync(target).isDirectory();
  const file = isDir ? path.join(target, 'SKILL.md') : target;
  if (!fs.existsSync(file)) {
    const children = isDir ? childSkillFiles(target) : [];
    if (children.length) {
      throw new Error(`이 폴더에는 스킬이 여러 개 있습니다(${children.map((f) => path.basename(path.dirname(f))).join(', ')}). 쓸 스킬 폴더를 하나씩 지정하세요: ${skillPath}`);
    }
    throw new Error(`스킬 폴더에 SKILL.md가 없습니다: ${skillPath}`);
  }
  return readSkillFile(file);
}

/** Several skills (a path, a list of paths or nothing), in order, each once. */
function loadSkills(skillPaths) {
  const list = (Array.isArray(skillPaths) ? skillPaths : [skillPaths]).filter((p) => typeof p === 'string' && p.trim());
  const seen = new Set();
  return list.map((p) => loadSkill(p.trim())).filter((s) => !seen.has(s.dir) && seen.add(s.dir));
}

/**
 * The skills a folder offers: itself when it holds SKILL.md, otherwise the
 * skill folders right under it (a .claude\skills folder).
 * Returns { folder, single, skills: [{ name, description, dir }] }.
 */
function listSkills(folder) {
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('스킬 폴더를 입력하세요');
  const target = path.resolve(folder.trim());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`스킬 폴더를 찾을 수 없습니다: ${folder}`);
  const own = path.join(target, 'SKILL.md');
  const files = fs.existsSync(own) ? [own] : childSkillFiles(target);
  if (!files.length) throw new Error(`이 폴더에도, 바로 아래 폴더에도 SKILL.md가 없습니다: ${folder}`);
  return {
    folder: target,
    single: files[0] === own,
    skills: files.map((f) => {
      const { name, description, dir } = readSkillFile(f);
      return { name, description, dir };
    }),
  };
}

// The summary skill nexa2vue makes at 구조 파악 (uni-skill.js SKILL_NAME). It
// already holds the uni docs, base screens and utils list, so a screen needs
// no project reads: the inputs go into the prompt and Claude answers in one turn.
const UNI_SKILL_NAME = 'vue-convert';
// Skills made before the rename are still the summary skill.
const LEGACY_SKILL_NAMES = ['uni-convert'];
const isSummarySkill = (s) => s.name === UNI_SKILL_NAME || LEGACY_SKILL_NAMES.includes(s.name);

function usesUniSkill(skills) {
  return skills.some(isSummarySkill);
}

// The fixed conversion rules, shipped with nexa2vue as a skill:
// nexa2vue-rules = how a Nexacro screen is carried over, in any Vue project.
// Every conversion gets it, with or without a summary skill. How those rules
// are kept with a project's own components is not shipped: the summary skill
// (uni-skill.js, made at 구조 파악 from that project's code) writes it.
// Skills win in prompt order: ones the user added, then these rules, then the
// summary skill.
const RULES_SKILL_DIR = path.join(__dirname, '..', 'skills', 'nexa2vue-rules');
// nexa2vue-rules-uni was shipped until 2026-11; a copy left in a skill folder is
// still dropped like the rules skill (the summary skill replaces it).
const RULES_SKILL_NAMES = ['nexa2vue-rules', 'nexa2vue-rules-uni'];
const isRulesSkill = (s) => RULES_SKILL_NAMES.includes(s.name);
// Summary skills made before the rules had their own skill carry an old copy of
// them; it is cut so a stale rule cannot contradict the current one.
const LEGACY_RULES_HEADING = '## 넥사크로 변환 규칙 (nexa2vue';

function withoutLegacyRules(body) {
  const at = body.indexOf(LEGACY_RULES_HEADING);
  if (at < 0) return body;
  const rest = body.slice(at + LEGACY_RULES_HEADING.length);
  const next = rest.search(/\n## /);
  return `${body.slice(0, at).trimEnd()}${next < 0 ? '' : `\n\n${rest.slice(next + 1)}`}`.trim();
}

/**
 * Skills for a conversion, in the order they win: skills the user added
 * (picked order), then the fixed rules (the uni ones only for uni), then the
 * summary skill 구조 파악 made.
 */
// uni / vue get the same rules skill; the project-specific way of keeping it
// comes from the summary skill. (opts kept for callers: { uni })
function conversionSkills(skillPaths, opts = {}) { // eslint-disable-line no-unused-vars
  const picked = loadSkills(skillPaths).filter((s) => !isRulesSkill(s));
  const added = picked.filter((s) => !isSummarySkill(s));
  const summary = picked.filter(isSummarySkill).map((s) => ({ ...s, body: withoutLegacyRules(s.body) }));
  return [...added, loadSkill(RULES_SKILL_DIR), ...summary];
}

const uniSkills = (skillPaths) => conversionSkills(skillPaths, { uni: true });

// Skill folders Claude may still read from: all of them, except the uni summary
// skill's and the rules skill's (just a SKILL.md each, already in the prompt).
function readableSkills(skills) {
  return skills.filter((s) => !isSummarySkill(s) && !isRulesSkill(s));
}

function skillSection(skills) {
  if (!skills.length) return '';
  const readable = readableSkills(skills);
  return `## 변환 규칙 (스킬: ${skills.map((s) => s.name).join(', ')})
이 작업의 규칙은 아래 스킬이다.${readable.length ? ` 스킬 폴더(${readable.map((s) => s.dir).join(', ')})의 참고 파일도 읽어도 된다.` : ''} 스킬이 아래 기본 규칙과 다르면 스킬을 따르고, 스킬이 정하지 않은 부분만 기본 규칙을 따른다.${skills.length > 1 ? ' 스킬끼리 다르면 앞에 있는 스킬을 따른다.' : ''}

${skills.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`).join('\n\n')}

`;
}

/**
 * inputs: { 'source.xfdl': text, 'draft/<name>': text, ... }, given with the
 * vue-convert skill: the files go into the prompt and the uni rules come from
 * the skill alone (no "read these first" list, no project reads).
 */
// A retry of a screen whose last AI output used common components wrongly
// (component-check.js) is told what was wrong, so it is not done again.
function previousChecksPrompt(checks) {
  if (!Array.isArray(checks) || !checks.length) return '';
  return `## 지난 변환에서 틀린 곳 (이번에는 고친다)
지난 AI 변환 결과에서 프로젝트 컴포넌트를 잘못 써서(선언과 다른 props, 없는 export·파일) 화면이 열리지 않았다. 같은 실수를 하지 말고, 이런 곳은 컴포넌트 문서·선언(props)대로, 실제로 있는 컴포넌트만 쓴다.
${checks.map((c) => `- ${c.file}:${c.line} ${c.message}`).join('\n')}

`;
}

function buildPrompt({ relPath, draftNames, uniFrontend, skills = [], backend, inputs, relations, previousChecks }) {
  const oneShot = usesUniSkill(skills);
  const docs = ['README.md', 'NAMING_CONVENTION.md', 'src/components/README.md', 'src/components/form/README.md', 'src/views/co/csm/README.md']
    .map((d) => `- ${path.join(uniFrontend, d)}`).join('\n');
  const rules = oneShot
    ? `## uni 규칙
- 위 ${UNI_SKILL_NAME} 스킬이 uni 문서·기준 화면·공통 유틸 목록의 요약이다. uni 프로젝트 파일은 따로 읽지 않는다.
- 공통 유틸은 스킬의 함수 목록에 있는 것만 쓴다. 스킬로 알 수 없는 규칙은 지어내지 말고 TODO(nexa2vue)로 남긴다.
`
    : `## 반드시 먼저 읽을 uni 규칙 (읽기 전용)
${docs}
- 가장 가까운 기본 화면(${path.join(uniFrontend, 'src/views/co/csm')}의 CCU0297010~CCU0297060)과 부품 사용법(CCU0298010~CCU0298050)을 열어 같은 방식으로 쓴다.
- 공통 유틸은 ${path.join(uniFrontend, 'src/utils')}(data, option, validate, task, file, MSG, popup)를 확인하고 실제 있는 함수만 쓴다.
`;
  return `넥사크로 화면을 uni frontend(Vue 3 + Quasar) 화면 표준으로 옮기는 작업이다. 결과는 JSON(view, service, constant, tabs, notes, doc, apis)으로만 답한다.

## 입력 (${inputs ? '맨 아래 <file> 블록에 전문이 있다' : '현재 폴더'})
- source.xfdl: 넥사크로 원본(${relPath}). 배치·Dataset·Bind·스크립트가 모두 들어 있다.
- draft/${draftNames.view}, draft/${draftNames.service}, draft/${draftNames.constant}: 규칙 기반 1차 초안. 배치는 이미 화면 표준(SearchSection·Section·DataGrid·Form·ButtonGroup)으로 잡혀 있고, 스크립트는 옮기지 않았다(맨 아래 주석에 원본 스크립트가 있다).

${skillSection(skills)}${rules}
${relationPrompt(relations)}${previousChecksPrompt(previousChecks)}## 할 일 (기본 규칙)
1. 초안의 화면ID, 파일명, export 이름(XXXView/XXXService/XXXConstant), defineOptions name, basicUrl은 그대로 둔다.
2. 원본 스크립트의 동작을 uni 방식으로 옮긴다.
   - form onload 초기화 → onMounted. 공통코드 조회(gfn_* 등)는 Constant의 commonOptions + option.setCommon, 그리드 코드값은 :option-map으로 연결.
   - transaction → Service 함수(이름 규칙: find/save + 대상 토큰 + List/Info). 화면은 task.run 안에서 service를 부른다. 입력·출력 Dataset을 보고 params와 결과를 어느 ref에 넣을지 맞춘다. 콜백 내용은 호출 뒤에 이어서 옮긴다.
   - Dataset 조작(addRow/setColumn/getColumn/deleteRow/rowposition 등) → data.add/remove/setStatus, rows.value[i].field, 선택 행 ref.
   - 버튼·그리드 이벤트 핸들러, 입력 검증(필수값 등 → validate 또는 required), alert/confirm(공통 문구는 MSG) 옮기기.
   - 초안이 버튼만 보고 만든 표준 함수(조회·추가·삭제·저장·엑셀)는 원본 로직과 맞게 고친다.
3. 원본에 있던 배치·라벨·컬럼 중 초안에서 빠졌거나 틀린 것이 있으면 고친다. 숨김 처리·간격용 Static은 배치하지 않는다.4. 필드 키는 초안처럼 Dataset 컬럼을 camelCase로 쓴다(STD_NO → stdNo).
5. 옮길 수 없는 것(정의를 모르는 gfn_* 함수, 다른 화면·팝업 호출, 서버 규칙을 모르는 부분)은 지어내지 말고 그 자리에 // TODO(nexa2vue): 설명 주석을 남기고 notes에도 적는다.
6. 처리한 TODO(nexa2vue) 주석은 지우고, 맨 아래 원본 스크립트 주석도 지운다(옮긴 결과가 대신한다).
7. 코드 스타일은 uni 기본 화면과 같게(2칸 들여쓰기, 세미콜론 없음, 작은따옴표, 한국어 주석은 기본 화면 수준).
8. 파일을 만들거나 고치지 말고, 세 파일의 전체 내용을 view/service/constant에 담아 답한다. 원본에 Tab이 있으면 초안이 세로로 펼쳐 둔 탭 영역을 KeepAliveTabs로 바꾸고, 탭 페이지마다 컴포넌트 하나를 tabs에 { name: '{화면ID}Tab{이름}', content: .vue 전체 }로 담는다(초안 이름의 화면ID 그대로, 예: ${draftNames.view.replace(/View\.vue$/, '')}Tab1). 탭이 없으면 tabs는 빈 배열. notes는 한국어로 짧게.${backend ? backendPrompt(backend, oneShot) : ''}

${DOC_PROMPT}${inputs ? inputBlocks(inputs) : ''}`;
}

function inputBlocks(inputs) {
  const blocks = Object.entries(inputs).map(([name, text]) => `<file path="${name}">\n${text.replace(/\s+$/, '')}\n</file>`);
  return `\n\n## 입력 파일\n${blocks.join('\n\n')}`;
}

// The write-up that becomes docs/…/<화면ID>.md (conversion-doc.js adds the
// header, file list and the notes as "확인할 것").
const DOC_PROMPT = `## 변환 내용 문서 (doc)
이 화면을 맡을 개발자가 원본과 결과를 맞춰 볼 수 있게, 이번 변환에서 한 일을 한국어 마크다운으로 doc에 적는다. 제목은 ###부터 쓰고 아래 순서를 따른다. 실제로 옮긴 코드 기준으로 쓰고, 없는 항목은 "없음"으로 적는다.
### 화면 개요
- 원본 화면이 하는 일 2~3줄.
### 화면 구성
- 표(영역 | 원본 컴포넌트 | 변환 결과): 조회조건, 그리드, 폼, 탭, 버튼이 어떤 uni 컴포넌트(SearchSection·Section·DataGrid·Form·ButtonGroup 등)가 되었는지.
### 스크립트 변환
- 표(원본 함수·이벤트 | 변환된 곳 | 내용): onload, 이벤트 핸들러, 콜백, 공통 함수가 View.vue의 어느 함수가 되었는지.
### 서버 호출
- 표(원본 transaction(svcId·URL) | 입력/출력 Dataset | Service 함수 | 백엔드): 백엔드를 함께 만들면 Controller 메서드·URL을 적고, 아니면 백엔드 칸은 "-". API 주소와 보내는 값·받는 값의 필드 목록은 여기 쓰지 말고 apis에 담는다(nexa2vue가 문서에 "API 명세"로 붙인다).
### 공통코드·검증
- 공통코드(코드 그룹 → commonOptions/option-map)와 필수값·입력 검증을 어떻게 옮겼는지.
### 원본과 달라진 점
- 동작이 바뀐 것, 추정해서 정한 것(PK, 테이블, 파라미터 이름 등). notes의 TODO는 nexa2vue가 문서 끝에 따로 붙이므로 여기서 되풀이하지 않는다.

## API 명세 (apis)
변환한 코드가 부르는 API마다 하나씩 apis에 담는다(코드와 똑같은 이름·메서드·주소). request에는 화면이 실제로 보내는 필드(조회조건 params, 저장 행의 컬럼과 상태값 등)를, response에는 화면이 받아 쓰는 필드(그리드 컬럼, 폼 항목 등)를 빠짐없이 적는다. 이름은 코드의 키 그대로, desc는 원본 라벨·Dataset 컬럼 기준으로 짧게. 모르는 것은 지어내지 말고 desc에 "추정"이라고 적는다.`;

function backendPrompt({ uniBackend, names }, oneShot) {
  const docs = ['SCREEN_CONVENTION.md', 'NAMING_CONVENTION.md', 'COMMENT_CONVENTION.md'].map((d) => `- ${path.join(uniBackend, d)}`).join('\n');
  const ref = path.join(uniBackend, 'src/main/java/kr/co/averedu/co/csm');
  const rules = oneShot
    ? '- 백엔드 규칙도 위 스킬의 백엔드 절을 따른다(uni backend 파일은 따로 읽지 않는다).'
    : `- 먼저 읽을 규칙(읽기 전용):
${docs}
- 기준 화면: ${ref}의 CCU0297010~CCU0297060(controller/service/mapper/dto)과 ${path.join(uniBackend, 'src/main/resources/mapper/co/csm')}의 같은 이름 Mapper.xml.`;
  return `

## 백엔드도 함께 (uni backend, Spring Boot + MyBatis)
- draft/backend/의 ${names.join(', ')}: 같은 화면의 백엔드 규칙 기반 초안이다. 프론트 Service.js의 API 이름(find…List/save…List/find…Info/save…Info)과 1:1로 맞춰 두었다.
${rules}
9. 프론트를 고치면서 API 이름·파라미터가 바뀌면 백엔드도 같이 맞춘다. 원본 transaction의 서비스 URL·입력/출력 Dataset을 보고 조회 조건과 저장 대상을 맞춘다.
10. 테이블·컬럼은 넥사크로 Dataset에서 추정한 것이다. DB를 조회하지 말고, 모르는 테이블·컬럼·키·업무 검증은 ${oneShot ? '스킬에 적힌' : 'SCREEN_CONVENTION.md 9장'} 방식의 TODO로 남긴다(초안의 TODO 문구를 따른다).
11. 다섯 파일의 전체 내용을 backend.controller/service/mapper/dto/mapperXml에 담는다. 패키지·파일 경로·클래스 이름은 초안 그대로 둔다.`;
}

// ---------------------------------------------------------------- vue mode
// A frontend that is not uni (uni-structure.js frontendKind 'vue'): no uni
// draft. Claude writes the screen's files the way the vue-convert skill (made
// from that project's screens at 구조 파악) describes, from the source alone.

const OUTPUT_SCHEMA_VUE = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: '이 화면에서 새로 만드는 파일 전부',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '프로젝트 기준 상대 경로(/ 구분), 예: src/views/users/UserListView.vue' },
          content: { type: 'string', description: '파일 전체 내용' },
        },
        required: ['path', 'content'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: '사람이 확인할 것(옮기지 못한 것, 추정한 것, 라우터 등록처럼 따로 할 일)' },
    doc: { type: 'string', description: '변환 내용 문서(마크다운, ### 제목부터)' },
    // no uni / Spring wording: another project's API
    apis: apiSpecSchema(false),
  },
  required: ['files', 'notes', 'doc', 'apis'],
};

// Paths nexa2vue writes itself; the screen's files must stay out of them.
const RESERVED_PREFIXES = ['docs/', 'preview/', 'backend/', '_nexa2vue'];

/** 'src\\views\\A.vue' → 'src/views/A.vue'; throws on absolute paths, '..' and reserved places. */
function cleanOutputPath(p) {
  const s = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`AI가 준 파일 경로를 쓸 수 없습니다: ${p}`);
  }
  if (RESERVED_PREFIXES.some((r) => s === r.replace(/\/$/, '') || s.startsWith(r))) throw new Error(`AI가 준 파일 경로가 nexa2vue가 쓰는 곳입니다: ${p}`);
  return s;
}

const DOC_PROMPT_VUE = DOC_PROMPT
  .replace('어떤 uni 컴포넌트(SearchSection·Section·DataGrid·Form·ButtonGroup 등)가 되었는지', '이 프로젝트의 어떤 컴포넌트·요소가 되었는지')
  .replace('View.vue의 어느 함수가 되었는지', '어느 파일의 어느 함수가 되었는지')
  .replace('Service 함수 | 백엔드): 백엔드를 함께 만들면 Controller 메서드·URL을 적고, 아니면 백엔드 칸은 "-".', '호출 함수 | URL): 이 프로젝트 방식의 호출 함수와 URL.')
  .replace('공통코드(코드 그룹 → commonOptions/option-map)와', '공통코드(코드 그룹을 어떻게 불러와 쓰는지)와');

function relationPromptVue(relations) {
  if (!relations) return '';
  const lines = [];
  if (relations.role === 'popup') {
    lines.push(`- 이 화면은 팝업이다${relations.parent ? `: ${relations.parent.name}(원본 ${relations.parent.rel})에서 연다` : '(여는 화면은 이번 변환에 없다)'}. 스킬에 있는 팝업·모달 방식으로 만들고, 원본에서 this.close(값)·opener/arguments로 주고받던 것을 그 방식의 props·emit으로 옮긴다. 스킬에 방식이 없으면 TODO.`);
  }
  for (const s of relations.subs || []) {
    lines.push(`- 하위 화면 ${s.name}(원본 ${s.rel}, source-${s.name}.xfdl): ${s.parent}의 원래 Div 자리에 들어가는 자식 컴포넌트다. 스킬의 컴포넌트 방식으로 따로 파일을 만들어 files에 넣고, 부모와 주고받던 것은 props·emit(또는 defineExpose)로 옮긴다.`);
  }
  for (const p of relations.popups || []) {
    lines.push(`- 여는 팝업 ${p.name}(원본 ${p.rel}): ${p.from}에서 연다. 팝업 화면은 따로 변환된다(이름 ${p.name}). 스킬의 팝업 방식으로 import해 열고, 원본 콜백에서 하던 일을 결과를 받은 뒤에 옮긴다. 경로를 모르면 TODO로 남긴다.`);
  }
  return lines.length ? `## 다른 화면과의 관계 (변환 전에 사람이 확인함)\n${lines.join('\n')}\n\n` : '';
}

function buildPromptVue({ relPath, skills, inputs, relations, screen, previousChecks }) {
  const hasSubs = !!(relations && relations.subs && relations.subs.length);
  return `넥사크로 화면을 아래 스킬에 정리된 Vue 프로젝트 방식으로 옮기는 작업이다. 결과는 JSON(files, notes, doc, apis)으로만 답한다.

## 입력 (맨 아래 <file> 블록에 전문이 있다)
- source.xfdl: 넥사크로 원본(${relPath}). 배치·Dataset·Bind·스크립트가 모두 들어 있다.
- analysis.json: nexa2vue가 원본에서 뽑은 화면ID·화면명·조회조건·서버 호출 목록. 참고용이며 이름은 스킬 규칙에 맞게 바꿔도 된다.${hasSubs ? '\n- source-<이름>.xfdl: 이 화면에 들어가는 하위 화면 원본.' : ''}

${skillSection(skills)}## 프로젝트 규칙
- 위 ${UNI_SKILL_NAME} 스킬이 이 프로젝트 화면들의 요약이다. 프로젝트 파일은 따로 읽지 않는다.
- 파일 구성·경로·이름·import·컴포넌트·서버 호출·상태 관리 방식은 스킬을 따른다. 스킬에 없는 라이브러리·공통 함수·컴포넌트는 지어내지 않는다.

${relationPromptVue(relations)}${previousChecksPrompt(previousChecks)}## 할 일
1. 화면ID ${screen.id}${screen.screenName ? `(${screen.screenName})` : ''}를 바탕으로 스킬의 이름 규칙에 맞게 파일 이름을 정한다. 경로는 스킬의 화면 폴더 규칙을 따르고${screen.dir ? `, 원본 폴더(${screen.dir})를 하위 폴더로 반영할 수 있으면 반영한다` : ''}.
2. 원본 배치(조회조건, 그리드·목록, 입력 폼, 탭, 버튼)를 빠짐없이 원본 순서대로 옮긴다. 숨김 처리·간격용 Static은 빼도 된다. 라벨·컬럼 제목은 원본 그대로.
3. 원본 스크립트의 동작을 옮긴다.
   - form onload 초기화 → 스킬의 초기화 방식(onMounted 등).
   - transaction → 스킬의 서버 호출 방식(api 모듈 등). 입력·출력 Dataset을 보고 params와 결과를 어느 상태에 넣을지 맞춘다. 콜백 내용은 호출 뒤에 이어서 옮긴다.
   - Dataset 조작(addRow/setColumn/getColumn/deleteRow/rowposition 등) → 배열·객체 상태 조작.
   - 버튼·그리드 이벤트 핸들러, 입력 검증, alert/confirm → 스킬에 있는 알림·확인 방식.
4. 필드 키는 Dataset 컬럼을 camelCase로 쓴다(STD_NO → stdNo).
5. 옮길 수 없는 것(정의를 모르는 gfn_* 함수, 서버 규칙을 모르는 부분)은 지어내지 말고 그 자리에 // TODO(nexa2vue): 설명 주석을 남기고 notes에도 적는다.
6. 라우터·메뉴·store 같은 기존 공용 파일은 고치지 않는다. 등록이 필요하면 notes에 적는다. files에는 이 화면에서 새로 만드는 파일만 넣는다.
7. 코드 스타일은 스킬의 예시와 같게.
8. 파일을 만들거나 고치지 말고, files에 path(프로젝트 기준 상대 경로, / 구분)와 content(전체 내용)를 담아 답한다. notes는 한국어로 짧게.

${DOC_PROMPT_VUE}${inputBlocks(inputs)}`;
}

/**
 * Vue mode: one screen (with its sub-screens) from the source alone, using the
 * vue-convert skill. screen: gen-uni's backendModel ({ id, dir, screenName, apis, search }).
 * Returns { files, notes, doc, apis, costUsd, durationMs }.
 */
async function aiConvertScreenVue({ sourceText, relPath, relations, screen, previousChecks, skills: skillPaths, model, claudeBin, timeoutMs = DEFAULT_TIMEOUT_MS, isCancelled, onStep, onUsage }) {
  const skills = conversionSkills(skillPaths, { uni: false });
  if (!usesUniSkill(skills)) {
    throw new Error(`이 frontend는 uni가 아니어서 구조 파악에서 만든 ${UNI_SKILL_NAME} 스킬이 있어야 변환할 수 있습니다. 구조 파악에서 규칙 스킬을 만드세요`);
  }
  const readable = readableSkills(skills);
  const inputs = {
    'source.xfdl': sourceText,
    'analysis.json': JSON.stringify({ id: screen.id, dir: screen.dir || '', screenName: screen.screenName || '', search: screen.search || [], apis: screen.apis || [] }, null, 2),
  };
  for (const s of (relations && relations.subs) || []) inputs[`source-${s.name}.xfdl`] = s.text;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-ai-'));
  try {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA_VUE),
      '--tools', readable.length ? 'Read,Glob,Grep' : '',
      ...readable.flatMap((s) => ['--add-dir', s.dir]),
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources', 'project',
    ];
    if (model) args.push('--model', model);
    const started = Date.now();
    const res = await runClaude(args, buildPromptVue({ relPath, skills, inputs, relations, screen, previousChecks }), { cwd: work, timeoutMs, claudeBin, isCancelled, onStep, onUsage });
    if (res.is_error || !res.structured_output) {
      throw new Error(`AI 변환 실패: ${String(res.result || res.subtype || 'no result').slice(0, 300)}`);
    }
    const out = res.structured_output;
    if (!Array.isArray(out.files) || !out.files.length) throw new Error('AI 응답에 파일이 없습니다');
    const seen = new Set();
    const files = out.files.map((f) => {
      const p = cleanOutputPath(f && f.path);
      if (seen.has(p.toLowerCase())) throw new Error(`AI가 같은 파일을 두 번 줬습니다: ${p}`);
      seen.add(p.toLowerCase());
      if (typeof f.content !== 'string' || !f.content.trim()) throw new Error(`AI 응답에 ${p} 내용이 없습니다`);
      return { path: p, content: f.content.endsWith('\n') ? f.content : `${f.content}\n` };
    });
    return {
      files,
      notes: Array.isArray(out.notes) ? out.notes.map(String) : [],
      doc: typeof out.doc === 'string' ? out.doc : '',
      apis: cleanAiApis(out.apis),
      costUsd: res.total_cost_usd,
      durationMs: Date.now() - started,
    };
  } finally {
    removeWorkDir(work);
  }
}

// ---------------------------------------------------------------- fix round
// After a conversion whose files the component check caught (component-check.js):
// one short Claude turn that fixes just those spots, told the real declarations.
// Same for uni and any other Vue project: it needs only the files and the project.

const OUTPUT_SCHEMA_FIX = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: '고친 파일 전부(고치지 않은 파일은 넣지 않는다)',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '받은 파일의 path 그대로' },
          content: { type: 'string', description: '고친 파일 전체 내용' },
        },
        required: ['path', 'content'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: '사람이 확인할 것(고치지 못한 곳, 추정해서 바꾼 것)' },
  },
  required: ['files', 'notes'],
};

// A component file sent whole unless it is long: then its <script> blocks
// (where props, models and emits are declared) are enough.
const COMPONENT_SOURCE_MAX = 12000;
function componentText(source) {
  if (source.length <= COMPONENT_SOURCE_MAX) return source;
  const scripts = source.match(/<script\b[\s\S]*?<\/script>/gi) || [];
  return `${scripts.join('\n\n').slice(0, COMPONENT_SOURCE_MAX)}\n<!-- nexa2vue: 길어서 <script>만 보냄 -->`;
}

// The screen's other files go along (an item definition may belong in its
// Constant, say) while they stay small; past that only the flagged ones.
const FIX_OTHERS_MAX = 40000;

function buildFixPrompt({ relPath, checks, files, others = [], context }) {
  const blocks = (list) => list.map(([name, text]) => `<file path="${name}">\n${text.replace(/\s+$/, '')}\n</file>`).join('\n\n');
  const lines = [
    `넥사크로 화면(${relPath})을 Vue로 옮긴 결과를 검사했더니, 프로젝트 컴포넌트를 잘못 써서 화면이 열리지 않는 곳이 나왔다. 그곳만 고쳐 JSON(files, notes)으로 답한다.`,
    '',
    '## 검사에서 나온 문제',
    ...checks.map((c) => `- ${c.file}:${c.line} ${c.message}`),
    '',
    '## 고치는 규칙',
    '- 위 문제만 고친다. 나머지 코드·배치·동작·주석은 그대로 둔다.',
    '- 컴포넌트는 아래 선언(props·defineModel·emits)대로 쓴다. 필수 prop은 선언된 이름과 형태로 넘기고, 그 값(설정 객체 등)이 필요하면 같은 파일이나 같은 화면의 다른 파일에 있는 방식을 따라 만든다.',
    '- v-model을 받지 않는 컴포넌트는 선언된 prop과 이벤트로 바꾼다(예: :model + @update).',
    '- 없는 export·파일은 지어내지 않는다. 아래 "실제로 있는 것"에서 같은 일을 하는 것으로 바꾸고, 맞는 것이 없으면 기본 HTML 요소로 바꾸고 그 자리에 // TODO(nexa2vue): 주석을 남기고 notes에도 적는다.',
    '- 설정 객체 같은 정의가 필요하면 그 화면이 이미 쓰는 곳(예: Constant)에 두고 가져다 쓴다. 아래 "같은 화면의 다른 파일"에 이미 있는 정의는 그대로 쓴다.',
    '- files에는 고친 파일만, 받은 path 그대로, 파일 전체 내용으로 넣는다. notes는 한국어로 짧게.',
    '',
  ];
  if (context.components.length) {
    lines.push('## 컴포넌트 선언 (프로젝트 파일, 고치지 않는다)', blocks(context.components.map((c) => [c.file, componentText(c.source)])), '');
  }
  if (context.exports.length || context.folders.length) {
    lines.push('## 실제로 있는 것');
    for (const e of context.exports) lines.push(`- '${e.source}'의 export: ${e.names.join(', ') || '(없음)'}`);
    for (const f of context.folders) lines.push(`- '${f.source}'가 가리키는 폴더의 파일: ${f.files.join(', ') || '(없음)'}`);
    lines.push('');
  }
  lines.push('## 고칠 파일', blocks(files.map((f) => [f.path, f.content])));
  if (others.length) lines.push('', '## 같은 화면의 다른 파일 (필요할 때만 고친다)', blocks(others.map((f) => [f.path, f.content])));
  return lines.join('\n');
}

/**
 * Fix what the component check found in a screen's files. frontendRoot: the
 * project the screen goes into. Returns { files (only the changed ones), notes,
 * costUsd, durationMs }.
 */
async function aiFixScreen({ relPath, files, checks, frontendRoot, model, claudeBin, timeoutMs = DEFAULT_TIMEOUT_MS, isCancelled, onStep, onUsage }) {
  const flagged = files.filter((f) => checks.some((c) => c.file === f.path));
  if (!flagged.length) throw new Error('고칠 파일이 없습니다');
  const context = fixContext(checks, files, frontendRoot);
  const rest = files.filter((f) => !flagged.includes(f));
  const others = rest.reduce((n, f) => n + f.content.length, 0) <= FIX_OTHERS_MAX ? rest : [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-fix-'));
  try {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA_FIX),
      // everything is in the prompt: no tools, one turn
      '--tools', '',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources', 'project',
    ];
    if (model) args.push('--model', model);
    const started = Date.now();
    const res = await runClaude(args, buildFixPrompt({ relPath, checks, files: flagged, others, context }), { cwd: work, timeoutMs, claudeBin, isCancelled, onStep, onUsage });
    if (res.is_error || !res.structured_output) {
      throw new Error(`AI 수정 실패: ${String(res.result || res.subtype || 'no result').slice(0, 300)}`);
    }
    const out = res.structured_output;
    const allowed = new Set([...flagged, ...others].map((f) => f.path));
    const fixed = (Array.isArray(out.files) ? out.files : []).map((f) => {
      const p = String((f && f.path) || '').replace(/\\/g, '/');
      if (!allowed.has(p)) throw new Error(`AI가 고칠 파일이 아닌 곳을 줬습니다: ${p}`);
      if (typeof f.content !== 'string' || !f.content.trim()) throw new Error(`AI 응답에 ${p} 내용이 없습니다`);
      return { path: p, content: f.content.endsWith('\n') ? f.content : `${f.content}\n` };
    });
    return {
      files: fixed,
      notes: Array.isArray(out.notes) ? out.notes.map(String) : [],
      costUsd: res.total_cost_usd,
      durationMs: Date.now() - started,
    };
  } finally {
    removeWorkDir(work);
  }
}

// One line for the progress log per step Claude takes (tool calls, short text).
function describeStep(block, cwd) {
  const rel = (p) => {
    const r = path.relative(cwd, String(p || ''));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : String(p || '');
  };
  if (block.type === 'text') {
    const text = String(block.text || '').replace(/\s+/g, ' ').trim();
    return text ? `생각: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}` : null;
  }
  if (block.type !== 'tool_use') return null;
  const i = block.input || {};
  switch (block.name) {
    case 'Read': return `읽기 ${rel(i.file_path)}`;
    case 'Glob': return `파일 찾기 ${i.pattern || ''}${i.path ? ` (${rel(i.path)})` : ''}`;
    case 'Grep': return `검색 "${i.pattern || ''}"${i.path ? ` (${rel(i.path)})` : ''}`;
    case 'StructuredOutput': return '결과 정리';
    default: return `${block.name}`;
  }
}

// Usage limits as Claude Code last reported them (rate_limit_event during an
// AI call): share of the 5-hour and 7-day windows used, and when they reset.
let lastUsage = null;

function recordUsage(info) {
  const windows = (info && info.unifiedWindows) || {};
  const pick = (w) => (w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: w.resetsAt || null } : null);
  lastUsage = {
    at: new Date().toISOString(),
    status: info.status || null,
    fiveHour: pick(windows.five_hour),
    sevenDay: pick(windows.seven_day),
  };
  return lastUsage;
}

function usageState() {
  return lastUsage;
}

// Claude Code sends rate_limit_event once per session, right after its first
// reply, so a long screen session's own usage only shows in a LATER reading.
// After the work, one tiny call (no tools, smallest model, one short answer)
// gets that "after" reading. Never throws: null when it could not read.
const PROBE_TIMEOUT_MS = 60 * 1000;
async function probeUsage({ claudeBin, model = 'haiku', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-usage-'));
  let seen = null;
  try {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project', '--model', model];
    await runClaude(args, 'OK 라고만 답하세요.', { cwd: work, timeoutMs, claudeBin, onUsage: (u) => (seen = u) });
  } catch {
    // no reading: the caller keeps what it had
  } finally {
    removeWorkDir(work);
  }
  return seen;
}

/** "5시간 30% 사용 (70% 남음)" style line for the progress log. */
function usageLine(u) {
  const part = (label, w) => (w ? `${label} ${Math.round(w.utilization * 100)}% 사용(${Math.max(0, 100 - Math.round(w.utilization * 100))}% 남음)` : null);
  return [part('5시간', u.fiveHour), part('7일', u.sevenDay)].filter(Boolean).join(' · ');
}

// Claude Code with --output-format stream-json: one JSON event per line. Each
// step goes to onStep as it happens; the final "result" event is returned.
function runClaude(args, input, { cwd, timeoutMs, claudeBin, isCancelled, onStep, onUsage }) {
  return new Promise((resolve, reject) => {
    const child = spawn(...claudeCommand(claudeBin, args), { cwd, windowsHide: true, env: claudeEnv() });
    let buffer = '';
    let stderr = '';
    let result = null;
    // Timeout or cancel: stop Claude Code and everything it started, and settle
    // once it has exited so its work folder is no longer in use.
    let stopped = null;
    let forceTimer = null;
    const stop = (err) => {
      if (stopped) return;
      stopped = err;
      killTree(child);
      forceTimer = setTimeout(() => reject(err), STOP_GRACE_MS);
    };
    const timer = setTimeout(() => stop(new Error(`AI 변환 시간 초과(${Math.round(timeoutMs / 60000)}분) — 화면이 크면 화면당 AI 제한 시간을 늘리세요`)), timeoutMs);
    const poll = setInterval(() => {
      if (isCancelled && isCancelled()) stop(new Error('취소되었습니다'));
    }, 500);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearInterval(poll);
    };
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'result') result = ev;
      else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
        const u = recordUsage(ev.rate_limit_info);
        if (onUsage) onUsage(u);
      }
      else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) && onStep) {
        for (const block of ev.message.content) {
          const step = describeStep(block, cwd);
          if (step) onStep(step);
        }
      }
    };
    child.stdout.on('data', (d) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      done();
      reject(err.code === 'ENOENT' ? new Error('Claude Code(claude 명령)를 찾을 수 없습니다. 설치·로그인한 뒤 다시 하세요') : err);
    });
    child.on('close', (code) => {
      done();
      onLine(buffer);
      if (stopped) reject(stopped);
      else if (result) resolve(result);
      else reject(new Error(`Claude Code가 실패했습니다(exit ${code}): ${stderr.trim().slice(0, 300) || '결과 없음'}`));
    });
    // Claude Code can exit before it has read the prompt (bad flag, sign-in
    // error, cancel): the write then fails with EPIPE/EOF. 'close' reports that
    // run, so the error is dropped here instead of crashing the whole server.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Port one screen. draftFiles: the uni draft [{ path, content }] (View, Service, Constant).
 * skills: optional paths of conversion-rules skills (folders with SKILL.md), applied in order.
 * Returns { files: [{ path, content }], notes: [], doc, apis, costUsd, durationMs }.
 */
async function aiConvertScreen({ sourceText, relPath, draftFiles, draftBackendFiles, relations, previousChecks, uniBackend, uniFrontend, skills: skillPaths, model, claudeBin, timeoutMs = DEFAULT_TIMEOUT_MS, isCancelled, onStep, onUsage }) {
  // Sub-screens converted with this screen (convert-core.js): their own .vue,
  // the host's Service/Constant. Picked by path, so a sub named …View.vue is no clash.
  const subs = ((relations && relations.subs) || []).map((s) => ({ ...s, draft: draftFiles.find((f) => f.path === s.file) }));
  if (subs.some((s) => !s.draft)) throw new Error('AI 변환에 필요한 하위 화면 초안 파일이 없습니다');
  const own = draftFiles.filter((f) => !subs.some((s) => s.file === f.path));
  const pick = (suffix) => own.find((f) => f.path.endsWith(suffix));
  const draft = { view: pick('View.vue'), service: pick('Service.js'), constant: pick('Constant.js') };
  if (!draft.view || !draft.service || !draft.constant) throw new Error('AI 변환에 필요한 초안 파일이 없습니다');
  if (!fs.existsSync(path.join(uniFrontend, 'src', 'components'))) throw new Error(`uni frontend를 찾을 수 없습니다: ${uniFrontend}`);
  const skills = uniSkills(skillPaths);
  const backendDraft = uniBackend && draftBackendFiles && draftBackendFiles.length
    ? BACKEND_KEYS.map(([key, suffix]) => ({ key, file: draftBackendFiles.find((f) => f.path.endsWith(suffix)) }))
    : null;
  if (backendDraft && backendDraft.some((d) => !d.file)) throw new Error('AI 변환에 필요한 백엔드 초안 파일이 없습니다');

  const oneShot = usesUniSkill(skills);
  const readable = readableSkills(skills);
  const inputs = oneShot ? { 'source.xfdl': sourceText } : null;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-ai-'));
  try {
    fs.writeFileSync(path.join(work, 'source.xfdl'), sourceText, 'utf8');
    fs.mkdirSync(path.join(work, 'draft'));
    const draftNames = {};
    for (const [key, f] of Object.entries(draft)) {
      draftNames[key] = path.posix.basename(f.path);
      fs.writeFileSync(path.join(work, 'draft', draftNames[key]), f.content, 'utf8');
      if (inputs) inputs[`draft/${draftNames[key]}`] = f.content;
    }
    for (const s of subs) {
      fs.writeFileSync(path.join(work, `source-${s.name}.xfdl`), s.text, 'utf8');
      fs.writeFileSync(path.join(work, 'draft', `${s.name}.vue`), s.draft.content, 'utf8');
      if (inputs) Object.assign(inputs, { [`source-${s.name}.xfdl`]: s.text, [`draft/${s.name}.vue`]: s.draft.content });
    }
    if (backendDraft) {
      fs.mkdirSync(path.join(work, 'draft', 'backend'));
      for (const d of backendDraft) {
        const name = path.posix.basename(d.file.path);
        fs.writeFileSync(path.join(work, 'draft', 'backend', name), d.file.content, 'utf8');
        if (inputs) inputs[`draft/backend/${name}`] = d.file.content;
      }
    }
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(withSubs(backendDraft ? OUTPUT_SCHEMA_BACKEND : OUTPUT_SCHEMA, subs)),
      // read-only tools; uni frontend for docs and examples. With the uni
      // summary skill: no project folders, and no tools at all unless another
      // skill's folder is there to read.
      '--tools', oneShot && !readable.length ? '' : 'Read,Glob,Grep',
      ...(oneShot ? [] : ['--add-dir', uniFrontend]),
      ...readable.flatMap((s) => ['--add-dir', s.dir]),
      ...(backendDraft && !oneShot ? ['--add-dir', uniBackend] : []),
      '--no-session-persistence',
      // no user plugins/hooks/MCP servers: just the model and the read tools
      '--strict-mcp-config',
      '--setting-sources', 'project',
    ];
    if (model) args.push('--model', model);
    const started = Date.now();
    const res = await runClaude(args, buildPrompt({ relPath, draftNames, uniFrontend, skills, inputs, relations, previousChecks, backend: backendDraft && { uniBackend, names: backendDraft.map((d) => path.posix.basename(d.file.path)) } }), { cwd: work, timeoutMs, claudeBin, isCancelled, onStep, onUsage });

    if (res.is_error || !res.structured_output) {
      throw new Error(`AI 변환 실패: ${String(res.result || res.subtype || 'no result').slice(0, 300)}`);
    }
    const out = res.structured_output;
    for (const key of ['view', 'service', 'constant']) {
      if (typeof out[key] !== 'string' || !out[key].trim()) throw new Error(`AI 응답에 ${key} 내용이 없습니다`);
    }
    let backendFiles;
    if (backendDraft) {
      const b = out.backend || {};
      for (const d of backendDraft) {
        if (typeof b[d.key] !== 'string' || !b[d.key].trim()) throw new Error(`AI 응답에 backend.${d.key} 내용이 없습니다`);
      }
      backendFiles = backendDraft.map((d) => ({ path: d.file.path, content: b[d.key].endsWith('\n') ? b[d.key] : `${b[d.key]}\n` }));
    }
    const subOut = out.subs || {};
    for (const s of subs) {
      if (typeof subOut[s.name] !== 'string' || !subOut[s.name].trim()) throw new Error(`AI 응답에 하위 화면 ${s.name} 내용이 없습니다`);
    }
    const nl = (text) => (text.endsWith('\n') ? text : `${text}\n`);
    const files = [
      { path: draft.view.path, content: nl(out.view) },
      { path: draft.service.path, content: nl(out.service) },
      { path: draft.constant.path, content: nl(out.constant) },
      ...subs.map((s) => ({ path: s.file, content: nl(subOut[s.name]) })),
    ];
    files.push(...tabFiles(out.tabs, draft.view.path, [...draftFiles.map((f) => f.path), ...files.map((f) => f.path)]));
    return {
      backendFiles,
      files,
      notes: Array.isArray(out.notes) ? out.notes.map(String) : [],
      doc: typeof out.doc === 'string' ? out.doc : '',
      apis: cleanAiApis(out.apis),
      costUsd: res.total_cost_usd,
      durationMs: Date.now() - started,
    };
  } finally {
    removeWorkDir(work);
  }
}

// Cleanup never replaces the outcome: on Windows the folder can stay busy for a
// moment after Claude Code exits, so retry, and leave it behind if it still fails.
function removeWorkDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // a leftover temp folder is harmless
  }
}

// child.kill() ends only claude.exe on Windows; its own child processes would
// keep running (and keep the work folder open), so end the whole tree.
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill();
  }
}

// The installer puts claude.exe in ~/.local/bin; a server started before PATH
// was updated (or from a shortcut) may not see it, so fall back to that path.
function resolveClaudeBin(claudeBin) {
  if (claudeBin) return claudeBin;
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const onPath = (process.env.PATH || '').split(path.delimiter).some((dir) => dir && ['claude', 'claude.exe', 'claude.cmd'].some((n) => fs.existsSync(path.join(dir, n))));
  return !onPath && fs.existsSync(local) ? local : 'claude';
}

// An npm install gives claude.cmd, which spawn() cannot run without a shell
// (and a shell would mangle the JSON arguments). The shim only starts its
// target with node (or the bundled claude.exe), so run that target directly.
function cmdTarget(cmdFile) {
  let text;
  try {
    text = fs.readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/g)].map((m) => m[1]).filter((t) => !/(^|\\)node(\.exe)?$/i.test(t));
  const target = targets.length ? path.join(path.dirname(cmdFile), targets[targets.length - 1]) : null;
  return target && fs.existsSync(target) ? target : null;
}

// The claude.cmd that a bare "claude" would run: first on PATH, unless that
// folder (or an earlier one) has claude.exe.
function cmdOnPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, 'claude.exe'))) return null;
    const cmd = path.join(dir, 'claude.cmd');
    if (fs.existsSync(cmd)) return cmd;
  }
  return null;
}

/** [file, args] to spawn Claude Code with. */
function claudeCommand(claudeBin, args) {
  const bin = resolveClaudeBin(claudeBin);
  const cmd = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(bin) ? bin : bin === 'claude' ? cmdOnPath() : null);
  const target = cmd && cmdTarget(cmd);
  if (!target) return [bin, args];
  return /\.(c|m)?js$/i.test(target) ? [process.execPath, [target, ...args]] : [target, args];
}

// Claude Code keeps its sign-in in a config folder (CLAUDE_CONFIG_DIR, else
// ~/.claude). People who run several accounts keep them in folders like
// ~/.claude-work, set only in their own shell, so a server started from the
// launcher would see ~/.claude and report "not signed in". nexa2vue finds the
// signed-in folders itself and runs every claude command with the chosen one.
const DEFAULT_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ACCOUNT_FILE = path.join(os.homedir(), '.nexa2vue', 'claude-account.json');
let configDir = null;

const sameDir = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function claudeEnv(dir = configDir) {
  return !dir || sameDir(dir, DEFAULT_CONFIG_DIR) ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: dir };
}

// The default folder plus every ~/.claude-* folder that holds a sign-in.
function configDirCandidates() {
  const home = os.homedir();
  const dirs = [DEFAULT_CONFIG_DIR, path.join(home, '.claude')];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      const dir = path.join(home, e.name);
      if (e.isDirectory() && /^\.claude[-_.]/.test(e.name) && fs.existsSync(path.join(dir, '.credentials.json'))) dirs.push(dir);
    }
  } catch {
    // no readable home folder: the default folder only
  }
  return dirs.filter((d, i) => dirs.findIndex((x) => sameDir(x, d)) === i);
}

// When the sign-in was last refreshed: the account in use most recently.
function credentialsTime(dir) {
  try {
    return fs.statSync(path.join(dir, '.credentials.json')).mtimeMs;
  } catch {
    return 0;
  }
}

function savedAccount() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')).configDir || null;
  } catch {
    return null;
  }
}

function saveAccount(dir) {
  fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify({ configDir: dir }, null, 2)}\n`, 'utf8');
}

function runQuick(claudeBin, args, timeoutMs = 15000, dir = configDir) {
  return new Promise((resolve) => {
    const child = spawn(...claudeCommand(claudeBin, args), { windowsHide: true, env: claudeEnv(dir) });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

// Quick check that the CLI is installed (before starting a long job).
function checkClaude(claudeBin) {
  return runQuick(claudeBin, ['--version']);
}

async function authStatus(claudeBin, dir) {
  const out = await runQuick(claudeBin, ['auth', 'status', '--json'], undefined, dir);
  let auth = {};
  try {
    auth = out ? JSON.parse(out) : {};
  } catch {
    auth = {};
  }
  return { configDir: dir, loggedIn: !!auth.loggedIn, email: auth.email || null, authMethod: auth.authMethod || null, plan: auth.subscriptionType || null };
}

/**
 * Installed and signed in? Checks every Claude Code config folder and uses a
 * signed-in one: the one picked on the page, else the one used most recently.
 * Returns { available, version, loggedIn, email, authMethod, plan, configDir, accounts: [signed-in folders] }.
 */
async function claudeStatus(claudeBin) {
  const version = await checkClaude(claudeBin);
  if (!version) return { available: false, version: null, loggedIn: false, accounts: [] };
  const all = await Promise.all(configDirCandidates().map((dir) => authStatus(claudeBin, dir)));
  const accounts = all.filter((a) => a.loggedIn);
  const saved = savedAccount();
  const pick = accounts.find((a) => sameDir(a.configDir, saved))
    || accounts.slice().sort((a, b) => credentialsTime(b.configDir) - credentialsTime(a.configDir))[0]
    // none signed in: sign in to the picked folder, else the default one
    || all.find((a) => sameDir(a.configDir, saved))
    || all[0];
  configDir = pick.configDir;
  return { available: true, version, ...pick, accounts };
}

/** Use the signed-in account in this Claude Code config folder from now on (saved for next time). */
async function selectClaudeAccount(dir, claudeBin) {
  const known = configDirCandidates().find((d) => sameDir(d, dir));
  if (!known) throw Object.assign(new Error(`Claude 설정 폴더를 찾을 수 없습니다: ${dir}`), { status: 400 });
  const status = await authStatus(claudeBin, known);
  if (!status.loggedIn) throw Object.assign(new Error(`이 폴더의 Claude 계정은 로그인되어 있지 않습니다: ${known}`), { status: 400 });
  saveAccount(known);
  configDir = known;
  return status;
}

// Web sign-in: `claude auth login` opens the browser and waits for the
// callback. Only one runs at a time; the sign-in URL it prints is returned
// so the page can offer it when the browser did not open by itself.
let loginChild = null;
let loginUrl = null;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function startClaudeLogin({ claudeBin, method = 'claudeai' } = {}) {
  if (loginChild) return Promise.resolve({ started: true, running: true, url: loginUrl });
  return new Promise((resolve) => {
    const child = spawn(...claudeCommand(claudeBin, ['auth', 'login', method === 'console' ? '--console' : '--claudeai']), { windowsHide: true, env: claudeEnv() });
    loginChild = child;
    loginUrl = null;
    let out = '';
    let answered = false;
    const answer = (body) => {
      if (answered) return;
      answered = true;
      resolve(body);
    };
    const onData = (d) => {
      out += d;
      const m = /https:\/\/[^\s"'<>]+/.exec(out);
      if (m && !loginUrl) {
        loginUrl = m[0];
        answer({ started: true, running: true, url: loginUrl });
      }
    };
    const killTimer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    // no URL printed: the browser was opened directly
    const answerTimer = setTimeout(() => answer({ started: true, running: true, url: null }), 5000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(killTimer);
      clearTimeout(answerTimer);
      loginChild = null;
      answer({ started: false, running: false, error: err.code === 'ENOENT' ? 'Claude Code(claude 명령)를 찾을 수 없습니다. 먼저 설치하세요' : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(answerTimer);
      loginChild = null;
      answer(code === 0
        ? { started: true, running: false, url: loginUrl }
        : { started: false, running: false, error: `로그인을 시작하지 못했습니다(exit ${code}): ${out.trim().slice(0, 300)}` });
    });
  });
}

// Sign out (to switch accounts or the connection method). A sign-in still
// waiting for the browser is stopped first.
async function logoutClaude(claudeBin) {
  if (loginChild) loginChild.kill();
  const out = await runQuick(claudeBin, ['auth', 'logout']);
  if (out === null) throw new Error('Claude Code 로그아웃에 실패했습니다');
  return { loggedOut: true };
}

function loginState() {
  return { running: !!loginChild, url: loginUrl };
}

module.exports = { API_SPEC_SCHEMA, DEFAULT_TIMEOUT_MIN, runClaude, removeWorkDir, usageState, usageLine, probeUsage, aiConvertScreen, aiConvertScreenVue, aiFixScreen, buildFixPrompt, buildPromptVue, cleanOutputPath, OUTPUT_SCHEMA_VUE, checkClaude, claudeStatus, selectClaudeAccount, startClaudeLogin, logoutClaude, loginState, buildPrompt, loadSkill, loadSkills, uniSkills, conversionSkills, withoutLegacyRules, RULES_SKILL_DIR, listSkills, claudeCommand, UNI_SKILL_NAME, isSummarySkill, OUTPUT_SCHEMA, OUTPUT_SCHEMA_BACKEND };
