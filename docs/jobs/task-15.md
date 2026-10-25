# TASK-15 작업 큐와 중단·오류 복구

코드: `apps/server/src/jobs/queue.ts`, 스키마: `db/migrations/0006_job_queue.sql`, 시험: `jobs/queue.test.ts`(실제 PostgreSQL 임시 스키마).

## 상태
`QUEUED → RUNNING → SUCCEEDED | FAILED | WAITING(BUDGET | PERMISSION | EXTERNAL_RESULT_UNKNOWN)`.
완료 단계 결과는 `job_stages`(DONE, result)에 남아 재시도·재시작 후에도 다시 실행하지 않는다.

## 규칙
- 자동 재시도: 작업 전체(모든 단계 합산)에서 최대 1회(`jobs.auto_retries_used` CHECK 0..1). 일시 오류·서버 중단만 소모.
- 재시도 불가(`NonRetryableError`, 4xx 거절)는 즉시 FAILED. 권한 부족(`PermissionDeniedError`)·예산 부족은 재시도 없이 WAITING + 사유.
- 유료 단계: 원장 예약 → 요청 식별자(`jobId:stage:attempt`, 원장 멱등키와 동일) 저장 → 실행. 결과가 불명확하면 원장 UNKNOWN 유지, **재전송 금지**,
  `lookup()` 조회 → COMPLETED(확정)/NOT_FOUND(근거와 함께 환급 후 일시 오류 취급)/불명(확인 대기). 정산은 `resolveUnknown(evidence)`만 사용.
- 재시도 비용은 `purpose=RETRY`로 같은 원장에 기록.
- 대기 재개(`wakeWaiting`)는 재시도 횟수를 쓰지 않는다. 예산은 잔여액이 다음 유료 단계 예상액 이상일 때, 권한은 `permissionRestored`가 true일 때.

## 사용 절차
- 서버/워커 시작 시 `recover()`가 임대 만료 RUNNING 작업을 이어받는다(`npm run start:worker`가 자동 수행).
- 수동 재시도: `requestManualRetry(jobId, {commandId, actor})` — 실제 사용자 명령 id 필수, `job_requests`에 기록, 같은 명령 재전송은 1회만 처리.
  자동 재시도 사용 횟수는 계승(초기화 없음), 완료 단계 결과 보존. 결과 불명 요청이 남은 작업은 `UNRESOLVED_EXTERNAL`로 거부.
- 불명 정산: `resolveExternal(jobId, stage, outcome, {commandId, actor})` — 확인 근거 필수.
- 단계 처리기 등록은 후속 Task가 `worker.ts`의 `handlers`에 추가한다(현재 비어 있음).

## 실제 프로세스 재시작 시험 (AC-2)
`npm run build && npm run test:queue-restart` (`npm run check`에 포함). 시험 스키마에서 워커를 별도 Node 자식 프로세스로 띄우고 처리 중 `SIGKILL` 한 뒤 새 프로세스가 임대 만료 후 `recover()`로 이어받는다.
- plain: 단계 a 완료 → b 처리 중 종료 → 재시작 후 a 미실행, b(시도 2)·c 완료, `auto_retries_used` DB 유지(중단은 일시 오류로 1회 소모).
- paid: a 일시 오류로 재시도 1회 사용 → 유료 b 요청 전송 후 종료 → 재시작 후 b 재전송 없이 조회로 확정, 재시도 횟수 1 유지, 원장 항목 1건.
