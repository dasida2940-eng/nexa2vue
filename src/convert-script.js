'use strict';

const acorn = require('acorn');
const { generate } = require('astring');

// Dataset methods implemented by runtime/nexa-compat.js (nexa.ds.*).
const DS_METHODS = new Set([
  'getColumn', 'setColumn', 'getRowCount', 'addRow', 'insertRow', 'deleteRow',
  'deleteAll', 'clearData', 'copyData', 'appendData', 'findRow', 'getSum',
]);
// Component properties that the generated template keeps in `comp[key]`.
const COMP_PROPS = new Set(['text', 'value', 'enable', 'visible', 'readonly', 'tabindex']);

const b = {
  id: (name) => ({ type: 'Identifier', name }),
  lit: (value) => ({ type: 'Literal', value }),
  member: (object, prop, computed = false) => ({
    type: 'MemberExpression',
    object,
    property: typeof prop === 'string' ? (computed ? b.lit(prop) : b.id(prop)) : prop,
    computed,
    optional: false,
  }),
  call: (callee, args) => ({ type: 'CallExpression', callee, arguments: args, optional: false }),
  path: (dotted) => dotted.split('.').map(b.id).reduce((obj, p) => b.member(obj, p)),
  assign: (left, right, operator = '=') => ({ type: 'AssignmentExpression', operator, left, right }),
  object: (entries) => ({
    type: 'ObjectExpression',
    properties: entries.map(([key, value]) => ({
      type: 'Property', key: b.lit(key), value, kind: 'init', computed: false, method: false, shorthand: false,
    })),
  }),
};

/**
 * Nexacro xscript is ES5 plus a few extensions: `include "x::y.xjs";` and
 * parameter type annotations (`obj:nexacro.Button`). Strip them while keeping
 * line numbers stable so TODO line references still point at the source.
 */
function preprocess(source) {
  const includes = [];
  let code = source.replace(/^[ \t]*#?include[ \t]+["']([^"']+)["'][ \t]*;?/gm, (m, p) => {
    includes.push(p);
    return m.replace(/[^\n]/g, ' ');
  });
  code = code.replace(/\bfunction\b(\s*[\w$]*\s*)\(([^)]*)\)/g, (m, name, params) =>
    `function${name}(${params.replace(/([\w$]+)\s*:\s*[\w$.]+/g, '$1')})`);
  return { code, includes };
}

/**
 * Convert a Nexacro script to Vue `<script setup>` statements (mode "form")
 * or an ES module (mode "lib").
 *
 * ctx: { datasets: Map<id, Dataset>, comps: Map<normalizedPath, key>,
 *        binds: Map<compKey, {datasetid, columnid, propid}>, libFns: Set }
 */
function convertScript(source, ctx = {}) {
  const mode = ctx.mode || 'form';
  const state = {
    mode,
    datasets: ctx.datasets || new Map(),
    comps: ctx.comps || new Map(),
    binds: ctx.binds || new Map(),
    libFns: ctx.libFns || new Set(),
    localFns: new Set(),
    formVars: new Set(),
    gfnUsed: new Set(),
    apiFns: new Map(),
    todos: [],
    uses: { nexa: false, gfn: false, api: false },
    stmtStack: [],
  };
  const { code, includes } = preprocess(source || '');
  const empty = { code: '', includes, todos: state.todos, localFns: state.localFns, gfnUsed: state.gfnUsed, apiFns: state.apiFns, uses: state.uses, error: null };
  if (!code.trim()) return empty;

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true });
  } catch (err) {
    return { ...empty, error: `Script parse error: ${err.message}` };
  }

  for (const stmt of ast.body) {
    const target = thisAssignTarget(stmt);
    if (target && isFunctionNode(stmt.expression.right)) state.localFns.add(target);
    else if (target) state.formVars.add(target);
    else if (stmt.type === 'FunctionDeclaration') state.localFns.add(stmt.id.name);
  }

  const body = [];
  for (const stmt of ast.body) {
    const converted = convertTopLevel(stmt, state);
    state.stmtStack.push(converted);
    body.push(rewrite(converted, state));
    state.stmtStack.pop();
  }
  const out = generate({ type: 'Program', body, sourceType: 'module' }, { comments: true, indent: '  ' });
  return { ...empty, code: out.replace(/<\/script/gi, '<\\/script') };
}

function thisAssignTarget(stmt) {
  if (stmt.type !== 'ExpressionStatement') return null;
  const e = stmt.expression;
  if (e.type !== 'AssignmentExpression' || e.operator !== '=') return null;
  const l = e.left;
  if (l.type === 'MemberExpression' && !l.computed && l.object.type === 'ThisExpression') return l.property.name;
  return null;
}

