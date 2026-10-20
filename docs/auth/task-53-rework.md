# TASK-53 F-01 재작업 검증

2026-10-20. 준비 범위 수정 완료, 독립 재검수 요청 대상. 실제 계정/제품 연결 완료나 최종 승인을 의미하지 않는다.

## 입력 및 수정

읽기 전용 `/run/mandu/MANDU-HANDOFF.json`의 TASK54 제출 `92cee358bed1b03981317435e0112585d4c41e5c`, tree `6afdf330c262ea5061925fda38f5adddbe771dec`가 착수 clean HEAD/tree와 일치했다. TASK48 보안 수정(Vitest4.1.11)을 유지한다. Task 공통 계획 revision2에서 AUTHREADY-01~04를 명시적으로 재개했다.

F-01 원인은 저장된 WAIT_PERMISSION을 일반 로그인과 동일하게 처리하여 동의 파라미터를 생략한 것이다. 해당 상태에서 화면에 **ChatGPT 사용 권한 활성화**를 표시하고 사용자 클릭 후에만 `prompt=consent`를 요청한다. 일반 로그인에는 추가하지 않는다. client/subject/host와 전체 scope 유지, 새 state/nonce/PKCE 및 반환 grant 검증을 보존한다. 재거절은 대기를 유지하며 grant가 있으면 자격증명 READY로 회복한다. 제품 검증 상태와 별개다.

근거: [공식 오류·복구](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [등록](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). force_reconsent는 통합 배포 확인이 없어 사용하지 않는다. VM/sessions/inference/limitations 원문도 다시 열어 기존 준비 경계와 대조했다.

## 새 실행 증거

| 검사 | 실제 결과 |
| --- | --- |
| 기존 QA `node scripts/siwc/qa54-reconsent.mjs` | 수정 전 explicitConsent:false FAIL, 수정 후 동일 스크립트 true PASS; 외부 호출0 |
| 새 auth 회귀 red→green | 수정 전 6 PASS/1 FAIL(prompt 누락), 수정 후 통과 |
| `npm ci` | exit0 |
| `npm run check` | exit0, 서버29 + SIWC17 + spike5 PASS; lint/typecheck/build PASS |
| SIWC 새 회귀 | 일반 READY/WAIT_AUTH/WAIT_SUPPORT 로그인 비강제, 반환 grant 유무, fresh state/nonce/PKCE, 등록/host 유지, 명시적 버튼 및 취소 후 저장 보존 |
| 기존 Playwright browser-smoke | demo/enabled-intercepted 두 모드 PASS, 외부 인증 호출0 |
| `npm audit --json` | exit0, 취약점0 |
| `npm run scan:secrets`, `git diff --check` | PASS |

원시 로그: ignored `data/task53-rework/`. Chromium은 제공 실행 경로를 사용했다. BEFORE `d3116368-39b4-4c3b-8bbb-90d50c905652`와 첫 AFTER는 환경 한글 폰트 누락이 있었다. workspace 내 Noto CJK 폰트를 적용한 읽을 수 있는 AFTER `6340cfb1-294b-456c-8468-d3324a496be6`를 추가 첨부하고 직접 확인했다. 합성 WAIT_PERMISSION 저장 상태를 실제 loopback 화면으로 렌더링한 자료이며 실제 계정 화면이 아니다.

## AC 및 미실행

- AC1 PASS: 기존 지원조건·미검증 문서 보존, 공식 복구 계약과 구현 대조, Codex 인증 비사용.
- AC2 PASS: 합성 auth/import/lock 검사 및 재동의 등록·nonce·scope 보존 회귀.
- AC3 PASS: 기존 runtime 대기·갱신·한도·실패·재호출 차단 시험 통과, 유료 자동 전환 없음.
- AC4 PASS (준비 범위): 명시적 권한 활성화·미검증 표시·취소 보존·복구 안내, 로컬 화면 및 회귀 검사.

실제 OAuth 동의/계정 재동의, 모델 목록/추론, SSH 전달, Android/Windows/macOS 실기기, 원격 CI, 배포는 NOT_RUN. TASK4 후속 검증 경계 유지. Wiki 원문은 열람하지 않았다. QA54 과거 보고와 재현 스크립트는 수정하지 않았다. runner claim/ACK/recovery/artifact publication은 수행하지 않았다.
