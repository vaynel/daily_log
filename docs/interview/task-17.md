# TASK-17 버튼·음성 중심 대화 화면

제품 대화 화면은 TASK-75의 Gemini Live 중계(`voice/live.ts`)를 로그인한 앱 안으로 옮긴 것이다. 순차 `/voice-test` 구조는 대화에 쓰지 않는다. 유료 호출은 TASK-13 월 원장을 거치며(목적 `PRODUCT`) 실제 유료 API 호출은 시험에서 하지 않았다(모의 Live).

## 구성
| 파일 | 역할 |
|---|---|
| `apps/server/src/interview/routes.ts` | `GET /api/interview/:id/state`, `WS /api/interview/ws?id=` (쿠키 세션·허용 계정·Origin 검사, 한 번에 한 연결) |
| `apps/server/src/interview/limits.ts` | 세션 상한 정책(하루 1회·10분·700원, 근접 8분·560원), 이어하기 지시문 |
| `apps/server/src/interview/usage.ts` + `0007_interview_live_usage.sql` | 생활일 기록 1건당 사용 시간·비용 합산, `ENDED` 면 그날 재시작 불가 |
| `apps/server/src/interview/view.ts` | 만료된 음성 안내(재개 불가 사유·보존 건수·백업 상태) |
| `apps/server/src/voice/live.ts` | `product` 모드: 상한 강제·마무리 안내·턴 저장·종료 훅(시험 도구 동작은 그대로) |
| `apps/web/src/InterviewScreen.tsx`, `interview.ts`, `audio.ts` | 화면·상태 전이·마이크/재생 |

설정: `DAILY_LOG_GEMINI_KEY_FILE`(0600). 없거나 잘못되면 서버는 뜨지만 대화 시작만 `LIVE_DISABLED` 로 막힌다(fail closed). `DAILY_LOG_VOICE_LIVE_*`(모델·단가·압축 3000/1500 등)는 `docs/voice/live.md`와 같다. 세션 기록 폴더는 `DAILY_LOG_VOICE_SESSION_DIR`(기본 `$FILE_STORAGE_DIR/live-sessions`, 0600). 배포 전 `npm run db:migrate`.

## 동작 규칙
- **시작 전 녹음 없음(AC-2)**: `getUserMedia` 는 시작/이어서 말하기 버튼 핸들러 안에서만 호출한다. 서버도 연결 전에는 Live 업스트림을 열지 않는다. 마이크 거부 시 서버 연결을 만들지 않는다.
- **연속 대화(AC-1)**: 한 번 시작하면 Live 자동 무음 감지로 답변마다 버튼 없이 이어진다. 끼어들기 시 재생을 멈춘다.
- **일시정지·재개(AC-3)**: 일시정지는 마이크를 즉시 끄고 서버가 지금까지의 턴을 저장한다. 재개는 저장된 대화를 `systemInstruction` 에 `[이어하기]` 로 덧붙여(최근 3,000자) 같은 일일 사용량에 합산한다. 이어하기에 `historyConfig`/`clientContent` 를 쓰지 않은 것은 모델별 지원이 확인되지 않아서다.
- **저장**: 턴마다 사용자 말(ANSWER) → AI 말(QUESTION) 순으로 `conversation_items` 에 멱등 키로 저장하고, 화면에는 서버에 저장된 대화만 보인다. PC·휴대폰 모두 같은 상태 API 를 읽어 이어간다(AC-5). 대화 중이 아닐 때 8초마다·포커스 시 다시 읽는다. 동시에 한 기기만 대화한다(`BUSY`).
- **상한(AC-8)**: 서버가 강제한다. 8분 또는 560원에 닿으면 마무리 안내(`realtimeInput.text`)를 한 번 보내 마무리 질문으로 전환하고 `wrap_up` 이벤트를 보낸다. 10분 또는 700원에 닿으면 새 턴을 받지 않고 종료(`TIME_LIMIT`/`COST_LIMIT`, 말하는 중이면 그 턴 뒤 종료, 15초 한도). 새 턴 전에 `누적 비용 + 다음 턴 추정 > 700` 이면 시작하지 않는다. 끝내기·상한 종료는 그날을 소진(`ENDED`)하고, 일시정지·연결 끊김·오류는 소진하지 않는다. 비용은 사용 토큰 × 설정 단가 추정이며 실제 청구액이 아니다.
- **실패 안내(AC-4)**: 마이크 거부/없음/미지원, 연결 끊김, 서버 설정 문제, 저장 실패, 무음·짧은 소리 각각 해결 행동 문구가 있고 기존 대화는 그대로 표시된다.
- **만료 안내(AC-6)**: 기록 상태에 만료된 음성 구간이 있으면 재개 불가 사유, 실제 보존된 글·첨부 건수, 실제 Drive 백업 상태에 맞춘 서버 정리 안내를 화면과 "음성으로 듣기"(브라우저 음성 합성)로 보여 준다. 이 앱은 원본 음성을 저장하지 않으므로 만료 구간은 `audio_segments` 에 있는 것만 표시한다.
- **글 입력(D15-04)**: 기본 화면에는 입력칸이 없다. "학습 내용을 글로 쓰기"/"말한 내용을 글로 정확히 고치기"를 고른 때만 나타나며 `NOTE` 첨부(`learning.md`/`correction.md`)로 저장한다.

## 단계별 지연(AC-7)
턴마다 `말 끝→첫 음성 = 음성 서비스(upstream) + 서버 추가분` 을 화면과 세션 기록(`live-<id>.json` 의 `turns[].latencyMs/upstreamLatencyMs/serverOverheadMs`)에 남긴다.
- 이전 기준(TASK-9 순차 STT→Pro→TTS 실측): 평균 7.8~12.6초, 최대 18.5초.
- 실시간 구조 실기기 실측(TASK-9 `/voice-live`): 1.27~1.57초. 같은 중계 코드이며 이 작업은 인증 경로·저장·상한만 추가했다.
- 이 작업의 모의 Live 측정: 332~341ms(모의 고정 지연 포함, 실제 예측 아님), 서버 추가분 0~3ms. **제품 화면에서의 실제 Gemini·Android 실측은 NOT_RUN**(아래).

## 검증
```
npm run build -w apps/web && npm run test:interview-e2e   # 가짜 마이크 Chromium + 모의 Live (PostgreSQL 불필요)
npm test                                                  # 단위·모의 통합. DATABASE_URL 이 있으면 PgLiveUsageStore 시험 포함
```
Playwright 는 Chromium 제한 옵션·`UV_THREADPOOL_SIZE=2`·마지막 단독 실행을 권장한다.

## 미검증 / 한계
- Android 실기기 마이크·백그라운드·알림·TalkBack, 실제 Gemini 응답·지연·비용, 실제 Google 로그인 경로의 WebSocket 쿠키 전달은 확인하지 않았다(AC-1 실기기 시연은 NOT_RUN).
- PostgreSQL 이 없어 `PgLiveUsageStore`·`0007` 마이그레이션·`RecordStore` 연동은 DB 시험을 실행하지 못했다(시험은 작성, `skipIf(!DATABASE_URL)`).
- 마무리 전환은 안내문을 보낸 직후 AI 가 한 번 더 말하는 방식이다. 실제 모델이 얼마나 자연스럽게 따르는지는 실측 필요.
- 사용 시간은 연결(ready~종료) 시간 합이며 일시정지 중에는 늘지 않는다. 비정상 종료(서버 강제 종료)된 연결의 시간·비용은 합산되지 않을 수 있다(월 원장에는 불명으로 남는다).
