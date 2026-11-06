'use strict';

// API 명세 for the conversion documents (conversion-doc.js): per API its
// address, method and what is sent / received, field by field.
// - AI conversion: the AI returns it as `apis` next to the code it wrote
//   (ai-convert.js API_SPEC_SCHEMA), so it matches that code. cleanAiApis()
//   keeps only well-formed entries.
// - Rule-based draft (or an AI answer without apis): ruleApiSpec() builds it
//   from gen-uni's backendModel, the same model gen-uni-backend.js writes the
//   Controller / Mapper.xml from.
// Pure string work so the browser build can use it too.

const { SKIP_COLUMNS } = require('./gen-uni-backend');

// uni frontend src/utils/infra/api.js: axios baseURL
const UNI_API_BASE = '/api';
const KIND_LABEL = { findList: '목록 조회', saveList: '목록 저장', findInfo: '단건 조회', saveInfo: '단건 저장' };
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_SHAPES = new Set(['query', 'object', 'list', 'none']);
const RESPONSE_SHAPES = new Set(['list', 'object', 'value', 'none']);

const REQUEST_LABEL = {
  query: '쿼리 파라미터 (URL ?키=값)',
  object: '요청 본문 JSON 객체',
  list: '요청 본문 JSON 배열 (행마다 아래 필드)',
  none: '없음',
};
const RESPONSE_LABEL = {
  list: 'JSON 배열 (행마다 아래 필드)',
  object: 'JSON 객체 (없으면 빈 응답)',
  value: '값 하나',
  none: '없음 (성공하면 200 OK)',
};

// "학생 목록" + "목록 조회" -> "학생 목록 조회"
const target = (a) => String(a.title || a.dsId || a.name).replace(/s*(목록|리스트|내역|정보|상세)$/, '').trim() || a.name;
const fieldType = (c) => (c && c.date ? 'string (YYYY-MM-DD)' : 'string');

/**
 * API spec from the rule-based model.
 * model: { id, dir, apis: [{ name, kind, title, dsId, columns: [{ col, field, label, date }], pk }], search: [{ key, label, type, required }] }
 * opts.backend: the backend was generated (address = its @RequestMapping)
 */
function ruleApiSpec(model, { backend = false } = {}) {
  if (!model || !Array.isArray(model.apis)) return [];
  const dirPart = model.dir ? `${model.dir}/` : '';
  // The address the browser requests: uni's axios baseURL '/api' + the
  // Service basicUrl, which is also the Controller's @RequestMapping.
  const urlBase = `${UNI_API_BASE}/${dirPart}${model.id}`;
  const search = model.search || [];
  return model.apis.map((a) => {
    const columns = (a.columns || []).filter((c) => !SKIP_COLUMNS.has(c.col));
    const pk = (a.pk || []).filter((f) => columns.some((c) => c.field === f));
    const keys = pk.length ? pk : columns.slice(0, 1).map((c) => c.field);
    const asField = (c, required) => ({ name: c.field, type: fieldType(c), required, desc: c.label || c.col || '' });
    const spec = {
      name: a.name,
      desc: `${target(a)} ${KIND_LABEL[a.kind] || ''}`.trim(),
      method: /^find/.test(a.kind) ? 'GET' : 'POST',
      url: `${urlBase}/${a.name}`,
      service: `${model.id}Service.${a.name}`,
      backend: backend ? `${model.id}Controller.${a.name}` : '',
      source: a.dsId ? `Dataset ${a.dsId}` : '',
      requestShape: 'none',
      request: [],
      responseShape: 'none',
      response: [],
    };
    if (a.kind === 'findList') {
      spec.requestShape = search.length ? 'query' : 'none';
      spec.request = search.map((s) => {
        const used = columns.some((c) => c.field === s.key);
        const like = s.type === 'text' || s.type === 'textarea';
        return {
          name: s.key,
          type: s.type === 'date' ? 'string (YYYY-MM-DD)' : 'string',
          required: !!s.required,
          desc: `${s.label || ''}${like && backend && used ? ' (부분 일치)' : ''}${used || !backend ? '' : ' — 맞는 컬럼이 없어 SQL 조건 미작성(TODO)'}`.trim(),
        };
      });
      spec.responseShape = 'list';
      spec.response = columns.map((c) => asField(c));
    } else if (a.kind === 'findInfo') {
      spec.requestShape = keys.length ? 'query' : 'none';
      spec.request = keys.map((f) => asField(columns.find((c) => c.field === f), true));
      spec.responseShape = 'object';
      spec.response = columns.map((c) => asField(c));
    } else if (a.kind === 'saveList') {
      spec.requestShape = 'list';
      spec.request = [
        { name: 'status', type: 'string', required: true, desc: '행 상태: I(등록) · U(수정) · D(삭제)' },
        ...columns.map((c) => asField(c, keys.includes(c.field))),
      ];
    } else if (a.kind === 'saveInfo') {
      spec.requestShape = 'object';
      spec.request = columns.map((c) => asField(c, keys.includes(c.field)));
    }
    return spec;
  });
}

const str = (v) => (v == null ? '' : String(v).trim());

