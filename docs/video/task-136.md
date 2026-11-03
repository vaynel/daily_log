# TASK-136 독립 검수

판정: **CHANGES_REQUESTED**. 제품 수정 없이 제출 코드에서 복구 결함 2건을 재현했다.

검수 대상 TASK-135: `2b009ff7aba97c86f087cdcb7e1a8abd5cebe9ea`, tree `a6add5ba5ac36dde49f6f640842f8bc479dbc834`.
`/run/mandu/MANDU-HANDOFF.json`의 불변 제출·get_task 선행 run `ee851a0d-a6a9-4e64-a067-168a488e5f17`와 실제 HEAD/tree를 대조했다. 선행 BEFORE/AFTER 이미지를 MCP로 직접 열람했다. 두 이미지 모두 CLI 근거 재구성이며 제품 실사용 화면이 아니다.

## 필수 수정

### F1 · P2: 중단 후 예약 금액이 RESERVED로 고착

위치: `apps/server/src/video/qualityEvidence.ts:103-105`.

실제 PostgreSQL MonthlyLedger에 예약을 커밋한 직후 실행 중단을 주입하고, 같은 cacheDir/원장으로 새 제공자를 만든다. 재호출은 중복 비용 방지를 위해 중단되지만 기존 항목을 UNKNOWN으로 전환하지 않는다. 실제 결과는 `reserved=136.8814`, `unknown=0`이다. 외부 호출은 양쪽 모두 0회였다. 이 재현은 프로세스 SIGKILL 자체가 아니라 **영속 예약 이후의 중단 경계 주입**이다.

`jobs/queue.ts:307-309`는 자체 원장 사용 처리기가 이미 불명 상태로 보존했다고 가정하며 budget_entry_id 없이 UNKNOWN 단계를 기록한다. 따라서 상위 큐도 이 RESERVED를 정산하지 않는다. `MonthlyLedger.listUnknown()`에서도 빠지므로 정상 불명 항목 확인·정산 경로에 드러나지 않고 월 예산을 점유한다.

요구 수정: 기존 예약의 상태·활성 실행 소유권을 확인하여, 중단이 확인된 예약을 보수적인 UNKNOWN으로 전환하고 원장/작업의 확인 경로에 연결한다. 실행 중인 동시 요청을 무작정 환급하거나 중복 호출해서는 안 된다.

### F2 · P2: 미청구 확인·정산 후에도 안전한 재시도가 불가능

위치: `apps/server/src/video/qualityEvidence.ts:100-105` (같은 중복 분기, 별도 복구 상태).

가짜 외부 호출 실패 → UNKNOWN 생성 → 실제 `ledger.resolveUnknown(id, {charged:false,evidence:...})` 성공 → RELEASED 확인 가능한 상태에서 같은 입력으로 새 제공자 호출. 정상적으로 확인을 마친 뒤에도 같은 idempotency key를 무조건 중복으로 취급하여 `QUALITY_EXTERNAL_UNKNOWN`으로 거절한다. 이 시험은 경과 시간에 의존하거나 미확인 호출을 반복하지 않는다.

요구 수정: 확인된 NOT_CHARGED 결과만 근거로 새 시도 번호를 영속화하고 재호출을 허용한다. UNKNOWN/RESERVED 상태의 무조건 재호출은 금지한다. 큐의 수동 정산 경로와 제공자 내부 원장/캐시 상태를 연결해야 한다.

## 제출 완료 조건별 독립 판정

