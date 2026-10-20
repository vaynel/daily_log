# TASK-53 검증 기록

2026-10-20 / 격리 `/workspace`, Node 22.23.3. 실제 계정 credential을 읽거나 요청하지 않았다.

| 검사 | 실제 결과 |
| --- | --- |
| npm ci | exit 0, TASK48 Vitest 4.1.11 통합 |
| npm run check | exit 0: ESLint, TypeScript, 서버 29 tests, SIWC 15 tests, 서버/웹 build, 기존 spike 5 tests |
| npm audit --json | exit 0, vulnerabilities 0 |
| npm run scan:secrets | exit 0 |
| git diff --check | exit 0 |
| Playwright / 제공 Chromium | 로컬 데모 버튼 차단과 활성 로그인 버튼의 공식 OAuth redirect를 네트워크 intercept로 확인. 외부 네트워크 호출 0 |

SIWC 시험: PKCE fresh state/nonce, 단일 callback·replay/expiry/duplicate/client mismatch 거부, RSA signature/issuer/audience/nonce/sub/expiry 검증, grant 누락 대기, 정확한 교환 파라미터, import 변조/계정 혼합 방지, host 보존, 0600·0700 저장과 배타 lock, HTTP 401/403/429/503 지속 대기, SSE 완료/실패/중단/분할 프레임, refresh 회전/동시 호출 차단/terminal 실패/불명 상태, 재연결 및 revoke/로컬 제거.

실패→수정 증거: 초기 auth 4개·runtime 5개·companion 2개는 미구현으로 assertion 실패 후 구현하여 통과. 추가 SSE 청크 분할 시험은 실제 실패를 재현한 뒤 버퍼 정규화 수정으로 통과. 실제 브라우저는 no-referrer에 의한 Origin:null/403을 재현했고 same-origin 정책으로 수정했다. 수동으로 Origin을 넣는 Node HTTP 시험만으로 브라우저 성공을 단정하지 않았다.

브라우저 첫 활성 모드 시험과 진단 재현에서는 Playwright가 redirect chain의 첫 URL만 route한다는 점을 놓쳐 공개 auth authorize 페이지 GET이 나가 403을 받았다(진단에서는 challenge 리소스 응답도 관찰). 계정 로그인·동의·토큰 교환·유료/추론 요청은 없었다. 이후 **로컬 /start 응답을 maxRedirects:0으로 읽고 303 Location을 검사한 뒤 합성 페이지로 대체**하도록 수정했다. 위 표의 외부 호출 0은 수정 후 최종 두 모드 실행에 한정되며 세션 전체 네트워크 호출 0을 뜻하지 않는다.

재현:

```sh
npm ci
npm run check
npm audit --json
npm run scan:secrets
# 선택: Playwright를 저장소 밖 대신 workspace의 ignored data 안에 설치
npm install --prefix /workspace/data/task53/browser playwright
node scripts/siwc/browser-smoke.mjs /workspace/data/task53/browser/node_modules/playwright/index.mjs
```

브라우저에는 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`를 사용한다. 환경에 한글 폰트가 없어서 화면 증거 작성 시 workspace 안의 Noto CJK 폰트를 fontconfig로 적용했다(제품 의존성 아님). 신규 화면이므로 과거 BEFORE 이미지를 만들지 않았다. AFTER 이미지에는 실제 계정 미연결과 데모 차단을 표시한다.

원시 로그: ignored `data/task53/{install.log,auth-red.log,auth-green.log,runtime-red.log,companion-red.log,sse-red.log,tests.log,check.log,check-final.log,audit.json,secrets.log,browser-smoke.log}`. 이 문서는 추적 가능한 요약이며 로그를 원격 CI 증거로 주장하지 않는다. 새 제출 commit의 원격 CI/실제 계정/실기기/SSH 전송/공개 배포는 NOT_RUN이다. 전송은 합성 파일로 import를 시험했다. TASK4 실제 계정 시험은 이 준비 작업의 PASS에 포함하지 않는다.

AC-1~4는 준비 범위에서 PASS. 실제 제품 지원·사용자 동의·추론 성공 판정은 보류. 독립 QA 및 PM 검토가 필요하다.
