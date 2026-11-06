// uni frontend src/main.js와 같은 순서로 스타일·플러그인을 올린다(라우터·로그인·사이트 설정은 뺀다).
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Quasar } from 'quasar'

import '@/assets/styles/custom-table.css'
import '@quasar/extras/material-icons/material-icons.css'
import 'quasar/src/css/index.sass'
import 'pretendard-gov/dist/web/variable/pretendardvariable-gov-dynamic-subset.css'

import api from '@/utils/infra/api'
import { setHttpClient } from '@/utils/infra/http'

import '@/assets/styles/style.css'

import { installMockApi } from './mock-api.js'
import App from './App.vue'

// 백엔드 없이 띄우므로 API는 샘플 데이터로 답한다
installMockApi(api)
setHttpClient(api)

const app = createApp(App)
// Without a handler, Vue dev re-throws render errors mid-patch. One broken screen then
// leaves a half-mounted tree and every later screen switch fails ("reading 'subTree'").
// Log instead so the broken part renders empty and the rest of the preview keeps working.
app.config.errorHandler = (err, instance, info) => {
  const name = instance?.$options?.name || instance?.$options?.__name || '?'
  console.error(`[미리보기] ${name} (${info}) 오류:`, err)
}
app.use(Quasar, { plugins: {} }).use(createPinia()).mount('#app')
