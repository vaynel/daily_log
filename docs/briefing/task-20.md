# TASK-20 통합 브리핑과 공개용 내용 확정

## 흐름
1. 대화 종료(사용자가 끝냄, 10분·비용 상한) 뒤 `POST /api/briefing/:id/start` → `decideEntry`(마무리 의사 또는 상한, 사용자 답변 1개 이상). 일시정지·연결 끊김은 진입하지 않는다.
2. Pro(주입된 `ProInfer`, 구독 경로 `runtime.infer` 와 같은 모양)로 `ORGANIZE_INSTRUCTION` 정리 → `parseStatements` 검증(첨부→사실 둔갑 거절, 형식 오류만 1회 재호출). Pro 대기·한도면 `PRO_WAITING`(503)으로 끝내고 유료 모델로 바꾸지 않는다.
3. `buildItems`: UNCERTAIN·MATERIAL(첨부 내용)·정책 제외(정치·비방·뒷담화·형사 사건, `exclusion.ts`)는 영상에서 제외. 사실·의견 중 강조 항목 우선으로 최대 6개 선정. 보안 예방 학습(취약점·피싱·SQL 인젝션 예방 등)은 일괄 제외하지 않는다. 제외 항목은 기록에 남고 영상 입력에서만 빠진다.
4. 하루 요약·영상 핵심·제외 목록·음성 안내문(`speech`)을 한 응답/한 화면(`BriefingPanel`)에 제시. 브리핑은 `record_versions(SUMMARY, kind=BRIEFING)` 에 버전으로 누적한다(마이그레이션 없음).
5. 정정 `POST /correct {version,itemId,action}`: 해당 항목만 EXCLUDE/REPLACE/INCLUDE 하고 새 버전 저장. 응답의 `correctionSpeech` 는 바뀐 부분만 말하며 전체를 반복하지 않는다(`repeatsFullBriefing:false`). Pro 재호출 없음. 정책 제외·불확실·첨부 항목은 되살릴 수 없고, 고친 문장도 필터를 다시 거친다.
6. 확인 `POST /confirm {version}`: `RecordStore.confirmBriefing` 이 한 트랜잭션에서 최신 버전 확인 → CONFIRMED·revision+1 → PRODUCTION_PLAN → pipeline QUEUED → `jobs`(VIDEO_PRODUCTION) 등록. 확인 전에는 어떤 경로에도 작업이 없다. 같은 버전 재확인은 같은 작업을 돌려주고(멱등키 `produce:<id>:<version>`), 오래된 버전은 `STALE_BRIEFING` 으로 거부한다.

## 한계·후속
- 운영 서버 `main.ts` 는 `briefing: { infer: null }` 로 연결했다: Pro 구독 경로 어댑터(scripts/siwc `runtime.infer`)는 서버 프로세스에서 아직 호출 연결하지 않아 실제 브리핑 생성은 `PRO_UNAVAILABLE` 로 막힌다(제작 작업도 생기지 않음). 어댑터 연결·호출 수 집계는 별도 확인이 필요하다.
- `VIDEO_PRODUCTION`/`PRODUCE` 단계 처리기는 영상 쪽 Task 가 등록해야 한다. 지금 worker 는 처리기가 없어 작업이 `NO_HANDLER` 로 실패할 수 있다.
- 제외 분류는 키워드 기반이다. 놓치는 표현은 사용자가 항목을 직접 뺄 수 있다. 실제 Pro 출력 품질·분류 정확도는 실모델로 평가하지 않았다(유료/Pro 호출 금지).
- 음성 안내는 브라우저 `speechSynthesis`(전체 듣기·정정 뒤 바뀐 부분)이며 캐릭터 목소리(Achird) 합성이 아니다. 실기기 TalkBack 검증은 하지 않았다.
- PostgreSQL 이 없는 러너라 `store.test.ts` 의 `confirmBriefing` 시험 3건은 실행하지 못했다(NOT_RUN).

## 검증
`cd apps/server && npx vitest run src/briefing`, 브라우저: `npm run build && npm run test:briefing-e2e`.
