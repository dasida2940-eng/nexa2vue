'use strict';

// After conversion: does a screen use the project's own components the way
// they declare their props? Works for any Vue 3 project (uni or not): imports
// are resolved the way the project resolves them (jsconfig/tsconfig paths,
// vite aliases, relative paths, barrel index files), and props are read from
// <script setup> (defineProps/defineModel, JS or TS) or the Options API
// (props: {...}). Only what the declarations make certain is flagged, since
// each of these breaks the screen:
// - a required prop left out, or v-model on a component with no such model prop
//   (the render throws, and in the dev server the whole screen goes blank)
// - a named import a project barrel does not export, or a component file in
//   the project that does not exist (the module does not load at all)
// Attributes a component does not declare are not flagged (they fall through
// to its root element), and nothing from packages (node_modules) is judged.

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const DIRECTIVE = /^(v-(?!model\b|bind\b)|@|#)/;
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^[a-z]/, (c) => c.toUpperCase());
const SOURCE_EXT = ['.vue', '.js', '.ts', '.mjs', '.jsx', '.tsx'];
// Screens and popups converted in the same run live here; a missing file there
// may just be another screen of this run, so it is not called missing.
const SCREEN_DIRS = /(^|\/)(views|pages|screens)(\/|$)/;

function parseModule(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
}

function parseExpression(code) {
  try {
    const node = acorn.parseExpressionAt(code, 0, { ecmaVersion: 'latest' });
    return code.slice(node.end).trim() ? null : node;
  } catch {
    return null;
  }
}

const keyName = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null);
const isRequired = (obj) => !!obj && obj.type === 'ObjectExpression'
  && obj.properties.some((q) => q.type === 'Property' && keyName(q) === 'required' && q.value.type === 'Literal' && q.value.value === true);

