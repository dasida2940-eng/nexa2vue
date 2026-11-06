// nexa2vue: uni 스타일 미리보기. 변환한 화면을 uni frontend의 공통 컴포넌트·스타일로 띄운다.
// uni frontend는 읽기만 한다(패키지·플러그인·소스를 그 위치에서 가져다 쓴다). 경로는 uni-preview.config.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { uniFrontend } = JSON.parse(fs.readFileSync(path.join(here, 'uni-preview.config.json'), 'utf8'))
const uni = path.resolve(uniFrontend)
const uniSrc = path.join(uni, 'src')
const uniModules = path.join(uni, 'node_modules')

// ESM entry of a package installed in the uni frontend
async function importFromUni(name) {
  const dir = path.join(uniModules, ...name.split('/'))
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exp = pkg.exports && (pkg.exports['.'] ?? pkg.exports)
  const entry = typeof exp === 'string' ? exp : (exp && (exp.import || exp.default)) || pkg.module || pkg.main
  return import(pathToFileURL(path.join(dir, entry)).href)
}

const { default: vue } = await importFromUni('@vitejs/plugin-vue')
const { quasar, transformAssetUrls } = await importFromUni('@quasar/vite-plugin')

const inside = (parent, file) => {
  const rel = path.relative(parent, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// Bare imports from files outside the uni frontend (the converted screens and
// this preview) resolve as if imported from uni's main.js, so there is one
// copy of vue/quasar shared with the uni components.
const resolveFromUni = {
  name: 'nexa2vue-resolve-from-uni',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    // bare package names only (not ./x, /x, C:/x, virtual:x)
    if (!importer || !/^(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/.*)?$/.test(source)) return null
    const file = importer.split('?')[0]
    if (inside(uni, path.resolve(file))) return null
    return this.resolve(source, path.join(uniSrc, 'main.js'), { ...options, skipSelf: true })
  },
}

export default {
  root: here,
  cacheDir: path.join(here, '.vite-cache'),
  plugins: [
    resolveFromUni,
    vue({ template: { transformAssetUrls } }),
    quasar({ sassVariables: path.join(uniSrc, 'quasar-variables.sass') }),
  ],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${uniSrc.split(path.sep).join('/')}/` },
      // plugin-vue dedupes "vue" from this folder, which has no node_modules: point it at uni's copy.
      { find: /^vue$/, replacement: path.join(uniModules, 'vue', 'dist', 'vue.runtime.esm-bundler.js') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    open: true,
    fs: { allow: [here, uni] },
  },
}
