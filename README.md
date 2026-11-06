# nexa2vue

넥사크로(`.xfdl`, `.xjs`) 소스를 **Vue 3** 코드로 일괄 변환하는 로컬 웹 도구입니다. uni 프로젝트 화면 표준, 구조 파악한 다른 Vue 프로젝트 방식, Element Plus(CLI 기본)로 변환하고, 화면마다 변환 내용·API 명세 문서를 만듭니다.

- **외부 전송**: 규칙 기반 변환(CLI `--ai` 없음, HTML 버전)은 이 PC 안에서만 하고 아무것도 보내지 않습니다. AI 변환(웹 화면은 항상 사용)은 이 PC에 로그인된 Claude Code로 화면 소스를 Anthropic에 보냅니다. 구조 파악 때 스킬 만들기와 화면 설명 문서도 마찬가지입니다.
- **원본 보호**: 출력 폴더는 입력 폴더와 겹칠 수 없습니다. 원본과 uni frontend·backend 폴더는 읽기만 합니다.
- 변환 결과는 **1차 초안**입니다. 자동으로 옮기지 못한 부분은 `TODO(nexa2vue)` 주석과 리포트, 문서의 "확인할 것"으로 표시합니다.

## 실행

프로젝트 폴더의 **`nexa2vue 서버 실행.cmd`**를 더블클릭하면 됩니다.
- 서버가 켜지고 브라우저에서 http://127.0.0.1:3470 이 열립니다.
- 처음 실행할 때만 필요한 패키지를 설치합니다.
- 사용하는 동안 검은 창을 닫지 마세요. 창을 닫으면 서버가 꺼집니다.
- Node.js(LTS)가 설치되어 있어야 합니다.

명령으로 실행해도 됩니다.

```bash
npm install
node bin/nexa2vue-web.js [--open]
# 브라우저에서 http://127.0.0.1:3470 접속
```

웹 화면에서 다음 순서로 진행합니다. 웹 화면은 항상 **uni 프로젝트 표준 + AI 변환**으로 진행합니다(출력 형식·UI만 변환·AI 선택 항목은 CLI에만 있습니다).
0. **준비**: frontend·backend 경로를 확인하고(각 칸의 선택 버튼으로 폴더 지정) **구조 파악**을 누릅니다. 구조를 파악하기 전에는 아래가 모두 잠겨 있습니다(아래 'uni 프론트·백엔드 구조 파악' 참고). Claude 계정도 여기서 연결하거나 바꿉니다.
   - 연결 방식: Claude 구독 계정(claude.ai) 또는 Anthropic Console(API 과금). **계정 변경**은 로그아웃한 뒤 웹 로그인을 다시 엽니다.
   - Claude 사용량(5시간·7일 한도의 사용 %와 남은 %, 초기화 시각)이 표시됩니다. Claude Code가 AI 호출 중에 알려 주는 값이라, AI 변환을 한 번 한 뒤부터 보이고 변환 중에 계속 바뀝니다.
