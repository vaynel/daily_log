# TASK-138 / TASK-32 통합 검수 실행

기준: `edfca7ac3ffbb98f51158e7ff9aea50be3e872ff`. 제품 결함 수정 금지, 배포 없음.
환경: 제공된 격리 PostgreSQL의 시험별 임시 스키마, 합성 데이터, 가짜 마이크/Live/Pro/TTS/이미지/Drive. Android는 Playwright Pixel 7 에뮬레이션이며 실기기는 TASK-33 사용자 확인 대상.

## 시나리오 매핑

Wiki 09 원문은 저장소에 없고 scoped Mandu MCP에 Wiki 읽기 기능이 없어 미열람. 아래는 **Task 패킷의 범위와 AC 및 기존 구현/시험에 매핑한 실행표**이며 Wiki 09 전체 충족을 주장하지 않는다. 원문 대조는 NOT_RUN으로 남긴다.

| 키 | 요구/관련 Task | 기대 결과 | 실행 증거 | 실제 결과 |
|---|---|---|---|---|
| S01 정상 | AC-2 / TASK-17,20,122,124 | 글 입력 없이 음성→첨부→브리핑→제작→수정→다운로드 | scripts/task138-e2e.mjs; integration.txt/json | 정상 흐름 desktop/Pixel7 PASS; 영구 삭제 잔존 검사 FAIL(별도) |
| S02 경계 | AC-2,3 / TASK-17 | 앱 새로고침 후 같은 대화 복구 | 통합 하네스 DB 항목 비교 | PASS — reload 후 저장된 4항목 동일 |
| S03 장애 | AC-3 / TASK-11 | 저장 도중 SIGKILL 후 원본 보존 | records-crash.txt | PASS — 확인된 5항목·5첨부 보존, 중간 트랜잭션 부분 저장 0 |
| S04 장애 | AC-3 / TASK-15,122 | 렌더·TTS 도중 종료 후 재개, 응답 유실 재전송 0 | pipeline-restart.txt, queue-restart.txt | PASS — 재전송 0, 원장 유지, 확인 대기/재개 정책 준수 |
| S05 경계 | AC-3 / TASK-13,105 | 예산 대기, 처리 재시도 1회·품질 재제작 1회 분리 | server.txt, quality-restart.txt | PASS — server 523건 및 quality-restart exit0 |
| S06 권한 | AC-4 / TASK-10,124 | 익명 401, 비허용 403, 타인/미통과 파일 차단 | server.txt, 통합 하네스 직접 URL 검사 | 익명/비허용 PASS; 다른 허용 계정·미검수 우회 FAIL(Q138-01/02) |
| S07 개인정보 | AC-4 / TASK-29,31 | 삭제·만료 정책, 백업/완성본 유지, 자격증명 비노출 | server.txt retention/backup/auth, 통합 하네스 sentinel | DB 보관·삭제 시험 PASS; 실제 음성 세션 전사 잔존 FAIL(Q138-03) |
| S08 장애 | AC-1,3 / TASK-27,31 | 모의 Drive 응답유실·권한·용량 실패 안전 | server.txt backup/restore | PASS — backup/restore 포함 server 전체523; 통합 백업 VERIFIED |
| S09 실패·경계 | AC-1,5,6 / TASK-32 | 실패/미실행 구분, P0~P2 미해결 시 출시 통과 금지 | 본 문서 결함 및 AC 판정 | PASS — 실패/미실행 구분, 출시 BLOCKED(미해결 P1 2건/P2 1건) |

전체 실행 결과와 결함을 아래에 기록했다. 이 문서는 실행 증거이며 최종 독립 검수·출시 승인은 PM 범위다.

## 재실행

