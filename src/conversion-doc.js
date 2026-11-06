'use strict';

// Conversion documents (uni profile): one folder per screen under docs/
// (01_개요, 02_변환내용, 03_API목록, API/<이름>.html) describing what was
// converted, plus docs/index.html listing every screen.
// The content is put together as Markdown and rendered by md-html.js. The AI
// pass writes the body (what the screen does, original script → converted
// code); without it the document is built from the rule-based model alone.
// Pure string work so the browser build can use it too.

const { usageText } = require('./usage');
const posix = require('./posix-path');
const { markdownPage } = require('./md-html');
const { ruleApiSpec, apiListMarkdown, apiDetailMarkdown } = require('./api-spec');

const DOCS_DIR = 'docs';
const INDEX_PATH = `${DOCS_DIR}/index.html`;
const ALL_APIS_PATH = `${DOCS_DIR}/전체_API목록.html`;

const FILE_ROLES = [
  ['View.vue', '화면(배치·이벤트 처리)'],
  ['Service.js', 'API 호출'],
  ['Constant.js', '컬럼·폼·조회조건 정의'],
  ['Controller.java', '백엔드 Controller'],
  ['Service.java', '백엔드 Service'],
  ['Mapper.java', '백엔드 Mapper 인터페이스'],
  ['Dto.java', '백엔드 DTO'],
  ['Mapper.xml', '백엔드 SQL(MyBatis)'],
];
const STATUS_LABEL = { ok: '완료', partial: '확인 필요', error: '실패' };

