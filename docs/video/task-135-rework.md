# TASK-135 재작업: 품질 검수 예약 복구

입력 커밋 `f3bde2fd49a874f5186af0f5c2fe80d0927362a3`, tree `a548220adc5b0c5d03bcc7f2c5b464b70ceb96b6`는 `/run/mandu/MANDU-HANDOFF.json`의 TASK-136 불변 제출과 일치한다. 기존 제품 제출은 `2b009ff7aba97c86f087cdcb7e1a8abd5cebe9ea`다.

## 원인과 변경

`qualityEvidence.ts`가 모든 중복 예약을 상태 확인 없이 거절했다. 독립 검수 시험을 수정 없이 실행하여 5 PASS / 2 FAIL을 재현했다(`task-135-rework-evidence/before.txt`).

- F1: 예약 커밋 직후 중단 시 재시작해도 RESERVED 136.8814원, UNKNOWN 0원. 중복 예약을 UNKNOWN으로 분류해 금액을 보수적으로 유지한다. 수정 후 RESERVED 0원, UNKNOWN 136.8814원.
- F2: 원장에 제공자 미청구 확인을 기록하고 RELEASED로 정산해도 동일 요청이 영구 차단됨. 원장 `entryState`로 RELEASED를 확인한 경우에만 결정적 다음 시도 키로 새 예산 예약을 한다. UNKNOWN/CONFIRMED/행 없음은 계속 차단한다.

기존 원장 항목과 확인 근거를 보존한다. 시간 경과, 캐시 부재, 미청구 추측으로 환급하지 않는다. 같은 키의 원장 예약이 한 호출만 허용하며, 재시도에도 월 한도를 다시 검사한다. 동시 요청이 진행 중 예약을 UNKNOWN으로 분류해도 최초 호출은 정상 정산할 수 있고 중복 요청은 외부 호출하지 않는다. RELEASED는 원장 정책상 최종 상태다.

변경은 품질 제공자 복구 분기와 원장 상태 조회뿐이다. 큐의 처리 재시도/품질 재제작 한도, 제공자 선택, 가격 설정은 그대로다. Pro의 명시적 대기 처리도 기존 경로를 유지한다.

## 재현과 검증

```sh
npm ci
npm test -w apps/server -- src/video/qualityEvidence.review.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

격리 PostgreSQL과 가짜 외부 제공자를 사용한다. 원본 검수 7시험에 청구 완료 재호출 차단, 해제 후 월예산 부족, 2회 미청구 정산 후 동시 복구를 추가했다. 중단 재현은 예약 커밋 경계에서 예외를 주입한 것이며 OS SIGKILL 실험은 아니다.

`focused.txt`: 기존 제공자17 + 원본 검수7 = 24 PASS. `recovery.txt`: 검수 및 복구 경계 10 PASS. 실패 전 로그를 삭제하거나 판정을 바꾸지 않았다. BEFORE/AFTER는 실제 CLI 출력의 REPRODUCTION이며 제품 UI 화면이 아니다.

## 비용과 제약

가격 로직 변경 없음. 기본값의 3장면/180초 검수 추가 비용은 1,103.69952원, 품질 재제작 포함 2회는 2,207.39904원이다. 실제 청구액이 아닌 보수 예약 추정이며 제작비와 합쳐 월 50,000원 한도를 검사한다. 확인되지 않은 외부 호출은 UNKNOWN 점유를 유지한다. 실제 유료 API 호출, 실계정 검수, 운영 배포는 실행하지 않았다.

참조: README, Mandu begin_task 고정 패킷과 공용 계획, 불변 handoff, TASK-136 검수보고/시험, TASK-135 비용문서, qualityEvidence/MonthlyLedger/pipeline 구현과 시험. 패킷의 systematic-debugging, test-driven-development, verification-before-completion 지침 및 동일 커밋 writing-good-tests 참조 적용. Wiki 원문 조회 도구는 없어 미열람.

## 최종 실행 결과와 AC 판정

서버 전체를 `npm test -w apps/server -- --maxWorkers=1 --no-file-parallelism`으로 실행해 37파일/508시험 PASS(exit 0). 웹은 같은 순차 옵션으로 6파일/39시험 PASS. SIWC/voice-measure는 37 PASS, Windows 전용 4 SKIP, 실패 0. 이는 루트 npm test 구성의 세 시험 묶음을 순차 실행한 결과다. lint/typecheck/build/scan:secrets 모두 exit 0 (`exits.json`).

| 조건 | 판정 | 직접 실행 근거 |
| --- | --- | --- |
| AC-1 | PASS | server.txt 전체508 PASS에 qualityEvidence.integration 포함: 실제 DB/FFmpeg와 buildVideoRuntime, 가짜 제공자로 passed/publishable 검증 |
| AC-2 | PASS | 같은 통합시험의 전사/사실/그림/가독성 repairStages, 기존 quality/pipeline 시험 통과 |
| AC-3 | PASS | focused.txt 24 PASS와 recovery.txt 10 PASS: 설정누락/실패폐쇄, F1 예약 중단 후 RESERVED0/UNKNOWN136.8814, F2 미청구 정산 복구 |
| AC-4 | PASS | 실제 MonthlyLedger 정산, CHARGED 재호출 차단, RELEASED 후 예산 검사/동시 복구; cost.txt 1103.69952원/2207.39904원 |
| AC-5 | PASS | server.txt 37파일508 PASS; lint/typecheck exit0. 웹39 PASS, SIWC37 PASS/4 SKIP, build/scan exit0 추가 확인 |

제약: 실유료 API/실계정/운영 배포 NOT_RUN. Windows 전용 시험은 Linux에서 SKIP. 테스트 경계 예외 주입을 실제 OS 강제 종료로 주장하지 않는다. 이 보고는 구현자 검증 결과이며 최종 승인은 독립 검수 및 권한 있는 담당자가 결정한다.
