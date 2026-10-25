# TASK-56 실행 증거 · 2026-10-20

## 복구 실행: 실제 Windows CI 근거 반영

현재 준비 범위 AC1~4는 아래 실제 CI 및 로컬 회귀 근거로 PASS 보고 대상이다. **TASK-57 독립 QA 전이며 사용자 실행 준비 완료나 실제 계정 지원 판정은 아니다.** 아래의 최초 PARTIAL/NOT_RUN 기록은 당시 사실로 보존한다.

- 이번 immutable `/run/mandu/MANDU-HANDOFF.json` 및 시작 checkout은 `a36ae5cb7b5315ddcfbcddbee1fe9a84e9be8e70`. 기존 구현을 다시 작성하지 않고 문서만 갱신했다. `git diff a36ae5cb7b5315ddcfbcddbee1fe9a84e9be8e70 HEAD -- scripts .github start-windows.cmd package.json package-lock.json apps`가 비어 있으므로 CI에서 실행된 소스·테스트·워크플로와 동일하다.
- PM이 수행한 [native CI run 39450866093](https://github.com/vaynel/daily_log/actions/runs/39450866093)의 job 목록과 [Windows job 118724984969](https://github.com/vaynel/daily_log/actions/runs/39450866093/job/118724984969) 전체 로그를 이번 실행에서 GitHub 연결로 직접 읽었다. 로그의 checkout SHA가 위 40자리 커밋과 일치한다. Windows Server 2025, Node 22.23.3: 23개 중 **21 PASS / 0 FAIL / 2 SKIP(POSIX 전용)**. Ubuntu job 118724985369도 success이며 PM 전달 결과는 19 PASS / 4 SKIP(Windows 전용)이다.
- Windows 로그에서 DPAPI 저장·재읽기·삭제, ACL/링크/손상 거부, 잠금·종료 복구, oversize 실패 시 이전 데이터 보존, 모의 OAuth 회귀가 통과했다. `launcher.test.mjs`의 Node 부재 `.cmd` 실행도 PASS이다. ZIP 2회 바이트 비교 및 한글·공백 경로 압축 해제 후 `node scripts/siwc-windows.mjs --check`도 PASS이다.
- [일반 CI run 39450865459](https://github.com/vaynel/daily_log/actions/runs/39450865459)의 job/step success를 직접 확인했다(설치, 비밀값 검사, lint, typecheck, test, build, 빈 DB migration/seed 포함). 해당 전체 로그를 읽었다는 주장은 하지 않는다.
- 현재 Linux checkout에서 `npm ci && npm run check` exit 0: server 29 PASS, SIWC 19 PASS / 4 SKIP / 0 FAIL, spike 5 PASS, lint/typecheck/build 통과. 로컬 로그는 `data/task56-recovery-install.log`, `data/task56-recovery-check.log`. `node scripts/siwc/qa54-reconsent.mjs`도 PASS, externalCalls 0.
- 기준 커밋 ZIP을 재생성해 Windows 로그와 같은 SHA256 `d0d29161c74fe8ca96f178afdfc63c0107c6c9ade03f712d00adfad456f52289`를 확인했다. 최종 문서 커밋은 ZIP 내용과 이름을 바꾸므로 최종 ZIP은 그 커밋에서 다시 생성하고 2회 비교한다. 최종 커밋·ZIP SHA256은 Mandu report와 ZIP 옆 manifest/체크섬이 기준이다. 문서에 자기 커밋/자기 ZIP 해시를 내장하지 않는다.

검증 한계: `.cmd` 더블클릭 및 Node가 있는 상태의 대화형 메뉴 전체, 다른 일반 사용자 계정 간 DPAPI 분리, 전원 장애, 실제 사용자 OAuth·계정 지원·추론·Windows→Linux 인계는 NOT_RUN이다. Windows CI는 기준 커밋에서 수행되었으며 최종 문서 커밋의 새로운 Windows 실행을 주장하지 않는다. 모의 OAuth 결과를 TASK-4 실제 계정 성공으로 바꾸지 않는다.

이전 실행은 Windows 증거 부재로 PARTIAL 제출되었고 `SUBMISSION_REJECTED`로 종료되었다. PM의 PARTIAL source registration 거절 이력과 품질 예산은 그대로 보존한다. 이번 작업자는 runner claim/ACK/recovery/artifact publication을 실행하지 않으며 로컬 패키지와 보고만 준비한다. 배포 없음.

## 최초 실행 기록 (역사 보존)

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
