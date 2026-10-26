# TASK-100 독립 검수 — PASS

검수 대상 TASK-99 제출 `e2e57b563f9a749ab39896ccc6182c644ed81773`,
tree `8a315dd3b5a6f936db22891d24727857b7b8f8cd`.
선행 run `1c639762-ccfb-4d19-a780-bd8bf1c14f63`, 검수 run
`26885ab9-5a7f-4fc3-ab42-349f364bef11`.
`/run/mandu/MANDU-HANDOFF.json` 불변 증거와 scoped get_task의 고정 선행 제출을 대조했다.
제품·기존 시험·마이그레이션·패키지 및 원 TASK26/97/99 이력은 수정하지 않았다.

## TASK-99 완료 조건 대조

| 조건 | 독립 확인 | 근거 |
| --- | --- | --- |
| AC1 ec9f4fd 누출 수정·고유제약 보존, fixture 충돌 수정, 품질 3파일 무skip | PASS | `source-audit.log`: apps 변경은 qualityStage.test.ts owner UUID 격리뿐. `fixture-probe.log`: 실제 PG에서 기존 owner/date 중복이 23505로 거절되고 고유 owner 2건은 삽입된다. `quality.log`: 3파일 33/33, skip0, exit0. `cross-scene.log`: TASK97 독립 반례에서 동일/다른 장면 모두 false. |
| AC2 실제 서비스·별도 카운터·SIGKILL | PASS | `services.log`: 주입 PG SELECT1, Redis PONG. qualityQueue의 (q1,retry0)→(q1,retry1) 및 권한/예산 대기 시험 통과. `quality-restart.log`: 실제 SIGKILL 종료 signal 확인 뒤 새 OS 프로세스 복구, q1/retry1, FAILED/QUALITY_EXHAUSTED, source attempts1/reviews2, exit0. |
| AC3 전체 검사·원TASK26 증거·제약 분리 및 새 commit | PASS | 제출 SHA 및 문서/원시 로그 대조. 이번 단일 npm run check exit0. 과거 실패·skip 및 미실행 범위를 분리했고 제품/원 이력 변경 없음. |

이번 증거는 `task-100-evidence/`에 있다. 선행 `task-99-evidence/red.log`의 32 PASS/1 FAIL은
개발 C의 역사적 실행이며 이번 실행으로 바꾸어 표현하지 않는다. 이번 fixture probe는 동일
DB 제약을 직접 재현하는 별도 검사이며 과거 33개 전체 적색 실행과 구분한다.

## TASK-26 AC1~5 연결

| 조건 | 이번 검증 결과 | 범위와 한계 |
| --- | --- | --- |
| AC1 제외 내용 미통과 | PASS, 합성 회귀 범위 | quality25건 및 TASK97 독립 장면경계 반례, 실제 MP4/PG cross-scene 통합. 실제 모델 의미 정확도는 NOT_RUN. |
| AC2 품질 재제작 최대1회 | PASS | qualityQueue/qualityStage q0/q1, DB CHECK 0~1, 권한/예산 대기. 품질 예산·이력 리셋 없음. |
| AC3 처리/품질 독립 카운터 | PASS | 실제 PG 복합 오류와 SIGKILL 복구에서 각각1, 안정 단계 재사용 확인. |
| AC4 재시작 후 횟수 보존 | PASS | q1 처리 중 SIGKILL 및 종료 확인, 새 프로세스 복구. 렌더 핸들러는 합성, 실제 MP4는 별도 qualityStage에서 검증. |
| AC5 미통과 정상완료/공개 표시 금지 | PASS, 서버 범위 | REVIEW_REJECTED, publishable=false, 실패 파일 SHA 유지, 자막만 재생성, 재검수 성공 후 COMPLETED. 품질 UI 브라우저 검수는 이번 NOT_RUN. |

F03 inspect/retryAllowed 대조: `qualityStage.ts:36`의 inspectQuality 결과를 실제 파일 SHA와
ffprobe 결과에 연결한다. 실패 시 현재 permissionGranted와 구성 요소별 repairStages를
QualityRejectedError로 전달한다. `queue.ts:306` 이후 행잠금 아래 품질 사용횟수·권한·예산을
검사하고 사유가 없을 때만 1회 증가한다. 소진 시 FAILED, 권한/예산 대기는 WAITING이다.
qualityQueue 5건과 qualityStage 3건이 이 경계를 실행한다. scoped MCP에는 Wiki/Flowchart
조회 도구가 없어 F03 원문 대조는 미실행이며 제공 패킷/코드의 해당 동작을 확인했다.

