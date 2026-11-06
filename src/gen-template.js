'use strict';

// Simple components: one Element Plus tag, optional v-model and text content.
// Can be extended/overridden with `componentMap` in nexa2vue.config.json.
const DEFAULT_COMPONENT_MAP = {
  Button: { tag: 'el-button', content: 'text', disable: true },
  Edit: { tag: 'el-input', model: true, disable: true },
  MaskEdit: { tag: 'el-input', model: true, disable: true },
  TextArea: { tag: 'el-input', model: true, disable: true, attrs: { type: 'textarea' } },
  Spin: { tag: 'el-input-number', model: true, disable: true },
  Calendar: { tag: 'el-date-picker', model: true, disable: true, attrs: { type: 'date', 'value-format': 'YYYYMMDD', format: 'YYYY-MM-DD' } },
  ImageViewer: { tag: 'img' },
};

const EVENT_MAP = {
  onclick: 'click',
  onchanged: 'change',
  onitemchanged: 'change',
  onkeydown: 'keydown',
  onkeyup: 'keyup',
  onsetfocus: 'focus',
  onkillfocus: 'blur',
};
const GRID_EVENT_MAP = { oncellclick: 'cell-click', oncelldblclick: 'cell-dblclick' };
const FORM_ONLY_EVENTS = new Set(['onload', 'onbeforeclose', 'onclose', 'oninit', 'onactivate', 'ondeactivate']);
const POSITION_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height'];
const IDENT = /^[A-Za-z_$][\w$]*$/;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeComment(value) {
  return String(value).replace(/--/g, '- -').replace(/[<>]/g, '');
}

function compExpr(key) {
  return IDENT.test(key) ? `comp.${key}` : `comp['${key}']`;
}

/**
 * Render the IR component tree to a Vue template.
 * ctx: { keyOf: Map<component, key>, binds: Map<key, bind>, datasets: Map,
 *        localFns: Set, componentMap, todos: [] }
 */
function genTemplate(ir, ctx) {
  const lines = [];
  const style = styleOf(ir.attrs, ctx, ir.id, ['width', 'height']);
  lines.push(`<div class="nexa-form"${style ? ` style="${style}"` : ''}>`);
  for (const comp of ir.components) genComponent(comp, ctx, lines, '  ');
  lines.push('</div>');
  return lines.join('\n');
}

function styleOf(attrs, ctx, key, props = POSITION_PROPS) {
  const parts = [];
  for (const prop of props) {
    const raw = attrs[prop];
    if (raw === undefined || raw === '') continue;
    const m = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(String(raw).trim());
    if (m) parts.push(`${prop}:${m[1]}${m[2] || 'px'}`);
    else ctx.todos.push({ component: key, message: `position ${prop}="${raw}" (relative/anchored layout) is not converted` });
  }
  return escapeAttr(parts.join(';'));
}

function commonAttrs(comp, ctx, key, { disable = false } = {}) {
  const attrs = [`data-nexa-id="${escapeAttr(key)}"`, 'class="nexa-abs"'];
  const style = styleOf(comp.attrs, ctx, key);
  if (style) attrs.push(`style="${style}"`);
  // A class (not v-show) so it also works on components with non-element roots (e.g. el-date-picker).
  attrs.push(`:class="{ 'nexa-hidden': !${compExpr(key)}.visible }"`);
  if (disable) attrs.push(`:disabled="!${compExpr(key)}.enable"`);
  if (disable && comp.attrs.readonly !== undefined) attrs.push(`:readonly="${compExpr(key)}.readonly"`);
  return attrs;
}

