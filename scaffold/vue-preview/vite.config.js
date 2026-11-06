// nexa2vue: 프로젝트 미리보기. 변환한 화면을 구조 파악한 Vue 프로젝트의 패키지·컴포넌트·스타일로 띄운다.
// 그 프로젝트는 읽기만 한다(패키지·플러그인·소스를 그 위치에서 가져다 쓴다). 경로는 vue-preview.config.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { frontend } = JSON.parse(fs.readFileSync(path.join(here, 'vue-preview.config.json'), 'utf8'))
const fe = path.resolve(frontend)
const feSrc = path.join(fe, 'src')
const feModules = path.join(fe, 'node_modules')
const outSrc = path.join(here, 'src')

// ESM entry of a package installed in the project
async function importFromProject(name) {
  const dir = path.join(feModules, ...name.split('/'))
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exp = pkg.exports && (pkg.exports['.'] ?? pkg.exports)
  const pick = (e) => (typeof e === 'string' ? e : e && (pick(e.import) || pick(e.default)))
  const entry = pick(exp) || pkg.module || pkg.main
  return import(pathToFileURL(path.join(dir, entry)).href)
}

const { default: vue } = await importFromProject('@vitejs/plugin-vue')

const inside = (parent, file) => {
  const rel = path.relative(parent, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// Bare imports from files outside the project (the converted screens and this
// preview) resolve as if imported from the project's main.js, so there is one
// copy of vue/pinia/… shared with the project's own files.
const resolveFromProject = {
  name: 'nexa2vue-resolve-from-project',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !/^(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/.*)?$/.test(source)) return null
    const file = importer.split('?')[0]
    if (inside(fe, path.resolve(file))) return null
    return this.resolve(source, path.join(feSrc, 'main.js'), { ...options, skipSelf: true })
  },
}

// "@/x": the converted files first (this folder's src), then the project's src.
const overlay = {
  name: 'nexa2vue-overlay',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!source.startsWith('@/')) return null
    for (const base of [outSrc, feSrc]) {
      const hit = await this.resolve(path.join(base, source.slice(2)), importer, { ...options, skipSelf: true })
      if (hit) return hit
    }
    return null
  },
}

export default {
  root: here,
  cacheDir: path.join(here, '.vite-cache'),
  plugins: [overlay, resolveFromProject, vue()],
  resolve: {
    alias: [
      // plugin-vue dedupes "vue" from this folder, which has no node_modules: point it at the project's copy.
      { find: /^vue$/, replacement: path.join(feModules, 'vue', 'dist', 'vue.runtime.esm-bundler.js') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    open: true,
    fs: { allow: [here, fe] },
  },
}
