<!-- nexa2vue 미리보기: 왼쪽 화면 목록 + 오른쪽은 uni 메인 틀과 같은 ContentLayout 안에 화면을 띄운다 -->
<template>
  <div class="np-shell">
    <aside class="np-side">
      <h1 class="np-title">nexa2vue 미리보기</h1>
      <p class="np-hint">uni 공통 컴포넌트·스타일 / API는 샘플 데이터</p>
      <input v-model="keyword" class="np-search" type="search" placeholder="화면 검색" />
      <ul class="np-list">
        <li v-for="s in filtered" :key="s.id">
          <a :href="`#/${s.id}`" :class="{ active: s.id === currentId }">
            <strong>{{ s.name }}</strong>
            <span>{{ s.dir }}</span>
          </a>
        </li>
        <li v-if="!filtered.length" class="np-empty">화면이 없습니다</li>
      </ul>
    </aside>
    <main class="np-main">
      <ContentLayout top-padding>
        <template #body>
          <component :is="current.component" v-if="current" :key="current.id" />
          <p v-else class="np-empty">왼쪽 목록에서 화면을 고르세요.</p>
        </template>
      </ContentLayout>
    </main>
  </div>
  <PopupOutlet />
</template>

<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue'
import { PopupOutlet } from '@/components'
import ContentLayout from '@/views/main/ContentLayout.vue'

// /src/views/ua/usr/BAU0101010/BAU0101010View.vue -> id 'ua/usr/BAU0101010'
const modules = import.meta.glob('/src/views/**/*View.vue')
const screens = Object.keys(modules)
  .map((file) => {
    const id = file.replace(/^\/src\/views\//, '').replace(/\/[^/]+View\.vue$/, '')
    const parts = id.split('/')
    return { id, name: parts[parts.length - 1], dir: parts.slice(0, -1).join('/'), component: defineAsyncComponent(modules[file]) }
  })
  .sort((a, b) => a.id.localeCompare(b.id))

const keyword = ref('')
const filtered = computed(() => screens.filter((s) => s.id.toLowerCase().includes(keyword.value.trim().toLowerCase())))

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
.np-shell {
  display: flex;
  height: 100vh;
}
.np-side {
  width: 260px;
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  border-right: 1px solid var(--color-border, #d0d7de);
  background: var(--color-surface, #fff);
}
.np-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.np-hint {
  margin: 4px 0 12px;
  font-size: 12px;
  color: #6b7280;
}
.np-search {
  padding: 6px 8px;
  border: 1px solid var(--color-border, #d0d7de);
  border-radius: 6px;
  margin-bottom: 8px;
}
.np-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
}
.np-list a {
  display: block;
  padding: 6px 8px;
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
}
.np-list a span {
  display: block;
  font-size: 12px;
  color: #6b7280;
}
.np-list a:hover,
.np-list a.active {
  background: var(--color-surface-muted, #f1f3f5);
}
.np-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.np-empty {
  padding: 8px;
  color: #6b7280;
}
</style>
