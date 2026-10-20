# TASK-54 독립 검수

2026-10-20. 판정: **CHANGES_REQUESTED**. P2 필수 수정 1건.
검수 자체는 완료했으나 TASK-53 준비 산출물의 승인을 권고하지 않는다.
제품 코드 수정·실제 사용자 동의·유료 호출·배포 없음.

## 고정 입력

- 저장소 origin: `https://github.com/vaynel/daily_log.git`
- TASK-53 제출: `a34fae31d393ef82f2c545587c7a85a994544ee6`
- 제출 tree: `02623d06797804dba4ed56d456fb7a623b4ec247`
- 원개발 run: `409124da-ba4e-41cf-9a68-fcf6130fcc4a`
- 검수 run: `629a3189-b92c-4d0a-a3dc-b8bd129f314d`
- `/run/mandu/MANDU-HANDOFF.json`과 get_task의 선행 제출, 실제 clean HEAD/tree가 일치했다. checkout 복사본이나 과거 host 경로는 사용하지 않았다.
- README, 원개발 변경 12개 파일 및 TASK48 의존성 변경을 확인했다. AGENTS.md는 없었다.
- 선행 첨부 이미지 `8512dc1e-f8f0-4fbc-b3ff-db998b1727aa`를 읽고 직접 실행한 로컬 화면과 대조했다.

## 원개발 AC 검수표

| 원개발 조건 | 판정 | 실제 근거 |
| --- | --- | --- |
| AC-1 공식 직접 등록·개인 self-hosted 조건과 개발 인증 분리 | PASS | `task-53-siwc.md`와 공식 문서 대조. 별도 앱 디렉터리, dynamic 등록, host 보존, 지원 미확정 gate, Codex/API-key 인증 비사용 확인. 실제 계정 적격성은 미확정으로 유지. |
| AC-2 localhost PKCE·보호 import·검증·갱신 직렬화 준비 | PASS | `auth.mjs`, `companion.mjs` 및 합성 시험 재실행: state/nonce/issuer/audience/subject/서명/만료, replay·계정혼합·변조 거부, 0600 파일·host 보존·lock. 실제 OAuth/SSH 전송은 미실행. 재동의 복구 결함은 AC-4에 판정. |
| AC-3 만료·권한·한도 오류 대기 및 유료 자동 전환 금지 | PASS | `runtime.mjs` 시험: 만료 갱신, 401/403/429/503 지속 대기와 재호출 없음, 불명 회전 및 중단 스트림 재실행 차단, SSE terminal 완료, revoke. 기존 worker와 미연결인 준비 모듈 범위. |
| AC-4 미검증 표시·사용자 버튼·기기 구분·비밀값 제거·취소/복구 | FAIL | 표시·데모·취소·상태 로그는 확인했으나 사용 권한 거절 후 명시적 재동의 복구 경로가 없다. 아래 F-01. 실제 계정 동의를 시험한 결과로 오해하지 않아야 한다. |

## F-01 · P2 · 권한 거절 후 명시적 재동의 경로 누락

위치: `scripts/siwc/auth.mjs:11`, `scripts/siwc/companion.mjs:22`,
`docs/auth/task-53-siwc.md` 상태·복구 안내.

이미 등록된 계정이 `WAIT_PERMISSION`인 상태에서 안내된 login 버튼을 다시 누르면
같은 issued client ID와 전체 scope를 요청하지만 `prompt=consent`가 없다.
별도 권한 활성화 버튼/CLI 옵션도 없다. 일반 재로그인과 권한 재동의를 구별할 수 없다.

[공식 오류·복구 문서](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)는
권한을 나중에 활성화하는 명시적 사용자 동작에서 재동의를 요청하도록 한다.
`force_reconsent=true`는 통합에 대한 배포 확인 후 사용하며 그 전에는 `prompt=consent`가 지원된다.
[등록 문서](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)는
기존 issued client의 일반 재로그인에서는 동의 화면이 생략된다고 설명한다.
따라서 단순 재로그인을 권한 복구 방법으로 제시한 현재 구현은 이 계약을 충족하지 못한다.
실제 서비스에서 반복 거절되는 현상까지 관찰한 것은 아니며, 재동의 요청 누락을 로컬에서 입증했다.