function eventAttrs(comp, ctx, key, map) {
  const attrs = [];
  for (const [name, handler] of Object.entries(comp.attrs)) {
    if (!/^on/.test(name) || !handler) continue;
    if (!IDENT.test(handler) || !ctx.localFns.has(handler)) {
      ctx.todos.push({ component: key, message: `event ${name}="${handler}" handler not found in script` });
      continue;
    }
    if (comp.type === 'Grid' && GRID_EVENT_MAP[name]) {
      const ds = comp.attrs.binddataset;
      const rowExpr = ds && ctx.datasets.has(ds) ? `${ds}.indexOf(row)` : '-1';
      attrs.push(`@${GRID_EVENT_MAP[name]}="(row, column, cell, event) => ${handler}(${compExpr(key)}, { row: ${rowExpr}, cell: column.no, col: column.no, event })"`);
    } else if (map[name]) {
      attrs.push(`@${map[name]}="${handler}(${compExpr(key)}, $event)"`);
    } else {
      ctx.todos.push({ component: key, message: `event ${name} is not mapped to a Vue event` });
    }
  }
  return attrs;
}

function modelExpr(ctx, key, prop = 'value') {
  const bind = ctx.binds.get(key);
  if (bind && bind.propid === prop) return `${bind.datasetid}[0].${bind.columnid}`;
  return `${compExpr(key)}.${prop}`;
}

function open(tag, attrs, selfClose = false) {
  return `<${tag} ${attrs.join(' ')}${selfClose ? ' />' : '>'}`;
}

function genComponent(comp, ctx, lines, indent) {
  const key = ctx.keyOf.get(comp);
  const map = { ...DEFAULT_COMPONENT_MAP, ...(ctx.componentMap || {}) };
  const events = eventAttrs(comp, ctx, key, EVENT_MAP);

  switch (comp.type) {
    case 'Static':
      lines.push(`${indent}${open('span', [...commonAttrs(comp, ctx, key), ...events])}{{ ${compExpr(key)}.text }}</span>`);
      return;
    case 'Div':
      lines.push(`${indent}${open('div', [...commonAttrs(comp, ctx, key), ...events])}`);
      for (const c of comp.children) genComponent(c, ctx, lines, indent + '  ');
      lines.push(`${indent}</div>`);
      return;
    case 'GroupBox':
      lines.push(`${indent}${open('fieldset', [...commonAttrs(comp, ctx, key), ...events])}<legend>{{ ${compExpr(key)}.text }}</legend></fieldset>`);
      return;
    case 'Tab':
      genTab(comp, ctx, lines, indent, key, events);
      return;
    case 'Grid':
      genGrid(comp, ctx, lines, indent, key, events);
      return;
    case 'Combo':
    case 'Radio':
      genOptions(comp, ctx, lines, indent, key, events);
      return;
    case 'CheckBox': {
      const attrs = [...commonAttrs(comp, ctx, key, { disable: true }), `v-model="${modelExpr(ctx, key)}"`];
      if (comp.attrs.truevalue !== undefined) attrs.push(`true-value="${escapeAttr(comp.attrs.truevalue)}"`);
      if (comp.attrs.falsevalue !== undefined) attrs.push(`false-value="${escapeAttr(comp.attrs.falsevalue)}"`);
      lines.push(`${indent}${open('el-checkbox', [...attrs, ...events])}{{ ${compExpr(key)}.text }}</el-checkbox>`);
      return;
    }
    default:
      break;
  }

  const spec = map[comp.type];
  if (!spec) {
    ctx.todos.push({ component: key, message: `unsupported component type ${comp.type}` });
    lines.push(`${indent}<!-- TODO(nexa2vue): unsupported component ${escapeComment(comp.type)} (${escapeComment(key)}) -->`);
    lines.push(`${indent}${open('div', [...commonAttrs(comp, ctx, key), 'title="unsupported"'])}</div>`);
    return;
  }
  const attrs = [...commonAttrs(comp, ctx, key, { disable: !!spec.disable })];
  for (const [name, value] of Object.entries(spec.attrs || {})) attrs.push(`${name}="${escapeAttr(value)}"`);
  if (spec.model) attrs.push(`v-model="${modelExpr(ctx, key)}"`);
  attrs.push(...events);
  if (spec.content) {
    lines.push(`${indent}${open(spec.tag, attrs)}{{ ${compExpr(key)}.${spec.content} }}</${spec.tag}>`);
  } else {
    lines.push(`${indent}${open(spec.tag, attrs, true)}`);
  }
}

