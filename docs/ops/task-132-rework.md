# TASK-132 재작업 검증 (2026-11-03)

선행 TASK-133의 P2(g/G 오판)를 수정했다. 시작 HEAD `514a545e4623771767aa86956f3fe0ae3b378548`와 tree `13b96b47ad3c0b3e1883588f89a69b534f4aceee`는 `/run/mandu/MANDU-HANDOFF.json`의 제출과 일치했다. 기존 검수 보고는 역사적 기록으로 보존한다.

## 변경과 재현

- `preflight.mjs`의 허용 단위에 g/G와 1024³ 배율을 추가했다. 안전한 정수·유한값·앱 한도 비교 및 release 승인 게이트는 그대로 적용한다.
- 동등한 1GiB의 bytes/k/K/m/M/g/G, 무제한 0g/0G, 잘못된 단위/소수/안전 정수 초과 회귀 시험을 추가했다. release 시험은 g/G 각각 이전 포인터에서 실제 전환을 검증한다.
- 배포 문서의 과거 '승인 JSON만 검사' 문구를 현재 자동 점검 동작으로 정정하고 지원 단위를 명시했다.
- 수정 전 `node scripts/ops/task133-review.mjs`: 24/28 PASS, 4 FAIL(g/G 판정 및 release). 새 시험을 먼저 실행하면 7 PASS / 2 FAIL(1g의 FAIL 판정, release 종료 2)이 발생했다.
- 수정 후 `node --test --test-concurrency=1 scripts/ops/*.test.mjs`: 10 PASS / 0 FAIL. `node scripts/ops/task133-review.mjs`: 28/28 PASS, 0 FAIL.
- 변경한 JS 3개 파일 ESLint 종료 0. `npm run scan:secrets`: 401 files OK (본 문서 추가 전). `git diff --check` 통과.

## 완료 조건

| 조건 | 결과 | 실제 근거 |
| --- | --- | --- |
| AC-1 | PASS | 누락/1m/10m/0/정확 경계 FAIL, 11m/경계+1/g/G PASS, 주석·상속·location 회귀 통과 |
| AC-2 | PASS | worker no/간격0/시작제한 FAIL, on-failure 및 always+양수 간격+제한0 PASS |
| AC-3 | PASS | FAIL 시 WAITING_PREFLIGHT 및 current 불변, missing/실제 EACCES NOT_RUN, g/G 전환 성공 |
| AC-4 | PASS | 기존 bundle/release 포함 순차 10/10, 자동 명령 문서 확인, 운영 변경·배포 없음 |

## 증거 및 한계

실제 명령 출력의 REPRODUCTION 이미지: BEFORE `eb526ad0-0b92-49b5-9b58-67d6592b755f`, AFTER `47c4abdf-5a17-496b-9c43-11cf96f3471c` (업로드 완료). 원본 로그는 `data/task132-rework/{before,red,ops,after}.txt`에 있다. 합성 fixture 전환은 `/workspace/data`에서만 수행했다.

운영 nginx/systemd 실효 상태·nginx -t·실제 배포는 NOT_RUN. 앱 전체·DB/Redis 통합·실기기 시험은 이번 ops 파서 수정 범위에서 미실행. 외부 include 미전개 및 JavaScript 안전 정수 범위 초과 거부는 기존 보수적 한계다.

참조: 고정 begin 패킷·Task 공통 계획, 불변 handoff, README, preflight/release 및 시험, TASK-133 검수 보고·재현 스크립트, 배포 문서, 앱 첨부 policy. Wiki/Flowchart 원문 미열람. systematic-debugging·verification-before-completion 및 실패 우선 회귀 검증 지침 적용.
