'use strict';

// Preview for a frontend that is not uni (uni-structure.js frontendKind 'vue'):
// the converted screens run with that project's packages, components and
// styles, read in place (nothing is installed or written there). The project's
// src/main.js gives the plugins and global CSS (preview/setup.js), without
// its router, App and mount.

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const SCAFFOLD_DIR = path.join(__dirname, '..', 'scaffold', 'vue-preview');
const TEMPLATES = ['index.html', 'vite.config.js', 'preview/App.vue', 'preview/mock-api.js', 'preview/start.mjs', 'view-screens.cmd'];

const ROUTER_SOURCE = /(^|\/)router(\/index)?(\.[jt]s)?$/;
const APP_SOURCE = /(^|\/)App\.vue$/;

/**
 * src/main.js → body of `export default async function setup(app)` plus its imports:
 * every import but App and the router, every app.use/component/directive/provide/config
 * but the router, and other top-level statements that do not touch App, the router or mount.
 * Relative imports become "@/…" (main.js sits in src). Returns { imports, body, skipped }.
 */
function setupFromMain(text) {
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch (err) {
    return { imports: [], body: [], skipped: [`main.js를 읽지 못함: ${err.message}`] };
  }
  const src = (n) => text.slice(n.start, n.end);
  const excluded = new Set(); // App, router and createApp names
  const imports = [];
  const skipped = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const from = node.source.value;
    if (APP_SOURCE.test(from) || ROUTER_SOURCE.test(from)) {
      node.specifiers.forEach((s) => excluded.add(s.local.name));
      skipped.push(src(node));
      continue;
    }
    let line = src(node);
    if (from === 'vue') {
      const keep = node.specifiers.filter((s) => !(s.imported && s.imported.name === 'createApp'));
      node.specifiers.filter((s) => !keep.includes(s)).forEach((s) => excluded.add(s.local.name));
      if (!keep.length) continue;
      line = `import { ${keep.map((s) => (s.imported.name === s.local.name ? s.local.name : `${s.imported.name} as ${s.local.name}`)).join(', ')} } from 'vue'`;
    } else if (from.startsWith('./')) {
      line = line.replace(node.source.raw, JSON.stringify(`@/${from.slice(2)}`));
    } else if (from.startsWith('../')) {
      skipped.push(src(node));
      continue;
    }
    imports.push(line);
  }

  const isExcluded = (s) => [...excluded].some((name) => new RegExp(`^${name}$`).test(s.trim()));
  const uses = (n) => [...excluded].some((name) => new RegExp(`\\b${name}\\b`).test(src(n)));
  const body = [];
  let appName = null;
  // createApp(App).use(a).use(router).mount('#app') → app.use(a)
  const chainCalls = (expr) => {
    const calls = [];
    let cur = expr;
    while (cur && cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression') {
      calls.unshift({ method: cur.callee.property.name, args: cur.arguments });
      cur = cur.callee.object;
    }
    const root = cur && cur.type === 'CallExpression' && cur.callee.type === 'Identifier' && excluded.has(cur.callee.name) ? 'createApp' : cur && cur.type === 'Identifier' ? cur.name : null;
    return { root, calls };
  };
  const emitCalls = (calls) => {
    for (const c of calls) {
      if (c.method === 'mount') continue;
      const args = c.args.map(src);
      if (args.some(isExcluded)) {
        skipped.push(`app.${c.method}(${args.join(', ')})`);
        continue;
      }
      body.push(`app.${c.method}(${args.join(', ')})`);
    }
  };
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') continue;
    if (node.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[0].init) {
      const { root, calls } = chainCalls(node.declarations[0].init);
      if (root === 'createApp') {
        appName = node.declarations[0].id.name;
        emitCalls(calls);
        continue;
      }
    }
    if (node.type === 'ExpressionStatement') {
      const expr = node.expression.type === 'AwaitExpression' ? node.expression.argument : node.expression;
      const { root, calls } = chainCalls(expr);
      if (root === 'createApp' || (appName && root === appName)) {
        emitCalls(calls);
        continue;
      }
    }
    if (uses(node)) {
      skipped.push(src(node).split('\n')[0]);
      continue;
    }
    const line = src(node);
    body.push(appName && appName !== 'app' ? line.replace(new RegExp(`\\b${appName}\\b`, 'g'), 'app') : line);
  }
  return { imports, body, skipped };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function setupModule(frontend) {
  const mainFile = ['main.js', 'main.ts'].map((n) => path.join(frontend, 'src', n)).find((f) => fs.existsSync(f));
  const { imports, body, skipped } = mainFile ? setupFromMain(fs.readFileSync(mainFile, 'utf8')) : { imports: [], body: [], skipped: ['src/main.js 없음'] };
  return `// nexa2vue: 프로젝트 src/main.js에서 플러그인·전역 스타일만 가져왔다(App·라우터·mount 제외).
// 화면이 안 뜨면 이 파일을 고쳐도 된다(다시 변환해도 덮어쓰지 않는다).
${imports.join('\n')}

export default async function setup(app) {
${body.map((l) => l.split('\n').map((x) => `  ${x}`).join('\n')).join('\n')}
}
${skipped.length ? `\n// 뺀 것:\n${skipped.map((s) => `// - ${s.replace(/\n/g, ' ')}`).join('\n')}\n` : ''}`;
}

function mainModule({ router, axios }) {
  return `// nexa2vue 미리보기 진입점. 프로젝트 설정은 setup.js, 화면 목록은 screens.js.
import { createApp } from 'vue'
${router ? "import { createRouter, createMemoryHistory } from 'vue-router'\n" : ''}${axios ? "import axios from 'axios'\n" : ''}import { installFetchMock${axios ? ', installAxiosMock' : ''} } from './mock-api.js'
import setup from './setup.js'
import App from './App.vue'

// 백엔드 없이 띄우므로 서버 호출은 빈 샘플로 답한다
installFetchMock()
${axios ? 'installAxiosMock(axios)\n' : ''}
const app = createApp(App)
${router ? `// 화면이 useRouter·useRoute를 쓰므로 빈 라우터를 둔다(화면 전환은 미리보기 목록이 한다)
app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] }))
` : ''}await setup(app)
app.mount('#app')
`;
}

/** Files of the preview for the project at frontend (an absolute folder). */
function vuePreviewFiles(frontend) {
  const pkg = readJson(path.join(frontend, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => !!deps[name] && fs.existsSync(path.join(frontend, 'node_modules', name));
  const templates = TEMPLATES.map((rel) => {
    let content = fs.readFileSync(path.join(SCAFFOLD_DIR, ...rel.split('/')), 'utf8');
    if (rel.endsWith('.cmd')) content = content.replace(/\r?\n/g, '\r\n');
    return { path: rel, content };
  });
  return [
    { path: 'package.json', content: `${JSON.stringify({ name: 'nexa2vue-preview', private: true, type: 'module', scripts: { dev: 'node preview/start.mjs' } }, null, 2)}\n` },
    { path: 'vue-preview.config.json', content: `${JSON.stringify({ frontend }, null, 2)}\n` },
    { path: 'preview/main.js', content: mainModule({ router: has('vue-router'), axios: has('axios') }) },
    { path: 'preview/setup.js', content: setupModule(frontend) },
    ...templates,
  ];
}

module.exports = { vuePreviewFiles, setupFromMain, mainModule };
