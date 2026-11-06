---
name: nexa2vue-rules-uni
description: 넥사크로 화면을 uni 화면 표준(Quasar + @/components)으로 옮길 때만 쓰는 고정 규칙. nexa2vue가 uni 프로젝트 변환에만 넣는다. 공통 규칙(nexa2vue-rules)을 uni 컴포넌트로 어떻게 지키는지 정한다.
---

## uni 변환 규칙 (nexa2vue)
- 따로 둔 조회조건 영역은 그 자리에 SearchSection을 하나 더 둔다. v-model·items·on-search는 따로 둔다(예: hakbeonParams·hakbeonSearchItems). 부품 예제 CCU0298010처럼 한 화면에 여러 개 둘 수 있다.
- 한 Div 안의 입력칸 묶음과 버튼은 같은 영역의 type: 'custom' 칸(columnSpan: 2) 하나에 넣는다. 슬롯 안에 `<div class="selector-box">`로 Field - Field + Button을 원본 순서대로 놓고(예: #directInput 슬롯에 과목코드 - 분반 [입력]), 버튼을 ButtonGroup으로 빼지 않는다. 값은 그 영역의 모델(예: hakbeonParams)에 같이 둔다.
- Field는 v-model·type·maxlength props가 없다(item·model 필수, 없으면 렌더가 깨져 화면 전체가 안 뜬다). 슬롯 안에서도 항상 `<Field :item="gwamokItems.cd" :model="params" @update="onParamUpdate" />`처럼 쓴다. item 정의({ key, type, maxlength, ... })는 Constant에 두고, 값은 update(key, value)를 받아 모델에 넣는다. Enter·버튼 동작은 Field가 아니라 감싸는 요소(@keyup.enter)나 Button에 건다. 슬롯 안의 Field는 item.disabled를 보지 않으므로(item.disabled는 Form·SearchSection 칸에서만 먹는다) 비활성 칸은 `<Field ... :disabled="..." />` prop으로 막는다(원본 enable="false"·readonly 칸).
- DataGrid 머리글은 한 줄(nowrap)로만 그려지고 줄바꿈·머리글 슬롯이 없다. 원본 머리글에 줄바꿈(&#13;&#10;)이 있거나 글자가 길면 원본 폭을 그대로 쓰지 말고, 한 줄 머리글이 다 보이게 width를 넓힌다(대략 글자 수 × 14 + 40px, 예: "매우그렇지 못하다" 140). 줄바꿈은 공백 하나로 바꾸고, 늘어난 폭은 가장 넓은 내용 컬럼(문항내용 등)에서 줄인다.
- 입력·처리만 하는 영역(조회조건 없음)이면 그 자리에 Form + ButtonGroup으로 둔다.
- 원본 조회 버튼은 SearchSection의 조회로, 그리드의 신규·추가/삭제/저장/엑셀 버튼은 그 Section ButtonGroup의 기능(@add-item·@delete-item·@save-data·@download-excel)으로 대신한다. 그 밖의 원본 버튼은 그 Section ButtonGroup의 #etc-btn에 둔다.
- 그리드 칸 안 버튼은 기본 화면 CCU0298030의 "B3-10 셀 안 부품"처럼 DataGrid의 `#body-cell-{컬럼명}` 슬롯에 `q-btn`(flat·dense)으로 넣는다. 공통 Button은 셀에 넣지 않는다. 예: `<template #body-cell-gyowonNo="{ row }"><q-btn flat dense icon="search" :aria-label="..." @click="openTeacherPopup(row)" /></template>`.
- 원본 Tab은 `@/components`의 KeepAliveTabs(부품 사용법 B4-2, 업무 화면 UAU0101120)로 옮긴다. 쓰는 법: `<KeepAliveTabs v-model="activeTab" :tabs="tabs" @change="onTabChange" />`. props는 modelValue(활성 탭 id)·tabs·keepAlive(기본 true)·keepAliveMax뿐이고 슬롯은 없다. tabs는 `[{ id, title, component, props?, disabled? }]`이며 탭마다 컴포넌트가 하나 있어야 한다. 탭 정의 목록(id·title)은 Constant에 두고 View에서 `computed(() => constants.tabItems.map((tab) => ({ ...tab, component: tabComponents[tab.id], props: {...} })))`로 만든다.
- 탭 페이지마다 화면 폴더에 `{화면ID}Tab{번호 또는 이름}.vue`를 하나씩 만들고 AI 응답의 tabs에 담는다(예: us02_008_t1Tab1). 탭 페이지는 그리기만 한다: 조회·저장·상태(rows·model·params)는 View에 그대로 두고, 탭 페이지는 props로 rows·columns·model·optionMap·disabled 등을 받고 동작은 props의 onXxx 함수나 emit으로 View에 알린다(UAU0101120Tab처럼). 탭 페이지 template은 원본 탭 안 배치대로 SectionGroup·Section·DataGrid·Form을 쓰고, 첫 줄 주석(화면명·역할·연관 API)을 단다. 탭 페이지에서 service를 직접 부르지 않는다.
