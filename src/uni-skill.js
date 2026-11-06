'use strict';

// Conversion-rules skill made right after "구조 파악": Claude reads the
// screens of the given frontend (and the backend base screens) once and condenses them into one
// SKILL.md, so each screen's AI pass can work from that instead of reading
// the projects again. The utils function list is taken from the source
// directly (no AI), so it lists only functions that really exist.
// Note: this sends the uni docs and base screens to Anthropic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');
const { runClaude, removeWorkDir, UNI_SKILL_NAME, RULES_SKILL_DIR, loadSkill } = require('./ai-convert');
const { listScreens } = require('./uni-structure');

// ai-convert.js runs a screen in one turn when it sees this name.
const SKILL_NAME = UNI_SKILL_NAME;
// Bump when buildSkillPrompt asks for something new, so a skill made by an
// older nexa2vue shows "다시 만들기 권장" (server.js savedSkill). Skills made
// before this field existed count as 1.
// 2: API address / params vs body / response shape; nexa2vue-rules topics left out.
// 3: "변환 규칙 적용법" — how each nexa2vue-rules rule is kept with this project's
//    components, and component pitfalls (replaces the shipped nexa2vue-rules-uni).
const SKILL_GENERATOR_VERSION = 3;
const DEFAULT_DIR = path.join(os.homedir(), '.nexa2vue', 'skills', SKILL_NAME);
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    skill: { type: 'string', description: 'SKILL.md 본문(마크다운, 머리말 --- 제외)' },
    notes: { type: 'array', items: { type: 'string' }, description: '요약하면서 판단이 애매했던 것' },
  },
  required: ['skill', 'notes'],
};

function walkJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walkJs(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  }).sort();
}

// `export const data = { add(rows, row) {…}, remove: (rows) => … }` → "data.add(rows, row)".
function exportedFunctions(text) {
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return [];
  }
  const params = (fn) => fn.params.map((p) => text.slice(p.start, p.end).replace(/\s+/g, ' ')).join(', ');
  const isFn = (n) => n && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.type);
  const out = [];
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue;
    const decl = node.declaration;
    if (decl.type === 'FunctionDeclaration' && decl.id) out.push(`${decl.id.name}(${params(decl)})`);
    if (decl.type !== 'VariableDeclaration') continue;
    for (const v of decl.declarations) {
      if (!v.id || v.id.type !== 'Identifier') continue;
      if (isFn(v.init)) out.push(`${v.id.name}(${params(v.init)})`);
      else if (v.init && v.init.type === 'ObjectExpression') {
        for (const p of v.init.properties) {
          if (p.type !== 'Property' || !p.key) continue;
          const key = p.key.name || p.key.value;
          if (isFn(p.value)) out.push(`${v.id.name}.${key}(${params(p.value)})`);
          else if (p.value.type === 'ObjectExpression' || p.value.type === 'Literal') out.push(`${v.id.name}.${key}`);
        }
      }
    }
  }
  return out;
}

