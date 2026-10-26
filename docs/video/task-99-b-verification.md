# TASK-99 개발 B 직접 검증

실행: `1c639762-ccfb-4d19-a780-bd8bf1c14f63`. 기준 및 부모:
`6da0c88fdb51770a3d91630e6b60ca01c51a9680`, 브랜치 `task-99-b-verified`.
제출 SHA는 Mandu report의 40자리 commit 필드와 이 문서를 포함하는 커밋으로 식별한다.

## 변경과 증거의 출처

PM이 보존한 fixture 수정은 각 사례의 UUID를 owner에 사용하여 동일 날짜의
`interviews_owner_id_life_date_key` 충돌을 없앤다. assertion, DB 고유 제약,
F97 전역 장면 누출 수정, 품질 예산과 제품 코드는 보존했다.
[fixture.diff](task-99-b-evidence/fixture.diff)는 ec9f4fd와 보존 커밋 사이 apps 변경 전체다.
이번 커밋은 그 수정의 후손이며, 단계별 검사 스크립트와 직접 실행 증거를 추가한다.

개발 C의 [red.log](task-99-evidence/red.log)는 실제 DB 32 PASS/1 FAIL,
고유 제약 충돌 exit1의 **역사적 증거**다. B가 적색을 새로 실행한 것으로 주장하지 않는다.
PM의 최신 지시에 따라 보존 SHA를 직접 검증했다. C의 기존 문서와 로그도 수정하지 않았다.
아래 `task-99-b-evidence`는 모두 이번 B 실행이다.

- `quality.log`: 최초 실행은 vitest 미설치, exit127. 숨기지 않고 보존.
- `install.log`: 기존 lockfile로 npm ci exit0. 새 패키지/lockfile 변경 없음.
- `quality-installed.log`: 품질 3파일 33 PASS, 0 FAIL, 0 SKIP, exit0.
- `services.log`: 주입 PG SELECT1, Redis PONG, exit0. URL/인증값 출력 없음.
- `build.log`: 서버 build exit0.
- `quality-restart.log`: 실제 별도 OS 프로세스 SIGKILL 종료 signal 확인 후
  새 프로세스 복구 exit0. quality=1, processing_retry=1,
  FAILED/QUALITY_EXHAUSTED, source attempts=1, reviews=2.

Redis는 연결 확인만 했다. 큐는 PostgreSQL을 사용한다. 복구 렌더 처리기는 합성이며,
실제 FFmpeg MP4와 실패 파일 SHA 보존은 qualityStage 시험에서 검증했다.

## 재실행

저장소 루트에서 제공된 격리 DATABASE_URL/REDIS_URL,
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 및 FFmpeg 환경을 사용한다. 값을 출력하지 않는다.

```sh
npm ci
timeout 120s npm test -w apps/server -- src/video/quality.test.ts src/video/qualityQueue.test.ts src/video/qualityStage.test.ts
timeout 120s npm run build -w apps/server
timeout 60s node scripts/quality-restart-e2e.mjs
bash scripts/task-99-check.sh
git diff --check
npm run scan:secrets
```

`task-99-check.sh`는 package.json의 check 8단계를 같은 순서로 각각 실행하며,
테스트는 480초, 다른 단계는 240초 제한과 실제 종료코드를 기록한다. 실패해도 다음 단계 결과를 수집한다.
따라서 단계별 실행 결과이며 단일 `npm run check` 호출 결과로 표현하지 않는다.

최초 단계 실행에서 test는 240초 제한으로 exit124였다. 이전 실행의 263초 소요를
확인하여 제한을 늘리고 `timeout --kill-after=10s 480s npm test`를 별도 실행했다.
최초 notify E2E는 이 테스트 재실행과 겹쳐 Chromium pthread_create EAGAIN으로 exit1이었다.
또한 실행 중 셸 스크립트를 편집한 B의 실수로 최초 wrapper 끝에서 EOF 구문 오류,
exit2가 발생했다. 각 단계 로그의 실제 종료코드는 보존했으며 최종 스크립트의
`bash -n`은 exit0이다. 최초 실행을 성공으로 바꾸지 않는다.

## 최종 검사 결과

| 단계 | 실제 결과 | 이번 원시 로그 (`task-99-b-evidence/`) |
| --- | --- | --- |
| lint | PASS exit0 | check-lint.log |
| typecheck | PASS exit0 | check-typecheck.log |
| test 최초 | TIMEOUT exit124 | check-test.log |
| test 재실행, 480초 제한 | PASS exit0; 서버411/411(261.06초), 웹29/29, CLI37 PASS/Windows 전용4 SKIP | check-test-480s.log |
| build | PASS exit0 | check-build.log |
| test:spike | PASS exit0, 5/5 | check-test-spike.log |
| test:records-crash | PASS exit0 | check-test-records-crash.log |
| test:queue-restart | PASS exit0 | check-test-queue-restart.log |
| test:notify-e2e 최초 | FAIL exit1, Chromium 스레드 자원 부족 | check-test-notify-e2e.log |
| test:notify-e2e 단독 재실행 | PASS exit0, PC/Android-emulated | notify-isolated.log |

알림 재검증 명령: `timeout --kill-after=10s 240s npm run test:notify-e2e`.
최종적으로 check의 모든 단계가 개별 실행에서 exit0이나 최초 wrapper는 exit2이며,
단일 전체 check 성공을 주장하지 않는다. 품질 전용은 33/33, skip 없음.
git diff --check, bash -n, scan:secrets도 제출 전 확인한다.

## TASK-26 AC1~5의 이번 증거와 한계

| 원 조건 | 이번 결과 | 증거 및 한계 |
| --- | --- | --- |
| AC1 제외 내용 미통과 | PASS, 합성 회귀 범위 | quality 25건과 실제 MP4/PG cross-scene. 실제 모델 의미 정확도 미검증. |
| AC2 품질 재제작 최대 1회 | PASS | qualityQueue/qualityStage q0/q1, 권한·예산 대기. DB CHECK 0~1 유지. |
| AC3 처리/품질 카운터 분리 | PASS | 실제 PG 복합 실패 (1,0)→(1,1), SIGKILL 후에도 각각 1. |
| AC4 재시작 후 횟수 보존 | PASS | 실제 SIGKILL 및 새 OS 프로세스 복구, source attempts=1. |
| AC5 미통과 정상완료·공개 표시 금지 | PASS, 서버 범위 | REVIEW_REJECTED, 실패 SHA 보존, 자막만 재제작, 통과 후 COMPLETED, publishable=false. 품질 UI 브라우저 시험은 NOT_RUN. |

이는 TASK-99의 fixture 검증이며 원 TASK-26/97의 전체 제품 승인이나 품질 재작업
카운터 리셋이 아니다. TASK-100의 독립 검수와 PM 판단이 필요하다.

읽은 참조: immutable `/run/mandu/MANDU-HANDOFF.json`, Mandu 현재 packet/공통 계획,
README, package scripts, TASK-99 및 TASK-26/26-rework, TASK-97 문서, 보존 red/green/check 로그,
qualityStage/qualityQueue 시험, db.testutil, migrations 0002/0010,
quality-restart 및 notify-e2e 스크립트. packet의 verification-before-completion 적용.
Wiki/Flowchart 원문과 과거 host infra-probe는 미열람.

실제 STT·그림 의미 판정·유료 provider·사용자 원문·Android 실기기·운영 worker 연결은
NOT_RUN. 운영 DB, host Docker, runner/controller/guard/service 변경, 배포,
원격 push 및 artifact publication은 수행하지 않았다.
