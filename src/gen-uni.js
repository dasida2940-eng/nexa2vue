'use strict';

// "uni" output profile: re-lays a Nexacro form out as a uni frontend screen
// (views/{dir}/{ID}/{ID}View.vue + Service.js + Constant.js) built from the
// project's standard parts (SearchSection, Section/SectionGroup, DataGrid,
// Form, ButtonGroup) instead of keeping absolute coordinates.
// Screen standard: uni frontend src/views/co/csm/README.md (base screens A1~A6).

const posix = require('./posix-path');
const { parseXfdl } = require('./xfdl-parser');
const { indexComponents } = require('./convert-form');
const { IDENT } = require('./gen-template');
const { generateBackend, snake, DATE_TYPES } = require('./gen-uni-backend');
const { outputId } = require('./names');

const INPUT_TYPES = new Set(['Edit', 'MaskEdit', 'TextArea', 'Spin', 'Calendar', 'Combo', 'Radio', 'CheckBox']);
const LAYOUT_ONLY_TYPES = new Set(['Div', 'Tab', 'GroupBox', 'Static', 'Button', 'Grid']);
const NUMERIC_TYPES = new Set(['INT', 'BIGDECIMAL', 'FLOAT', 'DECIMAL', 'LONG', 'NUMBER']);
const ID_PREFIX = /^(edt|cbo|cmb|cal|chk|rdo|rad|spn|spin|txt|txa|msk|mae|me|ta|sta|grd|btn|div)_/i;
const SCREEN_ID = /^[A-Z]{3}\d{7}(_POP)?$/;
// Gap allowed between stacked/side-by-side regions before they count as overlapping.
const OVERLAP_TOLERANCE = 5;
const MAX_FORM_COLUMNS = 4;

// ---------------------------------------------------------------- naming