| TASK-135 조건 | 판정 | 직접 확인한 근거 |
| --- | --- | --- |
| AC-1 운영 런타임 연결·정상 품질 PASS | PASS | 제출 그대로 서버 36파일/498시험 통과. 실제 DB·FFmpeg를 쓰는 qualityEvidence.integration 시험이 buildVideoRuntime quality의 passed/publishable을 검증한다. 외부 Gemini/Pro만 가짜다. |
| AC-2 전사·사실·그림·가독성 실패와 재제작 단계 | PASS | 기존 qualityEvidence/integration 및 queue 시험 통과. 독립 추가 learning=false도 LEARNING/zooms 실패를 확인했다. 코드의 zooms→narration 매핑 대조. |
| AC-3 미설정·실패 시 통과 금지, 예약 잔류 없음 | FAIL | 미설정, Pro 대기, HTTP503, 응답 유실·잘림·빈 응답·비정상 JSON의 실패 차단은 통과. 그러나 F1은 RESERVED 136.8814원 잔류; F2는 확인 후에도 복구 불가. |
| AC-4 외부 호출 예약·정산과 비용 수치 | FAIL | 정상 3항목 정산·월 50000원 차단·캐시 재사용은 기존 시험 통과. 보고의 기본 추정 3장면180초 1103.70원/검수, 재제작 포함2207.40원은 코드 계산과 일치하는 보수 추정이며 실청구액이 아니다. 중단 경계 F1의 정산 누락이 남아 전체 통과로 판정하지 않음. |
| AC-5 기존 영상·품질·파이프라인 회귀 및 lint/typecheck | PASS | 제출 그대로 서버 498개 통과(영상138 포함), 웹39개, SIWC37개 통과/Windows4개 SKIP. lint/typecheck 결과는 check-exits.json 참조. 추가 검수 회귀는 별도로 5 PASS/2 FAIL이며 실패를 숨기지 않는다. |

## 재현 및 증거

격리 DATABASE_URL이 설정된 `/workspace`에서:

```sh
npm ci --no-audit --no-fund
npm test -w apps/server -- --maxWorkers=1 --no-file-parallelism
npm test -w apps/server -- src/video/qualityEvidence.review.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

첫 번째 서버 실행은 추가 검수 파일 생성 전에 시작하여 **제출 시험 498개**만 실행했다. 추가 검수 파일을 포함하는 현재 전체 서버 실행에는 의도적으로 결함을 드러내는 2개 실패가 포함된다. 기존 시험을 수정하거나 제품 코드를 고치지 않았다. 추가 시험에는 실제 DB와 가짜 Gemini/Pro 응답을 사용한다.

- `task-136-evidence/server.txt`: 기존 36파일/498개 PASS, exit 0.
- `task-136-evidence/review.txt`: 추가 7개 중 5 PASS/2 FAIL, exit 1, 실제 오류·스택·원장 수치.
- `task-136-evidence/check-exits.json`: 순차 추가시험/웹/SIWC/lint/typecheck/build/비밀패턴검사 종료 코드.
- `task-136-evidence/server-initial-not-run.txt`: 의존성 미설치로 vitest 실행 불가(exit127). npm ci 후 위 전체 실행으로 해소.
- `task-136-evidence/review.png`: 실제 시험 로그를 표시한 REVIEW 근거 화면. 제품 UI나 실기기 검수 화면으로 주장하지 않는다.

실유료 API·실계정·배포는 요청에 따라 NOT_RUN. Windows 전용4시험은 Linux에서 SKIP. Wiki 원문은 scoped MCP 조회 도구가 없어 미열람. 실모델의 의미 판정 정확도·청구 금액은 이 가짜 제공자 시험으로 검증하지 않았다. ffmpeg 산출물의 통합 검사는 직접 실행했으나 사용자 실제 기록3회·Android 실기기 검수는 이번 범위가 아니다.

읽은 참조: 불변 handoff, begin_task 고정 패킷, 공용 계획, 선행 제출과 이미지, README, 실제 qualityEvidence/pipeline/pipelineRuntime/quality/qualityStage/subtitles/frame/ledger/queue/createProInfer와 해당 시험, TASK-135 비용 문서. 적용 지침: 고정 verification-before-completion·systematic-debugging. 검수 Task 자체의 AC1~3은 판정·결함 재현·이미지와 최종 verdict 등록 활동이며 제품 승인과 구분한다.
