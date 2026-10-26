# TASK-97 독립 검수 — CHANGES_REQUESTED

검수 대상: TASK-26, commit `991db74b8d102afefe6a50544224717fd3cf44dd`, tree `d84ef3f755d2b6cefa2bf9c632cf74f17b7aa682`.
Mandu 선행 run `413da952-9985-448f-8902-9811d93550bf`와 `/run/mandu/MANDU-HANDOFF.json`의 immutable 제출과 실제 HEAD/tree를 대조했다. 검수 run `243a3032-e2c9-4f79-b6bc-9ca46e3ceb18`. 제품 코드는 수정하지 않았다.

## 원 개발 AC 대조표

| TASK-26 조건 | 판정 | 독립 근거 |
| --- | --- | --- |
| AC-1 한 구성 요소라도 공개 제외 내용이 남으면 미통과 | FAIL | 기존 단일 구성 요소 누출 시험 통과. 추가 장면 경계 반례에서 제외된 정확한 문구가 두 장면 자막으로 나뉘면 passed=true. `cross-scene.ts`, `cross-scene.txt` |
| AC-2 같은 작업 품질 재제작 최대 1회 | PASS | qualityQueue 반복 실패·부분 재실행, PG CHECK 0~1·행 잠금 확인. 실제 MP4 통합시험 포함 targeted-retry.txt 29/29 |
| AC-3 처리 오류와 품질 카운터 분리 | PASS | 품질 실패 후 quality=1/retry=0, 처리 실패 후 각각1, 최종소진. qualityQueue 시험·restart.txt |
| AC-4 재시작 후 횟수 유지 | PASS | 별도 워커 q1 중 SIGKILL, 종료 확인 후 새 프로세스 복구. quality=1/retry=1, FAILED/QUALITY_EXHAUSTED, source attempts=1, reviews=2 |
| AC-5 미통과 결과 정상완료·공개가능 표시 금지 | PASS | 실제 FFmpeg/PG 통합: 거절 상태, q0 파일 SHA 보존, 재검수 통과 후 COMPLETED. qualityStatus false, 실제 React DOM 검수 미통과·두 사유 확인. 단, AC1의 잘못된 통과 판정은 별도 필수 결함 |

## 필수 수정 F97-1 — P1

`apps/server/src/video/quality.ts:32`~43은 장면 내부에서만 문구를 결합한다. 영상 전체에서 이어지는 같은 구성 요소의 내용을 검사하지 않는다.

재현: `node --import tsx docs/qa/task-97-evidence/cross-scene.ts`.
합성 안전 입력에 `excludedTexts=['비공개 프로젝트']` 설정. 자막을 한 장면의 `['비공개','프로젝트']`로 넣은 대조군은 passed=false. 두 장면의 자막 `['비공개']`, `['프로젝트']`로 나눈 입력은 passed=true, 실패 검사 0개다. 기대값 false인 독립 assert가 exit1로 실패한다. 의미 분류 모델 정확도 문제가 아니라, 이미 확정된 동일 제외 문구의 장면 경계 검사 누락이다.

원 담당 필수 조치: 영상 순서에 따른 구성 요소별 연속 내용을 검사하여 장면 경계 누출도 차단하고, 영향 장면/재생성 단계를 식별한다. 기존 같은 장면 차단·안전 입력 통과를 유지하면서 여러 장면의 자막 및 다른 연속 구성 요소에 회귀 시험을 추가한다. 수정 후 독립 재검수 필요. 검수자가 제품 코드를 수정하거나 최종 승인하지 않았다.

## 실행 및 환경

- `npm ci` 성공. 제공된 격리 DATABASE_URL의 임시 schema를 사용했다. REDIS_URL은 미주입이며 이 PG 큐 시험에는 불필요하다.
- 최초 대상시험: 28 PASS/1 FAIL (`spawnSync ffmpeg ENOENT`), targeted.txt에 보존.
- `/workspace/data/qa-tools`에 시험 전용 ffmpeg-static/ffprobe-static 설치 후 PATH 지정 재실행: 29/29 PASS, 4파일, skip 없음 (`targeted-retry.txt`). 제품 package/lock 변경 없음.
- `npm run build -w apps/server`: exit0 (`build.txt`).
- `node scripts/quality-restart-e2e.mjs`: exit0 (`restart.txt`). 실제 프로세스 복구 시험이지만 렌더/STT 처리기는 합성이다. 실제 MP4는 별도 qualityStage 시험에서 검증했다.
- `node scripts/task97-ui-review.mjs AFTER`: exit0 (`ui.txt`). 기존 UI 스크립트의 출력 위치만 QA 디렉터리로 변경. 제공 Chromium으로 실제 React·합성 API를 검사했다. 선행 BEFORE/AFTER 실제 이미지도 read_screenshot으로 확인했다.
- REVIEW 스크린샷 실제 바이트를 지정 attach-screenshot 도구로 첨부했다(upload c616ed51-2fab-4ffc-b792-948c4a408a21). 한글 폰트 부재로 글리프가 사각형으로 보이므로 시각적 한글 가독성 PASS는 주장하지 않는다. DOM 한글 문구·상태·사유 2개는 실제 assert로 확인했다.
- 전체 npm check/전체 서버·웹 회귀는 이번 검수에서 미실행. 기존 보고의 전체 PASS를 독립 재실행으로 간주하지 않았다.
- 실제 STT/의미·그림 판정/계정/유료 API/Android 실기기/운영 레지스트리 연결은 미검증. 기존 worker 빈 레지스트리 및 loadInput 주입 경계는 후속 통합 관찰 사항. 공개 SNS 서비스는 범위 밖이다.
- 유료 API 호출, 배포, push, runner claim/ACK/recovery, artifact publication 없음. 테스트 프로세스의 JobQueue.recover는 제품 복구 검증이며 runner recovery가 아니다.

## 참조와 검수 자체 AC

읽음: Mandu get_task/begin_task 고정 패킷·공통 계획·선행 TASK26 보고·immutable handoff, README, docs/video/task-26.md, quality/qualityStage 및 시험, queue/renderStage/store diff, migration0010, exclusion/view, restart/UI 스크립트와 선행 스크린샷. 패킷 verification-before-completion·pm-review-checklist 적용; 결함 원인 분석은 systematic-debugging 지침에 따라 대조군으로 재현했다. 로컬 AGENTS.md 없음. Wiki/Flowchart 원문은 scoped 도구 부재로 미열람. 전체 보안 감사나 실모델 정확도 검증을 주장하지 않는다.

검수 TASK97 AC1 PASS(개발 AC5개 표), AC2 PASS(독립 재현/제약 분리), AC3 PASS(근거 있는 CHANGES_REQUESTED와 필수 수정/후속 관찰 기록). PM의 검수 활동 판정 기준에 따라 개발 결함을 검수 AC 실패로 바꾸지 않는다. 최종 승인 및 재작업 배정은 권한 있는 PM/사람의 판단 대상이다.
