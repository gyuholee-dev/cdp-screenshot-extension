# cdp-screenshot-extension

CDP(Chrome DevTools Protocol) 기반 스크린샷 도구. 개발자용이며 웹 스토어에 배포하지 않는다.

- 스크린샷: 보이는 화면 그대로
- 전체 스크린샷: 스크롤 영역을 펼쳐 한 장으로
- 엘리먼트 스크린샷: 고른 요소만

## 구조

| 경로 | 역할 |
|---|---|
| `core/` | 환경 독립 모듈(순수 ESM). `cdp.send`/`cdp.on`을 인자로 받는다 |
| `adapter-chrome/` | `chrome.debugger` 어댑터 |
| `adapter-electron/` | `webContents.debugger` 어댑터 |
| `extension/` | 크롬 확장 UI(압축 해제 로드) |
| `test/` | 시험 |

## 앱에서 사용

```json
"cdp-screenshot-extension": "github:gyuholee-dev/cdp-screenshot-extension#<tag>"
```

```js
const core = await import('cdp-screenshot-extension/core');
```

## 개발

```bash
npm test
```

상태: 1단계(뼈대) 완료. 이후 단계는 인계 문서를 따른다.

## 라이선스

MIT