## 실패·skip·환경 제약

- B 제출은 최초 vitest 미설치 exit127, test timeout124, notify pthread EAGAIN exit1,
  실행 중 wrapper 편집 EOF exit2를 보존한다. 이후 단계별 재실행 통과를 단일 전체 check
  성공으로 과장하지 않은 점을 원시 로그와 대조했다.
- C 보존 check.log exit0는 역사적 증거다. 서버411/웹29, CLI37 PASS/4 SKIP과
  품질33/33 무skip은 서로 다른 검사다.
- Windows 전용 4건: cmd launcher, CurrentUser storage, rejected oversize transaction,
  owner-exit lock. Linux에서 미실행이다.
- 알림 E2E Android-emulated는 데스크톱 Chromium의 모바일 설정이며 Android 실기기 검증이 아니다.
- 주입된 격리 DATABASE_URL/REDIS_URL만 사용. Redis는 PING 연결 검사이며 큐는 PG다.
  의존성은 `/workspace/node_modules`의 기존 lock npm ci. 제공 브라우저 경로 사용.
- 실제 STT, 그림/의미 모델 정확도, 유료 provider, 실계정/사용자 원문, Android 실기기,
  운영 worker 연결 및 품질 화면 시각 검수는 NOT_RUN. 기존 worker 등록/의미 판정 주입 경계는
  원 TASK26 통합의 남은 범위이며 이번 fixture 수정의 신규 결함으로 주장하지 않는다.
- npm ci는 exit0이며 기존 의존성의 moderate 2건을 알렸다. 패키지 변경/감사 수정은 하지 않았다.

## 실행 명령과 재현

`bash docs/video/task-100-evidence/run.sh`: 품질3파일 → server build → 실제 quality-restart →
단일 `npm run check` 순서, 각각 원시 출력과 종료코드 기록. `fixture-probe.mjs`는 현재 작업
디렉터리에서 주입 DB의 임시 schema에 마이그레이션을 적용하고 종료 시 해당 schema를 제거한다.
독립 누출 반례: `node --import tsx docs/qa/task-97-evidence/cross-scene.ts`.
서비스 확인은 pg SELECT1 및 주입 Redis TCP PING이며 URL/인증정보는 기록하지 않았다.

읽은 자료: README, package scripts, 불변 handoff, Mandu packet/common plan 및 선행 보고,
TASK26/26-rework/97/99/B 문서와 원시 로그, quality/qualityStage/qualityQueue 및 시험,
db.testutil, migrations0002/0010, queue 품질 실패 경로, quality-restart/notify 스크립트.
패킷 verification-before-completion 적용. 로컬 AGENTS.md 없음.
Wiki/Flowchart 원문 및 과거 host 경로는 미열람. 배포·push·artifact publication·runner 조작 없음.

이 검수는 TASK99 제출에 대한 독립 판정이며 원 TASK26 최종 승인이나 출시/배포 승인이 아니다.

## 최종 실행과 판정

독립 판정 **PASS (TASK99 제출 범위)**. 필수 신규 결함은 발견하지 않았다.
핵심 안전 조건은 기존 owner/date 고유제약과 제품 로직을 유지하면서 각 fixture만 다른
소유자로 격리하는 것이다. 실제 DB 충돌/격리 probe와 정확한 제출 SHA의 품질33/33으로 증명했다.

| 이번 검사 | 결과 |
| --- | --- |
| npm ci | exit0, 기존 lock 사용 |
| 품질 3파일 | 33 PASS / 0 FAIL / 0 SKIP, exit0 |
| fixture 충돌/격리 probe 및 TASK97 반례 | 각각 exit0 |
| PG SELECT1 / Redis PING | PASS / PONG, exit0 |
| server build / 실제 quality SIGKILL | 각각 exit0 |
| 단일 npm run check | exit0; lint/typecheck, 서버411 PASS(264.23초), 웹29 PASS, CLI37 PASS/Windows4 SKIP, build, spike5 PASS, records-crash, queue-restart, notify PC/Android-emulated PASS |

품질33/33 무skip과 전체 check의 Windows4 skip을 구분한다. 전체 실행 로그는
`task-100-evidence/check.log`, 명령·단계 종료는 `run.sh`/`stages.log`에 보존했다.
검수표와 증거만 새 커밋으로 제출하며 Mandu에 AC별 근거·독립 PASS·사람 검토 요청을 등록한다.
TASK100 자체 AC1(고정 SHA 검수표), AC2(원TASK26 증거/제약 구분), AC3(독립 판정과 승인 경계)는 PASS.
