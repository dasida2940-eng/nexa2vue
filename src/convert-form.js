'use strict';

const posix = require('./posix-path');
const { parseXfdl, extractXjsScript } = require('./xfdl-parser');
const { convertScript } = require('./convert-script');
const { genTemplate, IDENT } = require('./gen-template');

/**
 * Index every component by its normalized path ("div_search.edt_name").
 * The state key is the bare id when it is unique in the form, otherwise the
 * path joined with "__".
 */
function indexComponents(components) {
  const entries = [];
  const walk = (list, prefix) => {
    for (const comp of list) {
      const p = [...prefix, comp.id];
      entries.push({ comp, path: p });
      if (comp.tabpages) {
        for (const tp of comp.tabpages) walk(tp.children, [...p, tp.id]);
      } else {
        walk(comp.children, p);
      }
    }
  };
  walk(components, []);

  const idCount = new Map();
  for (const e of entries) idCount.set(e.comp.id, (idCount.get(e.comp.id) || 0) + 1);

  const keyOf = new Map();
  const byPath = new Map();
  for (const e of entries) {
    let key = idCount.get(e.comp.id) === 1 ? e.comp.id : e.path.join('__');
    if (!IDENT.test(key)) key = key.replace(/[^\w$]/g, '_');
    keyOf.set(e.comp, key);
    byPath.set(e.path.join('.'), key);
  }
  return { entries, keyOf, byPath };
}