/** Every exported function under src/utils, per file: "### domain/data.js\n- data.add(rows, row)". */
function utilsReference(frontendRoot) {
  const utils = path.join(frontendRoot, 'src', 'utils');
  return walkJs(utils).map((file) => {
    const names = exportedFunctions(fs.readFileSync(file, 'utf8'));
    return names.length ? `### ${path.relative(utils, file).replace(/\\/g, '/')}\n${names.map((n) => `- ${n}`).join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

// The shipped base rules (skills/nexa2vue-rules) as the generator's checklist
// for "6. 변환 규칙 적용법": their bullets, without the skill's heading.
function rulesText() {
  try {
    return loadSkill(RULES_SKILL_DIR).body.replace(/^##[^\n]*\n/m, '').trim();
  } catch {
    return '- (기본 규칙 스킬을 읽지 못함 — 6번은 화면 배치·조회조건·버튼·그리드 칸·탭 기준으로 쓴다)';
  }
}

function buildSkillPrompt({ frontend, backend }) {
  // Made from the screens of the frontend given at 구조 파악, not from the uni docs.
  const screens = frontend.screens || listScreens(frontend.root);
  const list = screens.map((p) => `- ${path.join(frontend.root, p)}`).join('\n');
  return `구조 파악 때 지정한 frontend 프로젝트의 실제 화면을 읽고, 넥사크로 화면을 이 프로젝트 방식으로 옮길 때 쓸 스킬(SKILL.md) 하나로 요약하는 작업이다. 결과는 JSON(skill, notes)으로만 답한다.

## 왜 요약하는가
변환할 때 화면마다 Claude가 프로젝트 화면을 다시 읽느라 사용량이 많이 든다. 이 스킬만 보고 변환할 수 있게, 화면을 만드는 방식과 예시를 빠짐없이 그러나 짧게 담는다. 목표 분량은 한국어 기준 5천~8천 토큰.

## 읽을 것 (읽기 전용, 프로젝트: ${frontend.root})
화면:
${list || '- (src/views에 .vue 화면이 없음 — notes에 적는다)'}
- 위 화면이 import하는 컴포넌트·api·store·composable·유틸 파일은 따라가서 읽는다. src/router, src/main.js, package.json도 본다.
- README·*_CONVENTION.md 같은 문서는 기준으로 삼지 않는다. uni 화면 표준과 비교하지도 않는다. 화면 코드에 실제로 있는 방식만 쓴다.
${backend ? `backend (코드만, 문서는 읽지 않음):
- 기준 화면: ${backend.root}의 ${backend.referenceScreens.join(', ') || '(없음)'} (controller/service/mapper/dto, resources/mapper의 Mapper.xml)
- 기본 패키지: ${backend.basePackage}` : '- backend는 만들지 않는다(백엔드 절 생략).'}

## 스킬에 담을 것 (이 순서, ## 제목)
1. 프로젝트 구성: 기술 스택(package.json 기준), 폴더 구조, 화면 하나를 이루는 파일들(.vue, api, store 등)과 파일·컴포넌트 이름 규칙, import 경로(별칭 포함).
2. 화면 배치: 화면들이 실제로 쓰는 레이아웃·공통 컴포넌트(조회조건, 목록/표, 입력 폼, 버튼 영역, 팝업·모달 등)와 props·이벤트·슬롯. 표처럼 짧게.
3. 스크립트 패턴: 초기화(onMounted 등), 조회·저장·추가·삭제, 서버 호출(api 모듈·axios 등) 방식, 상태 관리(ref/reactive/store), 라우팅, 입력 검증, 알림·확인창. 각 패턴은 화면에서 가져온 짧은 코드 조각으로.
   서버 호출은 변환 문서의 API 명세(주소·보내는 값·받는 값)를 쓸 수 있게 따로 정리한다: 실제 요청 주소가 만들어지는 방식(axios baseURL·프록시 + 화면 기본 URL + 함수 경로), 메서드별로 값을 넘기는 방식(쿼리 파라미터/요청 본문, 목록 저장이면 행 배열과 행 상태값), 받는 응답의 모양(감싸는 객체가 있으면 그 구조, 화면이 결과를 꺼내 쓰는 방법).
4. 이름 규칙: 화면·컴포넌트·api 함수·변수 이름을 화면들에서 보이는 대로.
5. 대표 예시 하나: 목록+조회+입력/저장이 가장 잘 드러난 화면 하나를 골라 핵심만 남겨 싣는다(주석·중복 제거).
6. 변환 규칙 적용법: 아래 "nexa2vue 기본 규칙"의 항목마다, 이 프로젝트에서 그 규칙을 지키는 구체적인 방법을 쓴다(어느 컴포넌트·슬롯·prop·파일로 하는지, 짧은 코드 조각 하나). 규칙 문장 자체는 되풀이하지 않는다. 화면 코드에서 방법을 찾지 못한 항목은 "프로젝트 화면에 예가 없음"이라고 쓰고 notes에도 적는다. 최소한 다음을 다룬다.
   - 따로 떨어진 조회조건 영역을 하나 더 두는 법(한 화면에 여러 개 둘 때 값·조회 함수를 나누는 법), 한 영역 안에 입력칸 여러 개와 버튼을 원본 순서대로 함께 넣는 법(사용자 정의 칸·슬롯), 조회조건 없이 입력·처리만 하는 영역.
   - 원본 버튼을 옮기는 곳: 조회 버튼과 그리드의 추가·삭제·저장·엑셀 버튼이 프로젝트의 어떤 기능(이벤트)이 되는지, 그 밖의 버튼을 두는 자리.
   - 그리드 칸 안에 버튼을 넣는 법(칸 슬롯 이름 규칙, 그 안에 쓰는 버튼 요소, 그 행을 받는 법).
   - 탭 컴포넌트: props·이벤트·슬롯 유무, 탭 목록 모양, 탭 페이지를 파일로 나누는 방식과 상태를 어디에 두는지(화면 쪽 / 탭 페이지 쪽).
   - 컴포넌트를 잘못 쓰기 쉬운 곳: 필수 prop, 있을 것 같지만 없는 prop(v-model·type·maxlength 등), 어떤 감싸는 컴포넌트 안에서만 먹는 설정(예: 항목 정의의 disabled가 폼 안에서만 적용되고 단독으로 쓸 때는 prop으로 줘야 하는 경우), 그리드 머리글 줄바꿈·폭 같은 그리기 한계와 그때 맞추는 법.
${backend ? '7. 백엔드: 기준 화면 코드에서 본 Controller/Service/Mapper/Dto/Mapper.xml 이름·패키지·URL 규칙, 뼈대 한 벌(핵심만).\n8' : '7'}. 하지 말 것: 화면들에서 쓰지 않는 방식(다른 UI 라이브러리, 프로젝트에 없는 공통 함수 등).

## nexa2vue 기본 규칙 (6번의 기준, 변환 때 nexa2vue가 따로 넣는다)
${rulesText()}

## 규칙
- 읽은 화면 코드에 있는 내용만 쓴다. 화면마다 방식이 다르면 가장 많이 쓰는 방식을 쓰고 notes에 적는다. 추측한 규칙은 넣지 말고 notes에 적는다.
- 넥사크로 쪽 설명(gfn_*, Dataset 등)은 넣지 않는다. 변환 방법은 nexa2vue 프롬프트가 따로 준다.
- 넥사크로 화면을 옮기는 원칙(원본 영역을 나누거나 합치는 기준, 원본에 없는 버튼·제목 금지, 그리드 칸 팝업은 그 칸에, 탭은 탭으로)은 nexa2vue 기본 규칙이 정한다. 그 문장을 이 스킬에 되풀이하지 말고, 6번에 이 프로젝트에서 지키는 방법만 쓴다.
- 파일 경로는 프로젝트 기준 상대 경로로 쓴다(이 PC의 절대 경로 금지).
- 파일을 만들거나 고치지 말고 skill에 SKILL.md 본문(머리말 제외)을 담는다.`;
}

// The fixed Nexacro→uni conversion rules are not part of this summary: they
// live in their own skill (skills/nexa2vue-rules) that every uni conversion
// puts first (ai-convert.js uniSkills), so a rule change needs no new summary.
function skillFile({ body, structure, utils }) {
  const { frontend, backend } = structure;
  const description = `frontend${backend ? '·backend' : ''} 화면 구조 요약(구조 파악 때 지정한 프로젝트의 화면에서 만듦, 넥사크로 변환용). nexa2vue가 만든 스킬.`;
  return `---
name: ${SKILL_NAME}
description: ${description}
generated-at: ${new Date().toISOString()}
generator-version: ${SKILL_GENERATOR_VERSION}
generated-from: ${[frontend.root, backend && backend.root].filter(Boolean).join(', ')}
---

${body.trim()}

${utils ? `## 공통 유틸 함수 목록 (src/utils에서 추출, 이 목록에 있는 함수만 쓴다)

${utils}
` : ''}`;
}

/**
 * Make the uni conversion skill from a saved structure (uni-structure.js).
 * Returns { dir, file, chars, notes, costUsd, durationMs }.
 */
async function generateUniSkill({ structure, dir = DEFAULT_DIR, model, claudeBin, timeoutMs = DEFAULT_TIMEOUT_MS, isCancelled, onStep, onUsage }) {
  if (!structure || !structure.frontend) throw new Error('구조 파악을 먼저 하세요');
  const { frontend, backend } = structure;
  const utils = utilsReference(frontend.root);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa2vue-skill-'));
  try {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
      '--tools', 'Read,Glob,Grep',
      '--add-dir', frontend.root,
      ...(backend ? ['--add-dir', backend.root] : []),
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources', 'project',
    ];
    if (model) args.push('--model', model);
    const started = Date.now();
    const res = await runClaude(args, buildSkillPrompt(structure), { cwd: work, timeoutMs, claudeBin, isCancelled, onStep, onUsage });
    const out = res.structured_output;
    if (res.is_error || !out || typeof out.skill !== 'string' || !out.skill.trim()) {
      throw new Error(`스킬 생성 실패: ${String(res.result || res.subtype || 'no result').slice(0, 300)}`);
    }
    // Cancelled while Claude was finishing: keep the old skill.
    if (isCancelled && isCancelled()) throw new Error('취소되었습니다');
    const content = skillFile({ body: out.skill, structure, utils });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    // Written whole, then swapped in: a conversion starting now never reads half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return {
      dir,
      file,
      chars: content.length,
      notes: Array.isArray(out.notes) ? out.notes : [],
      costUsd: res.total_cost_usd || null,
      durationMs: Date.now() - started,
    };
  } finally {
    removeWorkDir(work);
  }
}

/** generator-version of a SKILL.md head (1 when the field is missing). */
function skillGeneratorVersion(head) {
  const m = /^generator-version:\s*(\d+)\s*$/m.exec(String(head || ''));
  return m ? Number(m[1]) : 1;
}

module.exports = { generateUniSkill, utilsReference, exportedFunctions, buildSkillPrompt, DEFAULT_DIR, SKILL_NAME, SKILL_GENERATOR_VERSION, skillGeneratorVersion, skillFile };
