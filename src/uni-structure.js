'use strict';

// "구조 파악": read the uni frontend and backend projects once, when the user
// asks from the web UI, and keep the result as the default for later runs.
// Conversion uses the saved result and does not read the projects again.
// Nothing is written to either project.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.nexa2vue', 'uni-structure.json');
const REFERENCE = /^CCU0297\d{3}/;

function listNames(dir, test) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(test).sort();
}

// Screens the skill is made from: the uni base screens (co/csm/CCU0297xxx)
// when the project has them, otherwise every .vue under src/views (up to MAX_SCREENS).
const MAX_SCREENS = 30;
function listScreens(root) {
  const views = path.join(root, 'src', 'views');
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d) || out.length >= MAX_SCREENS) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_SCREENS) return;
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules') walk(full);
      else if (e.isFile() && e.name.endsWith('.vue')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  const csm = path.join(views, 'co', 'csm');
  const refs = listNames(csm, (n) => REFERENCE.test(n));
  if (refs.length) refs.forEach((n) => walk(path.join(csm, n)));
  else walk(views);
  return out;
}

// 'uni': the uni frontend (base screens co/csm/CCU0297xxx), converted to the
// uni screen standard. 'vue': any other Vue project, converted the way the
// vue-convert skill (made from its screens) describes.
function frontendKind(root) {
  // A folder that is not there (or not a Vue project) keeps the uni behaviour.
  if (!fs.existsSync(path.join(String(root || ''), 'src', 'components'))) return 'uni';
  return listNames(path.join(String(root || ''), 'src', 'views', 'co', 'csm'), (n) => REFERENCE.test(n)).length ? 'uni' : 'vue';
}

function existingDocs(root, docs) {
  return docs.filter((d) => fs.existsSync(path.join(root, d)));
}

/** uni frontend: components, screen standard docs, base screens, API prefix. */
function analyzeFrontend(dir) {
  const root = path.resolve(String(dir || '').trim());
  if (!dir || !fs.existsSync(path.join(root, 'src', 'components'))) {
    throw new Error(`frontend를 찾을 수 없습니다(src/components 없음): ${dir}`);
  }
  const apiFile = path.join(root, 'src', 'utils', 'infra', 'api.js');
  const api = fs.existsSync(apiFile) ? /^\s*baseURL:\s*['"]([^'"]+)['"]/m.exec(fs.readFileSync(apiFile, 'utf8')) : null;
  return {
    root,
    kind: frontendKind(root),
    apiBase: api ? api[1] : null,
    docs: existingDocs(root, ['README.md', 'NAMING_CONVENTION.md', 'src/components/README.md', 'src/components/form/README.md', 'src/views/co/csm/README.md']),
    referenceScreens: listNames(path.join(root, 'src', 'views', 'co', 'csm'), (n) => REFERENCE.test(n)),
    screens: listScreens(root),
  };
}

/** uni backend: base package (@SpringBootApplication), CommonDto, docs, base screens. */
function analyzeBackend(dir) {
  const root = path.resolve(String(dir || '').trim());
  const javaRoot = path.join(root, 'src', 'main', 'java');
  if (!dir || !fs.existsSync(javaRoot)) throw new Error(`backend를 찾을 수 없습니다(src/main/java 없음): ${dir}`);
  let basePackage = null;
  const walk = (d, depth) => {
    if (basePackage || depth > 6) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (basePackage) return;
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('Application.java')) {
        const text = fs.readFileSync(full, 'utf8');
        const pkg = /^package\s+([\w.]+)\s*;/m.exec(text);
        if (pkg && /@SpringBootApplication/.test(text)) basePackage = pkg[1];
      }
    }
  };
  walk(javaRoot, 0);
  if (!basePackage) throw new Error(`backend에서 @SpringBootApplication 클래스를 찾지 못했습니다: ${root}`);
  const pkgDir = path.join(javaRoot, ...basePackage.split('.'));
  if (!fs.existsSync(path.join(pkgDir, 'common', 'dto', 'CommonDto.java'))) {
    throw new Error(`backend에 CommonDto가 없습니다(${basePackage}.common.dto.CommonDto): ${root}`);
  }
  return {
    root,
    basePackage,
    docs: existingDocs(root, ['SCREEN_CONVENTION.md', 'NAMING_CONVENTION.md', 'COMMENT_CONVENTION.md']),
    referenceScreens: listNames(path.join(pkgDir, 'co', 'csm', 'controller'), (n) => REFERENCE.test(n)).map((n) => n.replace(/Controller\.java$/, '')),
  };
}

/** Both at once; the backend is optional (empty = no backend generation). */
function analyzeUni({ uniFrontend, uniBackend }) {
  try {
    const frontend = analyzeFrontend(uniFrontend);
    const backend = uniBackend && String(uniBackend).trim() ? analyzeBackend(uniBackend) : null;
    return { analyzedAt: new Date().toISOString(), frontend, backend };
  } catch (err) {
    throw Object.assign(err, { status: 400 });
  }
}

function loadStructure(file = DEFAULT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveStructure(structure, file = DEFAULT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(structure, null, 2)}\n`, 'utf8');
}

/** Same folder? (case-insensitive on Windows; empty matches empty) */
function samePath(a, b) {
  const norm = (p) => {
    const s = String(p || '').trim();
    if (!s) return '';
    const r = path.resolve(s);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

module.exports = { frontendKind, listScreens, analyzeUni, analyzeFrontend, analyzeBackend, loadStructure, saveStructure, samePath, DEFAULT_FILE };
