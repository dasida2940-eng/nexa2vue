// 미리보기용 가짜 API. 변환한 화면의 Constant(컬럼·폼 정의)로 샘플 데이터를 만들어 돌려준다.
// URL: {basicUrl}/{action} — 예) /ua/usr/BAU0101010/findBamn010List
const constants = import.meta.glob('/src/views/**/*Constant.js', { eager: true })
const SAMPLE_ROWS = 5

function constantOf(screenId) {
  const hit = Object.entries(constants).find(([file]) => file.endsWith(`/${screenId}Constant.js`))
  return hit ? Object.values(hit[1])[0] : null
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1)

function sampleValue(def, label, i) {
  const options = [def.options, def.editor && def.editor.options].find(Array.isArray)
  if (options && options.length) return options[i % options.length].value
  const type = (def.editor && def.editor.type) || def.type
  // 이름으로 짐작할 수 있는 값(년도·학기·일자)은 그럴듯하게
  const key = String(def.field || def.key || '')
  if (/^year$|Year$/.test(key)) return '2026'
  if (/^hakgi$/i.test(key)) return String((i % 2) + 1)
  if (/(Dt|Date|Ymd)$/.test(key)) return `2026-03-${String(i + 2).padStart(2, '0')}`
  if (type === 'number' || def.align === 'right') return (i + 1) * 10
  if (type === 'date') return `2026-01-${String(i + 1).padStart(2, '0')}`
  if (type === 'toggle' || type === 'checkbox') return i % 2 ? '0' : '1'
  return `${label} ${i + 1}`
}

function sampleRows(columns) {
  return Array.from({ length: SAMPLE_ROWS }, (_, i) =>
    Object.fromEntries(columns.filter((c) => c.field).map((c) => [c.field, sampleValue(c, c.label || c.field, i)])),
  )
}

function sampleInfo(formItems) {
  const items = (formItems || []).flat().filter((it) => it.key && it.type !== 'custom')
  return Object.fromEntries(items.map((it) => [it.key, sampleValue(it, it.label || it.key, 0)]))
}

// Constant 안의 컬럼 정의(field)와 폼 항목(key)을 이름과 상관없이 모두 모은다.
// AI 변환은 columns·formItems·hakbeonItems처럼 이름을 자유롭게 붙이므로
// {이름}Columns / {이름}FormItems가 없을 때 이것으로 샘플을 만든다.
function collectDefs(constant) {
  const columns = []
  const items = []
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (typeof v.field === 'string' && (v.label || v.name)) columns.push(v)
    else if (typeof v.key === 'string') items.push(v)
    Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  walk(constant, 0)
  // 라벨이 없는 항목(팝업이 채우는 표시용 칸 등)은 같은 키의 컬럼 라벨을 빌린다
  const labelOf = (key) => (columns.find((c) => c.field === key && c.label) || items.find((it) => it.key === key && it.label) || {}).label
  return {
    columns: [...new Map(columns.map((c) => [c.field, c])).values()],
    items: items.map((it) => (it.label ? it : { ...it, label: labelOf(it.key) || it.key })),
  }
}

// 공통코드·도메인 옵션 조회(option.setCommon 등): 고를 수 있는 샘플 코드 3개
const SAMPLE_OPTIONS = [1, 2, 3].map((i) => ({ label: `코드 ${i}`, value: String(i) }))

function respond(url) {
  const parts = url.split('?')[0].split('/').filter(Boolean)
  const action = parts.pop() || ''
  if (/Options$/.test(action)) return SAMPLE_OPTIONS
  const constant = constantOf(parts.pop() || '') || {}
  let m = /^find(\w+)List$/.exec(action)
  if (m) return sampleRows(constant[`${lowerFirst(m[1])}Columns`] || collectDefs(constant).columns)
  m = /^find(\w+)Info$/.exec(action)
  if (m) return sampleInfo(constant[`${lowerFirst(m[1])}FormItems`] || collectDefs(constant).items)
  return {}
}

export function installMockApi(api) {
  api.defaults.adapter = async (config) => {
    const data = respond(config.url || '')
    console.info('[미리보기 API]', (config.method || 'get').toUpperCase(), config.url, data)
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
}