function isFunctionNode(n) {
  return n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

function convertTopLevel(stmt, state) {
  const name = thisAssignTarget(stmt);
  if (!name) return stmt;
  const value = stmt.expression.right;
  let decl;
  if (isFunctionNode(value)) {
    const body = value.body.type === 'BlockStatement'
      ? value.body
      : { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: value.body }] };
    decl = { type: 'FunctionDeclaration', id: b.id(name), params: value.params, body, async: value.async, generator: !!value.generator };
  } else {
    decl = { type: 'VariableDeclaration', kind: 'let', declarations: [{ type: 'VariableDeclarator', id: b.id(name), init: value }] };
  }
  decl.loc = stmt.loc;
  if (state.mode === 'lib') return { type: 'ExportNamedDeclaration', declaration: decl, specifiers: [], source: null, loc: stmt.loc };
  return decl;
}

function todo(state, node, message) {
  const line = node && node.loc ? node.loc.start.line : null;
  state.todos.push({ line, message });
  const top = state.stmtStack[state.stmtStack.length - 1];
  if (top) {
    top.comments = top.comments || [];
    const value = ` TODO(nexa2vue): ${message}`;
    if (!top.comments.some((c) => c.value === value)) top.comments.push({ type: 'Line', value });
  }
}

/**
 * Turn `this.a.form.b` / `a.b` into path segments. Returns null when the
 * chain does not start at `this` or a bare identifier.
 */
function chain(node) {
  if (node.type === 'ThisExpression') return { segs: [], bare: false };
  if (node.type === 'Identifier') return { segs: [node.name], bare: true };
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const base = chain(node.object);
    return base ? { segs: [...base.segs, node.property.name], bare: base.bare } : null;
  }
  return null;
}

function resolve(node, state) {
  const c = chain(node);
  if (!c) return null;
  const { segs, bare } = c;
  if (segs.length === 0) return { kind: 'this' };
  if (segs.length === 1) {
    const name = segs[0];
    if (state.datasets.has(name)) return { kind: 'ds', id: name };
    if (!bare && (state.localFns.has(name) || state.formVars.has(name))) return { kind: 'local', name };
  }
  const key = state.comps.get(segs.filter((s) => s !== 'form').join('.'));
  if (key) return { kind: 'comp', key };
  return null;
}

function compRef(key) {
  return b.member(b.id('comp'), key, !/^[A-Za-z_$][\w$]*$/.test(key));
}

function boundValue(state, key, prop) {
  const bind = state.binds.get(key);
  if (!bind || bind.propid !== prop) return null;
  return b.member(b.member(b.member(b.id(bind.datasetid), 'value'), b.lit(0), true), bind.columnid, true);
}

function rewrite(node, state) {
  if (!node || typeof node.type !== 'string') return node;
  const replaced = applyRules(node, state);
  if (replaced) return replaced;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'comments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      const isBody = key === 'body' || key === 'consequent';
      node[key] = value.map((item) => {
        if (!item || typeof item.type !== 'string') return item;
        if (isBody) state.stmtStack.push(item);
        const r = rewrite(item, state);
        if (isBody) state.stmtStack.pop();
        return r;
      });
    } else if (value && typeof value.type === 'string') {
      node[key] = rewrite(value, state);
    }
  }
  return node;
}

function applyRules(node, state) {
  if (node.type === 'CallExpression') return rewriteCall(node, state);
  if (node.type === 'MemberExpression') return rewriteMember(node, state);
  if (node.type === 'ThisExpression') {
    todo(state, node, '`this` (Nexacro form object) has no Vue equivalent');
  }
  return null;
}

function rewriteArgs(node, state) {
  return node.arguments.map((a) => rewrite(a, state));
}

function rewriteCall(node, state) {
  const callee = node.callee;

  if (callee.type === 'Identifier') {
    const name = callee.name;
    if (name === 'trace') return b.call(b.path('console.log'), rewriteArgs(node, state));
    if (name === 'alert' || name === 'confirm') return b.call(b.path(`window.${name}`), rewriteArgs(node, state));
    if (!state.localFns.has(name) && (/^gfn_/.test(name) || state.libFns.has(name))) {
      return gfnCall(state, name, rewriteArgs(node, state));
    }
    return null;
  }
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  const method = callee.property.name;
  const target = resolve(callee.object, state);
  if (!target) return null;

  if (target.kind === 'ds') {
    if (!DS_METHODS.has(method)) {
      todo(state, node, `Dataset method ${target.id}.${method}() is not supported`);
      return b.call(b.member(b.id(target.id), method), rewriteArgs(node, state));
    }
    state.uses.nexa = true;
    return b.call(b.path(`nexa.ds.${method}`), [b.id(target.id), ...rewriteArgs(node, state)]);
  }

  if (target.kind === 'comp') {
    const ref = compRef(target.key);
    const setter = /^set_(\w+)$/.exec(method);
    if (setter) {
      const prop = setter[1];
      if (!COMP_PROPS.has(prop)) todo(state, node, `component property ${target.key}.${prop} is not rendered by the template`);
      const left = boundValue(state, target.key, prop) || b.member(ref, prop);
      return b.assign(left, rewriteArgs(node, state)[0] || b.id('undefined'));
    }
    if (method === 'setFocus') {
      state.uses.nexa = true;
      return b.call(b.path('nexa.focus'), [b.lit(target.key)]);
    }
    todo(state, node, `component method ${target.key}.${method}() is not supported`);
    return b.call(b.member(ref, method), rewriteArgs(node, state));
  }

  if (target.kind === 'this') {
    if (method === 'alert' || method === 'confirm') return b.call(b.path(`window.${method}`), rewriteArgs(node, state));
    if (method === 'transaction') return rewriteTransaction(node, state);
    if (state.localFns.has(method)) return b.call(b.id(method), rewriteArgs(node, state));
    if (/^(go|close|reload|parent|opener|setTimer|killTimer|lookup|getOwnerFrame)$/.test(method)) {
      todo(state, node, `form method this.${method}() has no Vue equivalent`);
      return b.call(b.member(b.id('nexa'), method), rewriteArgs(node, state));
    }
    return gfnCall(state, method, rewriteArgs(node, state));
  }
  return null;
}