/** The AI's `apis` answer, keeping well-formed entries only (never throws). */
function cleanAiApis(raw) {
  if (!Array.isArray(raw)) return [];
  const fields = (list, withRequired) => (Array.isArray(list) ? list : [])
    .filter((f) => f && str(f.name))
    .map((f) => ({ name: str(f.name), type: str(f.type) || 'string', ...(withRequired ? { required: f.required === true } : {}), desc: str(f.desc) }));
  return raw.filter((a) => a && str(a.url)).map((a) => {
    const method = str(a.method).toUpperCase();
    const requestShape = REQUEST_SHAPES.has(a.requestShape) ? a.requestShape : 'none';
    const responseShape = RESPONSE_SHAPES.has(a.responseShape) ? a.responseShape : 'none';
    return {
      name: str(a.name) || str(a.url).split('/').pop(),
      desc: str(a.desc),
      method: METHODS.has(method) ? method : method || '-',
      url: str(a.url),
      service: str(a.service),
      backend: str(a.backend),
      source: str(a.source),
      requestShape,
      request: requestShape === 'none' ? [] : fields(a.request, true),
      responseShape,
      response: responseShape === 'none' ? [] : fields(a.response, false),
    };
  });
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The AI's spec against the code it wrote: each API's call function and the
 * last fixed part of its address must appear in the screen's script files.
 * An entry not found gets missing: ['함수 …', '주소 …'] (shown in the docs).
 */
function checkApisAgainstCode(apis, files) {
  const code = (files || []).filter((f) => /\.(m?js|ts|jsx|tsx|vue)$/.test(f.path)).map((f) => f.content).join('\n');
  const has = (word) => !!word && new RegExp(`(^|[^A-Za-z0-9_$])${reEsc(word)}(?![A-Za-z0-9_$])`).test(code);
  // "/a/b/${id}/findX?x=1" -> "findX" (template / path variables skipped)
  const lastLiteral = (url) => url.split('?')[0].split('/').filter((s) => s && !/[${}:]/.test(s)).pop();
  return apis.map((a) => {
    const fn = String(a.service || '').split('.').pop();
    const fnOk = has(fn) || has(a.name);
    const seg = lastLiteral(a.url);
    const urlOk = !seg || code.includes(seg);
    const missing = [!fnOk && `함수 ${fn || a.name}`, !urlOk && `주소 ${a.url}`].filter(Boolean);
    return missing.length ? { ...a, missing } : a;
  });
}

const cell = (v) => String(v == null || v === '' ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const code = (v) => (v ? `\`${String(v).replace(/`/g, "'")}\`` : '');

/** API 목록: one row per API (name linked to its page by linkOf(i)). */
function apiListMarkdown(apis, { note, linkOf } = {}) {
  if (!apis || !apis.length) return '';
  const lines = [];
  if (note) lines.push(note, '');
  lines.push(table(['API', '메서드', '주소', '보내는 값', '받는 값', '설명'], apis.map((a, i) => [
    linkOf ? `[${a.name}](${linkOf(i)})` : code(a.name),
    a.method,
    code(a.url),
    a.request.length ? `${a.request.length}개` : REQUEST_LABEL[a.requestShape] === '없음' ? '없음' : '-',
    a.response.length ? `${a.response.length}개` : a.responseShape === 'none' ? '없음' : '-',
    a.missing ? `⚠ 코드에서 찾지 못함(${a.missing.join(', ')}) ${a.desc}`.trim() : a.desc,
  ])));
  return lines.join('\n');
}

/** One API's page body: address, then what is sent and what comes back. */
function apiDetailMarkdown(a) {
  const lines = [table(['항목', '내용'], [
    ...(a.missing ? [['⚠ 확인 필요', `변환된 코드에서 찾지 못함: ${a.missing.join(', ')} — AI가 적은 명세가 코드와 다를 수 있습니다`]] : []),
    ['주소', `${a.method} ${code(a.url)}`],
    ['보내는 방식', REQUEST_LABEL[a.requestShape]],
    ['받는 형태', RESPONSE_LABEL[a.responseShape]],
    ...(a.service ? [['프론트 호출', code(a.service)]] : []),
    ...(a.backend ? [['백엔드', code(a.backend)]] : []),
    ...(a.source ? [['원본', a.source]] : []),
  ])];
  lines.push('', '## 보내는 값 (요청)', '');
  if (a.request.length) {
    lines.push(table(['이름', '형식', '필수', '설명'], a.request.map((f) => [code(f.name), f.type, f.required ? '예' : '', f.desc])));
  } else {
    lines.push(a.requestShape === 'none' ? '- 없음' : '- 필드 정보 없음 (코드 확인 필요)');
  }
  lines.push('', '## 받는 값 (응답)', '');
  if (a.response.length) {
    lines.push(table(['이름', '형식', '설명'], a.response.map((f) => [code(f.name), f.type, f.desc])));
  } else {
    lines.push(`- ${RESPONSE_LABEL[a.responseShape]}`);
  }
  return lines.join('\n');
}

module.exports = { ruleApiSpec, cleanAiApis, checkApisAgainstCode, apiListMarkdown, apiDetailMarkdown };