저장소 안에서 `npm ci` 후, 제공된 격리 `DATABASE_URL`과 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`를 사용한다. 실제 계정·유료 API 키를 설정하지 않는다.

```sh
mkdir -p /workspace/.tmp
UV_THREADPOOL_SIZE=2 TMPDIR=/workspace/.tmp node scripts/task138-checks.mjs
UV_THREADPOOL_SIZE=2 TMPDIR=/workspace/.tmp node --import tsx scripts/task138-access.mjs
# 위 프로세스 종료 후 브라우저 한 개, 프로필별 순차 실행:
UV_THREADPOOL_SIZE=2 TMPDIR=/workspace/.tmp node --import tsx scripts/task138-e2e.mjs
```

`task138-checks.mjs`는 build → 서버(단일 worker) → web → 기록/큐/제작/품질 SIGKILL → lint → typecheck를 순차 실행하고 각 종료 코드·시각을 checks.json에 남긴다. access/e2e 실패 종료 코드는 발견한 결함의 재현 증거가 될 수 있으므로 무조건 PASS로 바꾸지 않는다. 모든 데이터는 합성이고 테스트 스키마는 종료 시 제거한다. `.tmp`는 제출 대상이 아니다.

통합 시험의 대체 경계: 마이크는 WAV 톤, Live는 localhost WebSocket, Pro는 고정 합성 발화 정리, TTS/이미지/품질 판독은 기존 모의 제공자다. DB·라우트·큐·FFmpeg·브라우저·다운로드·Drive HTTP 클라이언트는 실제 코드를 호출한다. 로그인 세션은 시험 서명으로 발급하며 실제 Google 로그인은 실행하지 않는다(모의 OIDC는 기존 서버 인증 시험에서 별도 실행). 브라우저 시나리오의 수정은 '영상에서 빼기' 버튼이다. 실제 음성 인식 품질, 실기기, 운영 설정 전체 조합을 증명하지 않는다.

## 재현된 결함 (제품 코드 수정 없음)

### Q138-01 / P1 / OPEN — 일반 파일 경로의 소유자 검사 누락

- 재현: `node --import tsx scripts/task138-access.mjs`. 소유자 A의 첨부·영상 파일 생성 → 허용 목록의 다른 계정 B(다른 sub/email) 세션으로 직접 GET.
- 기대: 타인의 파일은 403/404, 본문 없음.
- 실제: `/api/records/:id/result/file` 및 `/results/1/file`은 404이나 `/api/videos/rejected.mp4`, `/api/attachments/private.md`는 200 + 합성 비공개 바이트.
- 증거: `task-32-evidence/access.json`의 `other-allowed` 4행, `access.txt` 종료 1. 파일명 사전 인지가 전제이며 비로그인 공개 접근으로 확대 해석하지 않는다.
- 원인 위치: `apps/server/src/auth/plugin.ts` 일반 파일 라우트는 허용 이메일만 검사한 뒤 파일을 반환하며 소유자 연결을 조회하지 않는다.

### Q138-02 / P2 / OPEN — 일반 영상 경로로 검수 차단 우회

- 같은 시험에서 production=DONE/review=REJECTED 상태·파일 존재를 구성.
- 기대: 검수 미통과 영상 직접 접근 차단.
- 실제: 소유자 세션의 기록별 파일 경로는 409지만 `/api/videos/rejected.mp4`는 200 + 영상 바이트.
- 증거: `access.json`의 `owner` 행. 일반 파일 라우트가 기록별 검수 판정을 거치지 않는다.
- Q138-01과 같은 라우트 계열이나 우회하는 조건이 다르다. PM의 별도 수정 Task와 독립 재검증이 필요하다.

### Q138-03 / P1 / OPEN — 영구 삭제 후 음성 세션 JSON 전사 잔존

- 재현: 통합 하네스에서 가짜 마이크로 2턴 이상 발화 → 종료 → `trashRecord` 및 실제 `RetentionService.purgeNow` 실행 → DB와 해당 실행의 sessionDir 검사.
- 기대: 영구 삭제된 기록의 서버 전사 사본도 제거되어야 한다(완성 영상·Drive 백업은 정책상 보존 대상).
- 실제: desktop/Pixel 7 모두 conversation_items=0이나 `live-*.json` 1개 이상에 userText/replyText가 남는다.
- 증거: `task-32-evidence/privacy.json`, `integration.txt`. 합성 텍스트 원문 대신 파일 수·DB 행 수만 보고한다.
- 원인 위치: `voice/live.ts`의 LiveSessionStore는 전사 JSON을 별도 저장하고, `retention/service.ts` purgeRecordTx는 DB·첨부를 정리하지만 sessionDir과의 연결/삭제를 수행하지 않는다. 파일 권한 0600 여부와 별개로 삭제 완료 후 잔존한다.

## 하네스 시행착오 (제품 결함과 분리)

- `integration-harness-initial.txt`: 첨부 패널 열기 클릭을 빠뜨려 숨겨진 완료 요소의 visible 대기 실패. 클릭을 추가했다. 음성 생성 전이므로 이 실행의 개인정보 검사에는 유효한 입력이 없으며 PASS 근거로 사용하지 않는다.
- `integration-first-render.txt`, `integration-short-learning.txt`: 공용 모의 장면 제공자가 두 번째 짧은 발화를 LEARNING으로 강제해 음성 길이(약 1초)가 학습 확대 최소 2.5초에 못 미침(ZOOM_FAILED). 일반 합성 발화에 맞게 **모의 제공자만 DAILY로 설정**했다. 제품 검증 조건/최소 시간은 변경하지 않았다. 학습 확대 경계는 기존 서버 시험으로 별도 검증했다.
- `integration-ui-race.txt`: 수정 응답 안내 표시와 상세 재조회가 비동기로 처리되어 desktop에서 재조회 전 다운로드 링크 수를 읽음. 링크가 실제로 제거되는 상태를 기다린 뒤 동일한 0건 검증을 하도록 보완했다. Pixel 7의 전체 흐름은 이 실행에서도 통과했다.


## 최종 실행 결과 / 2026-11-03 UTC

| 검사 | 실제 결과 | 증거 |
|---|---|---|
| build, lint, server/web typecheck | PASS, 각 exit 0 | build.txt, lint.txt, typecheck.txt, checks.json |
| 서버 전체 | 38파일 523/523 PASS, 369.12초 | server.txt |
| 웹 전체 | 6파일 39/39 PASS | web.txt |
| 기록·큐·제작·품질 재시작 | 모두 exit 0 | records-crash.txt, queue-restart.txt, pipeline-restart.txt, quality-restart.txt |
| 직접 파일 접근 추가 시험 | exit 1, 의도한 보안 불변조건 실패 | access.txt/json, Q138-01/02 |
| desktop 1280x800 / Pixel 7 | 정상 통합 경로 2/2 PASS | integration.json, desktop/pixel7-complete/revised.png |
| 영구 삭제 후 전사 잔존 | 두 프로필 모두 FAIL; 통합 명령 최종 exit 1 | privacy.json, integration.txt, Q138-03 |

통합 정상 경로: 파일 선택만으로 Markdown 첨부, 가짜 마이크 2턴, 일시정지·새로고침 후 DB 항목 동일, 대화 종료, 브리핑 생성/버튼 확인, 실제 제작 완료, 첫 MP4 다운로드와 저장 파일 SHA256 대조, 영상에서 빼기 버튼, 재제작 중 현재 다운로드 제거, 두 번째 RESULT와 다운로드 SHA256 대조, 제외 문장의 내레이션/자막 제거, 원본 대화 보존, 모의 Drive RECORD/ATTACHMENT/VIDEO 검증. `fill()`/키보드 글 입력 없음. 모의 fetch 외부 호출 0.

최종 두 번째 다운로드 SHA256(동일 합성 입력): `ff7cc8cd8dc9ba3d95b8475cdd2eb480a04b673757b23e58d720a6991bef148d`.

## AC 판정

| 원 완료 조건 | 판정 | 근거/한계 |
|---|---|---|
| AC-1 필수 시나리오 기대·실제·증거 | PARTIAL | 패킷 범위 S01~09는 실행·기록. Wiki09 원문 전체 대조는 접근 불가로 NOT_RUN; 독립 검수/PM 대조 필요. |
| AC-2 글 입력 없이 기록~수정·다운로드 | PASS | desktop/Pixel7 정상 경로 2/2, 버튼 수정, MP4 바이트 해시 대조. 실기기는 TASK-33 이관. |
| AC-3 중단·재시작 원본·중복·횟수 | PASS | 실제 SIGKILL 4스크립트, 응답유실 확인 대기·재전송0, retry/quality 각각1 유지. |
| AC-4 비로그인·비허용 파일 차단 | PASS | 해당 두 인증 범주 각4경로에서 401/403 및 비공개 바이트0. 다른 허용 계정 소유권 및 검수 우회는 별도 FAIL 결함이며 전체 보안 통과를 뜻하지 않음. |
| AC-5 미실행을 PASS 처리하지 않음 | PASS | 아래 NOT_RUN 및 하네스 오류/제품 결함 구분, access/integration exit1 보존. |
| AC-6 미해결 P0~P2 시 출시 통과 금지 | PASS | P1 2건/P2 1건 OPEN. **출시 판정 BLOCKED**. 제품 수정 및 재검수 없이 통과 불가. |

NOT_RUN: Wiki09 원문 대조(현재 저장소/scoped MCP 미제공); 실기기 Android/PC·실제 사용자 기록(TASK-33); 실제 Google/Gemini/Pro/Drive(금지 범위); 운영 배포(금지). 이번 실행에서 npm run check의 SIWC/spike/notify 별도 스크립트와 그 밖의 기존 브라우저 스크립트 전수 실행은 하지 않았으며 정상 통합 하네스와 관련 전체 server/web 시험으로 범위를 정했다. 브라우저의 실제 canplay/오디오 청취 품질은 검증하지 않았으며 다운로드 파일 바이트·실제 FFmpeg 결과만 검증했다.

읽은 참조: Mandu get_task/begin_task 고정 패킷과 선행 보고, Task-owned plan, /run/mandu/MANDU-HANDOFF.json 불변 근거, README, app.ts, auth/plugin/session/config, interview routes/usage 및 Live mock, voice/live.ts, briefing routes/briefing, records store/routes/revision, video pipeline-harness/pipeline.test/narrationStage/zoom, backup service/drive/backup.test/fakeDrive, retention service/retention.test, 기존 재시작/E2E 스크립트. 선행 보고 PASS는 이번 실행의 증거로 대체하지 않았다.

최종 하네스 변경 뒤 eslint 대상4파일 exit0, scan-secrets 514files OK, git diff --check PASS. 이전 하네스 실패 화면은 `*-harness-history.png`로 구분했으며 최종 정상 화면은 `*-complete.png`/`*-revised.png`이다. BEFORE/AFTER 출력 이미지는 실제 저장 로그를 렌더링한 REPRODUCTION이며 제품 화면으로 가장하지 않았다.

로그는 제출 diff 검사를 위해 마지막 빈 줄만 정리했다(내용·실패는 유지). Pixel 7 Playwright 정의의 실제 viewport는 412x839이다. Mandu 첫 UI 첨부의 viewport 393x851 표기는 오기이며, 동일 바이트를 412x839 메타데이터로 정정 재첨부했다.
