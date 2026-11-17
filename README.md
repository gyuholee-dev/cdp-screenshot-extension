# cdp-screenshot-extension

cdp-screenshot-extension은 Chrome DevTools Protocol(CDP)로 웹 페이지를 캡처하는 도구입니다. 화면에 보이는 부분만 찍는 데 그치지 않고, 스크롤 영역을 모두 펼쳐 **페이지 전체**를 한 장으로 담거나 마우스로 고른 **요소**만 정확히 잘라 낼 수 있습니다. 캡처 코드는 실행 환경에 의존하지 않는 모듈(`core`)로 분리되어 있어서 **Chrome 확장 프로그램**과 **Electron 앱**이 같은 코드를 함께 씁니다.

- [소개](#소개)
- [요구사항](#요구사항)
- [설치](#설치)
- [사용법](#사용법)
- [설계와 구조](#설계와-구조)
- [Electron 연동](#electron-연동)
- [알려진 문제와 한계](#알려진-문제와-한계)
- [라이선스](#라이선스)

## 소개

### 핵심 기능

| 캡처 | 설명 |
|---|---|
| **화면 캡처** | 지금 화면에 보이는 영역을 그대로 찍습니다. |
| **전체 캡처** | 문서 전체를 한 장으로 찍습니다. 앱처럼 내부 컨테이너가 스크롤되는 페이지도 스크롤 영역을 모두 펼쳐서 찍습니다. |
| **요소 캡처** | 페이지에서 클릭한 요소만 찍습니다. 화면 밖으로 넘치는 요소나 내부에서 스크롤되는 요소도 잘리지 않습니다. |

### 특징

- **CDP로 직접 제어합니다.** 확장은 `chrome.debugger`, Electron은 `webContents.debugger`를 통해 CDP에 연결해 페이지를 캡처합니다. 페이지에 콘텐츠 스크립트를 상주시키지 않으며, 캡처가 끝나면 뷰포트 크기, 스크롤 위치, 스타일을 모두 원래대로 되돌립니다.
- **스크롤 영역을 펼쳐서 찍습니다.** 문서 스크롤뿐 아니라 앱처럼 내부 컨테이너가 스크롤되는 레이아웃이나 스크롤 영역이 여러 겹으로 중첩된 구조도 영역마다 펼쳐서 한 장으로 만듭니다.
- **요소를 잘림 없이 찍습니다.** 화면 밖으로 넘치는 요소, 내부에서 스크롤되는 요소, 조상 요소에 잘리는 요소도 전체가 온전히 찍힙니다.
- **Chrome 확장과 Electron이 같은 코드를 씁니다.** 캡처 코드(`core`)는 `chrome.*`, `electron`, DOM에 의존하지 않으며, 어댑터는 CDP 연결만 제공합니다. Electron 앱에서는 `adapter-electron`을 불러와 `webContents`만 넘기면 확장과 똑같은 캡처 기능을 쓸 수 있습니다.
- **결과만 반환합니다.** 캡처 함수는 이미지 바이트와 크기만 반환하고, 파일 저장, 클립보드 복사, 창 제어는 이를 사용하는 쪽(호스트)이 처리합니다.

## 요구사항

| 용도 | 요구사항 |
|---|---|
| 확장 프로그램 사용 | Chrome 141 이상 (사이드 패널을 닫는 API가 필요합니다) |
| 테스트 실행, 개발 | Node.js 20 이상, yarn 1.22 이상 |
| Electron 연동 | 메인 프로세스에서 `webContents.debugger`를 사용할 수 있는 Electron (샘플은 Electron 44 기준) |

루트 패키지에는 의존성이 없습니다. 테스트 페이지 서버(`yarn serve`)를 실행하려면 Python 3이 필요합니다.

## 설치

### Chrome 확장 프로그램

1. 저장소를 내려받습니다.

   ```bash
   git clone https://github.com/gyuholee-dev/cdp-screenshot-extension.git
   ```

2. Chrome에서 `chrome://extensions`를 열고 오른쪽 위의 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누른 뒤, 저장소 **루트 폴더**(`manifest.json`이 있는 폴더)를 선택합니다. 별도로 빌드하거나 파일을 복사할 필요는 없습니다.
4. 확장 목록에 오류 없이 표시되고 툴바에 카메라 아이콘이 보이면 설치가 완료된 것입니다.

코드를 수정했거나 `git pull`로 저장소를 업데이트했다면 확장 카드의 **새로고침** 버튼을 누르세요. 컨텍스트 메뉴와 단축키는 확장을 설치하거나 브라우저를 시작할 때 등록되므로, 변경한 뒤에는 반드시 새로고침해야 반영됩니다.

> 이 확장은 `debugger` 권한으로 모든 탭에 연결할 수 있습니다. 평소 사용하는 프로필 대신 별도의 Chrome 프로필이나 Chrome for Testing에서 사용하는 것을 권장합니다.

### 설치 확인 (선택)

```bash
cd cdp-screenshot-extension
yarn test
```

단위 테스트가 모두 통과하는지 확인할 수 있습니다. 가짜 CDP를 사용하므로 Chrome도, `yarn install`도 필요하지 않습니다.

## 사용법

### 패널 열기

툴바의 카메라 아이콘을 누르거나 `Alt+Shift+S`를 누르면 사이드 패널이 열리고, 한 번 더 누르면 닫힙니다. 패널 위쪽의 버튼으로 캡처할 수 있고, 톱니바퀴 버튼을 누르면 환경설정 화면이 열립니다.

### 캡처하기

| 방법 | 화면 캡처 | 전체 캡처 | 요소 캡처 |
|---|---|---|---|
| 패널 위쪽 버튼 | `화면 캡처` | `전체 캡처` | `요소 캡처` |
| 단축키 | `Alt+Shift+1` | `Alt+Shift+2` | `Alt+Shift+3` |

컨텍스트 메뉴로도 캡처할 수 있습니다. 웹 페이지에서 마우스 오른쪽 버튼을 누르고 `CDP Screenshot` 아래의 `화면 캡처`, `전체 캡처`, `요소 캡처` 중 하나를 선택하세요.

위 이름은 한국어 화면 기준입니다. 영어 화면에서는 패널 위쪽 버튼이 `Screen`, `Full`, `Element`로, 메뉴 항목이 `Screen capture`, `Full capture`, `Element capture`로 표시됩니다.

- 단축키는 `chrome://extensions/shortcuts`에서 변경할 수 있습니다.
- 컨텍스트 메뉴는 웹 페이지(`http`, `https`, `file`)에서만 표시되며, 사이드 패널 안에서는 표시되지 않습니다. 사이드 패널을 열 수 없는 팝업 창에서는 메뉴나 단축키로 캡처하면 되고, 결과는 일반 창의 패널 기록에 추가됩니다.
- `chrome://` 같은 Chrome 내부 페이지와 웹 스토어는 캡처할 수 없습니다. 이런 페이지에서는 패널의 캡처 버튼이 비활성화되고, 단축키와 메뉴도 동작하지 않습니다.

### 요소 캡처

1. 요소 캡처를 시작하면 마우스 포인터가 가리키는 요소가 페이지에서 강조 표시됩니다.
2. 캡처할 요소를 클릭합니다.
3. 취소하려면 `Esc` 키나 패널의 **취소** 버튼을 누르세요. 다른 탭, 창, 앱으로 전환하거나 다른 페이지로 이동해도 취소됩니다. 버튼, 단축키, 메뉴 중 어떤 방법으로 시작했든 똑같이 동작합니다. 60초 안에 요소를 선택하지 않으면 자동으로 취소됩니다.

### 캡처 기록

캡처한 이미지는 패널에 카드 형태로 쌓이며, 가장 최근 카드가 맨 위에 표시됩니다. 카드에는 사이트 주소(누르면 해당 페이지가 열립니다), 캡처 종류와 크기, 날짜가 표시됩니다.

- **복사**: 이미지를 클립보드에 복사합니다. 캡처할 때 자동으로 복사되지는 않습니다.
- **저장**: 이미지를 파일로 저장합니다.
- **삭제**: 카드를 기록에서 삭제합니다.

### 환경설정

항목 이름은 한국어 화면 기준이며, 영어 화면에서는 같은 위치에 영어로 표시됩니다. 값을 바꾸면 즉시 적용됩니다. `저장` 버튼을 누르면 모든 항목을 한 번에 저장하고 메인 화면으로 돌아가며, `기본설정` 버튼을 누르면 모든 항목이 기본값으로 초기화됩니다.

| 항목 | 설명 | 기본값 |
|---|---|---|
| 이미지 형식 | PNG, JPEG, WebP 중에서 선택합니다. | PNG |
| 스크롤 탐색 깊이 | 스크롤 영역을 몇 단계 안쪽까지 탐색할지 정합니다. 전체 캡처에서는 `body`가, 요소 캡처에서는 선택한 요소가 0단계입니다. 스크롤 영역이 여러 겹으로 중첩된 앱 화면에서 전체 캡처가 잘린다면 값을 높이세요. | 5 |
| 캡처 지연시간 | 캡처 직전에 기다리는 시간(ms)입니다. 늦게 로딩되는 이미지나 애니메이션이 캡처 결과에서 빠진다면 값을 늘리세요. | 250 |
| 캡처 후 동작 | `기록에만 남기기`와 `지정한 폴더에 저장` 중에서 선택합니다. | 기록에만 남기기 |
| 파일 저장 경로 | 파일을 저장할 폴더입니다. 지정하지 않으면 Chrome의 다운로드 폴더에 저장됩니다. 브라우저를 다시 시작하면 폴더 접근 권한을 다시 허용해야 할 수도 있습니다. | 다운로드 |
| 썸네일 사이즈 | 기록 카드에 표시되는 이미지의 최대 너비(px)입니다. | 330 (256~1024) |
| 기록 보관 일수 | 이 기간이 지난 기록은 자동으로 삭제됩니다. 0으로 설정하면 삭제하지 않고 계속 보관합니다. | 30 |
| 캡처 효과 | 플래시와 가장자리 강조를 각각 켜고 끌 수 있으며, 모양은 CSS 속성값으로 변경할 수 있습니다. `테스트` 버튼을 누르면 현재 탭에서 효과를 미리 볼 수 있고, `기본값` 버튼을 누르면 처음 모양으로 되돌아갑니다. 캡처에 실패했을 때의 효과는 빨간색으로 고정되어 있습니다. | 켜짐 |

## 설계와 구조

### 설계 원칙

- **`core`는 실행 환경을 알지 못합니다.** `chrome.*`, `electron`, DOM을 직접 사용하지 않으며, `core`를 사용하는 쪽(확장이나 앱, 이하 *호스트*)이 `cdp` 객체를 넘겨줍니다. 그래서 확장과 Electron에서 같은 코드로 같은 결과를 얻을 수 있습니다.
- **캡처가 끝나면 항상 원래 상태로 되돌립니다.** 성공하든 실패하든 뷰포트 크기, 변경한 스타일, 스크롤 위치, 강조 표시를 `finally`에서 복구합니다.
- **저장, 클립보드, 창 제어는 호스트가 담당합니다.** `core`와 어댑터는 이미지 바이트와 크기만 반환합니다.

### 파일 구조

```
manifest.json            확장 매니페스트(저장소 루트가 곧 확장 폴더)
_locales/                확장 문구 (en: 기본, ko)
core/                    환경 독립 캡처 모듈 (순수 ESM)
  capture.js             captureViewport / captureFull / captureNode / captureElement
  expand.js              스크롤 영역 펼치기, 큰 요소 맞추기, 줌 보정
  scripts.js             페이지 안에서 실행되는 함수
  pick.js                요소 선택 (Overlay 검사 모드)
  geometry.js            요소 clip 계산
  util.js                옵션, 세션, 캡처 직전 대기, 이미지 크기 읽기
  errors.js              CaptureError와 오류 코드
adapter-chrome/          chrome.debugger 어댑터
adapter-electron/        webContents.debugger 어댑터 (electron을 import하지 않음)
extension/               확장 UI와 로직 (서비스 워커, 사이드 패널, 기록 저장소 등)
examples/electron-sample 샘플 Electron 앱
test/                    단위 테스트와 테스트 페이지(fixtures)
```

외부에 공개하는 모듈은 `./core`와 `./adapter-electron` 두 개뿐이며, `package.json`의 `files`에도 `core`와 `adapter-electron`만 포함되어 있습니다. `adapter-electron/index.js`는 `../core/index.js`를 상대 경로로 불러오므로 두 폴더가 반드시 함께 있어야 합니다.

### core 인터페이스

`core`의 캡처 함수는 호스트가 만든 `cdp` 객체를 첫 번째 인자로 받습니다.

```js
cdp.send(method, params)   // → Promise<결과>   CDP 명령 전송
cdp.on(event, handler)     // → 구독 해제 함수  CDP 이벤트 구독
// 디버거 연결이 끊기면 cdp.on('detach', ...)으로 구독한 핸들러가 호출되어야 합니다.
```

| 함수 | 설명 |
|---|---|
| `captureViewport(cdp, options)` | 화면에 보이는 영역을 캡처합니다. |
| `captureFull(cdp, options)` | 스크롤 영역을 펼쳐서 전체를 캡처합니다. |
| `captureNode(cdp, target, options)` | 이미 지정된 요소를 캡처합니다. `target`에는 `backendNodeId`(숫자), CSS 선택자 문자열, `{ selector }`, `{ backendNodeId }` 중 하나를 넘깁니다. |
| `pickNode(cdp, options)` | 사용자가 클릭해서 선택한 요소의 `{ backendNodeId }`를 반환합니다. |
| `captureElement(cdp, options)` | `pickNode`로 요소를 선택한 뒤 `captureNode`로 캡처합니다. |
| `captureByKind` | `viewport`, `full`, `element` 이름으로 위 캡처 함수를 찾는 객체입니다. `captureByKind[kind](cdp, options)`처럼 씁니다. |

캡처 함수는 `{ bytes: Uint8Array, mime, width, height }`를 반환합니다. 요소 캡처의 결과에는 캡처한 요소를 가리키는 `target: { backendNodeId }`도 포함됩니다. 파일 저장, 클립보드 복사, 다운로드는 호스트가 처리합니다.

**옵션**

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `depth` | 5 | 스크롤 영역을 탐색하는 깊이 (요소 캡처에서는 선택한 요소가 0) |
| `format` | `'png'` | `'png'`, `'jpeg'`, `'webp'` 중 하나 |
| `quality` | 90 | JPEG, WebP 품질 |
| `settleMs` | 250 | 캡처 직전에 기다리는 시간(ms) |
| `maxSidePixels` | 16384 | 결과 이미지의 한 변 최대 길이(px). 초과하면 `TOO_LARGE` 오류 |
| `pickTimeoutMs` | 60000 | 요소 선택 제한 시간(ms). 초과하면 `TIMEOUT` 오류 |
| `signal` | - | `AbortSignal`. 중단하면 요소 선택이 `CANCELED`로 끝남 |
| `reportProgress` | - | 진행 단계 콜백 `({ stage })`. `stage`는 `'pick'`, `'expand'`, `'capture'` 중 하나 |

**오류**

캡처 중 문제가 발생하면 `CaptureError`가 발생하며, `error.code`로 오류 종류를 구분합니다. `error.message`는 개발자용 영어 메시지이므로 사용자 화면에 그대로 노출하지 말고, `code`별로 준비한 문구를 보여 주세요.

| 코드 | 의미 | `details` |
|---|---|---|
| `TOO_LARGE` | 결과가 `maxSidePixels`를 초과함 | `{ maxSide }` |
| `NO_ELEMENT` | 요소를 찾지 못했거나 요소가 화면에 렌더링되지 않음 | |
| `CANCELED` | 요소 선택이 취소됨 (Esc, `signal` 등) | |
| `TIMEOUT` | 요소 선택 시간이 초과됨 | `{ pickTimeoutMs }` |
| `DETACHED` | 캡처 도중 디버거 연결이 끊김 | |
| `NOT_ATTACHABLE` | 디버거를 연결할 수 없음 (다른 디버거가 이미 연결되어 있거나 보호된 페이지) | |
| `INVALID_OPTION` | 옵션 값이 올바르지 않음 | |
| `CDP_ERROR` | 그 밖의 CDP 오류 | |

### 캡처 동작 방식

- **화면 캡처**는 `Page.captureScreenshot`으로 보이는 영역을 그대로 찍습니다.
- **전체 캡처**는 다음 순서로 진행됩니다.
  1. `depth` 범위 안에서 스크롤 영역을 찾습니다. `overflow-y`가 `auto`나 `scroll`이면서 실제로 가려진 부분이 있는 요소만 대상으로 하며, 숨겨진 요소, `display: contents` 요소, 크기가 0인 요소는 제외합니다.
  2. 뷰포트를 키워 스크롤 영역을 펼칩니다. 뷰포트를 키웠을 때 영역마다 반응이 다릅니다. 나란히 놓인 열은 함께 늘어나고, 위아래로 나뉜 영역은 늘어난 높이를 나눠 가지며, 높이가 고정된 영역은 늘어나지 않습니다. 그래서 영역별로 가려진 부분이 줄었는지 따로 확인하고, 늘어나지 않는 영역에는 `overflow: visible; height: auto`를 임시로 적용합니다.
  3. 문서 스크롤은 뷰포트를 콘텐츠 높이만큼 키운 뒤 찍습니다. `captureBeyondViewport`로 한 번에 찍으면 같은 화면이 반복해서 이어 붙는 경우가 있기 때문입니다.
  4. 캡처가 끝나면 변경한 내용을 모두 원래대로 되돌립니다.
- **요소 캡처**는 `Overlay` 검사 모드로 요소를 선택한 뒤, `DOM.getBoxModel`로 요소의 위치를 구해 해당 영역만 잘라 냅니다. 요소가 화면보다 크면 요소 높이에 맞춰서만 뷰포트를 키웁니다. 요소를 잘라 내는 조상 요소의 `overflow`는 캡처하는 동안에만 해제하고, 요소 내부의 스크롤 영역도 펼칩니다.
- **브라우저 줌**이 100%가 아니면 `clip` 값을 보정합니다. CDP의 `clip`은 CSS px이 아니라 줌 배율이 반영된 값이기 때문입니다(Chrome에서 90%와 125%로 확인했습니다).

### 확장 프로그램 구조

- **서비스 워커**: 메뉴, 단축키, 캡처 실행, 요소 선택 취소 감지, 화면 효과 재생을 담당합니다.
- **사이드 패널**: 캡처 버튼, 알림 영역, 기록 카드 목록, 환경설정 화면으로 구성됩니다.
- **기록 저장소**: 이미지(Blob)와 메타데이터를 IndexedDB에 저장하고, 보관 기간이 지난 항목을 삭제합니다. 설정은 `chrome.storage.local`에 저장합니다.
- **문구**: `_locales/<언어>/messages.json`에 있으며 `chrome.i18n`으로 불러옵니다. 새 언어를 추가하려면 영어(`en`)와 같은 키로 `_locales/<언어>/messages.json`을 만드세요. 키와 `{자리표시자}`가 영어 파일과 일치하는지는 테스트에서 검사합니다.
- **권한**: `debugger`(캡처), `downloads`(저장), `storage`와 `unlimitedStorage`(설정과 기록), `sidePanel`, `contextMenus`를 사용합니다. 데이터를 네트워크로 전송하지 않습니다.

### 테스트

```bash
yarn test     # 가짜 CDP 기반 단위 테스트
yarn serve    # 테스트 페이지 서버: http://localhost:8080/
```

단위 테스트는 CDP 호출 순서, 오류 복구, 설정, 기록, 알림 로직을 검사합니다. 다만 **실제 렌더링 결과는 검증할 수 없으므로**, `yarn serve`로 테스트 페이지(`test/fixtures`)를 열고 확장으로 직접 캡처해 보며 확인해야 합니다.

| 테스트 페이지 | 확인하는 내용 |
|---|---|
| `fixed-main` | 헤더·푸터가 고정되고 `main`만 스크롤되는 레이아웃 |
| `multi-scroll` | 여러 개의 스크롤 영역과 중첩 구조 (깊이 테스트) |
| `exclusions` | 숨겨진 요소, `display: contents`, 크기가 0인 요소 |
| `rounding` | 1px 오차 |
| `long` | 높이 20000px 페이지 (`TOO_LARGE`) |
| `doc-scroll` | 문서 스크롤만 있는 긴 페이지 |
| `layouts` | `sticky`, `fixed`, `100vh` |
| `inner-scroll` | 문서가 아닌 내부 컨테이너가 스크롤되는 앱 레이아웃에서의 요소 캡처 |
| `ilog` | 문서 맨 아래에 있는 `max-height` 로그 상자 |

다음 항목을 확인하세요.

- 이미지에 행 번호가 빠짐없이 순서대로 나오는가
- 아래쪽과 오른쪽에 흰 여백이 없는가
- 요소 캡처에서 선택한 요소만 정확히 찍혔는가
- 캡처 후 페이지 크기와 스크롤 위치가 원래대로 돌아왔는가

## Electron 연동

### 설계

Electron 앱의 메인 프로세스에서 `adapter-electron`을 불러와 `webContents`를 넘기면 확장과 같은 코드로 캡처할 수 있습니다. 역할은 다음과 같이 나뉩니다.

| 이 패키지가 하는 일 | 앱이 하는 일 |
|---|---|
| `webContents.debugger`를 연결하고 해제합니다. | 어느 창을 캡처할지 정합니다. |
| 화면, 전체, 요소 캡처를 수행합니다. | 요소 선택을 시작하기 전에 창에 포커스를 줍니다(`win.focus()`). |
| 이미지 바이트와 크기를 반환합니다. | 캡처하는 동안 화면 갱신을 멈춰 내용이 바뀌지 않게 합니다. |
| 오류를 `CaptureError`로 통일합니다. | 파일 저장, 클립보드 복사, 사용자에게 보여 줄 오류 문구를 처리합니다. |

`adapter-electron`은 `electron`을 import하지 않고 `webContents`를 인자로 받기만 합니다. 이 패키지는 ES 모듈이므로 일반 `import`로 불러옵니다. 다른 디버거가 이미 연결되어 있으면 `NOT_ATTACHABLE` 오류를 발생시키고, 캡처가 끝나면 이 패키지가 연결한 디버거만 해제합니다.

### 설치

```bash
yarn add github:gyuholee-dev/cdp-screenshot-extension#main
```

릴리스 태그가 생기면 `#<태그>`로 버전을 고정할 수 있습니다.

### 사용 예

아래 예제는 ES 모듈 메인 프로세스에서 페이지 전체를 캡처해 파일로 저장하고 클립보드에도 복사합니다.

```js
// main.js (ES 모듈 메인 프로세스)
import { app, BrowserWindow, clipboard, nativeImage } from 'electron';
import fs from 'node:fs';
import { runCapture } from 'cdp-screenshot-extension/adapter-electron';

async function main() {
  await app.whenReady();

  const win = new BrowserWindow({ width: 1280, height: 800 });
  await win.loadURL('https://example.com');

  // 'viewport' | 'full' | 'element'
  const shot = await runCapture(win.webContents, 'full', {
    depth: 5,        // 스크롤 영역을 탐색하는 깊이
    format: 'png',
  });

  // 반환값: { bytes: Uint8Array, mime, width, height }
  fs.writeFileSync('full.png', shot.bytes);
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(shot.bytes)));
  console.log(`${shot.width}x${shot.height}px`);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);                                 // 실패하면 앱이 종료되지 않고 남지 않도록 합니다
});
```

### 마우스로 요소 선택하기

`'element'`는 사용자가 클릭해서 요소를 선택하는 방식이므로, 시작하기 전에 창이 포커스를 받아야 합니다. macOS에서는 앱 자체가 활성화되지 않으면 하이라이트가 보이지 않으므로, `app.focus({ steal: true })`로 앱을 활성화한 뒤 `win.focus()`를 호출하세요. 앱 UI에서 선택을 취소할 수 있게 하려면 `AbortSignal`을 넘깁니다.

```js
const ac = new AbortController();

app.focus({ steal: true });                    // macOS: 앱을 먼저 활성화합니다 (앱이 할 일)
win.focus();
const shot = await runCapture(win.webContents, 'element', {
  signal: ac.signal,                           // 앱 UI에서 ac.abort()로 취소
  pickTimeoutMs: 60000,
  reportProgress: ({ stage }) => {             // 'pick' | 'expand' | 'capture'
    if (stage === 'pick') showHint('캡처할 요소를 클릭하세요');   // showHint는 앱에서 구현하는 함수의 예시
  },
});
```

**안내 문구를 페이지 안에 그리면 결과 이미지에 찍힙니다.** `reportProgress`는 동기 알림이라서, 안내를 지우고 페이지가 다시 그려질 때까지 기다릴 수 없기 때문입니다. 안내는 페이지 밖(앱의 다른 창이나 별도 뷰)에 두는 것이 가장 간단합니다. 꼭 페이지 안에 그려야 한다면 `runCapture` 대신 `pickNode`와 `captureNode`를 나누어 호출하고, 그 사이에 안내를 지운 뒤 화면이 다시 그려지기를 기다리세요.

```js
import { createElectronCdp } from 'cdp-screenshot-extension/adapter-electron';
import { pickNode, captureNode } from 'cdp-screenshot-extension/core';

const cdp = createElectronCdp(win.webContents);
await cdp.attach();                            // 다른 디버거가 이미 붙어 있으면 NOT_ATTACHABLE
try {
  showHint('캡처할 요소를 클릭하세요');          // 페이지 안에 그린 안내
  const { backendNodeId } = await pickNode(cdp, { signal: ac.signal });
  hideHint();                                  // 안내를 지우고
  await waitForRepaint(win);                   // 화면이 다시 그려질 때까지 기다립니다 (앱이 구현)
  const shot = await captureNode(cdp, backendNodeId, { depth: 5 });
} finally {
  await cdp.detach();                          // 이 패키지가 붙인 디버거만 뗍니다
}
```

### 선택자로 요소 찍기

클릭할 수 없는 호출자(예: 자동화 서버)는 선택자로 요소를 바로 찍을 수 있습니다.

```js
import { runCaptureNode } from 'cdp-screenshot-extension/adapter-electron';

const shot = await runCaptureNode(win.webContents, '#log-panel', { depth: 5 });
```

### 오류 처리

`error.code`로 분기하고, 사용자에게 보여 줄 문구는 앱에서 코드별로 따로 준비하세요. `error.message`는 개발자용 영어 원문이므로 로그에만 남기면 됩니다. `details`는 없을 수도 있으므로 `?.`로 읽으세요. 코드 목록과 `details` 형식은 [core 인터페이스](#core-인터페이스)를 참고하세요.

```js
try {
  await runCapture(win.webContents, 'element', { signal: ac.signal });
} catch (e) {
  console.error(e.code, e.message);            // 로그용
  switch (e.code) {
    case 'CANCELED': break;                    // 취소는 따로 알리지 않아도 됨 (notify는 앱에서 구현하는 함수의 예시)
    case 'TOO_LARGE': notify(`이미지가 너무 큽니다 (최대 ${e.details?.maxSide}px)`); break;
    case 'TIMEOUT': notify(`${e.details?.pickTimeoutMs / 1000}초 동안 요소를 선택하지 않았습니다`); break;
    default: notify('캡처에 실패했습니다');
  }
}
```

### 샘플 앱

`examples/electron-sample`은 ES 모듈로 작성한 최소 구성의 앱입니다. 위 예제와 똑같이 패키지 이름(`cdp-screenshot-extension/adapter-electron`)으로 어댑터를 불러오며, `package.json`의 `link:../..` 의존성이 저장소 루트를 그 패키지로 연결합니다. 저장소에 포함된 테스트 페이지를 캡처합니다.

```bash
cd examples/electron-sample
yarn install
yarn start --page=multi-scroll                 # 결과: examples/electron-sample/out/
# 옵션: --depth=5(기본값)  --format=png  --selector=#right  --hidden (창을 숨긴 채 캡처)
```

## 알려진 문제와 한계

**캡처 결과**

- `100vh`처럼 뷰포트 크기에 따라 커지는 레이아웃은 뷰포트에 들어가는 부분까지만 찍히고, 그 아래 내용은 잘립니다.
- `sticky` 요소는 맨 위에 한 번만 찍히고, `fixed` 요소는 이미지의 오른쪽 아래에 찍힙니다.
- 가로 스크롤, iframe(다른 출처 포함), shadow DOM 내부의 스크롤 영역은 펼치지 못합니다.
- 가상 스크롤(화면에 보이는 행만 렌더링하는 목록)은 아직 검증하지 않았습니다.
- 결과 이미지의 한 변 최대 길이(`maxSidePixels`, 16384px)는 실측값이 아니라 가정한 값입니다. 환경에 따라 실제 한계는 다를 수 있습니다.

**Chrome 확장 프로그램**

- 캡처하는 동안 Chrome 상단에 "디버깅 중" 안내 표시줄이 나타납니다. 정상적인 동작이며 캡처가 끝나면 사라집니다. 확장에서 숨길 수는 없고, Chrome을 `--silent-debugger-extension-api` 옵션으로 실행하면 표시되지 않습니다.
- 개발자 도구가 열린 탭에서 요소 캡처를 하면 이미지 오른쪽 위에 `1920px × 903px` 같은 창 크기 표시가 함께 찍힐 수 있습니다. 개발자 도구를 닫으면 나타나지 않습니다.
- 다른 확장이나 개발자 도구가 이미 해당 탭에 디버거를 연결해 두었다면 캡처할 수 없습니다(`NOT_ATTACHABLE`).
- `chrome://` 페이지, Chrome 웹 스토어, 다른 확장의 페이지는 캡처할 수 없습니다.
- `file://` 페이지를 캡처하려면 확장 카드에서 "파일 URL에 대한 액세스 허용"을 켜야 합니다.
- 요소를 선택하는 도중 주소 표시줄이나 제목 표시줄을 클릭하면 이를 감지하지 못해 선택이 취소되지 않습니다.
- 브라우저를 다시 시작하면 저장 폴더 접근 권한을 다시 허용해야 할 수 있습니다. 권한을 허용하기 전까지는 다운로드 폴더에 대신 저장됩니다.
- 웹 스토어를 통해 배포하지 않으므로 압축해제된 확장 프로그램으로 설치해야 하며, Chrome이 개발자 모드 경고를 표시할 수 있습니다.

**Electron**

- 숨겨진 창은 화면을 렌더링하지 않으므로 새 프레임이 들어오지 않습니다. 150ms 안에 프레임이 들어오지 않으면 숨겨진 창으로 판단하고 프레임 대기를 건너뛰는데, 숨겨진 창에서 캡처에 걸리는 시간과 결과는 아직 Electron에서 검증하지 못했습니다.
- 앱 창을 확대·축소한 상태에서 줌 보정이 올바르게 동작하는지는 Electron에서 검증하지 못했습니다. Chrome에서는 90%와 125%로 확인했으며, 줌이 100%일 때는 보정하지 않습니다.
- 개발자 도구가 열린 상태에서 `webContents.debugger.isAttached()`가 어떻게 동작하는지는 확인하지 못했습니다.
- macOS에서는 창이 포커스를 받지 않은 상태로 요소 선택을 시작하면(예: 컨텍스트 메뉴에서 시작) 강조 표시가 보이지 않을 수 있습니다. 앱에서 `win.focus()` 등으로 창을 앞으로 가져온 뒤 시작하세요.

## 라이선스

[MIT](LICENSE)
