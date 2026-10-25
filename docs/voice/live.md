# TASK-75: 실시간 음성 대화(Gemini Live) 시험 도구 (TASK-9 연장)

구조: 브라우저 마이크(PCM16 mono) → WebSocket → 서버 중계 → Gemini Live(`BidiGenerateContent`) → 오디오 스트림 → 브라우저 재생.
순차 구조(STT→Pro→TTS, `/voice-test`, TASK-73)는 그대로 두고 **별도 경로 `/voice-live`** 로 비교한다. 대화 후 정리(브리핑·대본)는 Pro가 맡는 기존 구조를 유지한다.
러너에서는 **모의 Live 서버만** 사용했다. 실제 Gemini 호출·실기기 마이크·휴대폰 실측은 하지 않았고 PM·관리자가 TASK-9 연장으로 수행한다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `apps/server/src/voice/live.ts` | `/voice-live/ws` 중계, 설정 로드, 무음·짧은 소리 판정, 지연·토큰·비용 계측, 세션 기록(JSON, 0600) |
| `apps/server/src/voice/live-page.ts` | `/voice-live` 시험 화면(대화 시작 버튼 1회, 턴별 지연 표시) |
| `apps/server/src/voice/live-mock.testutil.ts` | 모의 Live 서버(실제 프로토콜 형태, 입력 토큰 누적·압축 흉내) |
| `apps/server/src/voice/live.test.ts` | 모의 통합 시험(지연, 끼어들기, 키·예산, 경계, 40턴) |
| `scripts/voice-live-e2e.mjs` | 가짜 마이크 브라우저 E2E |

지시문은 `pipeline.ts` 의 `INSTRUCTION`(공감 한 문장 + 후속 질문 한 문장, 60자 안팎)을 `systemInstruction` 으로 그대로 쓴다.

## 환경변수

