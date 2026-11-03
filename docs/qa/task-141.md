# TASK-141 구형 음성 전사 보관 정리

기준: `110fee0f8066ed5b3477b43785739134fa5aa075`. `/run/mandu/MANDU-HANDOFF.json`과 Mandu 작업 패킷의 PM 정책을 적용했다. 격리 PostgreSQL 임시 스키마와 `/workspace/data`의 합성 파일만 사용한다. 배포·유료 API·운영 데이터 접근 없음.

## 변경과 보존

- 기록 ID가 없는 종료된 `live-*.json`은 파일 mtime에서 **Asia/Seoul 달력 한 달**이 되는 시각부터 정리한다. 기존 `addCalendarMonthSeoul`을 재사용하며 말일은 다음 달 말일로 보정한다. 파일 내부 시작/종료 시각을 보관 기간 기준으로 쓰지 않는다.
- 서버 `purgeTranscripts`/`drainFileQueue`와 워커 `sweepAll`에 적용했다. 주입된 시각을 모든 중첩 정리 호출에 전달하여 실제 현재 시각과 섞이지 않게 했다.
- 기록 ID가 있는 파일의 TASK-139 영구 삭제 경로는 유지한다. 다른 기록, 미종료 세션, `processing=true` 세션은 보존한다. 구형 파일을 DB 기록과 추정 연결하지 않는다.
- 종료 시각이 없거나 유효하지 않은 파일은 활성 여부를 추정하지 않고 보존한다. 프로세스 비정상 종료 후 남은 미종료/처리 중 표식도 시간만으로 해제하지 않는다. 손상 JSON은 삭제하지 않고 실패 수로 집계한다.
- 구형 파일 정리는 심볼릭 링크·일반 파일이 아닌 항목을 건너뛰고, 읽기 전후 inode/mtime/ctime/size가 달라지면 보존한다. 서버의 원자적 파일 교체를 감지한다. 관리자에 의한 동일 디렉터리의 임의 동시 파일 교체까지 잠금으로 통제하는 도구는 아니다.

## 운영 도구

저장소에서 `npm ci` 후 실행한다(Node/tsx는 기존 의존성). sessionDir를 명시해야 한다.

```sh
node scripts/ops/purge-legacy-live.mjs --session-dir /path/to/session-dir
node scripts/ops/purge-legacy-live.mjs --session-dir /path/to/session-dir --apply
```

기본은 읽기 전용 dry-run. JSON 출력은 mode, targets, oldest/newest mtime, deleted, failed뿐이다. 파일명·본문·기록 ID·원시 오류는 출력하지 않는다. `--apply`만 삭제하며 서버와 같은 정책 함수를 사용한다. 실패 수가 있거나 인자가 잘못되면 종료 코드 1. 디렉터리가 없으면 대상 0이다. `--now <ISO 시각>`은 합성 자료의 시계 제어 시험용이며 일반 운영에서는 생략한다.

## 재현·검증

```sh
npm exec -w apps/server -- vitest run src/retention/task141.test.ts src/retention/task139.test.ts --no-file-parallelism --maxWorkers=1
npm run test:retention-ops
npm test -w apps/server -- --no-file-parallelism --maxWorkers=1
npm test -w apps/web -- --no-file-parallelism --maxWorkers=1
npm run lint
npm run typecheck
```

- 생산 코드 수정 전 기준 커밋에서 새 시계 제어 시험 5개가 `expired legacy transcript must be deleted`로 실패했다(`before.txt`). 각각 만료 직전 보존과 만료 시각 삭제를 실제 파일 존재 여부로 검증한다.
- BEFORE/AFTER는 합성 파일을 사용한 **실제 시험 출력의 브라우저 렌더링(REPRODUCTION)** 이며 제품 UI가 아니다. `task-141-evidence/capture.mjs`로 생성한다.
- CLI 시험은 실제 자식 프로세스 실행 결과와 디렉터리 내용을 검증한다. dry-run 보존, apply 구형 대상만 삭제, 다른 기록/활성/처리 중/심볼릭 링크 보존, 재실행 멱등성, 민감 본문 미출력을 확인한다.
- 최초 typecheck에서 새 시험의 배열 구조 분해 타입에 `undefined`가 포함된 오류가 발견되었다(`typecheck-initial.txt`). fixture 표를 readonly tuple로 명시하여 수정했다.

읽은 참조: README, TASK-139 보고서/재현 캡처, 실제 records/time·retention·voice/live·worker 코드, Mandu get_task/begin_task와 Task 공용 계획, 불변 handoff 증거. 등록된 systematic-debugging, test-driven-development(보조 writing-good-tests 포함), verification-before-completion을 적용했다. TASK-140 브랜치 증거와 Wiki 원문은 이 checkout에 없으며 읽었다고 주장하지 않는다.

추가 검사 구성 오류도 보존했다: 최초 `test:retention-ops`를 `scripts/ops/*.test.mjs`로 등록하여 기존 TASK-30 시험까지 포함했고, bundle/preflight/release의 4개 시험이 준비되지 않은 `/workspace/data/task30` 때문에 ENOENT로 실패했다(`cli-initial.txt`, 8 PASS/4 FAIL; 새 구형 정리 시험 2개는 PASS). 명령을 이번 정리 도구의 정확한 시험 파일로 수정했다. TASK-30 시험 자체나 기대값은 변경하지 않았다.

## 최종 검증 결과

- 전체 서버: **40 파일 / 535 PASS**, 종료 0 (`server-all.txt`). Fastify 요청 JSON 줄만 제외하고 시험 결과·오류는 보존했다.
- 전체 웹: **6 파일 / 39 PASS**, 종료 0 (`web.txt`).
- TASK-141 + TASK-139 집중 회귀: **12 PASS**, 종료 0 (`targeted.txt`); 시계 경계 5개, 보존 1개, 기존 권한/삭제 6개.
- 운영 CLI: **2 PASS**, 종료 0 (`cli.txt`); 손상 JSON 보존·오류 본문 비노출도 포함한다.
- lint, server/web typecheck, server/web build, spike(5 PASS), records-crash, queue-restart, notify-e2e, secrets scan: 모두 종료 0 (`checks.txt` 및 개별 출력).
- SIWC/voice-measure: **37 PASS / 4 SKIP / 0 FAIL**. Linux에서 실행할 수 없는 기존 Windows 전용 시험 4개는 PASS로 계산하지 않았다 (`siwc.txt`).
- 모든 시험 명령은 순차 실행했다. 최초 잘못된 ops wildcard 호출은 Node의 파일 병렬 기본값으로 실행되었으며, 수정한 명령은 단일 파일의 순차 시험이다.

독립 검토를 요청하며 자체 최종 승인이나 배포는 하지 않는다.