function camel(id) {
  const s = String(id);
  if (/[a-z]/.test(s) && !s.includes('_')) return s[0].toLowerCase() + s.slice(1);
  return s.toLowerCase().replace(/^_+/, '').replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function pascal(id) {
  const c = camel(id);
  return c ? c[0].toUpperCase() + c.slice(1) : c;
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function uniqueName(base, used) {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

// ds_csys281 -> Csys281 (screen standard: Nexacro screens may use the dataset
// name as target token). Names that are not table codes (ds_list) give ''.
function datasetToken(dsId) {
  const stripped = String(dsId || '').replace(/^ds_?/i, '');
  if (!/^[A-Za-z]+_?\d+$/.test(stripped)) return '';
  const token = pascal(stripped.replace(/[^\w]/g, '_'));
  return IDENT.test(token) ? token : '';
}

// Undecided target: keep the base screens' Tbl001/Tbl002 so one replace fixes it later.
function placeholderToken(used) {
  for (let i = 1; ; i++) {
    const token = `Tbl${String(i).padStart(3, '0')}`;
    if (!used.has(token)) {
      used.add(token);
      return token;
    }
  }
}

// 받침 여부로 조사를 고른다: josa('목록', '을', '를') -> '목록을'
function josa(word, withFinal, withoutFinal) {
  const code = String(word).charCodeAt(String(word).length - 1);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return `${word}${hasFinal ? withFinal : withoutFinal}`;
}

function fieldKeyFromId(id) {
  const key = camel(String(id).replace(ID_PREFIX, '').replace(/[^\w]/g, '_'));
  return IDENT.test(key) ? key : 'field';
}

// ---------------------------------------------------------------- geometry

function num(raw, ref) {
  if (raw === undefined || raw === '') return null;
  const m = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(String(raw).trim());
  if (!m) return null;
  return m[2] === '%' ? (Number(m[1]) * ref) / 100 : Number(m[1]);
}

// A side given relative to a sibling ("grdMain:20"), in the parent's coordinates:
// left/top sit that far past the sibling's right/bottom edge, right/bottom that
// far before its left/top edge. Unknown siblings resolve to 0 (reading order only).
function anchored(raw, ref, side, parent, siblings) {
  const m = /^([A-Za-z_]\w*)\s*:\s*(-?\d+(?:\.\d+)?)(px|%)?$/.exec(String(raw ?? '').trim());
  if (!m) return num(raw, ref);
  const s = siblings && siblings.get(m[1]);
  if (!s) return 0;
  const gap = m[3] === '%' ? (Number(m[2]) * ref) / 100 : Number(m[2]);
  const x = s.x - parent.x;
  const y = s.y - parent.y;
  if (side === 'left') return x + s.w + gap;
  if (side === 'top') return y + s.h + gap;
  if (side === 'right') return parent.w - x + gap;
  return parent.h - y + gap;
}

// Absolute box from left/top/right/bottom/width/height; siblings (id -> box)
// resolve relative anchors.
function boxOf(attrs, parent, siblings) {
  const l = anchored(attrs.left, parent.w, 'left', parent, siblings);
  const r = anchored(attrs.right, parent.w, 'right', parent, siblings);
  const w = num(attrs.width, parent.w);
  const t = anchored(attrs.top, parent.h, 'top', parent, siblings);
  const b = anchored(attrs.bottom, parent.h, 'bottom', parent, siblings);
  const h = num(attrs.height, parent.h);
  const width = w ?? (l != null && r != null ? parent.w - l - r : 0);
  const height = h ?? (t != null && b != null ? parent.h - t - b : 0);
  const x = l ?? (r != null ? parent.w - r - width : 0);
  const y = t ?? (b != null ? parent.h - b - height : 0);
  return { x: parent.x + x, y: parent.y + y, w: Math.max(0, width), h: Math.max(0, height) };
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bt = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bt - y };
}

function overlapsX(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

function distance(a, b) {
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  return dy + dx * 2;
}

/**
 * Flatten the component tree with absolute boxes. `scope` is the innermost
 * tab page (or null for the form itself); regions are laid out per scope.
 */
function flatten(ir, keyOf) {
  const root = { x: 0, y: 0, w: num(ir.attrs.width, 0) ?? 1280, h: num(ir.attrs.height, 0) ?? 720 };
  const items = [];
  const walk = (list, parentBox, ancestors, scope) => {
    const siblings = new Map();
    for (const comp of list) {
      const item = { comp, key: keyOf.get(comp), box: boxOf(comp.attrs, parentBox, siblings), ancestors, scope };
      if (comp.id) siblings.set(comp.id, item.box);
      items.push(item);
      if (comp.tabpages) {
        comp.tabpages.forEach((page) => {
          const pageScope = { tab: item, page };
          walk(page.children, item.box, [...ancestors, item], pageScope);
        });
      } else {
        walk(comp.children, item.box, [...ancestors, item], scope);
      }
    }
  };
  walk(ir.components, root, [], null);
  return items;
}

// Rows of items ordered top-to-bottom, then left-to-right.
function groupRows(items) {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    // Half the shorter height, so a tall TextArea does not swallow the next line.
    const tol = row ? Math.max(8, Math.min(row.h || it.box.h, it.box.h || row.h) / 2) : 0;
    if (row && Math.abs(row.y - it.box.y) <= tol) row.items.push(it);
    else rows.push({ y: it.box.y, h: it.box.h, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.box.x - b.box.x));
}

// XY-cut: split into a vertical stack where no region spans the gap, else
// side by side; the result mirrors SectionGroup nesting.
function layoutTree(regions) {
  if (regions.length === 1) return regions[0];
  const stack = splitAlong(regions, (r) => r.box.y, (r) => r.box.y + r.box.h);
  if (stack.length > 1) return { dir: 'vertical', children: stack.map(layoutTree) };
  const side = splitAlong(regions, (r) => r.box.x, (r) => r.box.x + r.box.w);
  if (side.length > 1) return { dir: 'horizontal', children: side.map(layoutTree) };
  return { dir: 'vertical', children: [...regions].sort((a, b) => a.box.y - b.box.y) };
}

function splitAlong(regions, start, end) {
  const sorted = [...regions].sort((a, b) => start(a) - start(b));
  const groups = [];
  let current = [];
  let currentEnd = -Infinity;
  for (const r of sorted) {
    if (current.length && start(r) >= currentEnd - OVERLAP_TOLERANCE) {
      groups.push(current);
      current = [];
      currentEnd = -Infinity;
    }
    current.push(r);
    currentEnd = Math.max(currentEnd, end(r));
  }
  groups.push(current);
  return groups;
}

// ---------------------------------------------------------------- JS literal output

class Raw {
  constructor(code) {
    this.code = code;
  }
}

function jsString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

// Nexacro text going into a // or /** */ comment: one line (a line break would
// turn the rest into code) and no "*/" that would end the comment early.
function commentText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

// Prettier-like literal: inline when it fits in 100 columns, otherwise one
// entry per line. An object's `__comment` is printed as a line comment above it.
function toJs(value, indent = '') {
  if (value instanceof Raw) return value.code;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const forceMulti = value.some((v) => v && v.__comment);
    const inline = `[${value.map((v) => toJs(v, indent)).join(', ')}]`;
    if (!forceMulti && !inline.includes('\n') && inline.length + indent.length <= 100) return inline;
    const inner = indent + '  ';
    const lines = value.map((v) => {
      const comment = v && v.__comment ? `${inner}// ${commentText(v.__comment)}\n` : '';
      return `${comment}${inner}${toJs(v, inner)},`;
    });
    return `[\n${lines.join('\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([k, v]) => k !== '__comment' && v !== undefined);
    if (entries.length === 0) return '{}';
    const prop = (k) => (IDENT.test(k) ? k : jsString(k));
    const inline = `{ ${entries.map(([k, v]) => `${prop(k)}: ${toJs(v, indent)}`).join(', ')} }`;
    if (!inline.includes('\n') && inline.length + indent.length <= 100) return inline;
    const inner = indent + '  ';
    return `{\n${entries.map(([k, v]) => `${inner}${prop(k)}: ${toJs(v, inner)},`).join('\n')}\n${indent}}`;
  }
  if (typeof value === 'string') return jsString(value);
  return String(value);
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value) {
  return escapeAttr(value).replace(/\{/g, '&#123;');
}

function escapeComment(value) {
  return String(value).replace(/--/g, '- -').replace(/[<>]/g, '');
}

// ---------------------------------------------------------------- classification

function buttonAction(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (/^(조회|검색)$/.test(t)) return 'search';
  if (/엑셀|excel/i.test(t)) return 'download';
  if (/^(추가|행추가|신규)$/.test(t)) return 'add';
  if (/^(삭제|행삭제)$/.test(t)) return 'delete';
  if (/^저장$/.test(t)) return 'save';
  return null;
}

function staticText(item) {
  return cleanText(item.comp.attrs.text);
}

// A section title is a short name ("수강신청내역"), not a notice sentence
// ("※ ... 승인을 득해야 합니다.") or a count ("총 [0]건").
function isTitleText(text) {
  return /[A-Za-z가-힣]/.test(text) && text.length <= 30 && !/^[※*]/.test(text) && !/(니다|하세요)\.?\)?$/.test(text) && !/^총\s/.test(text);
}

// Display text from a Nexacro text value: line breaks become spaces and an
// "expr:" text keeps only its string literals (expr:"합격" + String.fromCharCode(13) + "유무" -> 합격 유무).
function cleanText(raw) {
  let text = String(raw || '');
  if (/^expr:/i.test(text)) text = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]).join(' ');
  return text.replace(/\s+/g, ' ').trim();
}

// "* 이름 :" -> { label: '이름', required: true }
function parseLabel(text) {
  const required = /^\*|\*$/.test(text.trim());
  const label = text.replace(/\*/g, '').replace(/[:：]\s*$/, '').trim();
  return { label, required };
}

function findSearchDiv(items) {
  const divs = items.filter((i) => i.comp.type === 'Div');
  const hasSearchButton = (div) =>
    items.some((i) => i.comp.type === 'Button' && i.ancestors.includes(div) && buttonAction(i.comp.attrs.text) === 'search');
  return divs.find((d) => /search|srch|sch|cond/i.test(d.comp.id)) || divs.find(hasSearchButton) || null;
}

function sameScope(a, b) {
  return a.scope === b.scope || (a.scope && b.scope && a.scope.page === b.scope.page);
}

// Pair each input with the nearest unused Static to its left on the same line.
function pairLabels(inputs, statics, used) {
  const labels = new Map();
  for (const input of inputs) {
    const b = input.box;
    let best = null;
    let bestGap = Infinity;
    for (const s of statics) {
      // "-" between two inputs (code - number) is a separator, not a label.
      if (used.has(s) || !sameScope(s, input) || !/[A-Za-z가-힣]/.test(staticText(s))) continue;
      const centerY = s.box.y + s.box.h / 2;
      if (centerY < b.y - 2 || centerY > b.y + Math.max(b.h, 20) + 2) continue;
      const gap = b.x - (s.box.x + s.box.w);
      if (gap < -5 || gap > 200) continue;
      if (gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best);
      labels.set(input, parseLabel(staticText(best)));
    }
  }
  return labels;
}

function staticOptions(ds, codeCol, dataCol) {
  if (!ds || !ds.rows.length || !codeCol || !dataCol) return null;
  return ds.rows.map((r) => ({ label: r[dataCol] ?? '', value: r[codeCol] ?? '' }));
}

/**
 * One FormItem for an input component.
 */
function formItem(input, ctx, labelInfo, keys) {
  const { comp } = input;
  const a = comp.attrs;
  const bind = ctx.bindOf.get(input.key);
  const key = uniqueName(bind ? camel(bind.columnid) : fieldKeyFromId(comp.id), keys);
  const label = (labelInfo && labelInfo.label) || (comp.type === 'CheckBox' ? a.text || '' : '') || key;
  const item = { key, label, type: 'text' };
  if (label === key) ctx.todo(`${comp.id}: 왼쪽에 라벨(Static)이 없어 라벨을 키 이름(${key})으로 두었습니다`);
  if (labelInfo && labelInfo.required) item.required = true;

  switch (comp.type) {
    case 'Edit':
      if (num(a.maxlength, 0)) item.maxlength = num(a.maxlength, 0);
      if (a.password === 'true') ctx.todo(`${comp.id}: 비밀번호 입력(password)은 Field에 없어 text로 둡니다`);
      break;
    case 'MaskEdit':
      if (String(a.type || '').toLowerCase() === 'number') item.type = 'number';
      if (a.mask) ctx.todo(`${comp.id}: 마스크 "${a.mask}"는 옮기지 않았습니다`);
      break;
    case 'TextArea':
      item.type = 'textarea';
      item.rows = Math.max(2, Math.round(input.box.h / 22) || 3);
      break;
    case 'Spin':
      item.type = 'number';
      break;
    case 'Calendar':
      item.type = 'date';
      break;
    case 'CheckBox':
      item.type = 'checkbox';
      if ((a.truevalue !== undefined && a.truevalue !== '1') || (a.falsevalue !== undefined && a.falsevalue !== '0')) {
        ctx.todo(`${comp.id}: 체크값 ${a.truevalue}/${a.falsevalue} — Field checkbox는 '1'/'0'을 씁니다`);
      }
      break;
    case 'Combo':
    case 'Radio': {
      item.type = 'select';
      const options = staticOptions(ctx.datasets.get(a.innerdataset), a.codecolumn, a.datacolumn);
      item.options = options || [];
      if (!options) {
        item.__comment = `TODO(nexa2vue): 선택지(${a.innerdataset || '없음'}) — 공통코드면 commonOptions로 연결`;
        ctx.todo(`${comp.id}: 선택지(innerdataset="${a.innerdataset || ''}")를 commonOptions나 고정 옵션으로 연결하세요`);
      }
      if (comp.type === 'Radio') ctx.todo(`${comp.id}: 라디오는 Field에 없어 select로 바꿨습니다`);
      break;
    }
    default:
      break;
  }
  return item;
}

function formItemsOf(inputs, ctx, labels) {
  const keys = new Set();
  const rows = groupRows(inputs).map((row) => row.map((input) => formItem(input, ctx, labels.get(input), keys)));
  // Rows wider than the grid wrap; a lone checkbox label row stays as is.
  const out = [];
  for (const row of rows) for (let i = 0; i < row.length; i += MAX_FORM_COLUMNS) out.push(row.slice(i, i + MAX_FORM_COLUMNS));
  return out;
}

function gridColumns(gridItem, ctx) {
  const ds = ctx.datasets.get(gridItem.comp.attrs.binddataset);
  const typeOf = (id) => (ds && (ds.columns.find((c) => c.id === id) || {}).type) || 'STRING';
  const names = new Set();
  const result = { columns: [], rowNumber: false, selection: false, editable: false };

  for (const cell of gridItem.comp.grid.columns) {
    const a = cell.attrs || {};
    const expr = cell.expr || a.expr || '';
    if (!cell.prop) {
      if (/currow/i.test(expr)) {
        result.rowNumber = true;
        continue;
      }
      if (!expr && !cell.label) continue;
      const name = uniqueName(`col${cell.col}`, names);
      result.columns.push({
        __comment: `TODO(nexa2vue): 원본 셀 표현식 ${expr || '(없음)'} — body-cell-${name} 슬롯이나 서버 값으로 옮기세요`,
        name, label: cleanText(cell.label), field: name, width: num(cell.width, 0) || undefined,
      });
      ctx.todo(`${gridItem.comp.id}: 셀 표현식 "${expr}"는 옮기지 않았습니다`);
      continue;
    }
    const checkLike = /checkbox/i.test(a.displaytype || '') || /checkbox/i.test(a.edittype || '');
    if (checkLike && /^_?(chk|check|sel|select)(_?yn)?$/i.test(cell.prop)) {
      result.selection = true;
      continue;
    }
    const name = uniqueName(camel(cell.prop), names);
    const col = { name, label: cleanText(cell.label) || cell.prop, field: name };
    const width = num(cell.width, 0);
    const numeric = NUMERIC_TYPES.has(String(typeOf(cell.prop)).toUpperCase());
    if (numeric) col.align = 'right';
    else if (width >= 150) col.align = 'left';
    if (width) col.width = width;

    const edit = String(a.edittype || '').toLowerCase();
    const comboOptions = staticOptions(ctx.datasets.get(a.combodataset), a.combocodecol, a.combodatacol);
    if (edit === 'combo') {
      col.editor = { type: 'select', options: comboOptions || undefined };
      if (!comboOptions) {
        col.__comment = `TODO(nexa2vue): 선택지(${a.combodataset || '없음'}) — option-map이나 editor.options로 연결`;
        ctx.todo(`${gridItem.comp.id}.${cell.prop}: 콤보 선택지(${a.combodataset || ''})를 연결하세요`);
      }
    } else if (edit === 'date') {
      col.editor = { type: 'date' };
    } else if (edit === 'checkbox') {
      col.editor = { type: 'toggle' };
    } else if (edit && edit !== 'none') {
      col.editor = { type: numeric ? 'number' : 'text' };
      const max = num(a.editmaxlength ?? a.editlimit, 0);
      if (max > 0 && !numeric) col.editor.maxlength = max;
    } else if (comboOptions && /combo/i.test(a.displaytype || '')) {
      col.options = comboOptions;
    }
    if (col.editor) result.editable = true;
    result.columns.push(col);
  }
  return result;
}

function guessPk(ds, columns) {
  const fields = columns.map((c) => c.field);
  const ids = ds ? ds.columns.map((c) => c.id) : [];
  const hit = ids.find((id) => /(_ID|_CD|_NO|_SEQ|ID|CD)$/.test(id) && fields.includes(camel(id)));
  return [hit ? camel(hit) : fields[0] || 'id'];
}

// ---------------------------------------------------------------- analysis

/**
 * Turn the IR into screen regions (grid / form / tab), the search area and
 * the button assignments.
 */
function analyze(ir, ctx) {
  const { keyOf } = indexComponents(ir.components);
  // Hidden components (visible="false", or inside a hidden container) are not
  // laid out: they are often spacing guides ("sta_GU_space") or shown later by script.
  const isHidden = (i) => [...i.ancestors, i].some((x) => x.comp.attrs.visible === 'false');
  const all = flatten(ir, keyOf);
  const items = all.filter((i) => !isHidden(i));
  const hiddenShown = all.filter((i) => isHidden(i) && !['Static', 'Div', 'GroupBox'].includes(i.comp.type));
  if (hiddenShown.length) {
    ctx.todo(`숨김(visible="false") 컴포넌트는 배치하지 않았습니다 — 스크립트로 보이게 한다면 옮기세요: ${hiddenShown.map((i) => i.comp.id).join(', ')}`);
  }
  const searchDiv = findSearchDiv(items);
  const statics = items.filter((i) => i.comp.type === 'Static');
  const usedStatics = new Set();

  const inSearch = (i) => searchDiv && i.ancestors.includes(searchDiv);
  const rootGrids = items.filter((i) => i.comp.type === 'Grid' && !i.scope);
  const firstGridTop = rootGrids.length ? Math.min(...rootGrids.map((g) => g.box.y)) : null;
  // No search Div: inputs sitting above the first grid on the form itself act as the search area.
  const positionalSearch = (i) =>
    !searchDiv && firstGridTop != null && !i.scope && i.box.y + i.box.h <= firstGridTop + 2 &&
    !i.ancestors.some((a) => a.comp.type === 'Div' || a.comp.type === 'Tab');

  for (const i of items) {
    if (!INPUT_TYPES.has(i.comp.type) && !LAYOUT_ONLY_TYPES.has(i.comp.type)) {
      ctx.todo(`${i.comp.id}: 지원하지 않는 컴포넌트 ${i.comp.type} — 옮기지 않았습니다`);
    }
  }

  const inputs = items.filter((i) => INPUT_TYPES.has(i.comp.type));
  const searchInputs = inputs.filter((i) => inSearch(i) || positionalSearch(i));
  const searchLabels = pairLabels(searchInputs, statics, usedStatics);
  const searchItems = searchInputs.length ? formItemsOf(searchInputs, ctx, searchLabels) : null;

  const regions = [];
  // A sub-screen's names go into its host's Service/Constant: tokens the host
  // (or another sub-screen) already uses are taken.
  const tokens = new Set(ctx.reservedTokens || []);

  // Sub-screens put in by a Div (url="…" or div.set_url): the Div becomes the
  // sub-screen's component (ctx.embeds: Div id -> { name }).
  for (const d of items.filter((i) => i.comp.type === 'Div' && ctx.embeds && ctx.embeds.has(i.comp.id))) {
    regions.push({ kind: 'embed', item: d, scope: d.scope, box: d.box, name: ctx.embeds.get(d.comp.id).name, actions: new Map(), etc: [] });
    ctx.embeds.get(d.comp.id).placed = true;
  }

  // Grids
  for (const g of items.filter((i) => i.comp.type === 'Grid')) {
    const dsId = g.comp.attrs.binddataset;
    const ds = ctx.datasets.get(dsId);
    if (!ds) ctx.todo(`${g.comp.id}: binddataset="${dsId || ''}"를 찾을 수 없습니다`);
    const dsToken = datasetToken(dsId);
    const token = dsToken ? uniqueName(dsToken, tokens) : placeholderToken(tokens);
    const cols = gridColumns(g, ctx);
    regions.push({ kind: 'grid', item: g, scope: g.scope, box: g.box, token, dsId, ds, ...cols, actions: new Map(), etc: [] });
  }

  // Forms: remaining inputs grouped by their innermost Div (or the scope itself)
  const formInputs = inputs.filter((i) => !searchInputs.includes(i));
  const groups = new Map();
  for (const i of formInputs) {
    const container = [...i.ancestors].reverse().find((a) => a.comp.type === 'Div' || a.comp.type === 'Tab') || null;
    const groupKey = container && container.comp.type === 'Div' ? container : i.scope ? i.scope.page : 'root';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(i);
  }
  for (const list of groups.values()) {
    const labels = pairLabels(list, statics, usedStatics);
    const dsIds = new Set(list.map((i) => (ctx.bindOf.get(i.key) || {}).datasetid).filter(Boolean));
    const dsId = dsIds.size === 1 ? [...dsIds][0] : null;
    if (dsIds.size > 1) ctx.todo(`폼 입력이 데이터셋 여러 개(${[...dsIds].join(', ')})에 바인딩되어 있어 첫 모델 하나로 묶었습니다`);
    regions.push({
      kind: 'form', scope: list[0].scope, box: unionBox(list.map((i) => i.box)), inputs: list,
      formItems: formItemsOf(list, ctx, labels), dsId, actions: new Map(), etc: [],
    });
  }

  // Link a form bound to a grid's dataset (A3: edit the selected row)
  for (const f of regions.filter((r) => r.kind === 'form')) {
    const grid = f.dsId && regions.find((r) => r.kind === 'grid' && r.dsId === f.dsId);
    if (grid) {
      f.linkedGrid = grid;
      grid.linkedForm = f;
    }
    const dsToken = datasetToken(f.dsId);
    f.token = grid ? grid.token : dsToken ? uniqueName(dsToken, tokens) : placeholderToken(tokens);
  }

  // Titles: an unused Static right above a region (a sub-screen has its own)
  for (const r of regions.filter((x) => x.kind !== 'embed')) {
    let best = null;
    let bestGap = Infinity;
    for (const s of statics) {
      if (usedStatics.has(s) || inSearch(s) || !isTitleText(staticText(s)) || !sameScope(s, { scope: r.scope }) || !overlapsX(s.box, r.box)) continue;
      const gap = r.box.y - (s.box.y + s.box.h);
      if (gap >= -2 && gap < 40 && gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    if (best) {
      usedStatics.add(best);
      r.title = parseLabel(staticText(best)).label;
    }
  }

  // Buttons
  const searchButtons = [];
  for (const b of items.filter((i) => i.comp.type === 'Button')) {
    const action = buttonAction(b.comp.attrs.text);
    if (action === 'search' && (searchItems || inSearch(b))) {
      searchButtons.push(b);
      continue;
    }
    const own = regions.filter((r) => r.kind !== 'embed');
    const candidates = own.filter((r) => sameScope(r, b));
    const pool = candidates.length ? candidates : own;
    if (!pool.length) {
      ctx.todo(`${b.comp.id}: 버튼 "${b.comp.attrs.text || ''}"을 둘 영역이 없어 옮기지 않았습니다`);
      continue;
    }
    let target = pool.reduce((best, r) => (distance(b.box, r.box) < distance(b.box, best.box) ? r : best));
    if (target.linkedGrid) target = target.linkedGrid;
    const allowed = target.kind === 'grid' ? ['add', 'delete', 'save', 'download'] : ['save'];
    if (action && allowed.includes(action) && !target.actions.has(action)) target.actions.set(action, b);
    else target.etc.push(b);
  }

  const leftover = statics.filter((s) => !usedStatics.has(s) && !inSearch(s) && staticText(s));
  if (leftover.length) {
    ctx.todo(`배치하지 않은 텍스트: ${leftover.map((s) => `${s.comp.id}("${staticText(s)}")`).join(', ')}`);
  }

  const tabs = items.filter((i) => i.comp.type === 'Tab');
  return { regions, searchItems, searchButtons, tabs, scopeTree: buildScopeTree(regions, tabs) };
}

// Regions per scope; a Tab becomes a region of its parent scope whose pages
// hold their own layouts.
function buildScopeTree(regions, tabs) {
  const forScope = (scope) => {
    const own = regions.filter((r) => (r.scope || null) === scope || (r.scope && scope && r.scope.page === scope.page));
    const tabRegions = tabs
      .filter((t) => (t.scope || null) === scope || (t.scope && scope && t.scope.page === scope.page))
      .map((t) => ({
        kind: 'tab', item: t, box: t.box,
        pages: t.comp.tabpages.map((page) => ({ page, tree: forScope({ tab: t, page }) })),
      }))
      .filter((t) => t.pages.some((p) => p.tree));
    const all = [...own, ...tabRegions];
    return all.length ? layoutTree(all) : null;
  };
  return forScope(null);
}

// ---------------------------------------------------------------- generation

function rowsVar(r) {
  return `${lowerFirst(r.token)}Rows`;
}

function sizeOf(region, ctx, parentDir) {
  if (region.kind === 'form') return null;
  if (region === ctx.mainGrid || parentDir === 'horizontal') return 'rest';
  return 'rows';
}

function renderNode(node, ctx, indent, parentDir) {
  if (node.dir) {
    const out = [`${indent}<SectionGroup direction="${node.dir}">`];
    for (const child of node.children) out.push(...renderNode(child, ctx, indent + '  ', node.dir));
    out.push(`${indent}</SectionGroup>`);
    return out;
  }
  if (node.kind === 'tab') {
    const names = node.item.comp.tabpages.map((p) => p.text).join(' / ');
    ctx.todo(`${node.item.comp.id}: 탭(${names})을 초안에서는 세로로 펼쳤습니다 — KeepAliveTabs + 탭 페이지 파일({화면ID}Tab…)로 나누세요(부품 사용법 B4-2)`);
    const out = [`${indent}<!-- TODO(nexa2vue): 원본 탭 ${escapeComment(node.item.comp.id)}(${escapeComment(names)}) — 세로로 두지 말고 KeepAliveTabs + 탭 페이지마다 {화면ID}Tab….vue로 나눈다(부품 사용법 B4-2) -->`];
    const pages = node.pages.filter((p) => p.tree);
    for (const p of pages) {
      const first = firstRegion(p.tree);
      if (first && !first.title) first.title = cleanText(p.page.text);
    }
    if (pages.length === 1) return [...out, ...renderNode(pages[0].tree, ctx, indent, parentDir)];
    out.push(`${indent}<SectionGroup direction="vertical">`);
    for (const p of pages) out.push(...renderNode(p.tree, ctx, indent + '  ', 'vertical'));
    out.push(`${indent}</SectionGroup>`);
    return out;
  }
  if (node.kind === 'embed') return [`${indent}<${node.name} />`];
  return node.kind === 'grid' ? renderGrid(node, ctx, indent, parentDir) : renderForm(node, ctx, indent, parentDir);
}

function firstRegion(node) {
  if (!node) return null;
  if (node.dir) return firstRegion(node.children[0]);
  if (node.kind === 'tab' || node.kind === 'embed') return null;
  return node;
}

function sectionOpen(region, ctx, indent, parentDir, fallbackTitle) {
  const size = sizeOf(region, ctx, parentDir);
  const title = region.title || fallbackTitle;
  return `${indent}<Section title="${escapeAttr(title)}"${size ? ` size="${size}"` : ''}>`;
}

function etcSlot(region, ctx, indent) {
  if (!region.etc.length) return [];
  const out = [`${indent}<template #etc-btn>`];
  for (const b of region.etc) {
    const handler = ctx.handlerFor(b);
    out.push(`${indent}  <Button color="secondary" @click="${handler}">${escapeText(b.comp.attrs.text || b.comp.id)}</Button>`);
  }
  out.push(`${indent}</template>`);
  return out;
}

function renderGrid(r, ctx, indent, parentDir) {
  const t = lowerFirst(r.token);
  const T = r.token;
  const out = [sectionOpen(r, ctx, indent, parentDir, '목록')];
  const events = [];
  if (r.actions.has('add')) events.push(`@add-item="add${T}"`);
  if (r.actions.has('delete')) events.push(`@delete-item="delete${T}"`);
  if (r.actions.has('save')) events.push(`@save-data="save${T}List"`);
  if (r.actions.has('download')) events.push(`@download-excel="download${T}Excel"`);
  const auth = r.actions.size ? ` :featureAuth="${t}FeatureAuth"` : '';
  const etc = etcSlot(r, ctx, indent + '      ');
  out.push(`${indent}  <template #actions>`);
  const open = `${indent}    <ButtonGroup${auth} :totalCount="${rowsVar(r)}.length"${events.length ? ' ' + events.join(' ') : ''}`;
  out.push(etc.length ? `${open}>` : `${open} />`);
  if (etc.length) out.push(...etc, `${indent}    </ButtonGroup>`);
  out.push(`${indent}  </template>`);

  const props = [`:rows="${rowsVar(r)}"`, `:columns="${t}Columns"`, `:pk="constants.${t}Pk"`];
  if (r.rowNumber) props.push('row-number');
  if (r.edit) props.push('status');
  if (r.checkbox) props.push(`v-model:checked="checked${T}Rows"`);
  else props.push(':checkbox="false"');
  if (r !== ctx.mainGrid) props.push(':auto-focus="false"');
  if (r.rowClick) props.push(`@row-click="on${T}RowClick"`);
  // popup (base screen A5): the main grid's active row is what confirm returns
  if (ctx.popup && r === ctx.mainGrid) props.push('ref="gridRef"', '@row-dblclick="confirm"');
  if (r.edit) props.push('@change="data.setStatus"');
  out.push(`${indent}  <DataGrid ${props.join(' ')} />`);
  out.push(`${indent}</Section>`);
  return out;
}

function renderForm(r, ctx, indent, parentDir) {
  const f = lowerFirst(r.token);
  const out = [sectionOpen(r, ctx, indent, parentDir, '상세정보')];
  if (r.actions.has('save') || r.etc.length) {
    const auth = r.actions.has('save') ? ` :featureAuth="${f}FeatureAuth" @save-data="save${r.token}Info"` : '';
    const etc = etcSlot(r, ctx, indent + '      ');
    out.push(`${indent}  <template #actions>`);
    out.push(etc.length ? `${indent}    <ButtonGroup${auth}>` : `${indent}    <ButtonGroup${auth} />`);
    if (etc.length) out.push(...etc, `${indent}    </ButtonGroup>`);
    out.push(`${indent}  </template>`);
  }
  const columnCount = Math.max(1, ...r.formItems.map((row) => row.length));
  if (r.linkedGrid) {
    const T = r.linkedGrid.token;
    out.push(`${indent}  <Form :model="${lowerFirst(T)}DetailModel" :items="${f}FormItems" :columnCount="${columnCount}" :disabled="is${T}FormDisabled" @update:model="on${T}FormUpdate" />`);
  } else {
    out.push(`${indent}  <Form v-model:model="${f}Model" :items="${f}FormItems" :columnCount="${columnCount}" />`);
  }
  out.push(`${indent}</Section>`);
  return out;
}

/**
 * Convert one .xfdl into uni screen files.
 * opts: { relPath: 'member/MemberList.xfdl', name: 'BAU0101010' (optional output name) }
 */
function convertFormUni(source, opts = {}) {
  const relPath = (opts.relPath || 'Form.xfdl').replace(/\\/g, '/');
  const ir = parseXfdl(source);
  const todos = [];
  const todo = (message) => todos.push({ message });

  const datasets = new Map(ir.datasets.map((d) => [d.id, d]));
  const { byPath } = indexComponents(ir.components);
  const bindOf = new Map();
  for (const bind of ir.binds) {
    const key = byPath.get(bind.compPath.split('.').filter((s) => s !== 'form').join('.'));
    if (key && datasets.has(bind.datasetid) && bind.columnid) bindOf.set(key, bind);
  }

  // opts.name: output name chosen per screen (screen ID); default is the file name.
  const base = opts.name || posix.basename(relPath).replace(/\.xfdl$/i, '');
  const dir = posix.dirname(relPath) === '.' ? '' : posix.dirname(relPath);
  // names.js checks clashes on this same ID
  const id = outputId(base);
  const screenName = commentText(cleanText(ir.attrs.titletext) || ir.id || id);
  // opts.role (screen-roles.js, confirmed before conversion):
  // - 'popup': {화면ID}_POP with the Popup frame (base screen A5 popup contract);
  // - 'sub': a component in its host screen's folder that uses the host's
  //   Service/Constant (opts.host: { id, viewDir }); its constants and APIs
  //   are returned in `sub` for the host to take in.
  const role = opts.role === 'popup' || (opts.role === 'sub' && opts.host) ? opts.role : 'screen';
  const host = role === 'sub' ? opts.host : null;
  const viewDir = host ? host.viewDir : `src/views/${dir ? dir + '/' : ''}${id}`;
  const basicUrl = `/${dir ? dir + '/' : ''}${id}`;
  if (role === 'popup' && !/^[A-Z]{3}\d{7}_POP$/.test(id)) todo(`팝업 이름이 {부모 화면ID + 1}_POP 꼴(예: CCU0297051_POP)이 아닙니다: ${id}`);
  if (role === 'screen' && !SCREEN_ID.test(id)) todo(`화면ID 형식(영문 3자 + 숫자 7자)이 아니어서 라우트가 자동 등록되지 않습니다: ${id}`);
  if (!host && !/^[a-z]{2}\/[a-z]{3}$/.test(dir)) todo(`폴더를 views/{대}/{중}(예: ua/usr)으로 옮기고 Service의 basicUrl을 맞추세요: ${dir || '(최상위)'}`);
  // Constants and services the screen uses: its own, or for a sub-screen its host's.
  const constName = host ? `${host.id}Constant` : `${id}Constant`;
  const serviceName = host ? `${host.id}Service` : `${id}Service`;
  // A sub-screen's search items sit next to the host's: own key.
  const searchKey = host ? `${lowerFirst(id.startsWith(host.id) && id.length > host.id.length ? id.slice(host.id.length) : id)}SearchItems` : 'searchItems';
  // opts.embeds: [{ compId, name }] sub-screens this screen's Divs hold (any role);
  // opts.subParts: the `sub` results of every sub-screen landing in this host;
  // opts.popups: [{ name, importPath, rel }] popups this screen opens.
  const subs = role === 'sub' ? [] : opts.subParts || [];
  const popups = opts.popups || [];

  const handlers = new Map();
  const handlerNames = new Set();
  const ctx = {
    datasets, bindOf, todo,
    popup: role === 'popup',
    reservedTokens: opts.reservedTokens,
    embeds: new Map((opts.embeds || []).filter((e) => e.compId).map((e) => [e.compId, { name: e.name }])),
    handlerFor(b) {
      if (!handlers.has(b)) {
        const original = b.comp.attrs.onclick;
        const name = uniqueName(original && IDENT.test(original) ? original : `on${pascal(fieldKeyFromId(b.comp.id))}Click`, handlerNames);
        handlers.set(b, { name, original: original && commentText(original), text: commentText(cleanText(b.comp.attrs.text) || b.comp.id) });
      }
      return handlers.get(b).name;
    },
  };

  const { regions, searchItems, searchButtons, scopeTree } = analyze(ir, ctx);
  const grids = regions.filter((r) => r.kind === 'grid');
  const forms = regions.filter((r) => r.kind === 'form');
  ctx.mainGrid = grids.reduce((best, g) => (!best || g.box.w * g.box.h > best.box.w * best.box.h ? g : best), null);
  // No Static above the main grid: name it after the screen ("편입생 목록").
  if (ctx.mainGrid && !ctx.mainGrid.title && ir.attrs.titletext) ctx.mainGrid.title = `${cleanText(ir.attrs.titletext)} 목록`;

  for (const g of grids) {
    g.edit = g.editable || g.actions.has('save') || g.actions.has('add') || g.actions.has('delete');
    g.checkbox = g.selection || g.actions.has('delete');
    g.rowClick = !!g.linkedForm || !!g.item.comp.attrs.oncellclick || !!g.item.comp.attrs.oncelldblclick;
    g.pk = guessPk(g.ds, g.columns);
    if (g.actions.has('download')) for (const c of g.columns) c.excel = true;
  }

  // Search target (screen standard: search runs the main lookup)
  const standaloneForms = forms.filter((f) => !f.linkedGrid);
  const formFind = searchItems && !grids.length && standaloneForms.length ? standaloneForms[0] : null;
  let searchFn = null;
  if (grids.length === 1) searchFn = `find${grids[0].token}List`;
  else if (grids.length > 1) searchFn = 'findAll';
  else if (formFind) searchFn = `find${formFind.token}Info`;
  if (searchItems && !searchFn) todo('조회조건은 있지만 조회할 그리드나 폼이 없습니다');

  // ---------------- Constant
  const apis = [];
  for (const g of grids) {
    apis.push(`find${g.token}List`);
    if (g.actions.has('save')) apis.push(`save${g.token}List`);
  }
  if (formFind) apis.push(`find${formFind.token}Info`);
  for (const f of standaloneForms) if (f.actions.has('save')) apis.push(`save${f.token}Info`);
  // A host also serves its sub-screens' APIs (same Service, same basicUrl).
  const allApis = [...apis, ...subs.flatMap((s) => s.apis)];
  const hostUrl = host ? `/${dir ? dir + '/' : ''}${host.id}` : basicUrl;
  const apiLine = allApis.length ? `${hostUrl}/${allApis[0]}${allApis.slice(1).map((a) => `, /${a}`).join('')}` : '(없음)';

  // Entry lines only (between `export const X = {` and `}`): a sub-screen hands
  // them to its host, a host adds its sub-screens' after its own.
  const constBody = [];
  const constEntry = (comment, key, value) => {
    if (comment) constBody.push(`  ${comment}`);
    constBody.push(`  ${key}: ${toJs(value, '  ')},`, '');
  };
  if (searchItems) constEntry("/** @type {import('@/types').FormItem[][]} */", searchKey, searchItems);
  for (const g of grids) {
    const t = lowerFirst(g.token);
    if (g.actions.size) {
      constEntry("/** @type {import('@/types').FeatureAuth} */", `${t}FeatureAuth`, {
        add: g.actions.has('add'), delete: g.actions.has('delete'), save: g.actions.has('save'), download: g.actions.has('download'),
      });
    }
    constEntry('// TODO(nexa2vue): PK 추정값 — 실제 키 컬럼으로 바꾼다', `${t}Pk`, g.pk);
    constEntry(`/** ${commentText(g.title || g.item.comp.id)} (원본 ${g.item.comp.id} / ${g.dsId || '-'}) @type {import('@/types').DataGridColumn[]} */`, `${t}Columns`, g.columns);
  }
  for (const f of forms) {
    const t = lowerFirst(f.token);
    if (!f.linkedGrid && f.actions.has('save')) {
      constEntry("/** @type {import('@/types').FeatureAuth} */", `${t}FeatureAuth`, { add: false, delete: false, save: true, download: false });
    }
    constEntry("/** @type {import('@/types').FormItem[][]} */", `${t}FormItems`, f.formItems);
  }
  for (const s of subs) {
    if (!s.constBody.length) continue;
    constBody.push(`  // ---- 하위 화면 ${s.name} (원본 ${commentText(s.rel)})`, ...s.constBody);
  }
  if (constBody[constBody.length - 1] === '') constBody.pop();
  const constLines = [
    '/**',
    ` * 화면명: ${screenName}`,
    ` * 역할: 넥사크로 ${relPath}에서 변환한 화면의 조회조건/컬럼/폼/권한 상수를 관리한다.${subs.length ? ` 하위 화면(${subs.map((s) => s.name).join(', ')})의 상수도 함께 둔다.` : ''}`,
    ` * 연관 API: ${apiLine}`,
    ' */',
    '// TODO(nexa2vue): 필드 키 임시 — 넥사크로 Dataset 컬럼을 camelCase로 바꾼 이름. DB 컬럼 확정 후 맞춘다',
    `export const ${id}Constant = {`,
    ...constBody,
    '}',
    '',
  ];

  // ---------------- Service
  const transactionsOf = (script) => [...(script || '').matchAll(/\.transaction\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']/g)].map((m) => `${m[1]} → ${m[2]}`);
  const transactions = [...transactionsOf(ir.script), ...subs.flatMap((s) => s.transactions.map((t) => `${t} (하위 화면 ${s.name})`))];
  const serviceLines = [
    "import api from '@/utils/infra/api'",
    "import { request } from '@/utils/infra/http'",
    '',
    '/**',
    ` * 화면명: ${screenName}`,
    ' * 역할: 넥사크로에서 변환한 화면의 조회·저장 API를 호출한다.',
    ` * 연관 API: ${apiLine}`,
    ' * TODO(nexa2vue): 백엔드 컨트롤러와 1:1로 맞춘다. 이름은 Dataset 토큰 기준 임시 이름이다',
    ...(transactions.length ? [' * 원본 transaction:', ...transactions.map((t) => ` *   ${t}`)] : []),
    ' */',
    `const basicUrl = ${jsString(basicUrl)}`,
    '',
    `export const ${id}Service = {`,
  ];
  for (const name of allApis) {
    const call = /^find/.test(name) ? `api.get(\`\${basicUrl}/${name}\`, { params })` : `api.post(\`\${basicUrl}/${name}\`, params)`;
    serviceLines.push(`  ${name}: (params) => request(${call}, '${name}', '${id}Service'),`, '');
  }
  if (serviceLines[serviceLines.length - 1] === '') serviceLines.pop();
  serviceLines.push('}', '');

  // Names the View script declares itself: a button handler must not reuse one
  // (a second `function findAll()` is a syntax error in the draft).
  for (const name of [
    'findAll', 'confirm', 'close', 'props', 'emit', 'service', 'constants', 'gridRef', 'searchItems', 'params',
    'data', 'file', 'MSG', 'popup', 'task', 'validate', 'ref', 'computed', 'onMounted',
    ...grids.flatMap((g) => [`find${g.token}List`, `on${g.token}RowClick`, `add${g.token}`, `delete${g.token}`, `save${g.token}List`, `download${g.token}Excel`]),
    ...forms.flatMap((f) => [`find${f.token}Info`, `save${f.token}Info`, `on${f.token}FormUpdate`]),
    ...popups.map((p) => `open${p.name.replace(/_POP$/, '')}Popup`),
  ]) handlerNames.add(name);

  // ---------------- View template
  const tpl = [];
  if (searchItems) tpl.push(`    <SearchSection v-model="params" :items="searchItems" :on-search="${searchFn || 'findAll'}" />`, '');
  if (scopeTree) {
    const body = scopeTree.dir === 'vertical' ? scopeTree.children : [scopeTree];
    body.forEach((node, i) => {
      if (i) tpl.push('');
      tpl.push(...renderNode(node, ctx, '    ', 'vertical'));
    });
  } else {
    todo('그리드나 입력 영역이 없어 빈 화면으로 만들었습니다');
  }

  // ---------------- View script
  const uses = { computed: false, onMounted: false, file: false, MSG: false, task: false, validate: false };
  const setup = [];
  const dataLines = [];
  const fnBlocks = [];

  if (searchItems) {
    setup.push(`const searchItems = ref(constants.${searchKey})`, `const params = ref(data.getParams(constants.${searchKey}))`);
  }
  const p = searchItems ? 'params.value' : '{}';
  const validateParams = searchItems ? `  if (!validate.validateRequiredParams(params.value, constants.${searchKey})) return\n` : '';
  if (searchItems) uses.validate = true;

  for (const g of grids) {
    const t = lowerFirst(g.token);
    const T = g.token;
    const title = commentText(g.title) || '목록';
    if (g.actions.size) setup.push(`const ${t}FeatureAuth = constants.${t}FeatureAuth`);
    setup.push(`const ${t}Columns = data.getGridColumns(constants.${t}Columns)`);
    if (g.actions.has('download')) setup.push(`const ${t}ExcelColumns = data.getExcelColumns(constants.${t}Columns)`);
    dataLines.push(`const ${rowsVar(g)} = ref([])`);
    if (g.checkbox) dataLines.push(`const checked${T}Rows = ref([])`);
    if (g.linkedForm) {
      uses.computed = true;
      dataLines.push(
        `const selected${T} = ref(null)`,
        `const ${t}DetailModel = computed(() => selected${T}.value || {})`,
        `const is${T}FormDisabled = computed(() => !selected${T}.value || data.isDeleted(selected${T}.value))`,
      );
    }

    uses.task = true;
    const reset = [
      g.checkbox ? `    checked${T}Rows.value = []` : '',
      g.linkedForm ? `    selected${T}.value = ${rowsVar(g)}.value[0] || null` : '',
    ].filter(Boolean);
    fnBlocks.push([
      `// ${josa(title, '을', '를')} 조회한다`,
      `async function find${T}List() {`,
      grids.length === 1 ? validateParams.trimEnd() : '',
      '  await task.run(async () => {',
      `    ${rowsVar(g)}.value = await service.find${T}List(${p})`,
      ...reset,
      '  })',
      '}',
    ].filter(Boolean).join('\n'));

    if (g.rowClick) {
      const orig = g.item.comp.attrs.oncellclick || g.item.comp.attrs.oncelldblclick;
      fnBlocks.push([
        `// ${title} 행을 선택한다`,
        `function on${T}RowClick(row) {`,
        '  if (!row) return',
        g.linkedForm ? `  selected${T}.value = row` : '',
        orig ? `  // TODO(nexa2vue): 원본 ${commentText(orig)} 참고` : '',
        '}',
      ].filter(Boolean).join('\n'));
    }
    if (g.linkedForm) {
      fnBlocks.push([
        '// 폼에서 바꾼 값을 선택한 행에 반영한다',
        `function on${T}FormUpdate(nextModel) {`,
        `  if (!selected${T}.value) return`,
        `  Object.assign(selected${T}.value, nextModel)`,
        `  data.setStatus(selected${T}.value)`,
        '}',
      ].join('\n'));
    }
    if (g.actions.has('add')) {
      const blank = Object.fromEntries(g.columns.filter((c) => !c.__comment).map((c) => [c.field, '']));
      fnBlocks.push([
        `// ${title}에 행을 추가한다`,
        `function add${T}() {`,
        `  data.add(${rowsVar(g)}, ${toJs(blank, '  ')})`,
        // data.add puts the new row first
        g.linkedForm ? `  selected${T}.value = ${rowsVar(g)}.value[0]` : '',
        '}',
      ].filter(Boolean).join('\n'));
    }
    if (g.actions.has('delete')) {
      uses.MSG = true;
      fnBlocks.push([
        `// 체크한 ${title} 행을 삭제한다`,
        `function delete${T}() {`,
        `  if (checked${T}Rows.value.length === 0) {`,
        '    alert(MSG.SELECT_DELETE)',
        '    return',
        '  }',
        '  // 삭제 확인',
        "  if (!confirm('삭제하시겠습니까?')) return",
        `  data.remove(${rowsVar(g)}, checked${T}Rows)`,
        '}',
      ].join('\n'));
    }
    if (g.actions.has('save')) {
      uses.MSG = true;
      uses.validate = true;
      fnBlocks.push([
        `// ${josa(title, '을', '를')} 저장한다`,
        `async function save${T}List() {`,
        `  const saveRows = data.getSaveRows(${rowsVar(g)}, data.getNulltoEmptyFields(constants.${t}Columns))`,
        '  if (saveRows.length === 0) {',
        '    alert(MSG.NO_SAVE_DATA)',
        '    return',
        '  }',
        `  if (!validate.validateRequired(saveRows, constants.${t}Columns)) return`,
        '',
        '  await task.run(async () => {',
        `    await service.save${T}List(saveRows)`,
        '    alert(MSG.SAVED)',
        `    await find${T}List()`,
        '  })',
        '}',
      ].join('\n'));
    }
    if (g.actions.has('download')) {
      uses.file = true;
      fnBlocks.push([
        `// ${josa(title, '을', '를')} 엑셀로 내려받는다`,
        `function download${T}Excel() {`,
        `  file.downloadExcel(${jsString(title)}, ${t}ExcelColumns, ${rowsVar(g)}.value)`,
        '}',
      ].join('\n'));
    }
  }

  if (grids.length > 1) {
    fnBlocks.unshift([
      '// 조회조건으로 화면의 목록을 모두 조회한다',
      '// TODO(nexa2vue): 마스터/디테일이면 기본 화면 A2처럼 마스터 행을 고를 때 디테일을 조회하도록 바꾼다',
      'async function findAll() {',
      validateParams.trimEnd(),
      ...grids.map((g) => `  await find${g.token}List()`),
      '}',
    ].filter(Boolean).join('\n'));
  }

  for (const f of standaloneForms) {
    const t = lowerFirst(f.token);
    const T = f.token;
    if (f.actions.has('save')) setup.push(`const ${t}FeatureAuth = constants.${t}FeatureAuth`);
    setup.push(`const ${t}FormItems = constants.${t}FormItems`);
    dataLines.push(`const ${t}Model = ref({})`);
    if (f === formFind) {
      uses.task = true;
      fnBlocks.push([
        `// ${josa(commentText(f.title) || '상세정보', '을', '를')} 조회한다`,
        `async function find${T}Info() {`,
        validateParams.trimEnd(),
        '  await task.run(async () => {',
        `    ${t}Model.value = (await service.find${T}Info(${p})) ?? {}`,
        '  })',
        '}',
      ].filter(Boolean).join('\n'));
    }
    if (f.actions.has('save')) {
      uses.task = true;
      uses.MSG = true;
      uses.validate = true;
      fnBlocks.push([
        `// ${josa(commentText(f.title) || '상세정보', '을', '를')} 저장한다`,
        `async function save${T}Info() {`,
        `  if (!validate.validateRequired([${t}Model.value], constants.${t}FormItems)) return`,
        '',
        '  await task.run(async () => {',
        `    await service.save${T}Info(${t}Model.value)`,
        '    alert(MSG.SAVED)',
        f === formFind ? `    await find${T}Info()` : '',
        '  })',
        '}',
      ].filter(Boolean).join('\n'));
    }
  }
  for (const f of forms.filter((x) => x.linkedGrid)) {
    setup.push(`const ${lowerFirst(f.token)}FormItems = constants.${lowerFirst(f.token)}FormItems`);
  }

  // Extra buttons: empty handlers pointing at the original script
  for (const { name, original, text } of handlers.values()) {
    fnBlocks.push([
      `// ${text} 버튼`,
      `function ${name}() {`,
      `  // TODO(nexa2vue): ${original ? `원본 ${original} 참고` : '원본에 onclick 핸들러가 없습니다'}`,
      '}',
    ].join('\n'));
  }

  // Sub-screens whose Div was not found (a Tabpage url, a hidden Div, a
  // set_url target): put at the end, to be moved by hand.
  for (const [compId, e] of ctx.embeds) {
    if (e.placed) continue;
    todo(`하위 화면 ${e.name}(원본 ${compId})를 둘 Div를 찾지 못해 화면 끝에 두었습니다 — 원래 자리(탭이면 KeepAliveTabs 탭)로 옮기세요`);
    tpl.push('', `    <!-- TODO(nexa2vue): 원본 ${escapeComment(compId)}에 들어가던 하위 화면 — 원래 자리로 옮긴다 -->`, `    <${e.name} />`);
  }
  const embedNames = [...ctx.embeds.values()].map((e) => e.name);

  // Popups this screen opens (uni: import the popup and open it with popup.open).
  for (const p of popups) {
    fnBlocks.push([
      `// ${commentText(p.screenName || p.name)} 팝업을 연다 (원본 ${commentText(p.rel)})`,
      `async function open${p.name.replace(/_POP$/, '')}Popup() {`,
      '  // TODO(nexa2vue): 원본에서 팝업을 열던 곳(버튼·셀 클릭 등)에서 부르고, 넘길 조건을 row에 넣는다',
      `  const result = await popup.open(${p.name}, { row: {} })`,
      '  // 닫기만 누르면 result 또는 result.data가 null이다',
      '  if (!result?.data) return',
      '  // TODO(nexa2vue): 원본 콜백에서 하던 일(돌려받은 값을 화면에 넣기)을 옮긴다',
      '}',
    ].join('\n'));
  }

  const isPopup = role === 'popup';
  if (isPopup) {
    uses.onMounted = true;
    fnBlocks.push([
      '// 고른 행을 돌려주고 닫는다',
      'function confirm() {',
      ctx.mainGrid ? '  const row = gridRef.value?.activeRow' : '  // TODO(nexa2vue): 원본에서 this.close(…)로 돌려주던 값을 만든다\n  const row = null',
      ctx.mainGrid ? "  if (!row) {\n    alert('목록에서 행을 선택해 주세요.')\n    return\n  }" : '',
      '  close(row)',
      '}',
    ].filter(Boolean).join('\n'), [
      '// 결과를 { data } 봉투로 넘기고 닫는다(닫기만 누르면 data는 null)',
      'function close(row = null) {',
      "  emit('callback', { data: row })",
      "  emit('update:modelValue', false)",
      '}',
    ].join('\n'));
  }
  if (!searchItems && grids.length) uses.onMounted = true;
  const onload = ir.attrs.onload;

  const vueImports = ['ref', uses.computed && 'computed', uses.onMounted && 'onMounted'].filter(Boolean).sort();
  const compImports = [
    (isPopup || regions.some((r) => r.etc.length)) && 'Button',
    (grids.length || regions.some((r) => r.actions.size || r.etc.length)) && 'ButtonGroup',
    grids.length && 'DataGrid',
    forms.length && 'Form',
    isPopup && 'Popup',
    searchItems && 'SearchSection',
    'Section',
    !isPopup && 'SectionGroup',
  ].filter(Boolean);
  const utilImports = ['data', uses.file && 'file', uses.MSG && 'MSG', popups.length && 'popup', uses.task && 'task', uses.validate && 'validate'].filter(Boolean);
  // Sub-screens sit in this folder; popups are their own screen folders.
  const embedImports = embedNames.map((name) => `import ${name} from './${name}.vue'`);
  const popupImports = popups.map((p) => `import ${p.name} from '${p.importPath}'`);

  const script = [
    `import { ${vueImports.join(', ')} } from 'vue'`,
    `import { ${compImports.join(', ')} } from '@/components'`,
    `import { ${utilImports.join(', ')} } from '@/utils'`,
    ...popupImports,
    ...embedImports,
    `import { ${serviceName} as service } from './${serviceName}'`,
    `import { ${constName} as constants } from './${constName}'`,
    '',
    // uni: popups have no defineOptions (CCU0297051_POP); sub-components are named as the file
    ...(isPopup ? [] : [`defineOptions({ name: '${host ? id : `${id}View`}' })`, '']),
    ...(isPopup ? [
      'const props = defineProps({',
      '  modelValue: Boolean,',
      '  // 여는 쪽이 넘긴 초기 조건',
      '  row: Object,',
      '})',
      "const emit = defineEmits(['update:modelValue', 'callback'])",
      '',
      '// 상태/참조',
      ...(ctx.mainGrid ? ['const gridRef = ref(null)'] : []),
      '',
    ] : []),
    '// 조회조건/그리드/폼 설정',
    ...setup,
    '',
    '// 화면 데이터',
    ...dataLines,
  ];
  if (isPopup) {
    const first = searchFn ? `  await ${searchFn}()` : '';
    script.push('', '// 초기화 (onMounted)', '// 여는 쪽이 넘긴 조건으로 바로 조회한다', 'onMounted(async () => {',
      searchItems ? '  params.value = { ...params.value, ...(props.row || {}) }' : '',
      first || (ctx.mainGrid ? `  await find${ctx.mainGrid.token}List()` : ''),
      '})');
  } else if (uses.onMounted && ctx.mainGrid) {
    script.push('', '// 초기화 (onMounted)', '// 조회조건이 없는 화면이라 들어오자마자 조회한다', 'onMounted(async () => {', `  await find${ctx.mainGrid.token}List()`, '})');
  }
  if (onload) script.push('', `// TODO(nexa2vue): 원본 onload(${commentText(onload)})에서 하던 초기화(공통코드 조회 등)를 옮긴다`);
  script.push('', fnBlocks.join('\n\n'));
  if (ir.script.trim()) {
    script.push('', `/* 원본 스크립트 (nexa2vue: 스크립트는 변환하지 않음 — 동작을 옮길 때 참고)\n${ir.script.replace(/\*\//g, '* /').replace(/<\/script/gi, '<\\/script')}\n*/`);
  }

  const searchNote = searchButtons.length ? ` / 조회 버튼(${searchButtons.map((b) => b.comp.id).join(', ')})은 SearchSection으로 대체` : '';
  const pattern = describePattern(grids, forms);
  const roleNote = isPopup ? ` / 팝업: ${opts.parentName ? `${escapeComment(opts.parentName)}에서 popup.open으로 연다, ` : ''}계약 = props modelValue·row, emit callback({ data })`
    : host ? ` / 하위 화면: ${escapeComment(host.id)}View 안에 들어가고 ${escapeComment(host.id)}Service·Constant를 같이 쓴다` : '';
  // Popup wraps its body in a vertical SectionGroup itself (components/README.md Popup).
  const width = num(ir.attrs.width, 0);
  const frame = isPopup
    ? [`  <Popup :model-value="modelValue"${width ? ` width="${Math.round(width)}px"` : ''}>`, ...tpl.map((l) => (l ? l.slice(2) : l)),
      '', '    <template #footer>', '      <Button color="primary" @click="confirm">확인</Button>', '      <Button color="secondary" @click="close()">닫기</Button>', '    </template>', '  </Popup>']
    : ['  <SectionGroup direction="vertical">', ...tpl, '  </SectionGroup>'];
  const vue = [
    '<!--',
    ...[
      `  화면명: ${escapeComment(screenName)}`,
      `  역할: 넥사크로 ${escapeComment(relPath)}에서 변환(nexa2vue 1차 초안). 배치는 ${pattern} 기준으로 다시 잡음${escapeComment(searchNote)}${roleNote}`,
      `  연관 API: ${escapeComment(apiLine)}`,
    ],
    '-->',
    '<template>',
    ...frame,
    '</template>',
    '',
    '<script setup>',
    script.join('\n').replace(/\n{3,}/g, '\n\n'),
    '</script>',
    '',
  ].join('\n');

  // ---------------- Backend model (gen-uni-backend.js): the same API names,
  // one table per dataset token, columns from the dataset.
  const labelOf = new Map();
  const dateFields = new Set();
  for (const g of grids) {
    for (const c of g.columns) {
      if (c.label) labelOf.set(c.field, c.label);
      if (c.editor && c.editor.type === 'date') dateFields.add(c.field);
    }
  }
  for (const f of forms) {
    for (const item of f.formItems.flat()) {
      if (item.label && item.label !== item.key) labelOf.set(item.key, item.label);
      if (item.type === 'date') dateFields.add(item.key);
    }
  }
  const columnsOf = (ds, fields) => {
    const list = ds && ds.columns.length
      ? ds.columns.map((c) => ({ field: camel(c.id), type: String(c.type || '').toUpperCase() }))
      : fields.filter((f) => !/^col\d+$/.test(f)).map((f) => ({ field: f, type: '' }));
    return list.map((c) => ({
      col: snake(c.field), field: c.field, label: labelOf.get(c.field) || '', date: DATE_TYPES.has(c.type) || dateFields.has(c.field),
    }));
  };
  const backendApis = [];
  for (const g of grids) {
    const columns = columnsOf(g.ds, g.columns.map((c) => c.field));
    const base = { token: g.token, dsId: g.dsId, title: g.title || '', columns, pk: g.pk };
    backendApis.push({ ...base, name: `find${g.token}List`, kind: 'findList' });
    if (g.actions.has('save')) backendApis.push({ ...base, name: `save${g.token}List`, kind: 'saveList' });
  }
  for (const f of standaloneForms) {
    const keys = f.formItems.flat().map((i) => i.key);
    const ds = f.dsId ? datasets.get(f.dsId) : null;
    const columns = columnsOf(ds, keys);
    const base = { token: f.token, dsId: f.dsId, title: f.title || '', columns, pk: guessPk(ds, columns) };
    if (f === formFind) backendApis.push({ ...base, name: `find${f.token}Info`, kind: 'findInfo' });
    if (f.actions.has('save')) backendApis.push({ ...base, name: `save${f.token}Info`, kind: 'saveInfo' });
  }
  const ownSearch = (searchItems || []).flat().map((i) => ({ key: i.key, label: i.label, type: i.type, required: !!i.required }));
  const tokensUsed = regions.filter((r) => r.token).map((r) => r.token);

  // A sub-screen: one component file; the rest goes to its host.
  if (host) {
    return {
      formId: ir.id,
      files: [{ path: `${viewDir}/${id}.vue`, content: vue }],
      sub: { name: id, rel: relPath, constBody, apis, backendApis, search: ownSearch, transactions: transactionsOf(ir.script), tokens: tokensUsed },
      todos,
      gfnUsed: new Set(),
      includes: [],
      error: null,
    };
  }

  // The host's backend serves its sub-screens too (one controller, same URLs).
  const seenSearch = new Set(ownSearch.map((s) => s.key));
  const backendModel = {
    id, dir, screenName: cleanText(screenName),
    apis: [...backendApis, ...subs.flatMap((s) => s.backendApis)],
    search: [...ownSearch, ...subs.flatMap((s) => s.search).filter((s) => !seenSearch.has(s.key) && seenSearch.add(s.key))],
  };

  return {
    formId: ir.id,
    backendModel,
    backendFiles: opts.backend ? generateBackend(backendModel, opts.backend) : [],
    files: [
      { path: `${viewDir}/${id}View.vue`, content: vue },
      { path: `${viewDir}/${id}Service.js`, content: serviceLines.join('\n') },
      { path: `${viewDir}/${id}Constant.js`, content: constLines.join('\n') },
    ],
    tokens: tokensUsed,
    todos,
    gfnUsed: new Set(),
    includes: [],
    error: null,
  };
}

function describePattern(grids, forms) {
  const linked = forms.some((f) => f.linkedGrid);
  if (grids.length === 0) return forms.length ? '기본 화면 A6(단건 폼)' : '빈 화면';
  if (grids.length === 1) return linked ? '기본 화면 A3(그리드 + 상세 폼)' : forms.length ? '기본 화면 A1(단일 그리드) + 폼' : '기본 화면 A1(단일 그리드)';
  return '기본 화면 A2(그리드 여러 개)';
}

module.exports = { convertFormUni, layoutTree, camel, datasetToken, toJs };