| 이름 | 기본 | 설명 |
|---|---|---|
| `DAILY_LOG_GEMINI_KEY_FILE` | (필수) | 키 파일, 권한 0600. 없음·권한 오류면 서버 시작 거부(코드 78, fail closed) |
| `DAILY_LOG_VOICE_BUDGET_KRW` | 1000 | 서버 프로세스 예산 상한. 도달하면 새 턴을 막고 세션 종료(`BUDGET`) |
| `DAILY_LOG_VOICE_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | 예: `gemini-3.8-live` |
| `DAILY_LOG_VOICE_LIVE_VOICE` | `Kore` | 음성 이름 |
| `DAILY_LOG_VOICE_LIVE_PRICING_JSON` | 입력 $3/1M·출력 $12/1M, 1달러=1,500원 | `{"usdKrw","inputUsdPerMTok","outputUsdPerMTok"}` 모델별 덮어쓰기 |
| `DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS` | 8000 | 맥락 압축 시작 토큰. 0이면 압축 끔(비교용) |
| `DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS` | 4000 | 압축 후 목표(시작값보다 작아야 함) |
| `DAILY_LOG_VOICE_LIVE_MAX_INPUT_TOKENS` | 12000 | 한 턴 입력이 넘으면 새 턴 전에 `CONTEXT` 로 종료 |
| `DAILY_LOG_VOICE_LIVE_MAX_SESSION_SEC` | 900 | 세션 최대 길이 |
| `DAILY_LOG_VOICE_LIVE_INPUT_RATE` | 16000 | 브라우저 PCM 샘플레이트 |
| `DAILY_LOG_VOICE_LIVE_URL` | Google 공식 엔드포인트 | 시험 시 모의 서버 주소 |

## 동작 규칙

- 키는 서버 파일에서만 읽고 업스트림 `x-goog-api-key` 헤더로만 보낸다. 브라우저 메시지·페이지·로그·세션 기록·오류 응답에 키도 임시 토큰도 없다(시험으로 확인). 업스트림이 키를 거부하면 `LIVE_AUTH` 로 끝나며 자동 재시도하지 않는다.
- 한 번 시작하면 버튼 없이 계속 대화한다(Live 서버측 자동 무음 감지). 사용자가 AI 발화 중 말하면 `interrupted` 이벤트를 받아 재생을 멈추고 세션 기록의 `interrupts`·턴의 `interrupted` 에 남긴다. 업스트림이 끊기면 `LIVE_CLOSED` 로 끝나고 자동 재연결하지 않는다. 동시에 한 세션만 허용(`BUSY`), 다른 출처 WebSocket은 403.
- 새 턴 전 예산 확인: 지출 + 다음 턴 예상 비용이 남은 예산을 넘으면 그 턴 음성을 업스트림에 보내지 않고 종료한다.
- 마이크 거부는 안내 후 세션을 만들지 않는다. 무음(8초)·0.3초 미만 짧은 소리는 업스트림에 보내지 않고 응답·저장 없이 안내만 한다.
- 계측(턴별): 말 끝→첫 음성 지연(`latencyMs`), 업스트림 지연(`upstreamLatencyMs`), 이 서버가 더한 지연(`serverOverheadMs`), 입력/출력 토큰(`usageMetadata`), 추정 비용(원). 세션 합계·최대 입력 토큰 포함. 화면 턴 목록과 세션 기록 `$DAILY_LOG_VOICE_SESSION_DIR/live-<uuid>.json`(0600)에 남는다. 원문 음성은 저장하지 않고 전사 텍스트는 세션 파일에만 둔다(로그 금지).

## 비용 관리

문제: Live 는 맥락이 턴마다 입력 토큰으로 누적된다(PM 실측 약 520토큰/턴, 1차 1068 → 3차 2137).
적용: **context window compression(슬라이딩 윈도우)** — setup 의 `contextWindowCompression: { triggerTokens, slidingWindow: { targetTokens } }`. 기본 8,000 시작 / 4,000 목표.
안전망: 압축이 꺼졌거나 실패해 한 턴 입력이 `MAX_INPUT_TOKENS`(12,000)를 넘으면 새 턴 전에 `CONTEXT` 로 종료한다.

### 40턴(약 10분) 모의 시험 결과 (`live.test.ts` AC-4, 모의 토큰 모델)

| 조건 | 결과 |
|---|---|
| 압축 ON(시작 3,000 / 목표 1,500) | 40턴 완주, 입력 합계 80,120(평균 2,003/턴, 최대 2,630 ≤ 3,000), 출력 8,000, 추정 504.5원 |
| 압축 OFF | 23턴에서 `CONTEXT` 종료, 입력 합계 156,170(최대 12,000 초과), 23턴 만에 추정 785.6원 |

### 10분 세션 추정 비용 계산

`원 = (입력토큰 × 3 + 출력토큰 × 12) / 1,000,000 × 1,500`

- 위 압축 ON 결과: (80,120 × 3 + 8,000 × 12) / 1e6 × 1,500 = (240,360 + 96,000) / 1e6 × 1,500 ≈ **504원 / 10분**.
- 월 추가 API 상한 50,000원 대비 10분 세션 약 100회분(Live 한정, 다른 호출 제외).
- 한계: 입력 토큰은 모의 모델 값이고 텍스트·오디오를 같은 단가로 센 보수 추정이다. 실제 청구액이 아니다. 압축 목표를 크게 잡으면 비용이 늘고 작게 잡으면 앞 대화를 더 잃는다. **실측으로 `usageMetadata` 합계와 비교해 단가·창 크기를 조정**한다.

## 실측 방법 (PM·관리자)

1. 서버에서 `DAILY_LOG_GEMINI_KEY_FILE`(0600)·`DAILY_LOG_VOICE_SESSION_DIR` 등 기존 음성 시험 환경으로 기동, 휴대폰 브라우저에서 `/voice-live` 접속.
2. 「대화 시작」을 한 번 누르고 약 10분 대화. 화면의 턴별 「말 끝→첫 음성」 지연과 종료 요약(평균·최대)을 확인한다.
3. 세션 기록 JSON 의 `turns[].latencyMs`, `totals`, `estimatedCostKrw`, `interrupts` 로 비교한다. `/voice-test`(순차)와 같은 문장으로 번갈아 비교.
4. 모델 비교는 `DAILY_LOG_VOICE_LIVE_MODEL` 만 바꿔 재기동.

## 롤백

`/voice-live` 는 추가 경로일 뿐 `/voice-test` 와 기존 API를 바꾸지 않았다. 끄려면 Live 설정을 주지 않거나(`LIVE_DISABLED` 로 거부) 해당 커밋을 되돌린다. 세션 기록은 삭제해도 다른 기능에 영향이 없다.

## 환경 제약·미검증

모의 Live 서버 기준이며 실제 Gemini 응답 형식·지연, Android 마이크·백그라운드·알림은 검증하지 않았다. 지연 약 315ms(모의, 고정 지연 포함)는 실제 지연 예측이 아니다. 서버 추가 지연(≈1ms)만 중계 자체의 지표다.
