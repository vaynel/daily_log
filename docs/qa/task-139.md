# TASK-139 파일 권한과 전사 삭제

기준 커밋: `edfca7ac3ffbb98f51158e7ff9aea50be3e872ff`. 실제 격리 PostgreSQL 임시 스키마, 합성 파일, 로컬 모의 음성 서버만 사용했다. 배포·유료 API·운영 DB 사용 없음.

## 변경

- 일반 첨부 URL은 `attachment_refs → interviews.owner_id`와 삭제 상태를 확인한다. 연결 없는 디스크 파일도 404/빈 본문이다.
- 일반 영상 URL은 해당 소유자의 RESULT 버전을 조회하고 기록별 버전 URL과 같은 `displayStatus`/`resultVersionState` 판정을 사용한다. 미통과·대체된 미통과·표식 없는 오래된 버전은 차단한다. 검수 통과한 이전 버전은 기존 버전별 계약대로 열람할 수 있다.
- 제품 Live 세션은 생성 시 서버에서 검증한 `interviewId`를 기록한다. 종료 후 전사/사용량 저장 체인이 끝날 때 `processing=false`를 기록한다.
- 영구 삭제 트랜잭션 완료 뒤 파일 정리 단계가 해당 기록의 종료된 전사 JSON을 삭제한다. `server_purged_at`을 재시도 근거로 사용하므로 실패/보류 건은 워커의 다음 훑기에서 재시도한다. 진행 중 세션·DB 작업·다른 기록은 보존한다. 앱/워커 모두 `DAILY_LOG_VOICE_SESSION_DIR`를 반영한다.

## 재현과 검사

```sh
npm ci
npm exec -w apps/server -- vitest run src/retention/task139.test.ts --no-file-parallelism
npm test -w apps/server -- --no-file-parallelism --maxWorkers=1
npm test -w apps/web -- --no-file-parallelism --maxWorkers=1
npm run lint
npm run typecheck
```

`DATABASE_URL`은 제공된 격리 서비스가 필요하다. TASK139 시험은 DB가 없으면 실패하며 건너뛰지 않는다. 모든 시험을 순차 실행한다.

- `before.txt`: 생산 코드 수정 전 새 회귀 시험 4개 FAIL. 타인 일반 파일 200/파일 바이트 노출, 소유자 REJECTED 200, 즉시/만료 삭제 후 전사 잔존을 실제 재현했다.
- `access.txt`: 최초 권한 수정 후 AC1/2 2 PASS, 선택하지 않은 삭제 시험 2 skipped.
- `targeted.txt`: 삭제·인터뷰·보관 시험 45 PASS. TASK29/31 정상 음성 조기 삭제 포함.
- BEFORE/AFTER 이미지는 실제 실행 출력을 브라우저로 렌더링한 REPRODUCTION 증거이며 제품 UI 캡처가 아니다. `capture.mjs`로 재생성 가능하다.

기존 auth 시험의 DB 연결 없는 파일은 이제 404가 올바른 기대값이다. 백업 장애 시 영상 열람 시험은 기존에 검수 통과 상태를 만들지 않았으므로, `DONE/PASSED` 정상본을 명시적으로 준비하도록 수정했다. 파일 바이트/200 검증은 유지한다.

## 한계와 보존

기록 ID가 없는 구형/독립 음성 시험 세션은 특정 기록과 안전하게 연결할 근거가 없어 자동 삭제하지 않는다. 이번 변경 이후 제품 세션은 생성 시 연결된다. 프로세스 비정상 종료로 `processing=true`인 세션도 처리 완료를 추정하지 않고 보존한다. 이 파일들의 과거 데이터 이관/정리는 별도 확인이 필요하다. 정상 처리 음성 `audio_segments` 조기 삭제 정책과 완성 영상/백업 보존 정책은 유지한다.

읽은 참조: Mandu get_task/begin_task 패킷과 공통 계획, 읽기 전용 `/run/mandu/MANDU-HANDOFF.json`, README, `docs/qa/task-31.md`, `docs/voice/live.md`, 실제 auth/records/interview/voice/retention/backup 코드와 DB 마이그레이션. Wiki 원문 및 task-138-evidence 브랜치는 이번 실행에서 읽지 않았으며 신규 실제 회귀 시험으로 재현했다.

첫 전체 서버 실행(`server-initial.txt`)은 39 파일 / 529개 중 528 PASS·1 FAIL이었다. 실패는 위에서 설명한 백업 시험의 미검수 픽스처이며 숨기지 않고 원본 진단을 보존했다. 증거 출력에서 Fastify 요청 JSON 줄만 제외하며 Vitest 결과·오류는 보존한다.

## 최종 결과 (2026-11-03 UTC)

- 전체 서버: **39 파일 / 529 PASS**, 종료 0 (`server-all.txt`). 수정된 백업 정상본 픽스처와 실제 제품 세션 JSON 검증 포함.
- 전체 웹: **6 파일 / 39 PASS**, 종료 0 (`web.txt`).
- 최종 TASK139 회귀: **6 PASS**, 종료 0 (`after.txt`): 타인 4경로 차단, 소유자 정상본/REJECTED, 즉시/만료 전사 정리, 처리 중·다른 기록 보존과 재시도, custom sessionDir, 이전 버전·휴지통 접근.
- lint, server/web typecheck, server/web build, spike, records-crash, queue-restart, notify-e2e, secrets scan: 모두 종료 0 (`checks.txt` 및 각 출력).
- SIWC/voice-measure: 37 PASS·4 SKIP·0 FAIL. 4개는 Linux에서 실행할 수 없는 Windows cmd/CurrentUser/트랜잭션/잠금 전용 검사다. 건너뜀은 PASS로 세지 않았다 (`siwc.txt`).
- BEFORE/AFTER는 지정된 `/run/mandu/attach-screenshot.mjs`로 Mandu에 실제 첨부했다.

자체 최종 승인이나 배포는 하지 않았다. 이 변경은 독립 검토 대상이다.