function gfnCall(state, name, args) {
  state.uses.gfn = true;
  state.gfnUsed.add(name);
  return b.call(b.member(b.id('gfn'), name), args);
}

function rewriteMember(node, state) {
  const self = resolve(node, state);
  if (self) {
    if (self.kind === 'ds') return b.id(self.id);
    if (self.kind === 'local') return b.id(self.name);
    if (self.kind === 'comp') return compRef(self.key);
  }
  if (node.computed || node.property.type !== 'Identifier') return null;
  const target = resolve(node.object, state);
  if (!target) return null;
  const prop = node.property.name;

  if (target.kind === 'ds') {
    if (prop === 'rowcount') {
      state.uses.nexa = true;
      return b.call(b.path('nexa.ds.getRowCount'), [b.id(target.id)]);
    }
    if (prop === 'rowposition') return b.member(b.id(target.id), 'rowposition');
    todo(state, node, `Dataset property ${target.id}.${prop} is not supported`);
    return b.member(b.id(target.id), prop);
  }
  if (target.kind === 'comp') {
    const bound = boundValue(state, target.key, prop);
    if (bound) return bound;
    if (!COMP_PROPS.has(prop)) todo(state, node, `component property ${target.key}.${prop} is not rendered by the template`);
    return b.member(compRef(target.key), prop);
  }
  if (target.kind === 'this') {
    todo(state, node, `form property this.${prop} has no Vue equivalent`);
    return b.member(b.id('nexa'), prop);
  }
  return null;
}

function parseDatasetMap(spec, reversed, state) {
  // inDatasets:  "server=client[:U] server2=client2"
  // outDatasets: "client=server client2=server2"
  const entries = [];
  for (const pair of spec.trim().split(/\s+/).filter(Boolean)) {
    const [left, right] = pair.split('=');
    if (!left || !right) return null;
    const server = reversed ? right : left;
    const client = (reversed ? left : right).replace(/:[A-Z]$/, '');
    if (!state.datasets.has(client)) return null;
    entries.push([server, b.id(client)]);
  }
  return entries;
}

function apiFnName(svcId) {
  const name = svcId.replace(/[^\w$]/g, '_');
  return /^[A-Za-z_$]/.test(name) ? name : `svc_${name}`;
}

function rewriteTransaction(node, state) {
  const args = node.arguments;
  const lits = args.slice(0, 4).map((a) => (a.type === 'Literal' && typeof a.value === 'string' ? a.value : null));
  const [svcId, url, inSpec, outSpec] = lits;
  const inMap = inSpec !== null ? parseDatasetMap(inSpec, false, state) : null;
  const outMap = outSpec !== null ? parseDatasetMap(outSpec, true, state) : null;
  if (args.length < 4 || lits.includes(null) || !inMap || !outMap) {
    todo(state, node, 'transaction() with dynamic or unknown arguments must be converted by hand');
    state.uses.nexa = true;
    return b.call(b.path('nexa.transactionTodo'), rewriteArgs(node, state));
  }

  const fnName = apiFnName(svcId);
  state.apiFns.set(fnName, url);
  state.uses.api = true;
  state.uses.nexa = true;

  let callback = b.lit(null);
  const cbArg = args[5];
  if (cbArg && cbArg.type === 'Literal' && typeof cbArg.value === 'string') {
    if (state.localFns.has(cbArg.value)) callback = b.id(cbArg.value);
    else if (cbArg.value) todo(state, node, `transaction callback "${cbArg.value}" is not defined in this form`);
  } else if (cbArg) {
    callback = rewrite(cbArg, state);
  }
  if (args.length > 6) todo(state, node, 'transaction() async/datatype options are ignored');

  return b.call(b.path('nexa.transaction'), [
    b.lit(svcId),
    b.member(b.id('api'), fnName),
    b.object(inMap),
    b.object(outMap),
    args[4] ? rewrite(args[4], state) : b.lit(''),
    callback,
  ]);
}

module.exports = { convertScript, preprocess, DS_METHODS };
