# TASK-56 실행 증거 · 2026-10-20

결론: **PARTIAL / Windows 실OS 검증 차단**. 코드·모의 테스트·CI·패키지 절차 제출이며 사용자 실행 준비 완료 또는 실제 계정 지원을 뜻하지 않는다. Windows 실제 OS 시험 및 독립 QA 후에만 사용자 로그인 요청 가능.

기준: immutable `/run/mandu/MANDU-HANDOFF.json`의 `695aaa1e866dd1ec3dbb2d17ebdfd955ed98bb5d`. origin `https://github.com/vaynel/daily_log.git` 확인, 기존 격리 checkout에서 `task-56-windows-siwc` 브랜치 사용. Task-owned WIN-01~04 등록 후 개발. 제출 commit은 Mandu report의 40자리 SHA가 기준이다. checkout의 동명 handoff 문서는 사용하지 않았다.

| 검사 | 실제 결과 |
|---|---|
| 기준 `npm ci`, SIWC | 설치 exit 0, 기존 17/17 PASS |
| 경로 신규 테스트 | 구현 전 missing function으로 FAIL → 구현 후 PASS. Windows 경로 파싱 테스트는 OS 보호 검증이 아니다 |
| launcher preflight 신규 테스트 | 구현 전 entrypoint 부재로 FAIL → Linux에서 WINDOWS_REQUIRED/외부 URL 없음 PASS |
| `npm run check` | 최종 exit 0: lint, 서버·웹 typecheck, server 29 PASS, SIWC 19 PASS/Windows 전용 3 SKIP, build, spike 5 PASS |
| 추가 Windows crash-lock 시험 후 `node --test scripts/siwc/*.test.mjs` | Linux 19 PASS, Windows 전용 4 SKIP, 실패 0. 신규 crash-lock은 Linux에서 실행하지 않음 |
| `node scripts/siwc/qa54-reconsent.mjs` | 기존 독립 QA probe PASS, issued client/direct scope/explicit consent 보존, externalCalls 0 |
| `npm run scan:secrets` / `git diff --check` | PASS (최종 제출 직전 재검사) |
| Windows native | NOT_RUN: DPAPI 실제 컴파일·암복호화, ACL, 링크, 핸들 잠금, 충돌/원자 교체, 종료 복구, cmd 실행을 여기서 통과로 표시하지 않음 |
| 원격 Windows CI | NOT_RUN. workflow 제출, PM push 및 CI 실행 후 결과 URL/로그 필요 |
| 실제 계정/OAuth/추론/Windows→Linux 전달 | NOT_RUN, TASK-4 후속. Windows 평문 export/import 없음 |
| 배포·runner claim/ACK/recovery/artifact publication | 수행하지 않음 |

첫 `npm run check`는 경로 제어문자 정규식의 `no-control-regex` lint 오류로 실패했다. 원인을 확인하고 문자 코드 검사로 수정한 뒤 전체 check를 재실행해 통과했다. 실패를 테스트 성공으로 세지 않았다.

Windows 시험 소스는 실제 `process.platform === 'win32'`일 때만 실행한다. 실제 저장/재읽기/계정 불일치/CurrentUser 암호문/로컬 삭제/host 보존, 다중 프로세스 잠금, 조상 rename 거부, lock 및 session hardlink, junction 및 ancestor junction, 잘못된 DPAPI 암호문, 파일/폴더의 Everyone ACL 거부, oversize 쓰기 시 기존값 보존, Node 소유자 종료 후 잠금 복구를 검사한다. 일반 사용자 간 DPAPI 분리 및 전원 장애 시험은 별도 미실행이다. C# 정적 검토는 Windows 컴파일/실행의 대체 증거가 아니다.

기존 state/nonce/PKCE/issuer/audience/서명/재동의/loopback/한도/모호한 응답 대기/유료 자동전환 금지 회귀는 Linux 모의 transport로 검사했다. 실제 지원을 확인하지 않으면 `WAIT_SUPPORT`, 상태 출력은 `NOT_VERIFIED`를 유지한다.

패키지 builder는 committed allowlist만 사용하며 동일 commit에서 2회 생성한 ZIP을 바이트/해시 및 파일 목록으로 확인한다. 최종 패키지 해시/경로는 Mandu 제출 증거에 기록한다. ZIP은 로컬 `dist/siwc-windows`에만 생성하며 공개 업로드하지 않는다.

공식 참조와 사용자/PM 후속 절차는 [Windows 안내](task-56-windows.md). README, TASK-53 auth/companion/runtime 및 테스트, 고정 패킷의 verification-before-completion·test-driven-development·systematic-debugging, TDD의 writing-good-tests, OpenAI Docs를 읽고 적용했다. Wiki 원문과 실제 계정은 열람하지 않았다.