/** Every <script> block: [{ setup, ts, code, offset }]. */
function scriptBlocks(text) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text))) {
    out.push({ setup: /\bsetup\b/.test(m[1]), ts: /\blang\s*=\s*["']tsx?["']/.test(m[1]), code: m[2], offset: m.index + m[0].indexOf(m[2], m[1].length) });
  }
  return out;
}

// Code with comments and string/template contents blanked (same length), so a
// text scan finds only real code. Strings keep their quotes.
function codeOnly(code) {
  let out = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += c + code.slice(i + 1, j).replace(/[^\n]/g, ' ') + (j < code.length ? c : '');
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// From an opening bracket at `at` in the blanked code: the index just past its match.
function matchClose(blank, at) {
  const open = blank[at];
  const close = { '(': ')', '{': '}', '[': ']', '<': '>' }[open];
  let depth = 0;
  for (let i = at; i < blank.length; i++) {
    const c = blank[i];
    if (open === '<' && c === '=' && blank[i + 1] === '>') { i++; continue; } // arrow types inside generics
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

// Calls of `name` in the code: [{ typeArg, args }] as source text (typeArg for TS generics).
function macroCalls(code, name) {
  const blank = codeOnly(code);
  const calls = [];
  const re = new RegExp(`\\b${name}\\s*(?=[<(])`, 'g');
  let m;
  while ((m = re.exec(blank))) {
    let i = m.index + m[0].length;
    let typeArg = null;
    if (blank[i] === '<') {
      const end = matchClose(blank, i);
      if (end < 0) continue;
      typeArg = code.slice(i + 1, end - 1);
      i = end;
      while (/\s/.test(blank[i])) i++;
    }
    if (blank[i] !== '(') continue;
    const end = matchClose(blank, i);
    if (end < 0) continue;
    calls.push({ typeArg, args: code.slice(i + 1, end - 1) });
    re.lastIndex = end;
  }
  return calls;
}

// Top-level members of a TS type literal body `a: string; b?: number`: [{ name, optional }] or null.
function typeMembers(body) {
  const blank = codeOnly(body);
  const members = [];
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i <= blank.length; i++) {
    const c = blank[i];
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === ']' || (c === '>' && blank[i - 1] !== '=')) depth--;
    else if ((c === ';' || c === ',' || c === '\n' || c === undefined) && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  for (const raw of parts) {
    // comments out, string contents kept (a member name can be quoted)
    const part = codeOnly(raw).trim() ? raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '').trim() : '';
    if (!part) continue;
    const m = /^(?:readonly\s+)?(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$-]*))\s*(\?)?\s*:/.exec(part);
    if (!m) {
      if (/^\.\.\.|^\[/.test(part)) return null; // index signatures, spreads: not known
      continue; // a type continuation line (e.g. `| 'b'`)
    }
    members.push({ name: m[2] || m[3], optional: !!m[4] });
  }
  return members;
}

// A TS props type: a literal `{ ... }` or the name of an interface/type alias in the same script.
function typeProps(typeArg, code) {
  const t = typeArg.trim();
  let body = null;
  if (t.startsWith('{')) body = t.slice(1, t.lastIndexOf('}'));
  else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const blank = codeOnly(code);
    const decl = new RegExp(`\\b(?:interface\\s+${t}\\s*(?:extends\\s+[^{]+)?|type\\s+${t}\\s*=\\s*)\\{`).exec(blank);
    if (!decl || /extends/.test(decl[0])) return null;
    const open = decl.index + decl[0].length - 1;
    const end = matchClose(blank, open);
    if (end < 0) return null;
    body = code.slice(open + 1, end - 1);
  }
  if (body == null) return null;
  const members = typeMembers(body);
  return members && members.map((m) => [m.name, { required: !m.optional }]);
}

// `{ a: { type: Object as PropType<X>, required: true } }` → plain JS for acorn.
const withoutTsCasts = (code) => code.replace(/\s+as\s+(?:const\b|[A-Za-z_$][\w$.]*(?:<[^,}\n]*>)?(?:\[\])?)/g, '');

// The props of a defineProps/props argument: [[name, { required }]] or null when not known.
function runtimeProps(argText) {
  const arg = parseExpression(withoutTsCasts(argText.trim()));
  if (!arg) return null;
  if (arg.type === 'ArrayExpression') {
    return arg.elements.every((e) => e && e.type === 'Literal') ? arg.elements.map((e) => [String(e.value), { required: false }]) : null;
  }
  if (arg.type !== 'ObjectExpression') return null;
  const out = [];
  for (const p of arg.properties) {
    const name = p.type === 'Property' && !p.computed ? keyName(p) : null;
    if (name == null) return null;
    out.push([name, { required: isRequired(p.value) }]);
  }
  return out;
}

// Options API: `export default { props }` / `export default defineComponent({ props })` (JS only).
function optionsProps(code) {
  const ast = parseModule(code);
  if (!ast) return null;
  const decl = ast.body.find((d) => d.type === 'ExportDefaultDeclaration');
  if (!decl) return [];
  let obj = decl.declaration;
  if (obj.type === 'CallExpression' && obj.arguments[0]) obj = obj.arguments[0];
  if (obj.type !== 'ObjectExpression') return null;
  const prop = obj.properties.find((p) => p.type === 'Property' && keyName(p) === 'props');
  if (!prop) return obj.properties.some((p) => p.type !== 'Property') ? null : [];
  return runtimeProps(code.slice(prop.value.start, prop.value.end));
}

/**
 * The props a component declares: { props: Map(name -> { required }) }, or
 * null when they cannot be known for sure (a parse error, props built from a
 * variable or a spread, an extended TS interface).
 */
function componentSpec(text) {
  const blocks = scriptBlocks(text);
  const setup = blocks.find((b) => b.setup);
  const props = new Map();
  if (setup) {
    if (!setup.ts && !parseModule(setup.code)) return null;
    for (const call of macroCalls(setup.code, 'defineProps')) {
      const list = call.typeArg != null ? typeProps(call.typeArg, setup.code) : call.args.trim() ? runtimeProps(call.args) : [];
      if (!list) return null;
      list.forEach(([name, p]) => props.set(name, p));
    }
    for (const call of macroCalls(setup.code, 'defineModel')) {
      const args = parseExpression(`[${withoutTsCasts(call.args)}]`);
      if (!args) return null;
      const first = args.elements[0];
      const name = first && first.type === 'Literal' && typeof first.value === 'string' ? first.value : 'modelValue';
      props.set(name, { required: isRequired(args.elements.find((a) => a && a.type === 'ObjectExpression')) });
    }
  }
  const plain = blocks.find((b) => !b.setup);
  if (plain && /\bexport\s+default\b/.test(codeOnly(plain.code))) {
    if (plain.ts) return null;
    const list = optionsProps(plain.code);
    if (!list) return null;
    list.forEach(([name, p]) => props.set(name, p));
  }
  if (!setup && !plain) return null;
  return { props };
}

// ---------------------------------------------------------------- the project

function readJsonLoose(file) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// JSON with comments / trailing commas (jsconfig, tsconfig) → plain JSON text.
function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Import aliases of a project: [[alias, absDir]], longest first. */
function projectAliases(root) {
  const aliases = new Map();
  for (const name of ['jsconfig.json', 'tsconfig.json', 'tsconfig.app.json']) {
    const json = readJsonLoose(path.join(root, name));
    const opts = json && json.compilerOptions;
    if (!opts || !opts.paths) continue;
    const base = path.resolve(root, opts.baseUrl || '.');
    for (const [key, targets] of Object.entries(opts.paths)) {
      const target = Array.isArray(targets) && targets[0];
      if (!target || !/\/\*$/.test(key) || !/\/\*$/.test(target)) continue;
      const alias = key.slice(0, -2);
      if (!aliases.has(alias)) aliases.set(alias, path.resolve(base, target.slice(0, -2)));
    }
  }
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const re = /['"]?([@~#$][\w/-]*)['"]?\s*:\s*(?:fileURLToPath\(\s*new URL\(\s*|(?:path\.)?resolve\(\s*__dirname\s*,\s*)?['"](\.{0,2}\/?[\w./-]*)['"]/g;
    let m;
    while ((m = re.exec(text))) if (!aliases.has(m[1])) aliases.set(m[1], path.resolve(root, m[2]));
  }
  if (!aliases.size && fs.existsSync(path.join(root, 'src'))) aliases.set('@', path.join(root, 'src'));
  return [...aliases].sort((a, b) => b[0].length - a[0].length);
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Where an import points: { file } (project file), { generated } (a file of
 * this conversion), { dir } (a folder without an index), { missing: abs },
 * or null (a package, or not resolvable).
 */
function resolveImport(source, fromRel, project) {
  let base = null;
  if (source.startsWith('./') || source.startsWith('../')) base = path.resolve(project.root, path.posix.dirname(fromRel), source);
  else {
    const hit = project.aliases.find(([alias]) => source === alias || source.startsWith(`${alias}/`));
    if (hit) base = path.join(hit[1], source.slice(hit[0].length));
  }
  if (!base) return null;
  const candidates = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.filter((e) => e !== '.vue').map((e) => path.join(base, `index${e}`))];
  for (const c of candidates) {
    const rel = toPosix(path.relative(project.root, c));
    if (project.generated.has(rel)) return { generated: rel };
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return { file: c };
    } catch {
      // not there
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) return { dir: base };
  return { missing: base };
}

function cached(cache, file, make) {
  let stamp;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = make();
  cache.set(file, { stamp, value });
  return value;
}

const specCache = new Map();
const specOf = (file) => cached(specCache, file, () => componentSpec(fs.readFileSync(file, 'utf8')));

const barrelCache = new Map();

/**
 * What a barrel (index.js etc.) exports: { names: Map(name -> .vue file | null), complete }.
 * complete: every export form was understood, so a name it lacks is really missing.
 */
function barrelExports(file, project, depth = 0) {
  if (depth > 6) return { names: new Map(), complete: false };
  return cached(barrelCache, file, () => {
    const ast = parseModule(fs.readFileSync(file, 'utf8'));
    const names = new Map();
    if (!ast) return { names, complete: false };
    let complete = true;
    const fromRel = toPosix(path.relative(project.root, file));
    const target = (source, imported) => {
      const r = resolveImport(source, fromRel, project);
      if (!r || !r.file) {
        complete = false;
        return null;
      }
      if (imported === 'default') return r.file.endsWith('.vue') ? r.file : null;
      if (r.file.endsWith('.vue')) return null;
      const sub = barrelExports(r.file, project, depth + 1);
      if (!sub.complete) complete = false;
      return sub.names.get(imported) || null;
    };
    const imports = new Map();
    for (const d of ast.body) {
      if (d.type !== 'ImportDeclaration') continue;
      for (const s of d.specifiers) {
        imports.set(s.local.name, { source: d.source.value, imported: s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportSpecifier' ? (s.imported.name || s.imported.value) : null });
      }
    }
    for (const d of ast.body) {
      if (d.type === 'ExportNamedDeclaration') {
        if (d.declaration) {
          const decl = d.declaration;
          const ids = decl.type === 'VariableDeclaration' ? decl.declarations.map((v) => v.id.name).filter(Boolean) : decl.id ? [decl.id.name] : [];
          ids.forEach((n) => names.set(n, null));
        }
        for (const s of d.specifiers) {
          const exported = s.exported.name || s.exported.value;
          const local = s.local.name || s.local.value;
          if (d.source) names.set(exported, target(d.source.value, local));
          else {
            const imp = imports.get(local);
            names.set(exported, imp && imp.imported ? target(imp.source, imp.imported) : null);
          }
        }
      } else if (d.type === 'ExportAllDeclaration') {
        if (d.exported) {
          names.set(d.exported.name || d.exported.value, null);
          continue;
        }
        const r = resolveImport(d.source.value, fromRel, project);
        if (!r || !r.file || r.file.endsWith('.vue')) {
          complete = false;
          continue;
        }
        const sub = barrelExports(r.file, project, depth + 1);
        if (!sub.complete) complete = false;
        for (const [n, f] of sub.names) if (!names.has(n)) names.set(n, f);
      }
    }
    return { names, complete };
  }) || { names: new Map(), complete: false };
}

// A folder imported without an index (only seen in hand-made fixtures): its
// components by file name, a name used twice left out.
function folderComponents(dir) {
  const byName = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.vue')) {
        const name = path.basename(e.name, '.vue');
        byName.set(name, byName.has(name) ? null : p);
      }
    }
  };
  walk(dir);
  return byName;
}