const cell = (v) => String(v == null || v === '' ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

// One folder per screen (docs/<원본 경로>/<화면ID>/), split into short pages.
// Numbered so they sort in reading order in the file explorer.
const SCREEN_DOC_FILES = {
  overview: '01_개요.html',
  conversion: '02_변환내용.html',
  apis: '03_API목록.html',
  apiDir: 'API',
};

/** docs/<원본 경로>/<화면ID> */
function screenDocDir(model) {
  return [DOCS_DIR, model.dir, model.id].filter(Boolean).join('/');
}

/** The single-file document older versions wrote: docs/<원본 경로>/<화면ID>.html */
function legacyDocPath(model) {
  return [DOCS_DIR, model.dir, `${model.id}.html`].filter(Boolean).join('/');
}

/** The screen's first page: docs/<원본 경로>/<화면ID>/01_개요.html */
function screenDocPath(model) {
  return `${screenDocDir(model)}/${SCREEN_DOC_FILES.overview}`;
}

// API page file names: the API name made file-safe, unique within the screen.
function apiFileNames(apis) {
  const seen = new Set();
  return apis.map((a, i) => {
    const base = String(a.name || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || `api${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    seen.add(name.toLowerCase());
    return `${name}.html`;
  });
}

function roleOf(file) {
  const hit = FILE_ROLES.find(([suffix]) => file.endsWith(suffix));
  return hit ? hit[1] : '';
}

function conversionLabel(ai) {
  if (!ai) return '규칙 기반';
  // AI files kept, but the component check failed them (convert-core.js)
  const checked = Array.isArray(ai.checks) && ai.checks.length;
  if (!ai.ok && !checked) return `규칙 기반 (AI 실패: ${ai.error})`;
  const parts = ['AI(Claude Code)'];
  if (ai.durationMs != null) parts.push(`${Math.round(ai.durationMs / 1000)}초`);
  // Claude usage as % of the plan limits (usage.js), not dollars
  const used = usageText(ai.usage);
  if (used) parts.push(used);
  if (ai.fix && !ai.fix.error) parts.push(`검사에 걸린 ${ai.fix.before}건을 AI가 고침${ai.fix.after ? `(${ai.fix.after}건 남음)` : ''}`);
  if (ai.fix && ai.fix.error) parts.push(`검사 후 AI 수정 실패: ${ai.fix.error}`);
  if (checked) parts.push(`검사 실패: ${ai.error} — 다시 변환 필요`);
  return parts.join(' · ');
}

/**
 * One screen's documents: [{ path, content }], the overview first.
 * result: the report entry ({ input, outputs, todos, status, ai, error })
 * model: convertFormUni's backendModel ({ id, dir, screenName, apis, search })
 * aiDoc: Markdown the AI pass wrote about the conversion (### headings), or ''
 * aiApis: the AI's API 명세 (api-spec.js cleanAiApis), or null
 * backend: backend files were written (addresses are the Controller's)
 */
/**
 * The screen's APIs as its documents show them (AI spec, else the rule-based
 * one; none in vue mode without the AI's), each with its page under API/.
 */
function screenApis({ model, aiApis, backend = false, kind = 'uni' }) {
  const fromAi = !!(aiApis && aiApis.length);
  const apis = fromAi ? aiApis : kind === 'vue' ? [] : ruleApiSpec(model, { backend });
  const files = apiFileNames(apis);
  return { fromAi, apis, files, paths: files.map((f) => `${screenDocDir(model)}/${SCREEN_DOC_FILES.apiDir}/${f}`) };
}

/** For the report (result.doc.apis) and docs/전체_API목록.html: one line per API. */
function apiSummary(args) {
  const { apis, paths } = screenApis(args);
  return apis.map((a, i) => ({ name: a.name, method: a.method, url: a.url, desc: a.desc, page: paths[i], ...(a.missing ? { missing: a.missing } : {}) }));
}

function screenDocs({ result, model, aiDoc, aiApis, backend = false, convertedAt, kind = 'uni' }) {
  const dir = screenDocDir(model);
  const F = SCREEN_DOC_FILES;
  const title = `${model.id} ${model.screenName || ''}`.trim();
  const page = (name, md) => markdownPage(`${title} ${name}`.replace(/\s+/g, ' '), md);
  const back = (up = '') => `[← ${title} 개요](${up}${linkPart(F.overview)})`;

  // Address and the fields sent / received for every API (api-spec.js).
  const { fromAi, apis, files: apiFiles } = screenApis({ model, aiApis, backend, kind });
  const apiLink = (i, up = '') => `${up}${F.apiDir}/${linkPart(apiFiles[i])}`;
  const basis = `${fromAi ? 'AI가 변환한 코드 기준입니다.' : '규칙 기반 초안 기준입니다(원본 Dataset·조회조건으로 추정).'} 보내는 값은 화면이 서버로 넘기는 값, 받는 값은 서버가 돌려줘서 화면이 쓰는 값입니다.`;

  // ---- 01 개요: 기본 정보, 문서 목록, 만든 파일, 확인할 것
  const todos = [...(result.error ? [{ message: result.error }] : []), ...result.todos];
  const madeFiles = result.outputs.filter((p) => !p.startsWith(`${DOCS_DIR}/`));
  const overview = [
    `# ${title}`,
    '',
    `넥사크로 화면 \`${result.input}\`을 ${kind === 'vue' ? '구조 파악한 프로젝트 화면 방식(vue-convert 스킬)' : 'uni 화면 표준'}으로 변환한 내용입니다. nexa2vue가 만들었습니다.`,
    '',
    table(['항목', '내용'], [
      ['원본', `\`${result.input}\``],
      ['화면ID', model.id],
      ['화면명', model.screenName],
      // role and links confirmed before conversion (screen-roles.js)
      ...(result.role && result.role !== 'screen' ? [['종류', `${result.role === 'popup' ? '팝업' : '하위 화면'}${result.parent ? ` (부모 \`${result.parent}\`)` : ''}`]] : []),
      ...(result.members && result.members.length ? [['함께 변환한 하위 화면', result.members.map((m) => `\`${m}\``).join(', ')]] : []),
      ['변환 방식', conversionLabel(result.ai)],
      ['상태', `${STATUS_LABEL[result.status] || result.status} (확인할 것 ${result.todos.length}건)`],
      ['변환 일시', convertedAt],
    ]),
    '',
    '## 문서',
    '',
    table(['문서', '내용'], [
      [`[변환 내용](${linkPart(F.conversion)})`, '원본 화면·스크립트가 어떻게 바뀌었는지'],
      ...(apis.length ? [[`[API 목록](${linkPart(F.apis)})`, `API ${apis.length}개의 주소, 보내는 값·받는 값`]] : []),
      ...apis.map((a, i) => [`[${a.name}](${apiLink(i)})`, `${a.method} ${a.desc || ''}`.trim()]),
    ]),
    '',
    '## 만든 파일',
    '',
    table(['파일', '역할'], madeFiles.map((p) => [`\`${p}\``, roleOf(p)])),
    '',
    `## 확인할 것 (${todos.length}건)`,
    '',
    ...(todos.length ? todos.map((t) => `- ${t.message}${t.line ? ` (원본 스크립트 ${t.line}행)` : ''}`) : ['- 없음']),
  ];

  // ---- 02 변환 내용
  const body = String(aiDoc || '').trim();
  const conversion = [back(), '', `# ${title} 변환 내용`, ''];
  if (body) {
    conversion.push('AI가 변환하면서 쓴 내용입니다.', '', body);
  } else {
    // No AI write-up: what the rule-based draft did, from its own model.
    conversion.push('규칙 기반으로 변환했습니다.', '',
      '배치는 uni 화면 표준(SearchSection·Section·DataGrid·Form·ButtonGroup)으로 다시 잡았습니다. 원본 스크립트는 옮기지 않았고 `View.vue` 아래쪽에 주석으로 남아 있습니다. 조회·추가·삭제·저장·엑셀은 기본 화면과 같은 표준 함수로 만들었습니다.');
    if (model.search && model.search.length) {
      conversion.push('', '### 조회조건', '', table(['키', '라벨', '형식', '필수'],
        model.search.map((s) => [`\`${s.key}\``, s.label, s.type, s.required ? '예' : ''])));
    }
  }

  const pages = [
    { path: `${dir}/${F.overview}`, content: page('개요', overview.join('\n')) },
    { path: `${dir}/${F.conversion}`, content: page('변환 내용', conversion.join('\n')) },
  ];
  if (!apis.length) return pages;

  // ---- 03 API 목록 + API/<이름>.html (one page per API)
  pages.push({
    path: `${dir}/${F.apis}`,
    content: page('API 목록', [back(), '', `# ${title} API 목록`, '', apiListMarkdown(apis, { note: basis, linkOf: (i) => apiLink(i) })].join('\n')),
  });
  apis.forEach((a, i) => {
    const nav = `${back('../')} · [API 목록](../${linkPart(F.apis)})`;
    pages.push({
      path: `${dir}/${F.apiDir}/${apiFiles[i]}`,
      content: page(a.name, [nav, '', `# ${a.name}${a.desc ? ` — ${a.desc}` : ''}`, '', basis, '', apiDetailMarkdown(a)].join('\n')),
    });
  });
  return pages;
}

/** docs/index.html: every screen of the run with a link to its document. */
// One path segment of a markdown link: spaces, "#" and parentheses would end
// or break the link, so they are encoded too.
const linkPart = (s) => encodeURIComponent(s).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// A docs/ path as a link from a page directly in docs/
const docsLink = (p) => posix.relative(DOCS_DIR, p).split('/').map(linkPart).join('/');
const apisOf = (f) => (f.doc && Array.isArray(f.doc.apis) ? f.doc.apis : []);

/**
 * docs/전체_API목록.html: every screen's APIs in one table, for handing the
 * server side over. Screens of an older report (no doc.apis) are counted.
 */
function allApisDoc(report) {
  const screens = report.files.filter((f) => f.doc && !f.mergedInto);
  const rows = screens.flatMap((f) => apisOf(f).map((a) => ({ f, a })));
  // the same method + address in more than one screen: the server serves it once
  const seen = new Map();
  for (const { f, a } of rows) {
    const key = `${a.method} ${a.url}`;
    seen.set(key, [...(seen.get(key) || []), f.doc.id]);
  }
  const shared = (a) => {
    const ids = [...new Set(seen.get(`${a.method} ${a.url}`) || [])];
    return ids.length > 1 ? ` (같은 주소: ${ids.join(', ')})` : '';
  };
  const unknown = screens.filter((f) => !Array.isArray(f.doc.apis));
  const lines = [
    `[← 변환 내용 문서](${linkPart('index.html')})`,
    '',
    '# 전체 API 목록',
    '',
    `이번 변환의 모든 화면이 부르는 API입니다(화면 ${screens.length}개 · API ${rows.length}개). 보내는 값·받는 값은 API 이름을 누르면 나옵니다. nexa2vue가 만들었습니다.`,
  ];
  if (rows.length) {
    lines.push('', table(['화면ID', '화면명', 'API', '메서드', '주소', '설명'], rows.map(({ f, a }) => [
      `[${f.doc.id}](${docsLink(f.doc.path)})`,
      f.doc.screenName,
      a.page ? `[${a.name}](${docsLink(a.page)})` : `\`${a.name}\``,
      a.method,
      `\`${String(a.url).replace(/`/g, "'")}\``,
      `${a.missing ? `⚠ 코드에서 찾지 못함(${a.missing.join(', ')}) ` : ''}${a.desc || ''}${shared(a)}`.trim(),
    ])));
  } else {
    lines.push('', '- 없음');
  }
  if (unknown.length) {
    lines.push('', `API 정보가 없는 화면(이전 버전으로 변환한 결과, 다시 변환하면 들어감): ${unknown.map((f) => f.doc.id).join(', ')}`);
  }
  return markdownPage('전체 API 목록', lines.join('\n'));
}