재현:

```sh
node scripts/siwc/qa54-reconsent.mjs
```

합성 WAIT_PERMISSION 저장 → 실제 loopback `/start` POST → 303을 따라가지 않고 검사.
결과: exit **1**, `issuedClientPreserved:true`, `directScopeRequested:true`,
`explicitConsent:false`, `externalCalls:0`, `result:FAIL`.
원래 15개 SIWC 시험에는 이 계약 검사가 없어 모두 통과한다.

필수 수정: 명시적인 “ChatGPT 사용 권한 활성화” 동작을 만들고, 해당 동작에서만
지원되는 재동의 파라미터를 추가한다. 일반 로그인에는 강제하지 않는다.
저장된 client/subject/host 유지, 새 state/nonce/PKCE 생성 및 반환 grant 재검증을 보존한다.
grant가 계속 없으면 대기하고, 부여되면 자격증명 READY로 회복하는 합성 회귀 검증을 추가한다.
문서의 권한 복구 절차도 해당 동작으로 연결한다. 실제 계정 검증은 TASK4에 남긴다.

## 독립 실행 결과

| 실행 | 결과 |
| --- | --- |
| `npm ci` | exit 0, Vitest 4.1.11. ESLint 9.39.5 deprecated 경고 관찰; 검사 실패는 아님 |
| `npm run check` | exit 0: lint, typecheck, 서버 29/29, SIWC 15/15, build, spike 5/5 |
| `npm audit --json` | exit 0, 취약점 0 |
| `npm run scan:secrets` | exit 0, 최종 QA 문서·재현 스크립트 포함 57개 파일 확인 |
| `npm run lint`, `git diff --check` | QA 재현 스크립트 추가 후 exit 0 |
| `node scripts/siwc/browser-smoke.mjs /workspace/data/task54/browser/node_modules/playwright/index.mjs` | exit 0, 데모 차단과 활성 버튼 303 local interception PASS. 외부 인증 이동·token 교환 없음 |
| `node scripts/siwc/qa54-reconsent.mjs` | exit 1, F-01 재현 |
| 제공 Chromium 직접 화면 확인 | 1280×800 로컬 데모 REVIEW 첨부, 미연결/사용자 버튼/컴퓨터·휴대폰 구분 확인 |

원시 로그는 ignored `data/task54/{install.log,check.log,audit.json,browser.log,reconsent.log}`.
한글 화면에는 workspace 안의 Noto CJK 폰트를 사용했다. 브라우저 의존성도 workspace 안에 설치했다.
초기 폰트 다운로드 명령은 curl 부재로 실패하여 Node fetch로 완료했다.
원격 인증 화면을 요청하지 않았다. 공식 문서·npm·폰트 다운로드는 수행했다.
REVIEW 이미지 upload ID: `a4c50d9a-c836-44ba-bb4d-275561042f8a`.

## 미실행과 범위

실제 OAuth 계정 동의, 모델 목록·추론, 실제 계정 재동의/재연결, SSH 전달,
Android/Windows/macOS 실기기, 원격 CI, 배포는 **NOT_RUN**.
TASK4의 실제 제품 인증 완료를 주장하지 않는다. Wiki 원문은 읽지 않았다.
이 검수는 원개발 준비 범위와 공개 공식 계약의 독립 대조이며 침투시험이나 전 제품 보안 감사가 아니다.
합성 token 검증은 실제 OpenAI 계정 적격성을 증명하지 않는다.

## 참조

Mandu 고정 패킷의 verification-before-completion 및 systematic-debugging 원문을 적용했다.
OpenAI Docs 스킬로 아래 공식 원문을 직접 열었다.

- [개요](https://developers.openai.com/siwc/token-sharing-open-source)
- [등록](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [VM 전송](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [계정·세션](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [모델·추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [오류·복구](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [제약](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

TASK-54 자체 AC-1 검수표, AC-2 독립 재현/미실행 분리, AC-3 판정/필수 수정 기록은 모두 수행했다.
이는 TASK-53 PASS나 출시 승인과 다르다. 원 담당 수정 후 독립 재검수가 필요하다.
