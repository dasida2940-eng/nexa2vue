// 미리보기 실행: uni frontend에 설치된 Vite로 이 폴더를 띄운다. npm install이 필요 없다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const configFile = path.join(here, 'uni-preview.config.json')
const { uniFrontend } = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const uni = path.resolve(uniFrontend)
const viteBin = path.join(uni, 'node_modules', 'vite', 'bin', 'vite.js')

if (!fs.existsSync(path.join(uni, 'src', 'components'))) {
  console.error(`[미리보기] uni frontend를 찾을 수 없습니다: ${uni}\n${configFile}의 uniFrontend를 고치세요.`)
  process.exit(1)
}
if (!fs.existsSync(viteBin)) {
  console.error(`[미리보기] uni frontend에 패키지가 설치되어 있지 않습니다: ${uni}\nuni frontend 폴더에서 npm install을 한 번 실행하세요.`)
  process.exit(1)
}

// extra arguments go to Vite (예: node preview/start.mjs --port 5180)
const args = [viteBin, '--config', path.join(here, 'vite.config.js'), ...process.argv.slice(2)]
const child = spawn(process.execPath, args, { cwd: here, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
