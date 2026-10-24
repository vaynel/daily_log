# TASK-73: 한국어 순차 음성 대화 시험 도구와 비용 계측 (TASK-9 선행)

구조: 브라우저 마이크 → (무음 감지 자동 전송) → 서버 → STT(`gpt-4o-mini-transcribe`, OpenAI) → Pro 텍스트(`scripts/siwc` `runtime.infer`) → TTS(`gemini-3.8-flash-tts`, Gemini) → 오디오 재생 → 재청취.
러너에서는 **모의 transport만** 실행했다. 실제 API 호출·실기기·실측은 하지 않았고 TASK-9에서 PM·관리자가 수행한다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `apps/server/src/voice/keys.ts` | 키 파일 검증(없음/일반 파일 아님/권한 ≠ 0600/빈 파일 → 시작 거부) |
| `apps/server/src/voice/pricing.ts` | 단가·환율(1달러=1,500원). **임시 단가** — 아래 참고 |
| `apps/server/src/voice/meter.ts` | 예산 장부, 세션 기록(JSON, 0600) |
| `apps/server/src/voice/pipeline.ts` | 한 발화 처리: 사전 예산 확인 → STT → Pro → TTS, 단계별 지연·호출 수·비용 |
| `apps/server/src/voice/transports.ts` | OpenAI STT / Gemini TTS / siwc Pro 어댑터 (모의 교체 가능) |
| `apps/server/src/voice/app.ts`, `page.ts`, `main.ts` | HTTP API, 시험 화면(`/voice-test`), 서버 진입점 |
| `scripts/voice-measure.mjs` | PM 실측 스크립트 |
| `scripts/voice-e2e.mjs` | 가짜 마이크 브라우저 E2E (모의) |

## 동작 규칙

- 키는 `DAILY_LOG_OPENAI_KEY_FILE`, `DAILY_LOG_GEMINI_KEY_FILE` 이 가리키는 파일(0600)에서만 읽는다. 하나라도 문제면 포트를 열기 전에 종료(코드 78)하며, 메시지에는 환경변수 이름과 사유 코드만 있다. Gemini 키는 URL이 아니라 `x-goog-api-key` 헤더로 보낸다. 외부 오류 본문은 버리고 코드만 쓴다.
- Pro 지원 확인 값(`supportVerified`)은 서버 설정 `DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED=true` 에서만 온다(요청 입력 무관). Pro가 성공이 아니면 답변·TTS 없이 대기 코드(`PRO_WAIT_*`)를 돌려준다. 유료 자동 전환·자동 재시도는 없다. 구독 경로 호출은 비용 0, 호출 수만 센다.
- 예산: 서버 프로세스 전체 상한(`DAILY_LOG_VOICE_BUDGET_KRW`, 기본 1,000원). STT 호출 전 `지출 + 최악 추정`, TTS 호출 전 `지출 + 글자 수 기반 추정`이 상한을 넘으면 호출하지 않고 세션을 `BUDGET` 으로 중단한다. 발화 길이 정보가 없으면 60초로 추정한다. 호출이 예외로 끝나도 나갔을 수 있어 추정액을 지출로 센다. 재시작하면 장부는 0에서 다시 시작하므로 상한은 프로세스 단위 안전장치다.
- 세션 기록 `$DAILY_LOG_VOICE_SESSION_DIR/<uuid>.json`: 호출 수, 턴별 STT·Pro·TTS 지연(ms), STT 초, 사용자·답변 글자 수, TTS 출력 초, 추정 비용, 거절 코드, 평가(1~5)·미지원 동작. **발화·답변 원문은 저장하지 않는다.** (Pro 문맥용 대화 이력은 메모리에만 있다.)
- 빈 음성(<800B)·형식 오류·과대 업로드·STT 빈 결과는 답변을 만들지 않고 턴으로 저장하지 않으며 안내를 보여 준다. 무음(8초)·너무 짧은 소리(<0.3초)는 브라우저가 보내지 않는다. 마이크 거부는 안내 후 세션을 만들지 않는다.
- 미지원: 끼어들기, 동시 발화(처리 중 요청은 409). 화면의 평가 칸에 기록한다.

## 단가에 관한 한계 (필독)