function genOptions(comp, ctx, lines, indent, key, events) {
  const isCombo = comp.type === 'Combo';
  const tag = isCombo ? 'el-select' : 'el-radio-group';
  const optionTag = isCombo ? 'el-option' : 'el-radio';
  const attrs = [...commonAttrs(comp, ctx, key, { disable: true }), `v-model="${modelExpr(ctx, key)}"`, ...events];
  lines.push(`${indent}${open(tag, attrs)}`);
  const ds = comp.attrs.innerdataset;
  const code = comp.attrs.codecolumn;
  const data = comp.attrs.datacolumn;
  if (ds && ctx.datasets.has(ds) && IDENT.test(code || '') && IDENT.test(data || '')) {
    const label = isCombo ? `:label="o.${data}" ` : '';
    const text = isCombo ? '' : `{{ o.${data} }}`;
    const optionAttrs = `v-for="o in ${ds}" :key="o.${code}" ${label}:value="o.${code}"`;
    lines.push(isCombo
      ? `${indent}  <${optionTag} ${optionAttrs} />`
      : `${indent}  <${optionTag} ${optionAttrs}>${text}</${optionTag}>`);
  } else {
    ctx.todos.push({ component: key, message: `${comp.type} options (innerdataset="${ds || ''}") must be wired by hand` });
    lines.push(`${indent}  <!-- TODO(nexa2vue): options for ${escapeComment(key)} -->`);
  }
  lines.push(`${indent}</${tag}>`);
}

function genTab(comp, ctx, lines, indent, key, events) {
  const c = compExpr(key);
  const attrs = [...commonAttrs(comp, ctx, key), `:model-value="String(${c}.tabindex)"`, `@update:model-value="(v) => (${c}.tabindex = Number(v))"`, ...events];
  lines.push(`${indent}${open('el-tabs', attrs)}`);
  comp.tabpages.forEach((tp, i) => {
    lines.push(`${indent}  <el-tab-pane name="${i}" label="${escapeAttr(tp.text)}">`);
    lines.push(`${indent}    <div class="nexa-tabpage">`);
    for (const child of tp.children) genComponent(child, ctx, lines, indent + '      ');
    lines.push(`${indent}    </div>`);
    lines.push(`${indent}  </el-tab-pane>`);
  });
  lines.push(`${indent}</el-tabs>`);
}

function genGrid(comp, ctx, lines, indent, key, events) {
  const ds = comp.attrs.binddataset;
  const attrs = [...commonAttrs(comp, ctx, key), 'border', 'height="100%"'];
  if (ds && ctx.datasets.has(ds)) attrs.push(`:data="${ds}"`);
  else ctx.todos.push({ component: key, message: `grid binddataset="${ds || ''}" not found` });
  lines.push(`${indent}${open('el-table', [...attrs, ...events])}`);
  for (const col of comp.grid.columns) {
    const colAttrs = [];
    if (col.prop) colAttrs.push(`prop="${escapeAttr(col.prop)}"`);
    if (col.label) colAttrs.push(`label="${escapeAttr(col.label)}"`);
    if (/^\d+$/.test(col.width)) colAttrs.push(`width="${col.width}"`);
    if (!col.prop && col.expr) {
      ctx.todos.push({ component: key, message: `grid cell expression "${col.expr}" is not converted` });
      lines.push(`${indent}  <!-- TODO(nexa2vue): cell expression ${escapeComment(col.expr)} -->`);
    }
    lines.push(`${indent}  <el-table-column ${colAttrs.join(' ')} />`);
  }
  lines.push(`${indent}</el-table>`);
}

module.exports = { genTemplate, DEFAULT_COMPONENT_MAP, FORM_ONLY_EVENTS, IDENT };
