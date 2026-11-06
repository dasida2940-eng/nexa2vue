<!-- nexa2vue 미리보기: 왼쪽 화면 목록 + 오른쪽에 화면. 화면 목록은 preview/screens.js(변환할 때 nexa2vue가 씀) -->
<template>
  <div class="np-shell">
    <aside class="np-side">
      <h1 class="np-title">nexa2vue 미리보기</h1>
      <p class="np-hint">프로젝트의 컴포넌트·스타일 / API는 빈 샘플 응답</p>
      <input v-model="keyword" class="np-search" type="search" placeholder="화면 검색" />
      <ul class="np-list">
        <li v-for="s in filtered" :key="s.id">
          <a :href="`#/${s.id}`" :class="{ active: s.id === currentId }">
            <strong>{{ s.id }}</strong>
            <span>{{ s.name }}</span>
          </a>
        </li>
        <li v-if="!filtered.length" class="np-empty">화면이 없습니다</li>
      </ul>
    </aside>
    <main class="np-main">
      <div id="np-screen" class="np-screen">
        <component :is="current.component" v-if="current" :key="current.id" />
        <p v-else class="np-empty">왼쪽 목록에서 화면을 고르세요.</p>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue'
import list from './screens.js'

const screens = list.map((s) => ({ ...s, component: defineAsyncComponent(s.load) }))

const keyword = ref('')
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return screens.filter((s) => `${s.id} ${s.name}`.toLowerCase().includes(k))
})

const currentId = ref('')
const current = computed(() => screens.find((s) => s.id === currentId.value) || null)
const syncHash = () => {
  currentId.value = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || (screens[0] ? screens[0].id : '')
}
syncHash()
window.addEventListener('hashchange', syncHash)
onBeforeUnmount(() => window.removeEventListener('hashchange', syncHash))
</script>

<style scoped>
.np-shell { display: flex; min-height: 100vh; }
.np-side { width: 240px; flex: 0 0 240px; display: flex; flex-direction: column; padding: 16px 12px; border-right: 1px solid #d0d7de; background: #fff; }
.np-title { margin: 0; font-size: 16px; font-weight: 700; }
.np-hint { margin: 4px 0 12px; font-size: 12px; color: #6b7280; }
.np-search { padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 8px; }
.np-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.np-list a { display: flex; flex-direction: column; padding: 6px 8px; border-radius: 6px; color: inherit; text-decoration: none; }
.np-list a span { font-size: 12px; color: #6b7280; }
.np-list a.active, .np-list a:hover { background: #eef2ff; }
.np-main { flex: 1; min-width: 0; }
.np-screen { padding: 16px; }
.np-empty { color: #6b7280; padding: 12px; }
</style>