러너는 Wiki07 §6 원문을 열람하지 못했다. 기본값은 공개 단가 기반 **임시값**이다(STT $0.003/분, TTS 입력 $0.0003/천 자, TTS 출력 $0.00025/초, 1달러=1,500원). 실측 전에 PM이 Wiki07 단가로 덮어쓴다.
`DAILY_LOG_VOICE_PRICING_JSON='{"usdKrw":1500,"sttUsdPerMinute":...,"ttsInputUsdPerKChar":...,"ttsOutputUsdPerSecond":...}'`
TTS 사전 추정은 한국어 약 4자/초로 보수적이라 실제보다 크다(예산을 일찍 멈추는 쪽). 이 숫자는 청구액이 아니라 추정치다.

## 환경변수

| 이름 | 설명 |
|---|---|
| `DAILY_LOG_OPENAI_KEY_FILE` / `DAILY_LOG_GEMINI_KEY_FILE` | 서버의 `~/.config/daily-log/{openai,gemini}.key` (0600) |
| `DAILY_LOG_SIWC_DIR` | siwc 앱 디렉터리 (TASK-53 절차로 준비) |
| `DAILY_LOG_VOICE_PRO_MODEL` | Pro 텍스트 모델 이름 |
| `DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED` | `true` 일 때만 Pro 호출 (TASK-4 근거) |
| `DAILY_LOG_VOICE_SESSION_DIR` | 세션 기록 디렉터리 |
| `DAILY_LOG_VOICE_BUDGET_KRW` | 예산 상한(기본 1000) |
| `DAILY_LOG_VOICE_PORT` | 기본 3100, `HOST` 기본 127.0.0.1 |

## 내부 HTTPS 배포·롤백 절차 (PM·관리자 수행, 러너는 배포하지 않음)

이 앱에는 로그인이 없고 유료 API를 호출하므로 **내부망 전용 HTTPS** 뒤에서만 연다. 마이크 사용에 HTTPS가 필요하다(`daily.log2u.me`, push-test와 같은 방식).

1. 준비: `git fetch && git checkout <제출 commit>`; `npm ci && npm run build -w apps/server`. 키 파일 권한 `chmod 600 ~/.config/daily-log/*.key`. 세션 디렉터리 생성(예: `~/daily-log-voice`).
2. 시작(예: systemd 사용자 서비스 `daily-log-voice.service`):
   `ExecStart=/usr/bin/node apps/server/dist/voice/main.js` + 위 환경변수, `WorkingDirectory=<repo>`, `Restart=no`(자동 재시작으로 예산 장부가 초기화되지 않게).
3. HTTPS: 리버스 프록시에서 `daily.log2u.me` → `127.0.0.1:3100`. 내부 대역만 허용(외부 접근 차단). 요청 본문 상한 2MB, 응답 캐시 금지.
4. 확인: `curl -s https://daily.log2u.me/healthz`, 시작 후 휴대폰 브라우저에서 `/voice-test`.
5. 중지: `systemctl --user stop daily-log-voice` (세션 JSON은 보존).
6. 롤백: 서비스 중지 → 프록시 라우트 제거(또는 직전 commit으로 `git checkout` 후 재빌드·재시작). 이 도구는 DB·기존 앱 데이터를 건드리지 않으므로 롤백에 데이터 복구가 필요 없다. 키 노출이 의심되면 즉시 두 키를 폐기·교체한다.

## PM 실측

```
node scripts/voice-measure.mjs --base https://daily.log2u.me --file sample-ko.webm --turns 5 --duration-ms 4000
```
`sample-ko.webm`(또는 `--mime audio/ogg`)은 PM이 준비한 한국어 샘플(합성/제공 오디오)이다. 같은 샘플을 N턴 보내고 호출 수, 단계별 평균 지연, 총 지연 p50/max, 추정 비용, 턴당 비용을 **값만** 출력한다. 서버 예산 상한에 닿으면(402) 멈춘다. 휴대폰 시연·자연스러움 평가는 화면 평가 칸에 기록한다(TASK-9).

## 시험 방법

- `npm test` (서버 vitest `src/voice/voice.test.ts` 17건, `scripts/voice-measure.test.mjs`)
- `npm run test:voice-e2e` (Chromium + 가짜 마이크, 모의 transport; 별도 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 필요)

## 검증하지 않은 것

실제 OpenAI/Gemini/Pro 응답·지연·비용, Android 실제 마이크·백그라운드·알림, 소음 환경의 무음 감지 임계값(RMS 0.02 기본, URL `?rms=` 로 조정), 스피커 소리가 마이크로 되먹임되는 에코(재생 중에는 듣지 않지만 기기별 확인 필요).