function indexDoc(report) {
  const s = report.summary;
  const screens = report.files.filter((f) => f.doc);
  const apiCount = screens.filter((f) => !f.mergedInto).reduce((n, f) => n + apisOf(f).length, 0);
  const lines = [
    '# 변환 내용 문서',
    '',
    '넥사크로 → uni 변환 결과입니다. 화면마다 변환 내용을 정리한 문서가 이 폴더에 있습니다. nexa2vue가 만들었습니다.',
    '',
    table(['항목', '내용'], [
      ['입력 폴더', `\`${report.input}\``],
      ['출력 폴더', `\`${report.output}\``],
      ['변환 방식', report.ai ? `AI(Claude Code), 동시 ${report.aiParallel}개` : '규칙 기반'],
      ...(report.usage ? [['Claude 사용량', `${usageText(report.usage).replace(/^사용량 /, '')} — 이번 변환 전체`]] : []),
      ['결과', `전체 ${s.total} · 완료 ${s.ok} · 확인 필요 ${s.partial} · 실패 ${s.error} · 확인할 것 ${s.todos}건`],
      ['변환 일시', `${report.startedAt} ~ ${report.finishedAt}`],
    ]),
    '',
    '## 문서',
    '',
    `- [전체 API 목록](${docsLink(ALL_APIS_PATH)}) — 모든 화면의 API ${apiCount}개(주소·메서드, 화면별 API 문서로 연결)`,
    '',
    '## 화면 목록',
    '',
    table(['화면ID', '화면명', '원본', '변환 방식', '상태', 'API', '확인할 것'], screens.map((f) => [
      `[${f.doc.id}](${docsLink(f.doc.path)})`,
      f.doc.screenName,
      `\`${f.input}\``,
      conversionLabel(f.ai),
      STATUS_LABEL[f.status] || f.status,
      f.mergedInto ? '-' : Array.isArray(f.doc.apis) ? f.doc.apis.length : '-',
      f.todos.length,
    ])),
  ];
  const failed = report.files.filter((f) => f.status === 'error');
  if (failed.length) {
    lines.push('', '## 변환하지 못한 화면', '', ...failed.map((f) => `- \`${f.input}\`: ${f.error}`));
  }
  return markdownPage('변환 내용 문서', lines.join('\n'));
}

module.exports = { screenDocs, screenApis, apiSummary, screenDocPath, screenDocDir, legacyDocPath, SCREEN_DOC_FILES, indexDoc, allApisDoc, INDEX_PATH, ALL_APIS_PATH };