/** The project a screen is checked against: { root, aliases, generated }. */
function projectOf(frontendRoot, files = []) {
  return { root: path.resolve(frontendRoot), aliases: projectAliases(path.resolve(frontendRoot)), generated: new Set(files.map((f) => f.path)) };
}

// Import statements of every <script> (JS or TS): [{ source, defaultName, named: [[local, imported]], at }].
function importsOf(text) {
  const out = [];
  for (const block of scriptBlocks(text)) {
    const blank = codeOnly(block.code);
    const re = /\bimport\s+(?!type\b)([\w$]+\s*,?\s*)?(\{[^}]*\})?\s*from\s*(['"])/g;
    let m;
    while ((m = re.exec(blank))) {
      const q = m.index + m[0].length;
      const end = block.code.indexOf(m[3], q);
      if (end < 0) continue;
      const source = block.code.slice(q, end);
      const defaultName = m[1] ? m[1].replace(/[\s,]/g, '') : null;
      const named = m[2]
        ? m[2].slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
          .map((s) => {
            const [imported, local] = s.split(/\s+as\s+/).map((x) => x.trim());
            return [local || imported, imported];
          })
        : [];
      out.push({ source, defaultName, named, at: block.offset + m.index });
    }
  }
  return out;
}

/**
 * What a screen imports from the project: { components: Map(local -> { name, file }),
 * problems: [{ at, component, message }] } (imports that cannot load).
 */
function screenImports(file, text, project) {
  const components = new Map();
  const problems = [];
  for (const imp of importsOf(text)) {
    const r = resolveImport(imp.source, file, project);
    if (!r || r.generated) continue;
    if (r.missing) {
      const rel = toPosix(path.relative(project.root, r.missing));
      if (!SCREEN_DIRS.test(rel) && fs.existsSync(path.dirname(r.missing))) {
        problems.push({ at: imp.at, component: imp.defaultName || (imp.named[0] && imp.named[0][1]) || imp.source, message: `'${imp.source}' 파일이 프로젝트에 없음(이 화면이 아예 열리지 않음)` });
      }
      continue;
    }
    if (r.dir) {
      const byName = folderComponents(r.dir);
      for (const [local, imported] of imp.named) if (byName.get(imported)) components.set(local, { name: imported, file: byName.get(imported) });
      continue;
    }
    if (r.file.endsWith('.vue')) {
      if (imp.defaultName) components.set(imp.defaultName, { name: path.basename(r.file, '.vue'), file: r.file });
      continue;
    }
    if (!imp.named.length) continue;
    const barrel = barrelExports(r.file, project);
    for (const [local, imported] of imp.named) {
      if (barrel.names.has(imported)) {
        const f = barrel.names.get(imported);
        if (f) components.set(local, { name: imported, file: f });
      } else if (barrel.complete) {
        problems.push({ at: imp.at, component: imported, message: `${imported}는 '${imp.source}'에 없는 export(이 화면이 아예 열리지 않음)` });
      }
    }
  }
  return { components, problems };
}

/** Local name -> component name for what a screen imports from the project. */
function commonImports(text, frontendRoot, file = 'src/views/_/_.vue') {
  const { components } = screenImports(file, text, projectOf(frontendRoot));
  return new Map([...components].map(([local, c]) => [local, c.name]));
}

// The template with comments blanked out (same length, so offsets keep their lines).
function templateRange(text) {
  const start = text.search(/<template\b/);
  const end = text.lastIndexOf('</template>');
  if (start < 0 || end < start) return null;
  return { start, body: text.slice(start, end).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')) };
}

/** Each start tag in a template: { name, attrs: [names], at: offset }. Quotes are honoured, so `a > b` in a value is no tag end. */
function startTags(body) {
  const tags = [];
  const re = /<([A-Za-z][\w-]*)/g;
  let m;
  while ((m = re.exec(body))) {
    const attrs = [];
    let i = m.index + m[0].length;
    while (i < body.length) {
      while (/\s/.test(body[i])) i++;
      if (i >= body.length || body[i] === '>' || body.startsWith('/>', i)) break;
      const nameStart = i;
      while (i < body.length && !/[\s=>]/.test(body[i]) && !body.startsWith('/>', i)) i++;
      const name = body.slice(nameStart, i);
      if (!name) { i++; continue; }
      attrs.push(name);
      while (/\s/.test(body[i])) i++;
      if (body[i] !== '=') continue;
      i++;
      while (/\s/.test(body[i])) i++;
      const q = body[i];
      if (q === '"' || q === "'") {
        const close = body.indexOf(q, i + 1);
        i = close < 0 ? body.length : close + 1;
      } else {
        while (i < body.length && !/[\s>]/.test(body[i])) i++;
      }
    }
    tags.push({ name: m[1], attrs, at: m.index });
    re.lastIndex = i;
  }
  return tags;
}

/** What an attribute passes: { prop } | { model } | { spread } | null (directive, event, slot). */
function attrTarget(attr) {
  const base = attr.split('.')[0];
  if (base === 'v-model') return { model: 'modelValue' };
  if (base.startsWith('v-model:')) return { model: camel(base.slice(8)) };
  if (base === 'v-bind') return { spread: true };
  if (base.startsWith('v-bind:')) return { prop: camel(base.slice(7)) };
  if (base.startsWith(':')) return { prop: camel(base.slice(1)) };
  if (DIRECTIVE.test(base)) return null;
  return { prop: camel(base) };
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * Problems in one .vue file: [{ file, line, component, message }], one per tag
 * or import. project: projectOf(frontendRoot, files).
 */
function checkVueFile(file, text, project) {
  const { components, problems } = screenImports(file, text, project);
  const issues = problems.map((p) => ({ file, line: lineAt(text, p.at), component: p.component, message: p.message }));
  const tpl = components.size ? templateRange(text) : null;
  if (!tpl) return issues;
  for (const tag of startTags(tpl.body)) {
    const local = components.has(tag.name) ? tag.name : components.has(pascal(tag.name)) ? pascal(tag.name) : null;
    const comp = local && components.get(local);
    const spec = comp && specOf(comp.file);
    if (!spec) continue;
    const given = new Set();
    let spread = false;
    const found = [];
    for (const attr of tag.attrs) {
      const t = attrTarget(attr);
      if (!t) continue;
      if (t.spread) spread = true;
      if (t.prop) given.add(t.prop);
      if (t.model) {
        given.add(t.model);
        if (!spec.props.has(t.model)) found.push(`${attr}를 받지 않음(${t.model} prop 없음)`);
      }
    }
    const missing = spread ? [] : [...spec.props].filter(([name, p]) => p.required && !given.has(name)).map(([name]) => name);
    if (missing.length) found.unshift(`필수 prop ${missing.join('·')} 없음`);
    if (!found.length) continue;
    issues.push({ file, line: lineAt(text, tpl.start + tag.at), component: comp.name, message: `<${tag.name}> ${found.join(', ')}` });
  }
  return issues.sort((a, b) => a.line - b.line);
}

/** Problems across a screen's files ([{ path, content }], project-relative paths); only .vue files are read. */
function checkComponentUse(files, frontendRoot) {
  if (!frontendRoot || !fs.existsSync(frontendRoot)) return [];
  const project = projectOf(frontendRoot, files);
  return files.filter((f) => f.path.endsWith('.vue')).flatMap((f) => checkVueFile(f.path, f.content, project));
}

/**
 * What the AI fix round needs to know about a list of issues:
 * - components: [{ component, file (project-relative), source }], each file once
 * - exports: [{ source, names }] what a barrel really exports, for a missing export
 * - folders: [{ source, files }] the component files really there, for a missing file
 */
function fixContext(issues, files, frontendRoot) {
  const project = projectOf(frontendRoot, files);
  const components = new Map();
  const exports = new Map();
  const folders = new Map();
  for (const f of files.filter((x) => issues.some((i) => i.file === x.path))) {
    const { components: used } = screenImports(f.path, f.content, project);
    for (const c of used.values()) {
      if (!issues.some((i) => i.file === f.path && i.component === c.name) || components.has(c.file)) continue;
      components.set(c.file, { component: c.name, file: toPosix(path.relative(project.root, c.file)), source: fs.readFileSync(c.file, 'utf8') });
    }
    for (const imp of importsOf(f.content)) {
      const r = resolveImport(imp.source, f.path, project);
      if (!r) continue;
      if (r.file && !r.file.endsWith('.vue') && imp.named.some(([, n]) => issues.some((i) => i.file === f.path && i.component === n)) && !exports.has(imp.source)) {
        exports.set(imp.source, [...barrelExports(r.file, project).names.keys()]);
      }
      if (r.missing && !folders.has(imp.source)) {
        const dir = path.dirname(r.missing);
        folders.set(imp.source, fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => SOURCE_EXT.some((e) => n.endsWith(e))).map((n) => toPosix(path.relative(project.root, path.join(dir, n)))) : []);
      }
    }
  }
  return {
    components: [...components.values()],
    exports: [...exports].map(([source, names]) => ({ source, names })),
    folders: [...folders].map(([source, list]) => ({ source, files: list })),
  };
}

module.exports = {
  checkComponentUse, checkVueFile, componentSpec, fixContext, commonImports, startTags,
  projectAliases, projectOf, resolveImport, barrelExports, importsOf, typeMembers, stripJsonComments,
};