function initialState(comp) {
  const a = comp.attrs;
  const state = {
    text: a.text || '',
    value: a.value || '',
    enable: a.enable !== 'false',
    visible: a.visible !== 'false',
    readonly: a.readonly === 'true',
  };
  if (comp.type === 'Tab') state.tabindex = Number(a.tabindex || 0) || 0;
  if (comp.type === 'Spin') state.value = Number(a.value || 0) || 0;
  return state;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

// One compact line per row/component keeps large forms readable.
function jsonLines(value) {
  const isArray = Array.isArray(value);
  const items = isArray
    ? value.map((v) => `  ${safeJson(v)}`)
    : Object.entries(value).map(([k, v]) => `  ${safeJson(k)}: ${safeJson(v)}`);
  if (items.length === 0) return isArray ? '[]' : '{}';
  return isArray ? `[\n${items.join(',\n')}\n]` : `{\n${items.join(',\n')}\n}`;
}

function relImport(fromFile, toFile) {
  let rel = posix.relative(posix.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function stubFunction(name) {
  return `function ${name}() {\n  // TODO(nexa2vue): original script could not be parsed\n}`;
}

function uiStubFunction(name) {
  return `function ${name}() {\n  // UI만 변환: 원본 스크립트의 ${name} 참고\n}`;
}

// Names the generated <script setup> declares or imports, and JS reserved words.
const RESERVED_DATASET_IDS = new Set([
  'ref', 'reactive', 'onMounted', 'nexa', 'gfn', 'api', 'comp',
  ...('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval undefined NaN Infinity').split(' '),
]);

/**
 * Convert one .xfdl source.
 * opts: { relPath: 'member/MemberList.xfdl', name (optional output file name), libFns: Set, componentMap }
 * Returns { files: [{ path, content }], todos, gfnUsed, includes, error, formId }
 * Output paths are POSIX paths relative to the output root.
 */
function convertForm(source, opts = {}) {
  const relPath = opts.relPath || 'Form.xfdl';
  const ir = parseXfdl(source);
  const todos = [];
  // A dataset becomes `const <id> = ref(...)` next to the names below, so an id
  // that is one of them (or a JS reserved word) would not compile.
  const usable = (id) => IDENT.test(id) && !RESERVED_DATASET_IDS.has(id);
  const datasets = new Map(ir.datasets.filter((d) => usable(d.id)).map((d) => [d.id, d]));
  for (const d of ir.datasets) {
    if (!IDENT.test(d.id)) todos.push({ message: `dataset id "${d.id}" is not a valid identifier` });
    else if (!usable(d.id)) todos.push({ message: `dataset id "${d.id}" clashes with a name the generated code uses; rename the dataset in the source` });
  }

  const { entries, keyOf, byPath } = indexComponents(ir.components);

  const binds = new Map();
  for (const bind of ir.binds) {
    const key = byPath.get(bind.compPath.split('.').filter((s) => s !== 'form').join('.'));
    if (!key || !datasets.has(bind.datasetid) || !IDENT.test(bind.columnid)) {
      todos.push({ message: `bind ${bind.compPath} -> ${bind.datasetid}.${bind.columnid} could not be resolved` });
      continue;
    }
    binds.set(key, bind);
  }

  // UI-only mode skips script conversion: handlers become empty stubs and the
  // original script is kept as a comment for porting by hand.
  const uiOnly = !!opts.uiOnly;
  const script = uiOnly
    ? { code: '', todos: [], error: null, localFns: collectHandlers(ir), gfnUsed: new Set(), includes: [], apiFns: new Map(), uses: {} }
    : convertScript(ir.script, { mode: 'form', datasets, comps: byPath, binds, libFns: opts.libFns });
  todos.push(...script.todos.map((t) => ({ ...t, message: `[script] ${t.message}` })));
  if (script.error) todos.push({ message: script.error });

  const templateTodos = [];
  const template = genTemplate(ir, {
    keyOf, binds, datasets, localFns: script.error ? collectHandlers(ir) : script.localFns,
    componentMap: opts.componentMap, todos: templateTodos,
  });
  todos.push(...templateTodos.map((t) => ({ message: `[template] ${t.component ? t.component + ': ' : ''}${t.message}` })));

  // Datasets referenced by a Bind need a row for v-model="ds[0].COL".
  const boundDatasets = new Set([...binds.values()].map((x) => x.datasetid));
  const dsInit = [...datasets.values()].map((d) => {
    let rows = d.rows;
    if (rows.length === 0 && boundDatasets.has(d.id)) rows = [Object.fromEntries(d.columns.map((c) => [c.id, '']))];
    return `const ${d.id} = ref(${jsonLines(rows)});`;
  });

  const compState = {};
  for (const e of entries) compState[keyOf.get(e.comp)] = initialState(e.comp);

  const srcBase = relPath.replace(/\\/g, '/').replace(/\.xfdl$/i, '');
  const base = opts.name ? `${posix.dirname(srcBase) === '.' ? '' : `${posix.dirname(srcBase)}/`}${opts.name}` : srcBase;
  const vuePath = `src/views/${base}.vue`;
  const apiPath = `src/api/${base}.js`;
  const compatPath = 'src/utils/nexa-compat.js';
  const gfnPath = 'src/utils/nexa-gfn.js';

  const imports = [uiOnly ? "import { ref, reactive } from 'vue';" : "import { ref, reactive, onMounted } from 'vue';"];
  if (!uiOnly) imports.push(`import * as nexa from '${relImport(vuePath, compatPath)}';`);
  if (script.uses.gfn) imports.push(`import * as gfn from '${relImport(vuePath, gfnPath)}';`);
  if (script.uses.api) imports.push(`import * as api from '${relImport(vuePath, apiPath)}';`);

  const scriptParts = [imports.join('\n'), dsInit.join('\n'), `const comp = reactive(${jsonLines(compState)});`];
  if (uiOnly) {
    scriptParts.push([...script.localFns].map(uiStubFunction).join('\n'));
    if (ir.script.trim()) {
      scriptParts.push(`/* 원본 스크립트 (UI만 변환: 스크립트는 변환하지 않음)\n${ir.script.replace(/\*\//g, '* /').replace(/<\/script/gi, '<\\/script')}\n*/`);
    }
  } else if (script.error) {
    scriptParts.push([...collectHandlers(ir)].map(stubFunction).join('\n'));
    scriptParts.push(`/* TODO(nexa2vue): original script (parse failed)\n${ir.script.replace(/\*\//g, '* /').replace(/<\/script/gi, '<\\/script')}\n*/`);
  } else if (script.code.trim()) {
    scriptParts.push(script.code.trim());
  }
  const onload = ir.attrs.onload;
  if (uiOnly) {
    // onload logic lives in the script, which is not converted in UI-only mode.
  } else if (onload && IDENT.test(onload) && (script.localFns.has(onload) || script.error)) {
    scriptParts.push(`onMounted(() => {\n  ${onload}(comp, {});\n});`);
  } else if (onload) {
    todos.push({ message: `form onload="${onload}" handler not found` });
  }

  const header = uiOnly
    ? `<!-- Generated by nexa2vue (UI only) from ${relPath.replace(/--/g, '- -')}. Event handlers are empty stubs. -->`
    : `<!-- Generated by nexa2vue from ${relPath.replace(/--/g, '- -')}. Search for TODO(nexa2vue). -->`;
  const vue = [
    header,
    `<template>\n${template}\n</template>`,
    `<script setup>\n${scriptParts.filter(Boolean).join('\n\n')}\n</script>`,
    '<style scoped>\n.nexa-form { position: relative; }\n.nexa-abs { position: absolute; box-sizing: border-box; }\n.nexa-hidden { display: none !important; }\n.nexa-tabpage { position: relative; width: 100%; height: 100%; }\n</style>',
    '',
  ].join('\n\n');

  const files = [{ path: vuePath, content: vue }];
  if (script.apiFns.size > 0) {
    const fns = [...script.apiFns].map(([name, url]) =>
      `export function ${name}(params) {\n  return http(${JSON.stringify(url)}, params);\n}`);
    files.push({
      path: apiPath,
      content: `// Generated by nexa2vue. TODO(nexa2vue): verify endpoint mapping in nexa-compat config.resolveUrl\nimport { http } from '${relImport(apiPath, compatPath)}';\n\n${fns.join('\n\n')}\n`,
    });
  }

  return { formId: ir.id, files, todos, gfnUsed: script.gfnUsed, includes: script.includes, error: script.error };
}

function collectHandlers(ir) {
  const names = new Set();
  const visit = (list) => {
    for (const c of list) {
      for (const [k, v] of Object.entries(c.attrs)) if (/^on/.test(k) && IDENT.test(v || '')) names.add(v);
      if (c.tabpages) c.tabpages.forEach((tp) => visit(tp.children));
      else visit(c.children);
    }
  };
  visit(ir.components);
  if (ir.attrs.onload && IDENT.test(ir.attrs.onload)) names.add(ir.attrs.onload);
  return names;
}

/**
 * Convert one .xjs library into an ES module under src/utils/nexa-lib/.
 */
function convertLibrary(source, opts = {}) {
  const relPath = (opts.relPath || 'lib.xjs').replace(/\\/g, '/');
  const script = convertScript(extractXjsScript(source), { mode: 'lib', libFns: opts.libFns });
  const libPath = `src/utils/nexa-lib/${relPath.replace(/\.xjs$/i, '')}.js`;
  const imports = [];
  if (script.uses.nexa) imports.push(`import * as nexa from '${relImport(libPath, 'src/utils/nexa-compat.js')}';`);
  if (script.uses.gfn) imports.push(`import * as gfn from '${relImport(libPath, 'src/utils/nexa-gfn.js')}';`);
  const body = script.error
    ? `/* TODO(nexa2vue): original script (parse failed)\n${source.replace(/\*\//g, '* /')}\n*/`
    : script.code;
  return {
    libPath,
    exported: script.error ? new Set() : script.localFns,
    files: [{ path: libPath, content: `// Generated by nexa2vue from ${relPath}\n${imports.join('\n')}${imports.length ? '\n\n' : ''}${body}` }],
    todos: [...script.todos.map((t) => ({ ...t, message: `[script] ${t.message}` })), ...(script.error ? [{ message: script.error }] : [])],
    gfnUsed: script.gfnUsed,
    error: script.error,
  };
}

/**
 * nexa-gfn.js: re-export converted library functions, stub the rest.
 */
function genGfnModule(libExports, gfnUsed) {
  const lines = ['// Generated by nexa2vue: common (gfn_*) functions used by converted screens.'];
  const provided = new Set();
  for (const [libPath, names] of libExports) {
    const fresh = [...names].filter((n) => !provided.has(n));
    fresh.forEach((n) => provided.add(n));
    if (fresh.length) lines.push(`export { ${fresh.join(', ')} } from '${relImport('src/utils/nexa-gfn.js', libPath)}';`);
  }
  const missing = [...gfnUsed].filter((n) => !provided.has(n)).sort();
  for (const name of missing) {
    lines.push(`\n// TODO(nexa2vue): implement ${name}\nexport function ${name}(...args) {\n  console.warn('[nexa2vue] TODO: ${name} is not implemented', args);\n}`);
  }
  return { content: lines.join('\n') + '\n', missing };
}

module.exports = { convertForm, convertLibrary, genGfnModule, indexComponents };
