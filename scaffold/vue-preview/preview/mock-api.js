// 백엔드 없이 띄우므로 서버 호출은 빈 샘플 응답으로 답한다(화면 배치 확인용).
// 응답은 빈 배열이면서 data·list·items·rows·content 같은 흔한 키도 빈 배열로 갖는다.
export function sample(method) {
  if (method && method.toUpperCase() !== 'GET') return { ok: true, success: true, data: {}, result: {} }
  const rows = []
  for (const k of ['data', 'list', 'items', 'rows', 'content', 'result', 'records']) rows[k] = []
  rows.total = 0
  rows.totalCount = 0
  return rows
}

const isApi = (url) => !/^\/(@|src\/|node_modules\/|preview\/)/.test(url) && !/\.(js|mjs|vue|css|json|png|svg|jpg|woff2?)(\?|$)/.test(url)

/** fetch: API로 보이는 요청은 서버로 보내지 않고 샘플로 답한다. */
export function installFetchMock() {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    if (!isApi(path)) return real(input, init)
    const method = init.method || (typeof input === 'object' && input.method) || 'GET'
    console.info('[미리보기 mock]', method, url)
    const res = new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    res.json = async () => sample(method)
    return res
  }
}

/** axios: 기본 adapter를 샘플 응답으로 바꾼다(이후에 만든 axios.create 인스턴스도 따른다). */
export function installAxiosMock(axios) {
  axios.defaults.adapter = async (config) => {
    console.info('[미리보기 mock]', (config.method || 'get').toUpperCase(), config.url)
    return { data: sample(config.method), status: 200, statusText: 'OK', headers: {}, config, request: {} }
  }
}