1. 입력 폴더와 출력 폴더를 고릅니다. **둘 다 채워야** 미리보기와 변환 버튼이 켜집니다.
   - **선택** 버튼은 이 PC에 Windows 폴더 선택 창을 띄웁니다(브라우저는 보안상 실제 폴더 경로를 알려주지 않기 때문입니다). 경로를 직접 입력해도 됩니다.
   - 입력 폴더 아래(하위 폴더 포함)에 넥사크로 화면(`.xfdl`)이 하나도 없으면 거부됩니다.
   - 출력 폴더는 자동으로 채우지 않습니다. 원하는 위치를 직접 고르세요.
   - `--input <경로>`로 실행하면 입력 폴더를 미리 채운 상태로 시작합니다(예전 이름 `--root`도 받습니다).
   - 입력 폴더와 겹치는 위치(같은 폴더, 그 안, 그것을 포함하는 폴더)와 드라이브 최상위(`D:\`)는 쓸 수 없습니다.
   - 출력 폴더에 같은 이름의 파일이 있으면 덮어씁니다. 기존 프로젝트 폴더 대신 빈 폴더를 권장합니다.
   - **UI만 변환**(기본 선택): 화면 배치, 컴포넌트, Dataset, Bind만 변환합니다.
     - 이벤트 핸들러는 빈 함수로 만들고, 원본 스크립트는 `.vue` 파일 아래쪽에 주석으로 남깁니다.
     - `.xjs` 공통 스크립트와 런타임 헬퍼(`nexa-compat.js`, `nexa-gfn.js`)는 만들지 않습니다.
     - 남는 TODO는 화면 쪽 항목뿐입니다(지원하지 않는 컴포넌트, Grid 셀 표현식 등).
     - 스크립트까지 변환하려면 체크를 해제합니다. CLI에서는 `--ui-only` 옵션을 씁니다.
   - **화면 보기용 Vite 프로젝트 함께 생성**(기본 선택): 출력 폴더에 실행용 파일을 만듭니다. 이미 있는 파일은 덮어쓰지 않습니다.
     - 만드는 파일: `package.json`, `vite.config.js`, `index.html`, `src/main.js`, `src/App.vue`, `view-screens.cmd`
   - **변환이 끝나면 화면 설명 문서 만들기**(기본 해제, uni 스타일 미리보기 생성이 켜져 있어야 고를 수 있음): 변환이 끝난 뒤 한 단계를 더 돌립니다. CLI에서는 `--shot-docs`(`--viewer` 필요)를 씁니다.
     - 출력 폴더의 미리보기를 빈 포트에 잠깐 띄우고, uni frontend에 설치된 Playwright와 이 PC의 Chrome(없으면 Edge)으로 화면마다 캡처합니다.
     - 캡처는 처음 화면, 조회 후 화면, 팝업으로 나뉩니다.
       - 조회 후 화면: 빈 조회조건에 샘플 값을 넣고 조회 버튼을 누른 모습입니다.
       - 팝업: 샘플 row로 `popup.open`을 해서 연 모습입니다.
     - 캡처 위 조회조건·섹션·그리드·버튼에 번호를 붙입니다. Claude Code가 변환된 View/Constant와 변환 문서를 읽고 번호별 설명, 사용 순서, 조회 결과 설명을 씁니다.
     - 결과는 화면 문서 폴더의 `01_개요.html`(`docs/<원본 경로>/<화면ID>/01_개요.html`) "만든 파일" 앞 **화면 설명** 섹션에 들어가고, 이미지는 같은 폴더의 `images/`에 저장됩니다. 설명표 행에 마우스를 올리면 캡처에서 같은 번호가 강조됩니다.
     - 화면당 1~3분 걸리며, 변환된 화면 코드와 캡처가 Anthropic으로 전송됩니다. Claude 설명이 실패한 화면은 캡처와 항목 목록만 넣고, 로그에 이유를 남깁니다.
2. **화면 검토**를 눌러 대상 화면을 확인합니다. 표 아래 **확인란에 체크해야 변환할 수 있습니다.**
   - 화면마다 **종류**(화면 · 하위 화면 · 팝업)와 **부모 화면**을 nexa2vue가 원본에서 추정해 보여 주고, **이렇게 본 근거**를 함께 적습니다. 틀리면 고르면 됩니다.
     - 하위 화면: 다른 화면의 Div·Tabpage `url="…"`(또는 `div.set_url("…")`)로 들어가는 화면
     - 팝업: 다른 화면 스크립트에 그 화면 주소(`"ua::…/X.xfdl"` — `gfn_openPopup`·`showModal`·`ChildFrame` 등)가 있는 화면. 여는 화면이 없어도 `this.close()`, 파일명 `_P`·`POP`, 제목의 "팝업"이 있으면 팝업으로 보고 부모는 비워 둡니다.
   - 종류에 따라 결과가 바뀝니다(uni 프론트 README 규칙).
     - 팝업: `{부모 화면ID + 1}_POP` 폴더(예: `BAU0101010` → `BAU0101011_POP`)에 `Popup` 틀로 만들고(props `modelValue`·`row`, `emit('callback', { data })`, 확인·닫기), 부모 화면에는 `import`와 `popup.open`으로 여는 함수 `open…Popup()`을 넣습니다.
     - 하위 화면: 부모 화면 폴더 안의 컴포넌트 `{부모ID}{Div 이름}.vue`(예: `div_detail` → `BAU0101010Detail.vue`)로 만들어 원래 Div 자리에 `<BAU0101010Detail />`로 넣습니다. 조회조건·컬럼 상수와 API는 부모의 `Constant.js`·`Service.js`·백엔드에 합칩니다(이름이 겹치지 않게 바꿈). 부모와 하위 화면은 AI 변환도 한 번에 합니다.
     - 종류를 바꾸면 기본 출력 이름과 결과 파일 경로가 바로 바뀝니다. 변환 문서에도 종류·부모·함께 변환한 하위 화면이 적힙니다.
   - 화면마다 **출력 이름**을 바꿀 수 있습니다. 기본값은 원본 파일명(팝업·하위 화면은 위 규칙의 이름)입니다. 옆 칸에 결과 파일 경로가 바로 표시됩니다.
   - 이름을 바꾸면 결과 파일명이 따라 바뀝니다. uni 형식에서는 화면 폴더명, `View`·`Service`·`Constant` 파일명, 그 안의 export 이름, `basicUrl`도 함께 바뀝니다.
   - 이름에는 영문자·숫자·밑줄(_)만 쓸 수 있고, 첫 글자는 영문자나 밑줄이어야 합니다. 같은 폴더 안에서 이름이 겹치면(대소문자 무시) 빨간 칸으로 표시되고 변환되지 않습니다.
   - 매번 같은 이름을 쓰려면 입력 폴더의 `nexa2vue.config.json`에 `"names": { "ua/usr/학적변동.xfdl": "BAU0101010" }`처럼 적어 두세요. 그 값이 기본값이 되고, 화면에서 다시 바꿀 수 있습니다. CLI에서는 `--names names.json`(같은 형식의 JSON)을 씁니다.
3. 변환을 실행합니다. **진행 상황**의 로그 창(읽기 전용)에 CLI처럼 단계가 실시간으로 찍힙니다.
   - 화면별 규칙 변환 시작·끝, AI 변환 시작, AI가 읽는 파일·검색·생각, 쓰는 파일, 화면별 결과와 전체 요약
   - Claude 사용량이 바뀔 때마다 `사용량 5시간 32% 사용(68% 남음) · 7일 11% 사용(89% 남음)` 줄이 찍히고, 로그 위 막대에도 표시됩니다.
4. 결과 목록에서 파일을 눌러 원본과 결과를 비교하고 TODO를 확인합니다.

### 변환된 화면 보기

화면 보기 옵션으로 변환했으면 출력 폴더에서 바로 실행할 수 있습니다.

```bat
cd /d C:\넥사프로젝트상위폴더_vue
npm install
npm run dev
```

`view-screens.cmd`를 더블클릭해도 같습니다. 처음 실행할 때만 npm install을 합니다.
- 브라우저에서 `http://127.0.0.1:5173`이 열립니다.
- 왼쪽 목록에서 화면을 고르면 오른쪽에 표시됩니다. 검색할 수 있고, 주소(`#/member/MemberList`)로 바로 들어갈 수도 있습니다.
- `npm install`은 npm 레지스트리에서 vue, element-plus, vite 패키지만 내려받습니다. 소스는 전송하지 않습니다. 사내망에서 npm이 막혀 있으면 사내 npm 미러를 설정하세요.
- 전체 변환 모드에서는 화면을 열 때 `onload`의 transaction 등이 실행됩니다. 백엔드가 없으면 콘솔에 요청 실패가 표시될 수 있습니다.

CLI로도 실행할 수 있습니다.

```bash
node bin/nexa2vue.js --in C:\work\nexa-project --out C:\work\vue-out [--dry-run] [--ui-only] [--viewer]
```

## 서버 없이 HTML 파일로 쓰기

서버를 띄우지 않고 HTML 파일 하나로도 쓸 수 있습니다.

```bash
npm run build:html
# dist/nexa2vue.html 이 만들어집니다. 이 파일만 복사해서 더블클릭하면 됩니다.
```

- **사용 순서**:
  1. **폴더 선택**으로 넥사크로 소스 폴더를 고릅니다.
  2. 출력 형식을 고르고 **변환 실행**을 누릅니다.
  3. **출력 폴더에 저장**이나 **ZIP으로 내려받기**로 결과를 저장합니다.
- 결과 목록에서 파일을 누르면 원본과 변환 결과를 비교할 수 있습니다.
- **브라우저**: Chrome·Edge에서는 고른 출력 폴더에 바로 저장합니다. 폴더 쓰기를 지원하지 않는 브라우저(Firefox 등)에서는 ZIP 다운로드만 됩니다.
- **원본 보호**:
  - 입력 폴더는 읽기 권한으로만 엽니다.
  - 출력 폴더가 입력 폴더와 같거나, 그 안에 있거나, 그것을 포함하면 저장을 거부합니다.
  - 화면 보기용 프로젝트 파일은 출력 폴더에 이미 있으면 덮어쓰지 않습니다.
- **외부 전송 없음**: 페이지에 네트워크 요청을 막는 CSP(`connect-src 'none'`)가 걸려 있고, 외부 스크립트나 CSS를 하나도 불러오지 않습니다.
- **변환 코드**: Node 서버, CLI와 같은 코드(`src/convert-core.js`)를 씁니다. 그래서 변환 결과도 같습니다.

## 출력 형식: uni 프로젝트 표준

웹 화면의 **출력 형식**에서 `uni 프로젝트 표준`을 고르거나, CLI에 `--profile uni`를 붙이면 됩니다. 넥사크로 화면을 uni frontend의 화면 표준(`src/views/co/csm/README.md`)에 맞춰 **다시 배치**합니다.

```bash
node bin/nexa2vue.js --in C:\work\nexa-project --out C:\work\vue-out --profile uni
```

- **출력 파일**: 화면마다 `src/views/<원본 경로>/<화면ID>/` 폴더에 `<화면ID>View.vue`, `<화면ID>Service.js`, `<화면ID>Constant.js` 세 파일을 만듭니다.
- **조회조건**: 다음 둘 중 하나를 조회조건으로 봅니다.
  - 이름에 search/srch/cond가 들어가거나 `조회` 버튼이 있는 Div
  - Div가 없으면 첫 그리드보다 위에 있는 입력
  - 조회조건은 `SearchSection`의 `searchItems`로 옮깁니다. 라벨은 입력 왼쪽의 Static에서 가져오고, `*`가 붙어 있으면 `required`로 바꿉니다. 원본 조회 버튼은 SearchSection의 조회 기능으로 대신합니다.
- **그리드**: `Section` 안의 `DataGrid`로 옮깁니다.
  - `edittype`을 `editor`로 바꿉니다(combo→select, date→date, checkbox→toggle, 나머지→text·number).
  - `currow` 표현식은 `row-number`로, 선택용 체크 컬럼(CHK 등)은 체크박스로 바꿉니다.
- **입력 폼**: 나머지 입력은 Div 단위로 묶어 `Form`으로 옮깁니다. 그리드와 같은 Dataset에 바인딩된 폼은 기본 화면 A3처럼 선택한 행을 편집하는 폼이 됩니다.
- **배치**: 영역이 겹치지 않으면 위아래로(`direction="vertical"`), 나란히 있으면 좌우로(`direction="horizontal"`) `SectionGroup`을 중첩합니다. 가장 큰 그리드는 `size="rest"`입니다.
- **버튼**:
  - 추가/삭제/저장/엑셀 버튼은 가장 가까운 섹션의 `ButtonGroup` `featureAuth`로 옮깁니다.
  - 그 밖의 버튼은 `#etc-btn` 슬롯에 넣고, 원본 핸들러 이름으로 빈 함수를 만듭니다.
  - 영역 바로 위의 Static은 섹션 제목이 됩니다.
- **이름**: 이름 규칙(`NAMING_CONVENTION.md`)을 따릅니다.
  - 테이블 코드 모양의 Dataset 이름(`ds_bamn010`)은 대상 토큰(`findBamn010List`)으로 씁니다.
  - 그렇지 않은 이름(`ds_list`)은 `Tbl001`로 둡니다. 필드 키는 Dataset 컬럼을 camelCase로 바꾼 이름입니다(`STD_NO`→`stdNo`).
- **스크립트**: 변환하지 않습니다. 조회·추가·삭제·저장·엑셀은 기본 화면(A1~A3)과 같은 표준 함수로 만듭니다. 원본 스크립트는 `View.vue` 아래쪽에 주석으로 남깁니다.
- **TODO**: 탭(KeepAliveTabs로 나눌 것), 공통코드 선택지, PK 추정값, 셀 표현식, 화면ID·폴더 규칙 위반은 `TODO(nexa2vue)` 주석과 리포트로 표시합니다.
- **변환 내용 문서**: 화면마다 화면ID 이름의 폴더(`docs/<원본 경로>/<화면ID>/`)에 짧은 문서 여러 개로 나눠 만들고, 전체 목록으로 `docs/index.html`, 모든 화면의 API를 모은 `docs/전체_API목록.html`을 만듭니다. 브라우저에서 바로 열어 보면 되고, 문서끼리 링크로 오갑니다(인터넷 연결 없이 열림, 다크 모드 지원).

  ```
  docs/
  ├─ index.html                     전체 화면 목록(화면별 API 개수, 전체 API 목록 링크)
  ├─ 전체_API목록.html              모든 화면의 API(화면 · API · 메서드 · 주소 · 설명)
  └─ <원본 경로>/<화면ID>/
     ├─ 01_개요.html                원본·화면ID·화면명, 변환 방식(AI 시간·사용량), 문서 목록, 만든 파일과 역할, 확인할 것(TODO)
     ├─ 02_변환내용.html            변환 내용(AI 작성 또는 규칙 기반)
     ├─ 03_API목록.html             API마다 메서드·주소·보내는 값/받는 값 개수
     └─ API/<API 이름>.html         API 하나: 주소, 보내는 값(요청), 받는 값(응답)
  ```

  - **변환 내용**: AI로 변환하면 AI가 씁니다(화면 개요, 화면 구성(원본 컴포넌트 → uni 컴포넌트), 스크립트 변환(원본 함수·이벤트 → 변환된 함수), 서버 호출(transaction → Service 함수 → 백엔드), 공통코드·검증, 원본과 달라진 점). AI 없이 변환했거나 AI가 실패한 화면은 규칙 변환 결과(조회조건)로 채웁니다.
  - **API 명세**: API마다 주소, 보내는 방식(쿼리 파라미터 / JSON 객체 / JSON 배열), 보내는 값(이름·형식·필수·설명), 받는 형태(목록 / 단건 / 없음), 받는 값(이름·형식·설명), 프론트 호출 함수, 백엔드 메서드, 원본 Dataset을 적습니다.
    - AI 변환: AI가 코드와 함께 명세를 돌려줍니다(Claude를 따로 부르지 않음). 명세의 호출 함수·주소가 변환된 코드에 실제로 있는지 nexa2vue가 대조하고, 없으면 "⚠ 확인 필요"로 표시하고 확인할 것에 `[검사] API 명세 …`로 남깁니다.
    - 규칙 기반(uni): 원본 Dataset·조회조건으로 추정합니다. 목록 조회는 조회조건이 쿼리 파라미터, 목록 저장은 행 배열(`status` I/U/D + 컬럼)입니다.
    - 주소는 브라우저가 실제로 요청하는 주소입니다. uni는 axios baseURL `/api` + Service `basicUrl` + 함수 경로(= Controller `@RequestMapping` + 메서드 경로, 예: `/api/ua/usr/BAU0101010/findBamn011List`)이고, uni가 아닌 프로젝트는 그 프로젝트의 기본 주소를 붙입니다(모르면 코드에 쓴 주소 그대로 쓰고 "(기본 주소 미확인)"을 붙임).
    - uni가 아닌 프로젝트는 AI가 명세를 준 경우에만 API 문서를 만듭니다(추정하지 않음).
  - **전체 API 목록**: 여러 화면이 같은 메서드·주소를 쓰면 "(같은 주소: A1, B1)"로 알려 줍니다. 이 기능 전에 변환한 화면(리포트에 API 정보 없음)은 따로 표시되고, 다시 변환하면 들어갑니다.
  - **다시 변환할 때**: 그 화면 문서 폴더의 문서와 `API/`를 지우고 새로 씁니다. 그래서 이름이 바뀌거나 없어진 API의 문서가 남지 않습니다. 예전 형식의 한 파일짜리 문서(`docs/<원본 경로>/<화면ID>.html`)도 지웁니다. 화면 설명 캡처(`images/`)는 남깁니다(화면 설명 섹션은 다시 만들어야 함). HTML 버전은 저장 폴더의 기존 문서를 지우지 않습니다.
  - 문서는 `src/` 밖에 있으므로 uni frontend로 화면을 복사할 때 섞이지 않습니다. 결과 목록에서도 열어 볼 수 있습니다.
- 결과는 uni frontend의 `src/views/{대}/{중}/` 아래로 복사해서 씁니다. 이 형식에서는 `UI만 변환` 옵션을 쓰지 않습니다.

### AI로 스크립트까지 변환 (서버 버전)

웹 화면에서는 항상 AI로 변환합니다(Claude가 연결되어 있어야 시작됩니다). CLI에서는 `--ai`를 씁니다. 규칙 기반 초안을 만든 뒤, 이 PC에 설치·로그인된 **Claude Code**(`claude` 명령)가 원본 스크립트까지 uni 방식으로 옮깁니다. 옮기는 대상은 다음과 같습니다.
- onload 초기화 → `onMounted`
- 공통코드 → `commonOptions`·`option-map`
- transaction → Service 함수 + `task.run`
- Dataset 조작 → `data.*`
- 이벤트 핸들러, 입력 검증

- **외부 전송**: 이 옵션을 켜면 해당 화면 소스(.xfdl)가 Anthropic으로 전송됩니다. 켜지 않으면 지금처럼 아무것도 전송하지 않습니다.
- **권한**: Claude에게는 읽기 도구만 줍니다. 읽을 수 있는 범위는 작업 폴더와 uni frontend(규칙 문서·기본 화면 참고용)입니다. 결과 파일은 nexa2vue가 씁니다. 사용자 플러그인·훅·MCP 서버는 불러오지 않습니다.
- **시간**: 화면당 약 1~5분 걸리고, 큰 화면(xfdl 60KB 이상)은 7~10분 넘게 걸리기도 합니다(실측: 중간 복잡도 화면 1개에 약 3분).
  - 화면당 제한 시간은 기본 20분입니다. 웹 화면의 **화면당 AI 제한 시간**, `nexa2vue.config.json`의 `aiTimeout`(분), CLI의 `--ai-timeout <분>`으로 바꿉니다.
  - 제한 시간을 넘으면 그 화면의 Claude Code(와 그것이 띄운 프로세스)를 끝내고 규칙 기반 초안을 저장합니다. TODO에는 `AI 변환 시간 초과(20분)`처럼 실제 이유가 남습니다.
- **동시 진행**: 화면마다 따로 Claude Code 세션을 띄워 **여러 화면을 동시에** 변환합니다.
  - 동시에 변환하는 화면 수는 기본 3개이고 최대 8개입니다. 웹 화면의 **동시에 변환할 화면 수**, `nexa2vue.config.json`의 `aiParallel`, CLI의 `--ai-parallel <개수>`로 정합니다.
  - 동시 개수를 늘리면 빨라지지만, Claude 구독 사용량 한도에 그만큼 빨리 닿습니다.
  - 진행 상황에는 지금 AI가 변환 중인 화면 목록이 나옵니다. 결과 목록과 리포트는 끝난 순서와 상관없이 원본 순서로 정리됩니다.
- **실패 처리**: AI 변환에 실패한 화면은 규칙 기반 초안을 저장하고, 실패 이유를 TODO로 남깁니다. AI가 옮기지 못한 것(정의를 모르는 `gfn_*`, 팝업·다른 화면 호출 등)은 `TODO(nexa2vue)` 주석과 리포트의 `[AI]` 항목으로 남습니다.
- **컴포넌트 사용 검사** (uni와 uni가 아닌 Vue 프로젝트 모두): 변환 결과의 .vue가 프로젝트 컴포넌트를 화면이 열리지 않게 쓴 곳을 찾습니다.
  - 잡는 것: 필수 prop이 빠짐(예: `Field`에 `item`·`model` 없음), model prop이 없는 컴포넌트에 `v-model`을 씀, 배럴(`index.js`)에 없는 이름을 가져옴, 프로젝트에 없는 컴포넌트 파일을 가져옴.
  - import는 프로젝트가 찾는 방식 그대로 따라갑니다: `jsconfig`·`tsconfig`의 `paths`, `vite.config`의 alias(없으면 `@` → `src`), 상대 경로, `export *`·`export { default as X }` 배럴.
  - props는 `<script setup>`의 `defineProps`·`defineModel`(JS·TS 모두: `defineProps<{ … }>()`, `interface Props`, `withDefaults`)과 Options API의 `props: { … }`에서 읽습니다.
  - 잡지 않는 것: 선언되지 않은 속성(`class` 등, 루트 요소로 넘어감), 패키지(element-plus 등) 컴포넌트, 전역 등록 컴포넌트, props를 다른 곳에서 가져와 만든 컴포넌트, `views`·`pages`·`screens` 아래의 없는 파일(같은 변환의 다른 화면일 수 있음).
  - **바로 고치기**(기본 켜짐): 검사에 걸리면 걸린 파일, 문제 목록, 해당 컴포넌트 선언, 배럴에 실제로 있는 이름을 Claude에 한 번 더 보내 그곳만 고치게 합니다. 같은 화면의 다른 파일도 함께 보냅니다(합쳐서 4만 자까지). 그 뒤 다시 검사합니다. 걸린 화면만 Claude를 한 번 더 부릅니다(실측: uni 화면 Field 1곳, $0.36·70초, 1줄만 바뀜). 끄려면 웹 화면에서 체크를 해제하거나 CLI에 `--no-ai-fix`를 붙입니다. 결과는 리포트 `ai.fix`에 남습니다.
  - 그래도 남으면 AI 결과는 저장하되 그 화면을 **AI 실패**로 표시합니다(리포트 `ai.checks`, TODO `[검사] 파일:줄`). 아래 다시 변환 때 무엇이 틀렸는지 AI에 알려 줍니다.
  - AI를 쓰지 않았거나 AI가 실패해서 규칙 기반 초안을 저장할 때도 같은 검사를 하고, 걸린 곳은 TODO `[검사] 초안 파일:줄`로 남깁니다.
- **AI 실패한 화면만 다시 변환**: 사용 한도·시간 초과 등으로 AI가 실패한 화면만 골라 다시 돌립니다. 폴더 전체를 처음부터 다시 변환할 필요가 없습니다.
  - 웹 화면: 지난번과 **같은 입력·출력 폴더**를 넣고 **AI 실패한 화면만 다시 변환**을 누릅니다. 화면 검토는 필요 없습니다.
  - CLI: `node bin/nexa2vue.js --in <입력> --out <같은 출력> --retry-failed` (`--profile uni --ai`가 함께 켜집니다)
  - 대상은 출력 폴더의 `_nexa2vue-report.json` 기준으로 정합니다. AI가 실패한 화면, 변환 자체가 실패한 화면, 지난번에 끝까지 못 간 화면(취소·새로 추가)이 대상입니다. 하위 화면은 부모 화면과 함께 다시 변환합니다.
  - 화면 종류(화면·하위 화면·팝업)와 출력 이름은 지난 변환 것을 그대로 써서, 같은 파일을 덮어씁니다. 나머지 화면 파일은 건드리지 않습니다.
  - 리포트, `docs/index.html`, `docs/전체_API목록.html`은 전체 화면 기준으로 다시 씁니다. 다시 변환한 화면은 리포트의 `retry.units`에 남습니다.
  - 다시 변환할 화면이 없거나, 지난 변환이 드라이런이었거나, 입력 폴더가 다르면 시작하지 않고 알려 줍니다.
- **설정**: 모델은 Claude Code 기본값을 씁니다. `nexa2vue.config.json`의 `aiModel` 또는 CLI `--ai-model`로 바꿀 수 있고, `claude` 경로는 `claudePath`로 지정합니다.
- **변환 규칙 스킬**: 변환 규칙을 Claude Code 스킬(`SKILL.md`가 있는 폴더)로 넘길 수 있습니다.
  - 지정하는 곳: 웹 화면의 **변환 규칙 스킬 폴더**, `nexa2vue.config.json`의 `aiSkill`, CLI의 `--ai-skill <폴더>` 중 하나
  - 웹 화면의 기본 스킬 폴더는 `사용자 폴더\.nexa2vue\skills`입니다. 구조 파악이 만든 요약 스킬(`vue-convert`)이 여기에 생기고, 직접 만든 스킬도 폴더째(`<이름>\SKILL.md`) 넣으면 다음 변환부터 목록에 체크된 채로 나옵니다. 지금의 frontend·backend와 다른 폴더로 만든 요약 스킬은 목록에는 나오지만 체크되지 않습니다.
    - 요약 스킬에는 프로젝트의 서버 호출 방식(실제 요청 주소가 만들어지는 방식, 메서드별로 값을 넘기는 방식, 응답 모양)이 따로 정리되어 API 명세에 쓰입니다. 고정 변환 규칙 스킬이 정하는 내용(영역 나누기, 버튼, 탭 등)은 요약 스킬에 넣지 않습니다.
    - 요약 스킬 머리말에는 만든 방식의 버전(`generator-version`)이 들어갑니다. nexa2vue가 스킬 만드는 방식이 바뀌어 예전 버전으로 만든 스킬이면 웹 화면에 **다시 만들기를 권장**한다고 나옵니다(그 스킬도 계속 씁니다). 다시 만들려면 `사용자 폴더\.nexa2vue\skills\vue-convert`를 지우고 구조 파악에서 다시 만듭니다.
  - **스킬이 여러 개인 폴더**(`.claude\skills`처럼 스킬마다 하위 폴더가 있는 곳)도 됩니다.
    - 웹 화면: 폴더를 넣고 **스킬 목록**을 누르면 그 아래 스킬이 이름·설명과 함께 체크박스로 나옵니다. 체크한 스킬만 적용합니다. 스킬 하나짜리 폴더는 그 스킬이 체크된 채로 나옵니다.
    - 폴더를 넣고 스킬을 하나도 고르지 않으면 변환을 시작하지 않습니다. 기본 규칙만 쓰려면 폴더 칸을 비우세요.
    - CLI: `--ai-skill`을 여러 번 씁니다. 예: `--ai-skill C:\...\skills\screen-convert --ai-skill C:\...\skills\screen-summary`
    - 설정 파일: `"aiSkill": ["C:\\...\\skills\\screen-convert", "C:\\...\\skills\\screen-summary"]` 처럼 배열도 받습니다(문자열 하나도 그대로 됩니다). CLI에서 `--ai-skill`을 주면 설정 파일 값 대신 씁니다.
    - CLI·설정 파일에는 스킬 폴더를 하나씩 적습니다. 상위 폴더를 적으면 어떤 스킬이 있는지 알려 주고 멈춥니다.
    - 여러 개면 고른 순서(웹 화면은 목록 순서)대로 들어가고, 스킬끼리 다르면 앞의 스킬을 따릅니다.
  - 스킬 본문은 변환 규칙으로 맨 앞에 들어갑니다. 스킬 폴더의 참고 파일은 Claude가 읽을 수 있습니다.
  - 스킬이 정하지 않은 부분만 nexa2vue의 기본 규칙을 따릅니다. 스킬을 지정하지 않으면 기본 규칙만 씁니다.
  - 변환에는 nexa2vue에 들어 있는 **고정 변환 규칙 스킬**이 늘 들어갑니다. `skills/nexa2vue-rules/SKILL.md`는 어느 Vue 프로젝트에나 맞는 원칙(Div 영역을 합치거나 쪼개지 않기, 원본에 없는 버튼·제목 만들지 않기, 그리드 칸 팝업은 그 칸에 두기, 컴포넌트는 선언대로 쓰기)이라 uni가 아닌 프로젝트에도 들어갑니다. `skills/nexa2vue-rules-uni/SKILL.md`는 그 원칙을 uni 컴포넌트로 지키는 방법(SearchSection, custom 칸 selector-box, Field, ButtonGroup, `#body-cell` + q-btn)이라 uni 변환에만 들어갑니다. 구조 요약 스킬이 없어도 들어갑니다. 스킬끼리 규칙이 다르면 **직접 추가한 스킬 → 고정 규칙 스킬 → 구조 파악이 만든 요약 스킬(vue-convert)** 순서로 앞의 것을 따릅니다. 규칙을 고치려면 이 파일만 고치면 되고 구조 파악을 다시 할 필요는 없습니다(예전에 만든 요약 스킬 안의 옛 규칙 절은 변환할 때 빼고 씁니다).
  - 스킬 경로가 잘못되면 변환을 시작하기 전에 알려줍니다.
- **HTML 버전**: 웹 페이지에서는 PC의 프로그램을 실행할 수 없어서 HTML 버전에서는 AI 변환을 할 수 없습니다.

### uni 스타일 미리보기

uni 형식에서 **uni 스타일 미리보기 함께 생성** 옵션을 켜면 됩니다. CLI에서는 `--viewer`와 `--uni-frontend <경로>`를 씁니다. 변환한 화면을 uni 프로젝트에 넣지 않고도 uni의 공통 컴포넌트와 스타일로 띄워 볼 수 있습니다.

```bat
node bin\nexa2vue.js --in C:\work\nexa --out C:\work\nexa_vue --profile uni --viewer --uni-frontend C:\uni_averedu\frontend
cd /d C:\work\nexa_vue
view-screens.cmd
```

- **uni 쪽 그대로 사용**: `@/components`, `@/utils`, Quasar, KRDS 스타일, 글꼴, `ContentLayout`을 uni frontend에서 직접 가져옵니다.
  - 패키지도 uni frontend에 설치된 것을 그대로 씁니다. 그래서 **npm install이 필요 없고 하지도 않습니다**.
  - uni frontend에는 아무것도 쓰지 않습니다. Vite 캐시는 출력 폴더의 `.vite-cache`에 생깁니다.
- **실행**: 브라우저에서 http://127.0.0.1:5174 가 열리면 왼쪽 목록에서 화면을 고릅니다.
- **샘플 데이터**: 백엔드 없이 띄우기 때문에 API는 가짜 응답을 돌려줍니다. 조회하면 각 화면 Constant의 컬럼·폼 정의로 만든 샘플 데이터(5행)가 나오고, 저장은 성공으로 처리합니다.
- **경로 변경**: uni frontend 경로는 출력 폴더의 `uni-preview.config.json`에서 바꿀 수 있습니다. 그 경로의 uni frontend에는 `npm install`이 되어 있어야 합니다.
- **차이**: 앱 구성은 uni의 `src/main.js`와 같은 순서로 스타일과 플러그인을 올립니다. 다만 라우터, 로그인, 사이트 설정은 빼서 실제 메뉴 화면과는 조금 다를 수 있습니다.

## 출력 구조

```
<출력>/
├─ src/views/<원본 경로>/<화면>.vue        화면 (template + script setup)
├─ src/api/<원본 경로>/<화면>.js           transaction() → API 함수 스텁
├─ src/utils/nexa-compat.js                Dataset/transaction 등 런타임 헬퍼
├─ src/utils/nexa-gfn.js                   공통 함수 (변환된 .xjs re-export + 미구현 스텁)
├─ src/utils/nexa-lib/<원본 경로>.js       .xjs 변환 결과
└─ _nexa2vue-report.json                   파일별 상태, TODO, 구현 필요 함수
```

결과물을 쓰는 Vue 프로젝트에서 `app.use(ElementPlus)`로 Element Plus를 전역 등록해야 합니다. 또 `nexa-compat.js`의 `config.resolveUrl`과 `config.request`를 실제 백엔드에 맞게 수정해야 합니다.

## 변환 규칙

| 넥사크로 | Vue |
|---|---|
| 절대좌표(left/top/width/height/right/bottom) | `position:absolute` 스타일 그대로 유지 |
| Static / Button / Edit / MaskEdit / TextArea / Spin / Calendar | `span` / `el-button` / `el-input` / `el-input-number` / `el-date-picker` |
| Combo / Radio (innerdataset) | `el-select` + `el-option` / `el-radio-group` + `el-radio` |
| CheckBox (truevalue/falsevalue) | `el-checkbox` |
| Div / Tab·Tabpage / GroupBox | `div` / `el-tabs`·`el-tab-pane` / `fieldset` |
| Grid (Format head/body band, `bind:COL`) | `el-table` + `el-table-column` |
| Dataset | `ref([...행])` |
| Bind | `v-model="ds[0].COL"` (0번째 행 기준) |
| `this.ds.getColumn/setColumn/addRow/...` | `nexa.ds.getColumn(ds, ...)` 등 |
| `this.comp.set_xxx(v)` / `.value` / `.enable` | `comp.<id>.xxx` (반응형 상태) |
| `this.transaction(...)` (리터럴 인자) | `nexa.transaction(..., api.<svcId>, ...)` + API 스텁 |
| `this.gfn_*()` / `include` 라이브러리 함수 | `gfn.<name>()` |
| `this.alert / confirm`, `trace` | `window.alert / confirm`, `console.log` |
| onclick / onchanged / onitemchanged / oncellclick 등 | `@click` / `@change` / `@cell-click` 등 |
| Form `onload` | `onMounted` |

인코딩은 UTF-8(BOM 포함)과 EUC-KR을 자동으로 감지합니다.

### 자동 변환되지 않는 것 (TODO로 표시)

- 지원 목록에 없는 Dataset 메서드(`filter`, `sort` 등)와 컴포넌트 메서드
- `this.parent`, `this.go`, `this.close` 같은 폼 프레임워크 API
- 동적 인자를 쓰는 `transaction()`
- 상대 위치(`btn_a:10`)
- Grid 셀 표현식
- 지원하지 않는 컴포넌트(WebBrowser 등)
- 핸들러 첫 인자 `obj`의 메서드 호출(`obj.set_text()`)

### 사용자 정의 컴포넌트 매핑

입력 폴더 최상위에 `nexa2vue.config.json`을 두면 컴포넌트 매핑을 추가하거나 덮어쓸 수 있습니다.

```json
{
  "componentMap": {
    "MyCodeEdit": { "tag": "my-code-input", "model": true, "disable": true },
    "ImageViewer": { "tag": "el-image" }
  }
}
```

## uni 프론트·백엔드 구조 파악과 백엔드 생성

uni 형식을 고르면 frontend·backend 경로(선택 버튼으로 폴더 지정)와 **구조 파악** 버튼이 나옵니다.

- 변환할 때마다 두 프로젝트를 읽지 않습니다. **구조 파악**을 누를 때 한 번만 읽습니다.
  - 프론트: API 접두어(`src/utils/infra/api.js`의 baseURL), 화면 규칙 문서, 기준 화면 `CCU0297xxx`
  - 백엔드: 기본 패키지(`@SpringBootApplication` 클래스), `CommonDto`, 규칙 문서(`SCREEN_CONVENTION.md` 등), 기준 화면
- 결과는 `%USERPROFILE%\.nexa2vue\uni-structure.json`에 저장되고, 다음 실행부터 두 경로의 기본값이 됩니다.
- 화면의 경로가 파악한 경로와 같으면 버튼이 꺼지고, 경로를 바꾸면 다시 켜집니다. 경로가 바뀐 상태에서는 변환을 시작하지 않습니다.
- backend 경로를 채우고 파악하면, 화면마다 백엔드 표준(`SCREEN_CONVENTION.md`) 모양으로 다섯 파일을 출력 폴더의 `backend/` 아래에 만듭니다.
  - 파일: `src/main/java/{패키지}/{대}/{중}/controller·service·mapper·dto/{화면ID}…java`, `src/main/resources/mapper/{대}/{중}/{화면ID}Mapper.xml`
  - 메서드 이름은 프론트 `Service.js`의 API 이름(`find…List`, `save…List`, `find…Info`, `save…Info`)과 같습니다.
  - 테이블은 Dataset 토큰(`ds_bamn011` → `UNI.BAMN011`), 컬럼은 Dataset 컬럼, 키는 추정값입니다. 추정한 곳마다 `<!-- TODO: … -->`를 남깁니다.
- AI 변환을 켜면 AI가 백엔드 규칙 문서와 기준 화면도 읽고, 프론트와 함께 백엔드 초안을 다듬습니다.
- 두 프로젝트에는 아무것도 쓰지 않습니다. 결과를 확인한 뒤 각 프로젝트로 복사해서 씁니다.

## 보안

- 서버는 `127.0.0.1`에만 바인딩합니다. Host와 Origin 헤더를 검사해 DNS 리바인딩과 다른 사이트에서 오는 요청을 막습니다.
- 변경 요청은 `application/json`만 받습니다(폼 CSRF 차단).
- 소스 읽기는 고른 입력 폴더 안에서만 합니다. 심볼릭 링크는 따라가지 않습니다.
- 출력 파일은 지정한 출력 폴더 안에만 씁니다(경로 탈출 차단).
- 파일 내용은 화면에 텍스트(`textContent`)로만 표시합니다.

## 테스트

```bash
npm test
```

테스트 fixture(`test/fixtures/`)는 모두 가상으로 작성한 샘플입니다.
