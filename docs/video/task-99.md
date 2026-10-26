# TASK-99 — 실제 DB fixture 격리 및 복구 증거

기준 HEAD: `ec9f4fdd87141c848cc9b5927998db8b42c70415`.
브랜치: `task-99-fixture-isolation`. 실행: `ada2f8a4-071a-4741-8f1f-cfb7b7cb493d`.
제출 SHA는 이 문서와 원시 로그를 포함하는 Git 커밋 및 Mandu report의 40자리 commit 필드로 식별한다.

## 변경 및 적색 → 녹색

`qualityStage.test.ts`의 두 매개변수 사례가 동일한 schema에서
`owner_id=fixture`, `life_date=2030-01-01`을 재사용했다.
실제 주입 PostgreSQL에서 수정 전 32 PASS/1 FAIL, exit 1로
`interviews_owner_id_life_date_key` 충돌을 재현했다([red.log](task-99-evidence/red.log)).
각 사례의 UUID로 합성 owner를 만들도록 INSERT만 변경했다.
날짜, 제약, 모든 검증 assertion, F97 장면 경계 차단 및 제품 로직은 그대로다.
같은 명령을 다시 실행하여 33 PASS/0 FAIL/0 SKIP, exit 0을 확인했다([green.log](task-99-evidence/green.log)).

## 재실행 명령

제공된 격리 DATABASE_URL/REDIS_URL 및 FFmpeg/ffprobe/Chromium 환경에서 저장소 루트로 실행한다.
환경변수 값은 출력하지 않는다. 의존성은 기존 lockfile의 `npm ci`만 사용했다.

```sh
npm ci
npm test -w apps/server -- src/video/quality.test.ts src/video/qualityQueue.test.ts src/video/qualityStage.test.ts
npm run build -w apps/server
node scripts/quality-restart-e2e.mjs
npm run check
git diff --check
npm run scan:secrets
```

각 명령은 `> docs/video/task-99-evidence/<name>.log 2>&1`로 원시 출력을 저장하고,
바로 다음에 `result=$?; echo "exit_code=$result" >> <log>`로 실제 종료코드를 기록했다.
수정 전 재현은 기준 SHA에서 같은 품질 3파일 명령을 실행하면 된다.

## 서비스 및 복구 검증

- [services.log](task-99-evidence/services.log): 주입된 PG에 `SELECT 1`, 주입 Redis에 RESP `PING`을 보내 각각 1/PONG 확인, exit 0. 접속 URL/인증값은 출력하지 않았다.
- 큐 구현에는 Redis 클라이언트가 없다. Redis 결과는 접속 확인이며 Redis 기반 작업 복구의 증거가 아니다.
- [green.log](task-99-evidence/green.log): `qualityQueue.test.ts`의 복합 오류 시험은 실제 PG에서 품질 실패 후 `(quality,retry)=(1,0)`, 처리 실패 후 `(1,1)`, 새 JobQueue 인스턴스에서도 `(1,1)` 및 QUALITY_EXHAUSTED를 검증한다. 예산/권한 대기·동시 사유도 포함한다.
- [build.log](task-99-evidence/build.log): 서버 빌드 exit 0.
- [quality-restart.log](task-99-evidence/quality-restart.log): 기존 스크립트가 q1 렌더 중 별도 OS 프로세스를 SIGKILL하고 실제 종료 signal을 확인한 뒤 새 프로세스를 시작했다. 최종 quality=1/retry=1, FAILED/QUALITY_EXHAUSTED, source attempts=1, reviews=2, exit 0. 렌더 처리기는 합성이며 실제 MP4는 qualityStage에서 별도 검증했다.

## TASK-26 AC별 현재 증거

이 표는 TASK-99 범위의 현재 실행 증거다. 원 TASK-26/97의 승인이나 재작업 횟수 변경이 아니다.

| 원 조건 | 현재 실행 판정 | 근거 및 한계 |
| --- | --- | --- |
| AC-1 제외 내용이 남으면 미통과 | PASS (합성 회귀 범위) | quality 단위 25건 및 실제 MP4/PG cross-scene 통합 통과. F97 수정 보존. 실제 모델 의미 판정 정확도는 미검증. |
| AC-2 같은 작업 품질 재제작 최대 1회 | PASS | qualityQueue 반복 실패·권한/예산 대기 및 qualityStage q0/q1 검증. 원래 DB CHECK 보존. |
| AC-3 처리 오류와 품질 카운터 분리 | PASS | 실제 DB 복합 오류에서 (1,0)→(1,1); SIGKILL 복구에서도 각각 1. |
| AC-4 재시작 후 횟수 유지 | PASS | 실제 SIGKILL 종료 확인 및 새 OS 프로세스 복구 exit 0. 완료 source 단계 재실행 없음. |
| AC-5 미통과 정상완료·공개가능 표시 금지 | PASS (서버 통합 범위) | qualityStage에서 REVIEW_REJECTED, 실패 파일 SHA 보존, 자막만 재제작, 통과 후 COMPLETED; qualityStatus publishable=false 검증. 이번 작업의 품질 UI 브라우저 검사는 NOT_RUN. |

## 참조와 범위 제한

읽은 자료: Mandu get_task/begin_task 고정 패킷과 공유 계획, `/run/mandu/MANDU-HANDOFF.json`, README,
TASK-26/26-rework/97 문서, quality/qualityStage 및 3개 시험, DB fixture 유틸, migrations 0002/0010,
quality/queue restart 스크립트, notify-e2e 및 scan-secrets 스크립트.
패킷의 systematic-debugging/TDD/verification-before-completion과 고정 커밋의 writing-good-tests를 적용했다.
Wiki/Flowchart 원문은 scoped 도구에 없어 미열람이며, 과거 host 경로의 infra-probe 로그도 사용하지 않았다.

제품 API·유료 provider·실제 STT/그림 의미 판정·사용자 기록·Android 실기기·운영 worker 연결은 미실행이다.
runner/controller/guard/service, 제품 코드, package/lockfile, 원 TASK26/97 이력과 품질 예산은 변경하지 않았다.
새 패키지 추가, 운영 DB 접근, 호스트 Docker, 배포, 원격 push 및 artifact publication은 수행하지 않았다.
독립 QA가 제출 SHA를 검증하고 PM이 원 작업의 반영 여부를 판단해야 한다.
