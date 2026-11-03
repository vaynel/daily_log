# TASK-132 개발 검증 기록

- 기준: `c98e81c0323b1839f48ad0839ef0dca5e5ef421f`, 최초 작업 트리 clean. 작업 브랜치 `task-132-preflight`.
- 환경: 격리 `/workspace`, Node v22.23.3. 실제 운영 설정 수정·서비스 변경·배포·유료 API 호출 없음.
- 읽은 참조: Task 패킷 및 공유 계획, README, `scripts/ops/release.mjs`/기존 시험, `apps/server/src/attachments/policy.ts`, `docs/ops/task-30-deployment.md`. Wiki·Flowchart 원문은 미열람.

## 재현 및 실제 결과 (2026-11-03 UTC)

1. 구현 전 `node --test --test-concurrency=1 scripts/ops/release.test.mjs`: 기존 1개 PASS, 새 회귀 1개 FAIL. `1m` 설정에서 기대 `WAITING_PREFLIGHT`, 실제 `READY_FOR_ADMIN_SWITCH`를 확인했다.
2. 구현 후 `node --test --test-concurrency=1 scripts/ops/*.test.mjs`: **9 tests / 9 pass / 0 fail**. 파일 간 시험도 순차 실행했다.
3. `npx eslint scripts/ops/preflight.mjs scripts/ops/preflight.test.mjs scripts/ops/release.mjs scripts/ops/release.test.mjs`: 종료 0.
4. `npm run scan:secrets`: 통과. `git diff --check`: 통과.
5. 실제 CLI 파일 입력: nginx `11m` + worker `on-failure/10s/0` → PASS/PASS, 종료 0. nginx `1m` → FAIL/PASS, 종료 1.
6. 격리 환경 기본 소스로 `node scripts/ops/preflight.mjs`: nginx 파일 없음 및 systemctl 조회 불가 → NOT_RUN/NOT_RUN, 종료 0. 운영의 실제 설정이 적합하다는 판정은 하지 않았다.

| 조건 | 결과 | 실행 증거 |
| --- | --- | --- |
| AC-1 | PASS | preflight 시험: 누락/1m/10m/0/정확 경계값 FAIL, 11m·단위 변형 PASS, 주석·중첩 location·상속·여러 server 검사 |
| AC-2 | PASS | preflight 시험: Restart=no·간격0·유한 시작 제한 FAIL; on-failure/always + 양수 간격 + 제한0 PASS |
| AC-3 | PASS | release 시험: nginx/worker FAIL 모두 WAITING_PREFLIGHT, current 불변. 파일 없음 및 실제 비특권 UID의 EACCES는 NOT_RUN. NOT_RUN 허용 및 PASS 전환 확인 |
| AC-4 | PASS | 기존 bundle/release 포함 총 9/9 통과, ESLint·비밀 검사·diff 검사 통과, 자동 명령과 한계 문서화 |

Mandu 이미지(실제 명령 출력을 HTML로 렌더링한 **REPRODUCTION**, 운영 화면 아님):

- BEFORE upload `2e1dfb15-74d1-4342-87d3-94f1f29b0a37`: 기준 HEAD·clean status·사전 점검 부재.
- AFTER upload `4cc347cd-57a9-4a29-b452-da75e7dfe9fd`: 순차 시험 결과와 CLI PASS/FAIL/NOT_RUN.

## 한계

외부 include는 자동 전개하지 않으며 NOT_RUN으로 남긴다. nginx의 완전한 구문 검증은 관리자 `nginx -t`와 실효 설정 확인이 필요하다. 모든 HTTPS 하위 location을 보수적으로 검사한다. worker의 실제 DB 장애 복구 및 RestartPreventExitStatus 확인은 기존 수동 체크리스트 대상이다. 운영 nginx·worker 상태 검증, DB/Redis 통합 시험, 제품 UI 시험은 이번 스크립트 변경 범위에서 수행하지 않았다. 실제 배포는 수행하지 않았다.
